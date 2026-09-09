// @ts-ignore -- @iarna/rtf-to-html ships no types; resolution differs between tsconfigs
import rtfToHTML from '@iarna/rtf-to-html'
import { ConversionError } from '../errors'
import { sanitizeToHub } from '../allowlist'
import type { HubDocument, SourceInput } from '../types'

/**
 * Recorded fidelity (phase-3 spike, 2026-08-31; tables added 2026-08-31):
 * paragraphs and inline formatting survive via @iarna/rtf-to-html, and
 * `\trowd ... \cell ... \row` tables now survive as real <table> markup,
 * including tables nested in a cell (`\nestcell`/`\nestrow`/`\itap`), which
 * come out as a real <table> inside the parent <td>.
 *
 * Why a segmenting pre-pass rather than replacing the converter: the library
 * has no table model at all, but its prose/inline path is the one this app has
 * shipped on. So the table regions are cut out of the RTF *before* conversion,
 * parsed here into a row/cell model, and their place held by a plain-text
 * token; the rest of the document takes exactly the path it took yesterday and
 * the rendered <table> is stitched back over the token afterwards. Anything the
 * table parser cannot read confidently is simply left in the stream, where the
 * old degraded-paragraph behaviour (below) still applies — a table can lose its
 * shape, never its text.
 */
/**
 * Lookup tables keyed by text taken straight out of the document must not
 * inherit from Object.prototype: a `\toString` control word would otherwise
 * resolve to a *function*, which the callers then treat as a string. Every
 * table below is null-prototyped for that reason (`SKIP_DESTINATIONS` and
 * friends are already safe, being Sets).
 */
function lookup<T extends object>(entries: T): T {
  return Object.assign(Object.create(null) as T, entries)
}

const CP1252: Record<string, string> = lookup({
  '85': '\\u8230?', // …
  '91': '\\u8216?',
  '92': '\\u8217?',
  '93': '\\u8220?',
  '94': '\\u8221?',
  '95': '\\u8226?', // •
  '96': '\\u8211?',
  '97': '\\u8212?',
})

/** CP1252's 0x80-0x9F window; 0xA0-0xFF already agree with Latin-1. */
const CP1252_HIGH: Record<number, string> = lookup({
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…',
  0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
  0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’',
  0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ',
  0x9e: 'ž', 0x9f: 'Ÿ',
})

/**
 * `\binN` and its optional delimiting space. The negative lookahead keeps
 * `\binary` (or any longer word) from being read as `\bin`.
 */
const BIN_CONTROL = /\\bin(?![a-zA-Z])(-?\d*)[ ]?/y

/** Deepest `\itap` honoured. Word stops at a few; three is the most seen in the wild. */
const MAX_NEST_DEPTH = 8

/**
 * Index just past the backslash escape at `j`, where `j` is the `\`.
 *
 * `\` normally escapes the single character after it. The one exception is
 * `\binN`, which declares N *raw* bytes following the control word: a `{` or
 * `}` in that payload is data, not structure. A brace walk that misses this
 * desynchronises on the first binary `{` and swallows the rest of the document
 * — Word emits `\bin` routinely for embedded objects, so it is reachable with
 * ordinary files. The main tokenizer has always honoured it (`cw === 'bin'`);
 * this is the same rule, shared by the three structural walks below.
 */
function afterEscape(rtf: string, j: number): number {
  BIN_CONTROL.lastIndex = j
  const match = BIN_CONTROL.exec(rtf)
  if (!match) return j + 2
  const count = /^-?\d+$/.test(match[1]) ? parseInt(match[1], 10) : NaN
  const skip = count > 0 ? count : 0
  return Math.min(rtf.length, j + match[0].length + skip)
}

/**
 * Remove a balanced RTF group starting at `open`, returning the index after it.
 * Embedded pictures are megabytes of hex that the converter emits as literal
 * body text — one real file was 99.6% hex by volume.
 */
