// @ts-ignore -- rtf-parser ships no types; resolution differs between tsconfigs
import parseRtf from 'rtf-parser'
// @ts-ignore -- rtf-parser ships no types; see keepGroupStyles below.
import RTFGroup from 'rtf-parser/rtf-group.js'
// @ts-ignore -- rtf-parser ships no types; see ctrl$up/ctrl$dn below.
import RTFInterpreter from 'rtf-parser/rtf-interpreter.js'
// @ts-ignore -- rtf-parser ships no types; see the finisher below.
import RTFParagraph from 'rtf-parser/rtf-paragraph.js'
// @ts-ignore -- @iarna/rtf-to-html ships no types. Its renderer is imported on
// its own so the parsed document can be mended first (see markSubscripts).
import renderRtfDocument from '@iarna/rtf-to-html/rtf-to-html.js'
import { ConversionError } from '../errors'
import { sanitizeToHub } from '../allowlist'
import type { HubDocument, SourceInput } from '../types'
import { imageMime } from './image'
import { vectorMime } from '../pictures'
import { archiveInlineBudget, createImageLedger, imagePlaceholder, OVER_BUDGET } from '../inline-images'

/**
 * Keep the formatting a span was given inside its own group.
 *
 * rtf-parser styles a span when it is added to the group it was read in,
 * then MOVES it into the parent group when that group closes, through the
 * same addContent, which styles it again with the parent's style. Everything
 * set inside the group was overwritten: `{\\b bold}` arrived as plain text,
 * and so did italic, underline and superscript. Word writes nearly all run
 * formatting that way; only toggles (`\\b bold\\b0`) survived.
 *
 * A node is styled once, where it was read, and moved as it is after that.
 * The second pass also converted an already-resolved font and color as if
 * they were table indices, so skipping it is right for those too.
 */
const STYLED = Symbol('rtf-styled')
const originalAddContent = RTFGroup.prototype.addContent
RTFGroup.prototype.addContent = function (this: { content: unknown[] }, node: Record<symbol, boolean>) {
  if (node[STYLED]) {
    this.content.push(node)
    return
  }
  originalAddContent.call(this, node)
  node[STYLED] = true
}

/**
 * Read `\\upN` and `\\dnN` as superscript and subscript.
 *
 * They raise or lower text by N half-points, the positional way of writing
 * x² and H₂O that older exporters still use. rtf-parser has no handler for
 * either, so the digit came out on the baseline: "mc2", "H2O". The offset
 * itself is layout; what it means is the same as `\\super`/`\\sub`, so it is
 * read as those, and `\\up0`/`\\dn0` (back to the baseline) as `\\nosupersub`.
 */
interface Interpreter {
  group: { style: Record<string, unknown> }
  groupStack: unknown[]
  doc: { content: unknown[]; addContent: (node: unknown) => void }
  cmd$groupEnd: () => void
}
const interpreter = RTFInterpreter.prototype as Record<string, (this: Interpreter, param?: number) => void>
interpreter.ctrl$up = function (param) {
  this.group.style.valign = param === 0 ? 'normal' : 'super'
}
interpreter.ctrl$dn = function (param) {
  this.group.style.valign = param === 0 ? 'normal' : 'sub'
}

/**
 * Close the last paragraph when the file does not.
 *
 * rtf-parser gathers a paragraph's spans into it when it meets `\\par`, and
 * the renderer draws paragraphs only, so text after the last `\\par` was left
 * loose and dropped: a file ending without one lost its last paragraph, and
 * `{\\rtf1 Only words}` read as empty. The finisher unwinds any open groups
 * first, so by the time the stray spans are gathered they are all at the top.
 */
const originalFinisher = interpreter.finisher
interpreter.finisher = function () {
  while (this.groupStack.length) this.cmd$groupEnd()
  const last = this.doc.content[this.doc.content.length - 1]
  if (last !== undefined && !(last instanceof RTFParagraph)) this.doc.addContent(new RTFParagraph())
  originalFinisher.call(this)
}

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
  /** \super / \sub; absent is the baseline. */
  va?: 'super' | 'sub'
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
  va?: 'super' | 'sub'
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
    if (run.va === 'super') text = `<sup>${text}</sup>`
    if (run.va === 'sub') text = `<sub>${text}</sub>`
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
      last.u === state.u &&
      last.va === state.va
    ) {
      last.text += text
      return
    }
    runs.push({ text, b: state.b, i: state.i, u: state.u, ...(state.va ? { va: state.va } : {}) })
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
          case 'super':
          case 'sub':
            state.va = cw
            continue
          case 'nosupersub':
            state.va = undefined
            continue
          // Raised or lowered by N half-points; see ctrl$up/ctrl$dn at the top.
          case 'up':
          case 'dn':
            state.va = param === 0 ? undefined : cw === 'up' ? 'super' : 'sub'
            continue
          case 'v':
            state.hidden = param !== 0
            continue
          case 'plain':
            state.b = false
            state.i = false
            state.u = false
            state.va = undefined
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