function stripGroups(rtf: string, starters: RegExp): string {
  let out = ''
  let i = 0
  while (i < rtf.length) {
    starters.lastIndex = i
    const match = starters.exec(rtf)
    if (!match) {
      out += rtf.slice(i)
      break
    }
    out += rtf.slice(i, match.index)
    // Walk to the matching close brace, honouring nesting, \{ escapes and \bin.
    let depth = 0
    let j = match.index
    while (j < rtf.length) {
      const ch = rtf[j]
      if (ch === '\\') {
        j = afterEscape(rtf, j)
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
      j++
    }
    i = j
  }
  return out
}

/** Picture/binary stripping, shared by the table pre-pass and the prose path. */
function stripPictures(rtf: string): string {
  // \pict and the Word-specific picture wrappers carry no text.
  const out = stripGroups(
    rtf,
    /\{\\\*?\\?(pict|shppict|nonshppict|objdata|datastore|themedata|colorschememapping|fontemb|fontfile)\b/g,
  )
  // Anything left that is a long hex run is picture payload, not prose.
  return stripBinPayloads(out).replace(/\b[0-9a-f]{200,}\b/gi, '')
}

/**
 * A `\binN` that survived group stripping — in a destination not listed above,
 * or bare in prose — still carries N raw bytes, and rtf-parser does not know
 * the control word: a `{` in the payload reached it and the whole document
 * failed with a TypeError. Splice each one out, payload included.
 */
function stripBinPayloads(rtf: string): string {
  if (!rtf.includes('\\bin')) return rtf
  let out = ''
  let i = 0
  for (;;) {
    const at = rtf.indexOf('\\bin', i)
    if (at === -1) break
    BIN_CONTROL.lastIndex = at
    const m = BIN_CONTROL.exec(rtf)
    if (!m) {
      // \binary or similar: not ours.
      out += rtf.slice(i, at + 4)
      i = at + 4
      continue
    }
    const count = m[1] === '' || m[1] === '-' ? 0 : parseInt(m[1], 10)
    out += rtf.slice(i, at)
    i = BIN_CONTROL.lastIndex + Math.max(0, count)
  }
  return out + rtf.slice(i)
}

/** The degraded path, applied to whatever the table pre-pass did not claim. */
function preprocess(rtf: string): string {
  let out = rtf
  // Keep degraded table cells separated (" | ") and split rows into paragraphs.
  out = out.replace(/\\cell\b/g, ' | \\cell')
  out = out.replace(/\\row\b/g, '\\row\\par')
  out = out.replace(/\\'([0-9a-f]{2})/gi, (m, hex: string) => CP1252[hex.toLowerCase()] ?? m)
  return out
}

/* -------------------------------------------------------------------------- */
/* RTF table extraction                                                        */
/* -------------------------------------------------------------------------- */

interface Run {
  text: string
  b: boolean
  i: boolean
  u: boolean
  /** A hard break inside a cell (\par or \line). */
  br?: boolean
  /**
   * Pre-rendered markup emitted verbatim instead of `text` — a nested table.
   * `text` still carries the nested table's flattened text, because the merge
   * and empty-table decisions elsewhere are made on cell *text*, and a cell
   * holding nothing but a nested table is not an empty cell.
   */
  html?: string
}

interface CellDef {
  /** \cellx right edge in twips; 0 when the producer gave none. */
  right: number
  hMergeFirst: boolean
  hMergeCont: boolean
  vMergeFirst: boolean
  vMergeCont: boolean
}

interface BuiltCell {
  html: string
  text: string
  right: number
  colspan: number
  rowspan: number
  vMergeFirst: boolean
  vMergeCont: boolean
  dropped: boolean
}

interface BuiltRow {
  cells: BuiltCell[]
  header: boolean
}

/**
 * One nesting level of the table stack. `levels[0]` is the `\itap1` table, and
 * `levels[n]` an `\itap(n+1)` table living inside `levels[n-1]`'s current cell.
 *
 * `pendingRaw` exists only for nested levels: Word writes the inner row's
 * `\cellx` grid AFTER its cells, in `{\*\nesttableprops ... \nestrow}`, so a
 * closed nested row is held raw until either those props arrive or the level is
 * flushed. The outer level never needs it — `\trowd\cellx...` always precedes
 * its own cells.
 */
interface TableLevel {
  rows: BuiltRow[]
  rowCells: Run[][]
  curRuns: Run[]
  cellDefs: CellDef[]
  pendingDef: CellDef
  rowHeader: boolean
  pendingRaw: Run[][] | null
  /**
   * Whether a nested-cell marker was actually seen at this level. `\itap2` on
   * its own is not proof of a table — some producers raise it around ordinary
   * cell content — and a level that never saw `\nestcell`/`\nestrow` gives its
   * runs back to the parent rather than inventing a 1×1 table around them.
   */
  sawNest: boolean
}

function newLevel(): TableLevel {
  return {
    rows: [],
    rowCells: [],
    curRuns: [],
    cellDefs: [],
    pendingDef: blankDef(),
    rowHeader: false,
    pendingRaw: null,
    sawNest: false,
  }
}

interface CharState {
  b: boolean
  i: boolean
  u: boolean
  hidden: boolean
  /** \ucN — how many fallback characters follow a \uN escape. */
  uc: number
}

/** Destinations whose text is markup, metadata, or picture payload. */
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'listtable', 'listoverridetable',
  'rsidtbl', 'generator', 'pict', 'shppict', 'nonshppict', 'objdata', 'datastore',
  'themedata', 'colorschememapping', 'nesttableprops', 'pntxta', 'pntxtb', 'pntext',
  // \nonesttables holds a *duplicate*, flattened rendering of a nested table
  // for readers that cannot nest. This one can, so the duplicate is noise —
  // Word's is a bare \par, which would otherwise land in the parent cell.
  'nonesttables',
  'xmlnstbl', 'latentstyles', 'filetbl', 'header', 'headerl', 'headerr', 'headerf',
  'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'ftnsep', 'ftnsepc', 'ftncn',
  'annotation', 'atnid', 'atnauthor', 'atnref', 'atntime', 'bkmkstart', 'bkmkend',
  'fldinst', 'do', 'shp', 'shpinst', 'template', 'revtbl', 'mmathPr',
])
// Deliberately NOT skipped: \upr (its ANSI half is real text — only the
// {\*\ud} Unicode half is ignorable), \field/\fldrslt, and \listtext.

/** Control words that stand for one literal character. */
const SYMBOL_WORDS: Record<string, string> = lookup({
  tab: '\t',
  emdash: '—',
  endash: '–',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
  bullet: '•',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  zwj: '',
  zwnj: '',
  ltrmark: '',
  rtlmark: '',
})

/** Table structure, never a `\uN` fallback character. */
const STRUCTURAL_WORDS = new Set([
  'cell', 'row', 'trowd', 'cellx', 'par', 'intbl', 'nestcell', 'nestrow', 'sect', 'page', 'itap',
])

const tableToken = (index: number): string => `zZrTfTbL${index}Zz`

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function blankDef(): CellDef {
  return { right: 0, hMergeFirst: false, hMergeCont: false, vMergeFirst: false, vMergeCont: false }
}

/** Index just past the `}` matching the `{` at `open`. */
function groupEnd(rtf: string, open: number): number {
  let depth = 0
  let j = open
  while (j < rtf.length) {
    const ch = rtf[j]
    if (ch === '\\') {
      j = afterEscape(rtf, j)
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return j + 1
    }
    j++
  }
  return rtf.length
}

function isBalanced(slice: string): boolean {
  let depth = 0
  let j = 0
  while (j < slice.length) {
    const ch = slice[j]
    if (ch === '\\') {
      j = afterEscape(slice, j)
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < 0) return false
    }
    j++
  }
  return depth === 0
}

function runsText(runs: Run[]): string {
  return runs
    .map((r) => (r.br ? ' ' : r.text))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Cell content as inline hub HTML. Runs are emitted in order with their own
 * <strong>/<em>/<u>, and a \par inside a cell becomes <br> — the hub's grid
 * reader treats <br> as a block boundary, which is what keeps two paragraphs
 * in one cell from extracting as "onetwo".
 */
function renderRuns(runs: Run[]): string {
  const kept = runs.filter((r) => r.br || r.text !== '')
  // Trim the cell's outer whitespace without disturbing run boundaries.
  while (kept.length > 0 && (kept[0].br || kept[0].text.trim() === '')) kept.shift()
  while (kept.length > 0 && (kept[kept.length - 1].br || kept[kept.length - 1].text.trim() === ''))
    kept.pop()
  if (kept.length > 0) {
    kept[0] = { ...kept[0], text: kept[0].text.replace(/^\s+/, '') }
    const last = kept.length - 1
    kept[last] = { ...kept[last], text: kept[last].text.replace(/\s+$/, '') }
  }
  let out = ''
  for (const run of kept) {
    if (run.br) {
      out += '<br>'
      continue
    }
    // A nested table is already rendered markup; it must not be escaped, and
    // it carries its own block boundaries so it needs no <br> around it.
    if (run.html !== undefined) {
      out += run.html
      continue
    }
    // Tabs and newlines inside a cell are layout, not content.
    let text = escapeHtml(run.text.replace(/[\t\r\n]+/g, ' '))
    if (text === '') continue
    if (run.u) text = `<u>${text}</u>`
    if (run.i) text = `<em>${text}</em>`
    if (run.b) text = `<strong>${text}</strong>`
    out += text
  }
  return out
}

/** A whole table's text, for the cell that will hold it as a nested table. */
function tableText(rows: BuiltRow[]): string {
  return rows
    .map((row) =>
      row.cells
        .filter((c) => !c.dropped && c.text !== '')
        .map((c) => c.text)
        .join(' '),
    )
    .filter((t) => t !== '')
    .join(' ')
}

/**
 * Do two rows belong to the same table? `\cellx` declares each row's column
 * boundaries in twips, which is the only structural evidence RTF gives: rows of
 * one table share a right edge, and a row with merged cells declares a SUBSET
 * of the full boundary set (three columns merged into one leaves just the
 * rightmost edge). A different right edge, or a boundary neither row shares,
 * means a different table.
 *
 * This is what tells "a stray \par between two rows" apart from "a \par that
 * ended one table before another began" — see the `\par` handler.
 */
function defsCompatible(a: CellDef[], b: CellDef[]): boolean {
  // Neither row declared a grid: nothing says they differ, so keep them together.
  if (a.length === 0 || b.length === 0) return a.length === b.length
  const ax = a.map((d) => d.right)
  const bx = b.map((d) => d.right)
  if (ax[ax.length - 1] !== bx[bx.length - 1]) return false
  const [small, large] = ax.length <= bx.length ? [ax, bx] : [bx, ax]
  return small.every((edge) => large.includes(edge))
}

/**
 * The `\cellx` grid (and header flag) of a nested row, which Word writes after
 * the row's cells inside `{\*\nesttableprops\trowd\itap2\cellx...\nestrow}`.
 * The closing `\nestrow`/`\row` frequently lives inside this group too, so the
 * group both describes and terminates the row.
 */
function parseNestProps(group: string): {
  defs: CellDef[]
  header: boolean
  itap: number
  closesRow: boolean
} {
  const defs: CellDef[] = []
  let pending = blankDef()
  let header = false
  let itap = 0
  let closesRow = false
  const words = /\\([a-zA-Z]+)(-?\d+)?/g
  let m: RegExpExecArray | null
  while ((m = words.exec(group)) !== null) {
    switch (m[1]) {
      case 'cellx':
        defs.push({ ...pending, right: m[2] ? parseInt(m[2], 10) : 0 })
        pending = blankDef()
        break
      case 'clmgf':
        pending.hMergeFirst = true
        break
      case 'clmrg':
        pending.hMergeCont = true
        break
      case 'clvmgf':
        pending.vMergeFirst = true
        break
      case 'clvmrg':
        pending.vMergeCont = true
        break
      case 'trhdr':
        header = true
        break
      case 'itap':
        if (m[2]) itap = Math.min(MAX_NEST_DEPTH, parseInt(m[2], 10))
        break
      case 'nestrow':
      case 'row':
        closesRow = true
        break
      default:
        break
    }
  }
  return { defs, header, itap, closesRow }
}

function lastKept(cells: BuiltCell[]): BuiltCell | undefined {
  for (let k = cells.length - 1; k >= 0; k--) if (!cells[k].dropped) return cells[k]
  return undefined
}

/**
 * One `\row` worth of cells. `\cellx` declares the column boundaries, so its
 * count is the authoritative column count; a row with fewer `\cell`s than
 * `\cellx`es is padded, and a row with more keeps the extras rather than
 * dropping text.
 */
function buildRow(cells: Run[][], defs: CellDef[], header: boolean): BuiltRow {
  const count = Math.max(cells.length, defs.length)
  const out: BuiltCell[] = []
  for (let k = 0; k < count; k++) {
    const def = defs[k] ?? blankDef()
    const runs = cells[k] ?? []
    const text = runsText(runs)
    const cell: BuiltCell = {
      html: renderRuns(runs),
      text,
      right: def.right,
      colspan: 1,
      rowspan: 1,
      vMergeFirst: def.vMergeFirst,
      vMergeCont: def.vMergeCont,
      dropped: false,
    }
    const prev = lastKept(out)
    if (def.hMergeCont && prev) {
      // \clmrg continues a horizontal merge: the text lives in the \clmgf cell
      // and this one is normally empty. Widen the first cell instead of
      // emitting a duplicate, and if the producer did put text here, append it
      // (separated) rather than dropping it.
      prev.colspan += 1
      prev.right = def.right
      if (text !== '') {
        prev.html = prev.html === '' ? cell.html : `${prev.html} ${cell.html}`
        prev.text = prev.text === '' ? text : `${prev.text} ${text}`
      }
      cell.dropped = true
    }
    out.push(cell)
  }
  return { cells: out, header }
}

/**
 * Collapse `\clvmgf`/`\clvmrg` vertical merges into rowspan. Columns are
 * matched by their `\cellx` right edge, which is how RTF identifies "the same
 * column" across rows. A continuation cell that unexpectedly carries text is
 * left alone — a slightly wrong shape beats losing the text.
 */
function applyVerticalMerges(rows: BuiltRow[]): void {
  const open = new Map<number, BuiltCell>()
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.dropped) continue
      const key = cell.right
      if (cell.vMergeFirst && key > 0) {
        open.set(key, cell)
        continue
      }
      if (cell.vMergeCont && key > 0 && cell.text === '' && open.has(key)) {
        const target = open.get(key)
        if (target) {
          target.rowspan += 1
          cell.dropped = true
        }
        continue
      }
      if (key > 0) open.delete(key)
    }
  }
}