/** Private-use marks around subscript text, through @iarna/rtf-to-html and back. */
const SUB_OPEN = '\uE020'
const SUB_CLOSE = '\uE021'

interface RtfNode {
  value?: unknown
  style?: { valign?: string }
  content?: RtfNode[]
}

/**
 * Subscript, mended on its way through @iarna/rtf-to-html.
 *
 * rtf-parser reads \sub correctly (valign 'sub'), but rtf-to-html 1.1.0's
 * renderer writes <sup> for it as well as for \super, so H₂O came out H²O.
 * That went unseen while the hub dropped both tags. So each subscript run's
 * text is wrapped in private-use marks and its valign cleared before
 * rendering, and the marks become <sub> afterwards; superscript is left to
 * the library, which gets that one right.
 *
 * A paragraph whose spans are all subscript carries valign 'sub' too (the
 * parser lifts shared span styles onto it), and spans in one group can share
 * a single style object. So every subscript node is found FIRST and changed
 * after; clearing as the walk goes would hide the spans that come next.
 */
function markSubscripts(doc: RtfNode): RtfNode {
  const subs: RtfNode[] = []
  const walk = (node: RtfNode): void => {
    if (node.style?.valign === 'sub') subs.push(node)
    for (const child of node.content ?? []) walk(child)
  }
  walk(doc)
  for (const node of subs) {
    if (typeof node.value === 'string') node.value = SUB_OPEN + node.value + SUB_CLOSE
  }
  for (const node of subs) node.style = { ...node.style, valign: 'normal' }
  return doc
}

function unmarkSubscripts(html: string): string {
  return html
    .split(SUB_CLOSE + SUB_OPEN)
    .join('')
    .replace(new RegExp(`${SUB_OPEN}([\\s\\S]*?)${SUB_CLOSE}`, 'g'), '<sub>$1</sub>')
    .replace(new RegExp(`[${SUB_OPEN}${SUB_CLOSE}]`, 'g'), '')
}

function convert(rtf: string): Promise<string> {
  return new Promise((resolve, reject) => {
    parseRtf.string(rtf, (err: Error | null, doc: RtfNode) => {
      if (err) return reject(err)
      try {
        resolve(unmarkSubscripts(renderRtfDocument(markSubscripts(doc))))
      } catch (e) {
        reject(e)
      }
    })
  })
}

/**
 * Where a lifted footnote stood. Plain ASCII, like tableToken, because it
 * must come through both RTF paths as text: a \\uN escape is folded to its
 * fallback character on the way.
 */
const NOTE_MARK = (i: number): string => `zZrTfNoTe${i}Zz`
const NOTE_MARK_RE = /zZrTfNoTe(\d+)Zz/g

/**
 * Take every `{\\footnote …}` group out of the stream, leaving a marker.
 *
 * Read in place, a footnote's text ran into its sentence ("Claim The source
 * note.. More text."), and inside a table the group was skipped and the note
 * lost. Its body is read on its own instead, and becomes a note in the hub's
 * model (src/core/footnotes.ts). An endnote is a \\footnote with \\ftnalt
 * and is treated the same.
 */