function renderTable(rows: BuiltRow[]): string {
  if (!rows.some((r) => r.cells.some((c) => !c.dropped && c.text !== ''))) return ''
  const rowHtml = (row: BuiltRow): string => {
    const tag = row.header ? 'th' : 'td'
    const cells = row.cells
      .filter((c) => !c.dropped)
      .map((c) => {
        const attrs =
          (c.colspan > 1 ? ` colspan="${c.colspan}"` : '') +
          (c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : '')
        return `<${tag}${attrs}>${c.html}</${tag}>`
      })
      .join('')
    return `<tr>${cells}</tr>`
  }
  // \trhdr marks repeating header rows; they lead the table when present.
  let head = 0
  while (head < rows.length && rows[head].header) head++
  const thead = head > 0 ? `<thead>${rows.slice(0, head).map(rowHtml).join('')}</thead>` : ''
  const body = rows.slice(head)
  const tbody = body.length > 0 ? `<tbody>${body.map(rowHtml).join('')}</tbody>` : ''
  return `<table>${thead}${tbody}</table>`
}

/**
 * Cut every table region out of `rtf`, replacing each with a plain-text token,
 * and return the rendered <table> HTML for each token in document order.
 * A region that cannot be read confidently is left in place, so the caller's
 * degraded path still renders its text.
 *
 * Exported for the invariant test in tests/core/rtf-nested-tables.test.ts: every byte
 * this does not claim as a table region has to reach @iarna/rtf-to-html exactly
 * as it arrived, and that is only checkable on the segmented RTF itself.
 */
export function extractTables(rtf: string): { rtf: string; tables: string[] } {
  // Documents without a row definition — the overwhelming majority — pay only
  // this test. (One 807 KB real file: 0 tables, 44 pictures.)
  if (!/\\trowd(?![a-zA-Z])/.test(rtf)) return { rtf, tables: [] }

  const regions: { start: number; end: number; html: string }[] = []
  const len = rtf.length
  let state: CharState = { b: false, i: false, u: false, hidden: false, uc: 1 }
  const stack: CharState[] = []
  let depth = 0
  let skipChars = 0

  // Paragraph tracking, so a table region can start at the paragraph mark
  // before `\trowd` rather than mid-paragraph.
  let segStart = 0
  let textSinceBreak = false

  // Table-in-progress state. `levels` is the nesting stack: levels[0] is the
  // \itap1 table, levels[n] an \itap(n+1) table inside levels[n-1]'s open cell.
  // Everything else here describes the *region* being cut, which only ever
  // belongs to the outermost table.
  let inTable = false
  let tableStart = -1
  let tableDepth = 0
  let lastRowEnd = -1
  let levels: TableLevel[] = [newLevel()]
  let betweenRows = false
  let firstContentPos = -1
  let abandoned = false
  /** Current `\itap` nesting depth; 1 when the producer writes no `\itap`. */
  let itap = 1

  // Defect 2 state: a `\par` after a `\row` is only *provisionally* the end of
  // the table. The verdict waits for the next `\row`, where the new row's
  // \cellx grid says whether it belongs to the same table (see defsCompatible).
  let parPending = false
  let splitEnd = -1 // where the table would end if the \par turns out to be real
  let splitStart = -1 // where the next table would start in that case
  let prevRowDefs: CellDef[] = []
  let prevRowItap = 1

  const top = (): TableLevel => levels[levels.length - 1]

  const resetTable = (): void => {
    inTable = false
    tableStart = -1
    lastRowEnd = -1
    levels = [newLevel()]
    betweenRows = false
    firstContentPos = -1
    abandoned = false
    itap = 1
    parPending = false
    splitEnd = -1
    splitStart = -1
    prevRowDefs = []
    prevRowItap = 1
  }

  /**
   * Push one finished table as a cut region, or decline it. Declining is always
   * safe: the RTF stays in the stream and the degraded prose path renders its
   * text instead. Returns whether the region was taken.
   */
  const emitRegion = (start: number, end: number, rows: BuiltRow[], bad: boolean): boolean => {
    if (bad || rows.length === 0 || start < 0 || end <= start) return false
    if (!isBalanced(rtf.slice(start, end))) return false
    applyVerticalMerges(rows)
    const html = renderTable(rows)
    // An empty render means the parser did not find the row's text where it
    // expected it (a producer that writes cell text *before* \trowd is the
    // known case). Leaving the region in the stream keeps that text: it comes
    // out as degraded paragraphs instead of vanishing behind an empty table.
    if (html === '') return false
    regions.push({ start, end, html })
    return true
  }

  const commitTable = (): void => {
    // A cell whose text started before the region would be rendered twice —
    // once in the table, once by the prose path. Refusing such a region is the
    // safe read: the text still comes out, just degraded.
    const early = firstContentPos >= 0 && tableStart >= 0 && firstContentPos < tableStart
    emitRegion(tableStart, lastRowEnd, levels[0].rows, abandoned || early)
    resetTable()
  }

  const enterTable = (pos: number): void => {
    if (inTable) return
    resetTable()
    inTable = true
    tableDepth = depth
    // Mid-paragraph entry keeps the prose before it out of the region.
    tableStart = textSinceBreak ? pos : segStart
  }

  const pushRun = (text: string): void => {
    const runs = top().curRuns
    const last = runs[runs.length - 1]
    if (
      last &&
      !last.br &&
      last.html === undefined &&
      last.b === state.b &&
      last.i === state.i &&
      last.u === state.u
    ) {
      last.text += text
      return
    }
    runs.push({ text, b: state.b, i: state.i, u: state.u })
  }

  const pushBreak = (): void => {
    const runs = top().curRuns
    if (runs.length === 0) return
    runs.push({ text: '', b: false, i: false, u: false, br: true })
  }

  /* ---------------------------------------------------------------------- */
  /* Nesting                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Turn a nested level's held-back raw row into a real row. */
  const flushPendingRow = (lvl: TableLevel): void => {
    if (!lvl.pendingRaw) return
    lvl.rows.push(buildRow(lvl.pendingRaw, lvl.cellDefs, lvl.rowHeader))
    lvl.pendingRaw = null
    lvl.rowHeader = false
  }

  /**
   * Close a nested row. `defs`/`header` are non-null only when the closing came
   * from `{\*\nesttableprops}`, which is the one place the row's own `\cellx`
   * grid is stated; without them the row is held until it is known.
   */
  const closeNestedRow = (lvl: TableLevel, defs: CellDef[] | null, header: boolean | null): void => {
    if (lvl.curRuns.length > 0) {
      lvl.rowCells.push(lvl.curRuns)
      lvl.curRuns = []
    }
    if (lvl.rowCells.length > 0) {
      flushPendingRow(lvl) // the previous row never got its props
      lvl.pendingRaw = lvl.rowCells
      lvl.rowCells = []
    }
    if (defs) {
      lvl.cellDefs = defs
      if (header !== null) lvl.rowHeader = header
      flushPendingRow(lvl)
    }
  }

  /**
   * Grow the stack so a level for `\itap depth` exists. Clamped: Word will not
   * nest tables past a handful of levels and no real document has been seen
   * beyond three, while `\itap50000000` — one object per claimed level — was a
   * fatal V8 heap OOM in the main process, which no try/catch can reach.
   */
  const ensureLevel = (want: number): void => {
    while (levels.length < Math.min(MAX_NEST_DEPTH, Math.max(2, want))) levels.push(newLevel())
  }

  /**
   * Finish the deepest level and hand its rendered <table> to the cell that
   * contains it. A nested table that renders empty contributes nothing rather
   * than an empty <table>, and its text (if any) still rides along as a run.
   */
  const flushLevel = (): void => {
    if (levels.length < 2) return
    const lvl = levels.pop() as TableLevel
    if (!lvl.sawNest) {
      const parent = top()
      for (const cell of lvl.rowCells) parent.curRuns.push(...cell)
      parent.curRuns.push(...lvl.curRuns)
      return
    }
    closeNestedRow(lvl, null, null)
    flushPendingRow(lvl)
    applyVerticalMerges(lvl.rows)
    const text = tableText(lvl.rows)
    const html = renderTable(lvl.rows)
    if (text === '') return
    const parent = top()
    parent.curRuns.push(
      html === ''
        ? { text: ` ${text} `, b: false, i: false, u: false }
        : { text, b: false, i: false, u: false, html },
    )
  }

  /** Collapse the stack back to `want` levels, folding each into its parent. */
  const unwindTo = (want: number): void => {
    while (levels.length > Math.max(1, want)) flushLevel()
  }

  const addText = (text: string, pos: number): void => {
    if (state.hidden || text === '') return
    const solid = text.trim() !== ''
    if (!inTable) {
      if (solid) textSinceBreak = true
      return
    }
    if (betweenRows) {
      // Prose after a row ends the run of rows; the next \trowd starts a new table.
      if (solid) {
        commitTable()
        textSinceBreak = true
      }
      return
    }
    if (solid && firstContentPos < 0) firstContentPos = pos
    pushRun(text)
  }

  const endParagraph = (after: number): void => {
    segStart = after
    textSinceBreak = false
  }

  /**
   * A place a table region may legally start: after a brace (the region has to
   * be brace-balanced), after a skipped header destination, or after \pard.
   * Without this the region could start at offset 0 and eat `{\rtf1...`.
   */
  const markBoundary = (after: number): void => {
    if (!inTable && !textSinceBreak) segStart = after
  }

  let i = 0
  while (i < len) {
    const ch = rtf[i]

    if (ch === '{') {
      // {\*\nesttableprops ...} is the ONLY statement of a nested row's \cellx
      // grid, and Word puts the closing \nestrow inside it too. So it is read
      // here and then skipped whole — its \trowd must never reach the scanner,
      // where it would be taken for the outer table's next row.
      if (inTable && /^\{\s*(?:\\\*\s*)?\\nesttableprops(?![a-zA-Z])/.test(rtf.slice(i, i + 40))) {
        const end = groupEnd(rtf, i)
        const props = parseNestProps(rtf.slice(i, end))
        // Producers that omit \itap here (the pre-Word-2003 shape) describe the
        // deepest open nested level.
        ensureLevel(props.itap >= 2 ? props.itap : 2)
        const lvl = levels[props.itap >= 2 ? Math.min(levels.length - 1, props.itap - 1) : levels.length - 1]
        lvl.sawNest = true
        if (props.closesRow) closeNestedRow(lvl, props.defs, props.header)
        else {
          lvl.cellDefs = props.defs
          lvl.rowHeader = props.header
        }
        i = end
        markBoundary(i)
        continue
      }
      // Ignorable and non-text destinations are skipped whole.
      const probe = /^\{\s*\\(\*|[a-zA-Z]+)/.exec(rtf.slice(i, i + 40))
      const word = probe?.[1]
      if (word === '*' || (word && SKIP_DESTINATIONS.has(word))) {
        i = groupEnd(rtf, i)
        markBoundary(i)
        continue
      }
      stack.push({ ...state })
      depth++
      i++
      markBoundary(i)
      continue
    }

    if (ch === '}') {
      depth--
      const restored = stack.pop()
      if (restored) state = restored
      if (inTable && depth < tableDepth) commitTable()
      i++
      markBoundary(i)
      continue
    }

    if (ch === '\\') {
      const next = rtf[i + 1]
      if (next === undefined) break
      if (/[a-zA-Z]/.test(next)) {
        let j = i + 1
        while (j < len && /[a-zA-Z]/.test(rtf[j])) j++
        const cw = rtf.slice(i + 1, j)
        let numText = ''
        if (rtf[j] === '-') {
          numText = '-'
          j++
        }
        while (j < len && /[0-9]/.test(rtf[j])) {
          numText += rtf[j]
          j++
        }
        const hasParam = numText !== '' && numText !== '-'
        const param = hasParam ? parseInt(numText, 10) : undefined
        if (rtf[j] === ' ') j++ // the delimiting space belongs to the control word
        const wordStart = i
        i = j

        if (cw === 'bin' && hasParam && (param as number) > 0) {
          i = Math.min(len, i + (param as number))
          continue
        }
        if (cw === 'u' && hasParam) {
          const code = (param as number) < 0 ? (param as number) + 65536 : (param as number)
          addText(String.fromCharCode(code), wordStart)
          skipChars = state.uc
          continue
        }
        // Structure never stands in for a \uN fallback character.
        if (STRUCTURAL_WORDS.has(cw)) skipChars = 0
        if (skipChars > 0) {
          // A \uN fallback may itself be a control word (\'3f is the usual one).
          skipChars--
          continue
        }
        if (cw === 'uc' && hasParam) {
          state.uc = Math.max(0, param as number)
          continue
        }

        switch (cw) {
          case 'b':
            state.b = param !== 0
            continue
          case 'i':
            state.i = param !== 0
            continue
          case 'ul':
            state.u = param !== 0
            continue
          case 'ulnone':
            state.u = false
            continue
          case 'v':
            state.hidden = param !== 0
            continue
          case 'plain':
            state.b = false
            state.i = false
            state.u = false
            state.hidden = false
            continue
          case 'pard':
            markBoundary(i)
            continue
          case 'trowd': {
            // Outside {\*\nesttableprops} a \trowd always redefines the row of
            // the level we are currently in — the outer one, unless \itap put
            // us deeper.
            enterTable(wordStart)
            const lvl = top()
            lvl.cellDefs = []
            lvl.pendingDef = blankDef()
            lvl.rowHeader = false
            betweenRows = false
            continue
          }
          case 'intbl':
            enterTable(wordStart)
            betweenRows = false
            continue
          case 'itap':
            if (!inTable) continue
            itap = Math.min(MAX_NEST_DEPTH, hasParam ? (param as number) : 1)
            if (itap >= 2) ensureLevel(itap)
            // Coming back out of a nested table hands it to the cell that holds
            // it; \itap0 says the document has left the table altogether, which
            // settles any \par still awaiting a verdict (see 'par' below).
            else unwindTo(Math.max(1, itap))
            if (itap === 0 && betweenRows) commitTable()
            continue
          case 'trhdr':
            if (inTable) top().rowHeader = true
            continue
          case 'cellx':
            if (inTable) {
              const lvl = top()
              lvl.cellDefs.push({ ...lvl.pendingDef, right: hasParam ? (param as number) : 0 })
              lvl.pendingDef = blankDef()
            }
            continue
          case 'clmgf':
            top().pendingDef.hMergeFirst = true
            continue
          case 'clmrg':
            top().pendingDef.hMergeCont = true
            continue
          case 'clvmgf':
            top().pendingDef.vMergeFirst = true
            continue
          case 'clvmrg':
            top().pendingDef.vMergeCont = true
            continue
          case 'cell':
            if (inTable) {
              // \cell belongs to the outer table, so any nested table still
              // open is finished and folded into this cell first.
              unwindTo(1)
              const lvl = levels[0]
              lvl.rowCells.push(lvl.curRuns)
              lvl.curRuns = []
              betweenRows = false
            }
            continue
          case 'row':
            if (inTable) {
              unwindTo(1)
              const lvl = levels[0]
              if (lvl.curRuns.length > 0) {
                lvl.rowCells.push(lvl.curRuns)
                lvl.curRuns = []
              }
              // A \par has been waiting since the last \row to learn whether it
              // ended the table. This row's \cellx grid is the evidence: an
              // incompatible grid means the \par was a real boundary, so the
              // rows before it are cut as their own table and this row opens a
              // new region starting just after the \par.
              if (parPending) {
                const same =
                  itap === prevRowItap && defsCompatible(prevRowDefs, lvl.cellDefs)
                if (!same) {
                  const early =
                    firstContentPos >= 0 && tableStart >= 0 && firstContentPos < tableStart
                  emitRegion(tableStart, splitEnd, lvl.rows, abandoned || early)
                  lvl.rows = []
                  tableStart = splitStart
                  firstContentPos = -1
                  abandoned = false
                }
                parPending = false
              }
              lvl.rows.push(buildRow(lvl.rowCells, lvl.cellDefs, lvl.rowHeader))
              prevRowDefs = lvl.cellDefs.slice()
              prevRowItap = itap
              lvl.rowCells = []
              lvl.rowHeader = false
              betweenRows = true
              lastRowEnd = i
              endParagraph(i)
            }
            continue
          case 'nestcell':
            if (inTable && !betweenRows) {
              // Producers that mark the nested cell with nothing but \nestcell
              // (no \itap) have already handed this cell's text to the parent
              // level; move it down as the nested level is created.
              const carried = levels.length < 2 ? top().curRuns : []
              if (levels.length < 2) top().curRuns = []
              ensureLevel(2)
              const lvl = top()
              lvl.sawNest = true
              if (carried.length > 0) lvl.curRuns = carried.concat(lvl.curRuns)
              lvl.rowCells.push(lvl.curRuns)
              lvl.curRuns = []
            }
            continue
          case 'nestrow':
            // The row's \cellx grid usually arrives afterwards, in
            // {\*\nesttableprops}; closeNestedRow holds the row until then.
            if (inTable && !betweenRows && levels.length > 1) {
              top().sawNest = true
              closeNestedRow(top(), null, null)
            }
            continue
          case 'par':
          case 'line':
            if (inTable && betweenRows) {
              // NOT a table boundary yet: rows of one table are routinely
              // separated by a bare \par. The verdict is deferred to the next
              // \row, which knows its own \cellx grid.
              if (!parPending) {
                parPending = true
                splitEnd = lastRowEnd
                splitStart = i
              }
            } else if (inTable) pushBreak()
            endParagraph(i)
            continue
          case 'sect':
          case 'page':
          case 'column':
            if (inTable) commitTable()
            endParagraph(i)
            continue
          default:
            break
        }

        const symbol = SYMBOL_WORDS[cw]
        if (symbol !== undefined) addText(symbol, wordStart)
        continue
      }

      // Control symbol.
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4)
        i += 4
        if (skipChars > 0) {
          skipChars--
          continue
        }
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          const code = parseInt(hex, 16)
          addText(CP1252_HIGH[code] ?? String.fromCharCode(code), i - 4)
        }
        continue
      }
      i += 2
      if (skipChars > 0) {
        skipChars--
        continue
      }
      if (next === '\\' || next === '{' || next === '}') addText(next, i - 2)
      else if (next === '~') addText(' ', i - 2)
      else if (next === '_') addText('‑', i - 2)
      else if (next === '\n' || next === '\r') {
        // An escaped newline is a \par; between rows it gets the same deferred
        // verdict a literal \par does.
        if (inTable && betweenRows) {
          if (!parPending) {
            parPending = true
            splitEnd = lastRowEnd
            splitStart = i
          }
        } else if (inTable) pushBreak()
        endParagraph(i)
      }
      continue
    }

    if (ch === '\r' || ch === '\n') {
      i++
      continue
    }

    // Plain text: take the whole run up to the next delimiter at once.
    let j = i
    while (j < len && rtf[j] !== '\\' && rtf[j] !== '{' && rtf[j] !== '}' && rtf[j] !== '\r' && rtf[j] !== '\n')
      j++
    let text = rtf.slice(i, j)
    if (skipChars > 0) {
      const drop = Math.min(skipChars, text.length)
      skipChars -= drop
      text = text.slice(drop)
    }
    addText(text, i)
    i = j
  }
  if (inTable) commitTable()

  if (regions.length === 0) return { rtf, tables: [] }

  const tables: string[] = []
  let out = ''
  let cursor = 0
  for (const region of regions) {
    if (region.start < cursor) continue
    out += rtf.slice(cursor, region.start)
    out += `{\\pard\\plain ${tableToken(tables.length)}\\par}`
    tables.push(region.html)
    cursor = region.end
  }
  out += rtf.slice(cursor)
  return { rtf: out, tables }
}