function liftRtfFootnotes(rtf: string): { rtf: string; notes: string[] } {
  const notes: string[] = []
  let out = ''
  let i = 0
  const opener = /\{(?:\\\*)?\\footnote\b/g
  for (let m = opener.exec(rtf); m; m = opener.exec(rtf)) {
    // groupEnd returns the position AFTER the group's closing brace.
    const end = groupEnd(rtf, m.index)
    out += rtf.slice(i, m.index) + NOTE_MARK(notes.length)
    notes.push(rtf.slice(m.index + m[0].length, rtf[end - 1] === '}' ? end - 1 : end))
    i = end
    opener.lastIndex = i
  }
  return notes.length ? { rtf: out + rtf.slice(i), notes } : { rtf, notes }
}

/* -------------------------------------------------------------------------- */
/* Pictures                                                                    */
/* -------------------------------------------------------------------------- */

/** A picture read from a `\\pict` group: its bytes as a file of its type, and the size the document shows it at (CSS px). */
interface RtfPicture {
  mime: string
  bytes: Buffer
  width?: number
  height?: number
  alt?: string
}

/** Where a lifted picture stood. Plain ASCII, like tableToken and NOTE_MARK, so it comes through both RTF paths as text. */
const PICTURE_MARK = (i: number): string => `zZrTfPiC${i}Zz`
const PICTURE_MARK_RE = /zZrTfPiC(\d+)Zz/g

/** The picture types a `\\pict` names, by control word. QuickDraw, OS/2 metafiles and device-dependent bitmaps are not read. */
const PICT_TYPES: Record<string, string> = lookup({
  pngblip: 'image/png',
  jpegblip: 'image/jpeg',
  emfblip: 'image/x-emf',
  wmetafile: 'image/x-wmf',
  dibitmap: 'image/bmp',
})

/** Hex digits and the line breaks between them. */
const HEX_RUN = /[0-9a-fA-F][0-9a-fA-F\s]*/y

/** The largest side believed, in CSS px (about 5 m), as picture-headers.ts. */
const MAX_PICTURE_SIDE = 20000

/** Text of an RTF fragment with its control words gone and its escapes decoded (a \\picprop value). */
function rtfPlainText(fragment: string): string {
  return fragment
    .replace(/\\'([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_m, n: string) => String.fromCharCode((Number(n) + 65536) % 65536))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/\\([\\{}])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A BMP file of a DIB: a `\\dibitmap` holds the BITMAPINFO and the bits, and
 * a file wants the 14-byte header in front, which says where the bits start
 * (after the info header, its color table and any bit-field masks).
 */
function dibToBmp(dib: Buffer): Buffer | null {
  if (dib.length < 12) return null
  const size = dib.readUInt32LE(0)
  let table = 0
  if (size === 12) {
    const bits = dib.readUInt16LE(10)
    table = bits <= 8 ? (1 << bits) * 3 : 0
  } else if (size >= 40 && size <= 124 && dib.length >= 40) {
    const bits = dib.readUInt16LE(14)
    const compression = dib.readUInt32LE(16)
    const used = dib.readUInt32LE(32)
    table = (used > 0 && used <= 256 ? used : bits <= 8 ? 1 << bits : 0) * 4
    if (size === 40 && compression === 3) table += 12
    if (size === 40 && compression === 6) table += 16
  } else return null
  if (size + table > dib.length) return null
  const header = Buffer.alloc(14)
  header.write('BM', 0, 'latin1')
  header.writeUInt32LE(14 + dib.length, 2)
  header.writeUInt32LE(14 + size + table, 10)
  return Buffer.concat([header, dib])
}

/**
 * A WMF file of the metafile a `\\wmetafile` holds: that is the bare
 * metafile, and the document gives its size (in twips), so it is given the
 * Aldus placeable header Word writes in front of a .wmf file, which says
 * the same. Null when it is not a metafile at all.
 */
function placeableWmf(meta: Buffer, twipsWide: number, twipsHigh: number): Buffer | null {
  if (meta.length >= 22 && meta.readUInt32LE(0) === 0x9ac6cdd7) return vectorMime(meta) ? meta : null
  if (!(meta.length >= 18 && [1, 2].includes(meta.readUInt16LE(0)) && meta.readUInt16LE(2) === 9)) return null
  if (!(twipsWide > 0 && twipsHigh > 0)) return null
  // The box is 16-bit: a very large picture is given fewer units to the inch.
  const k = Math.max(1, Math.ceil(Math.max(twipsWide, twipsHigh) / 0x7fff))
  const head = Buffer.alloc(22)
  head.writeUInt32LE(0x9ac6cdd7, 0)
  head.writeInt16LE(Math.round(twipsWide / k), 10)
  head.writeInt16LE(Math.round(twipsHigh / k), 12)
  head.writeUInt16LE(Math.round(1440 / k), 14)
  let sum = 0
  for (let i = 0; i < 20; i += 2) sum ^= head.readUInt16LE(i)
  head.writeUInt16LE(sum, 20)
  return Buffer.concat([head, meta])
}

/**
 * One `{\\pict …}` group, from `open` to `end` (just past its `}`): its type
 * (the blip control word), its data (hex digits, or `\\binN` raw bytes), its
 * sizes (`\\picwgoal`/`\\pichgoal` in twips, scaled by `\\picscalex`/`y`
 * percent; `\\picw`/`\\pich`, a metafile's in hundredths of a millimetre)
 * and the description Word keeps in `\\picprop`. Null when it is of a type
 * not read here or its data is not that type (the bytes say, not the word).
 */
function readPict(rtf: string, open: number, end: number): RtfPicture | null {
  const words: Record<string, number> = lookup({})
  let type: string | undefined
  let alt: string | undefined
  const digits: string[] = []
  let raw: Buffer | undefined
  const CONTROL = /\\([a-z]+)(-?\d+)? ?/y
  let i = rtf.indexOf('\\pict', open) + 5
  while (i < end - 1) {
    const ch = rtf[i]
    if (ch === '{') {
      const close = Math.min(groupEnd(rtf, i), end - 1)
      const group = rtf.slice(i, close)
      const desc = /\{\\sn\s+wzDescription\}\s*\{\\sv\s+((?:[^{}\\]|\\.)*)\}/.exec(group)
      if (desc && /^\{\\\*\\picprop\b/.test(group)) alt = rtfPlainText(desc[1]) || undefined
      i = close
      continue
    }
    if (ch === '\\') {
      CONTROL.lastIndex = i
      const m = CONTROL.exec(rtf)
      if (!m) {
        i += 2
        continue
      }
      const [, word, param] = m
      i = CONTROL.lastIndex
      if (word === 'bin') {
        const count = Math.max(0, Math.min(Number(param ?? 0), end - 1 - i))
        raw = Buffer.from(rtf.slice(i, i + count), 'latin1')
        i += count
      } else if (PICT_TYPES[word]) type = PICT_TYPES[word]
      else if (param !== undefined) words[word] = Number(param)
      continue
    }
    // A run of hex (lines of it, in practice), taken whole.
    HEX_RUN.lastIndex = i
    const run = HEX_RUN.exec(rtf)
    if (run && run[0].length > 0) {
      digits.push(run[0].replace(/\s+/g, ''))
      i += run[0].length
      continue
    }
    i++
  }
  if (!type) return null
  const hexDigits = digits.join('')
  let bytes = raw ?? Buffer.from(hexDigits.slice(0, hexDigits.length - (hexDigits.length % 2)), 'hex')
  const scale = (n?: number): number => (n && n > 0 ? n / 100 : 1)
  const sx = scale(words.picscalex)
  const sy = scale(words.picscaley)
  const metafile = type === 'image/x-emf' || type === 'image/x-wmf'
  // twips: the size asked for, else a metafile's own extent (0.01 mm).
  let tw = words.picwgoal > 0 ? words.picwgoal : metafile && words.picw > 0 ? (words.picw * 1440) / 2540 : 0
  let th = words.pichgoal > 0 ? words.pichgoal : metafile && words.pich > 0 ? (words.pich * 1440) / 2540 : 0
  tw *= sx
  th *= sy
  if (type === 'image/bmp') {
    const bmp = dibToBmp(bytes)
    if (!bmp) return null
    bytes = bmp
  } else if (type === 'image/x-wmf') {
    const wmf = placeableWmf(bytes, tw, th)
    if (!wmf) return null
    bytes = wmf
  } else if (type === 'image/x-emf') {
    if (vectorMime(bytes) !== 'image/x-emf') return null
  } else if (imageMime(bytes) !== type) return null
  const picture: RtfPicture = { mime: type, bytes, alt }
  const width = Math.round(tw / 15)
  const height = Math.round(th / 15)
  if (width >= 1 && height >= 1 && width <= MAX_PICTURE_SIDE && height <= MAX_PICTURE_SIDE) {
    picture.width = width
    picture.height = height
  }
  return picture
}

/** The first `{\\pict` group inside [from, to), read. */
function pictIn(rtf: string, from: number, to: number): RtfPicture | null {
  const at = rtf.slice(from, to).search(/\{\\(?:\*\\)?pict\b/)
  return at < 0 ? null : readPict(rtf, from + at, Math.min(groupEnd(rtf, from + at), to))
}

/** Picture groups, and Word's pair of them (`\\shppict`, the picture; `\\nonshppict`, its fallback for older readers). */
const PICTURE_GROUP = /\{\\(?:\*\\)?(shppict|nonshppict|pict)\b/g

/**
 * Take every picture out of the stream, leaving a marker where it stood.
 *
 * They used to be stripped, and an RTF document arrived with no pictures at
 * all. Word writes each as a pair: `{\\*\\shppict{\\pict…}}` (the picture,
 * PNG, JPEG or EMF) and `{\\nonshppict{\\pict…}}` right after (a WMF or a
 * DIB for readers that know no better). The first is the picture, the
 * second its alternate: both reach the hub (`data-alt-src`), and the picture
 * step takes whichever the target can use (pictures.ts) - Word the EMF, a
 * web page the DIB beside it. A `\\pict` on its own, or a `\\nonshppict`
 * with no `\\shppict` before it, is the picture. One nothing here reads is
 * left out, as before.
 */
function liftRtfPictures(rtf: string): { rtf: string; pictures: { picture: RtfPicture; alternate?: RtfPicture }[] } {
  if (!rtf.includes('\\pict')) return { rtf, pictures: [] }
  const pictures: { picture: RtfPicture; alternate?: RtfPicture }[] = []
  let out = ''
  let i = 0
  PICTURE_GROUP.lastIndex = 0
  for (let m = PICTURE_GROUP.exec(rtf); m; m = PICTURE_GROUP.exec(rtf)) {
    // An escaped brace is text, not a group.
    let slashes = 0
    for (let k = m.index - 1; k >= 0 && rtf[k] === '\\'; k--) slashes++
    if (slashes % 2 === 1) continue
    const end = groupEnd(rtf, m.index)
    let next = end
    let picture = m[1] === 'pict' ? readPict(rtf, m.index, end) : pictIn(rtf, m.index, end)
    let alternate: RtfPicture | null = null
    if (m[1] === 'shppict') {
      const after = /^\s*\{\\nonshppict\b/.exec(rtf.slice(end, end + 64))
      if (after) {
        const open = end + after[0].indexOf('{')
        next = groupEnd(rtf, open)
        alternate = pictIn(rtf, open, next)
      }
    }
    if (!picture) [picture, alternate] = [alternate, null]
    out += rtf.slice(i, m.index)
    if (picture) {
      out += PICTURE_MARK(pictures.length)
      pictures.push(alternate ? { picture, alternate } : { picture })
    }
    i = next
    PICTURE_GROUP.lastIndex = next
  }
  return { rtf: out + rtf.slice(i), pictures }
}

/** Each marker that came through becomes its picture, within the document's image budget (as docx and pptx). */
function placePictures(html: string, pictures: { picture: RtfPicture; alternate?: RtfPicture }[], sourceLength: number): string {
  if (pictures.length === 0) return html
  const ledger = createImageLedger(archiveInlineBudget(sourceLength))
  return html.replace(PICTURE_MARK_RE, (_m, n: string) => {
    const entry = pictures[Number(n)]
    if (!entry) return ''
    const { picture, alternate } = entry
    if (!ledger.admit(picture.bytes.length + (alternate?.bytes.length ?? 0))) {
      return imagePlaceholder(picture.alt ? `${escapeHtml(picture.alt)} — ${OVER_BUDGET}` : OVER_BUDGET, 'inline')
    }
    const uri = (p: RtfPicture): string => `data:${p.mime};base64,${p.bytes.toString('base64')}`
    const size = picture.width && picture.height ? ` width="${picture.width}" height="${picture.height}"` : ''
    const alt = picture.alt ? ` alt="${escapeHtml(picture.alt)}"` : ' alt=""'
    return `<img src="${uri(picture)}"${alt}${size}${alternate ? ` data-alt-src="${uri(alternate)}"` : ''}>`
  })
}

/** Convert a raw RTF string to hub HTML (also used for .msg plain-RTF bodies). */
export async function rtfStringToHubHtml(rtf: string): Promise<string> {
  if (!rtf.trimStart().startsWith('{\\rtf')) {
    throw new ConversionError('rtf-parse-failed', 'Not an RTF document')
  }
  const lifted = liftRtfPictures(rtf)
  return placePictures(await rtfWithoutPicturesToHubHtml(lifted.rtf), lifted.pictures, rtf.length)
}

async function rtfWithoutPicturesToHubHtml(rtf: string): Promise<string> {
  const lifted = liftRtfFootnotes(stripPictures(rtf))
  const main = await rtfBodyToHubHtml(lifted.rtf)
  if (lifted.notes.length === 0) return main
  // Each note body is a fragment of the same document: read it the same way.
  const bodies: string[] = []
  // The closing \\par makes the body a paragraph; without one it renders as nothing.
  for (const note of lifted.notes) bodies.push(await rtfBodyToHubHtml(`{\\rtf1\\ansi ${note}\\par}`))
  const html = main.replace(NOTE_MARK_RE, (_m, n: string) => {
    const label = String(Number(n) + 1)
    return `<sup data-fn="${label}">${label}</sup>`
  })
  const items = bodies.map((b, i) => `<li data-fn="${i + 1}">${b.trim() || '<p></p>'}</li>`)
  return `${html}<ol>${items.join('')}</ol>`
}

async function rtfBodyToHubHtml(stripped: string): Promise<string> {
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