/**
 * Swap each placeholder paragraph in the converted HTML for its table. The
 * converter wraps the token in its own styled <p>, and a <table> may not live
 * inside one, so the whole paragraph goes. One global pass, so a document with
 * many tables stays linear.
 */
const TOKEN_PATTERN =
  /<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?zZrTfTbL(\d+)Zz(?:(?!<\/p>)[\s\S])*?<\/p>|zZrTfTbL(\d+)Zz/g

function injectTables(html: string, tables: string[]): string {
  if (tables.length === 0) return html
  return html.replace(TOKEN_PATTERN, (_m, wrapped?: string, bare?: string) => {
    const index = parseInt(wrapped ?? bare ?? '', 10)
    return tables[index] ?? ''
  })
}

/** Promote big-font strong paragraphs (WordPad-style titles) to headings. */
function promoteHeadings(html: string): string {
  return html.replace(
    /<p style="[^"]*font-size:\s*(\d+)pt[^"]*">\s*<strong>([\s\S]*?)<\/strong>\s*<\/p>/g,
    (m, size: string, text: string) => (parseInt(size, 10) >= 16 ? `<h2>${text}</h2>` : m),
  )
}

function convert(rtf: string): Promise<string> {
  return new Promise((resolve, reject) => {
    rtfToHTML.fromString(rtf, (err: Error | null, html: string) =>
      err ? reject(err) : resolve(html),
    )
  })
}

/** Convert a raw RTF string to hub HTML (also used for .msg plain-RTF bodies). */
export async function rtfStringToHubHtml(rtf: string): Promise<string> {
  if (!rtf.trimStart().startsWith('{\\rtf')) {
    throw new ConversionError('rtf-parse-failed', 'Not an RTF document')
  }
  const stripped = stripPictures(rtf)
  const segmented = segmentTables(stripped)
  let full: string
  try {
    full = await convert(preprocess(segmented.rtf))
  } catch (err) {
    throw new ConversionError('rtf-parse-failed', `Could not parse RTF: ${(err as Error).message}`)
  }
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(full)?.[1] ?? full
  const withTables = injectTables(promoteHeadings(body), segmented.tables)
  const clean = sanitizeToHub(withTables)
  // Trailing " | " before a row break reads badly; collapse doubled separators.
  return clean.replace(/ \|\s*<\/p>/g, '</p>')
}

/**
 * A fault that means THIS READER is broken, not that the input is unreadable.
 *
 * extractTables never throws deliberately — a region it cannot read confidently
 * is left in the stream, not reported as an error — so every throw out of it is
 * a bug here. The pre-pass is still wrapped, because a latent bug costing only
 * a document's table structure beats it costing the whole document; but
 * swallowing a TypeError is how R9 stayed invisible. A `	oString` control word
 * made SYMBOL_WORDS return a function, `.trim()` threw, this catch ate it, and
 * every table in the document silently became prose with no error anywhere.
 */
function isProgrammingError(err: unknown): boolean {
  return err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError
}

/**
 * The table pre-pass with its safety net. The extractor is injectable for the
 * tests that drive the two error paths — the same shape readDoc uses for
 * word-extractor — because a genuine reader bug cannot be summoned on demand.
 */
export function segmentTables(
  rtf: string,
  extract: (s: string) => { rtf: string; tables: string[] } = extractTables,
): { rtf: string; tables: string[] } {
  try {
    return extract(rtf)
  } catch (err) {
    if (isProgrammingError(err)) throw err
    // Anything else: fall back to prose-only, as before.
    return { rtf, tables: [] }
  }
}

export async function readRtf(src: SourceInput): Promise<HubDocument> {
  const html = await rtfStringToHubHtml(src.bytes.toString('latin1'))
  const title = /<h2>([^<]*)<\/h2>/.exec(html)?.[1]?.trim() || undefined
  return { html, title }
}
