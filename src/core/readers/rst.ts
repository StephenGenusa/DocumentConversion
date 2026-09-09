import { ConversionError } from '../errors'
import { resolveExport } from '../interop'
import { escapeHtml } from '../shell'
import type { HubDocument, SourceInput } from '../types'

interface RstNode {
  type: string
  value?: string
  depth?: number
  children?: RstNode[]
}

/** Render the restructured AST; unknown node types fall through to their children. */
function render(node: RstNode, depth = 0): string {
  const kids = (d = depth): string => (node.children ?? []).map((c) => render(c, d)).join('')
  switch (node.type) {
    case 'document':
      return kids()
    case 'section':
      return kids(node.depth ?? depth + 1)
    case 'title': {
      const level = Math.min(6, Math.max(1, depth || 1))
      return `<h${level}>${kids().trim()}</h${level}>`
    }
    case 'paragraph':
      // Text nodes keep their source newlines; block content reads better trimmed.
      return `<p>${kids().trim()}</p>`
    case 'text':
      return escapeHtml(node.value ?? '')
    case 'strong':
      return `<strong>${kids()}</strong>`
    case 'emphasis':
      return `<em>${kids()}</em>`
    case 'literal':
      return `<code>${kids()}</code>`
    case 'literal_block':
      return `<pre><code>${escapeHtml(node.value ?? '')}${kids()}</code></pre>`
    case 'bullet_list':
      return `<ul>${kids()}</ul>`
    case 'enumerated_list':
      return `<ol>${kids()}</ol>`
    case 'list_item': {
      // List items wrap their text in paragraphs; unwrap the common one-
      // paragraph item for tidier output. An item holding more than that (a
      // table, or two paragraphs) keeps its wrappers — stripping only the
      // outermost pair left stray </p><p> in the middle of the item.
      const inner = kids().trim()
      const single = inner.startsWith('<p>') && inner.endsWith('</p>') && inner.indexOf('</p>') === inner.length - 4
      return `<li>${single ? inner.slice(3, -4) : inner}</li>`
    }
    case 'block_quote':
      return `<blockquote>${kids()}</blockquote>`
    case 'transition':
      return '<hr>'
    case 'directive':
      // Without this the directive's text nodes concatenate with no
      // separators at all ("Simple======  ===Item    Qty  Price...").
      return `<pre>${kids()}</pre>`
    case 'unknown':
      // Anything the parser cannot classify — including a table this reader
      // declined to parse. The default branch would drop it on the floor
      // (unknown_line carries a value, not children), so keep the block
      // verbatim; its alignment is the only structure it has left.
      return `<pre>${kids()}</pre>`
    case 'unknown_line':
      return `${escapeHtml(node.value ?? '')}\n`
    default:
      return kids()
  }
}

/* ------------------------------------------------------------------ *
 * Tables
 *
 * The `restructured` package declares table/tgroup/row/entry node types
 * but never emits them: both RST table syntaxes come back as ordinary
 * paragraphs of text, so every table reached the hub as ASCII art and
 * every writer rendered it as prose. Tables therefore have to be lifted
 * out of the source text BEFORE it reaches the parser.
 *
 * Both syntaxes are rigidly specified — column boundaries come straight
 * off the rule line — so this pass is deterministic. Anything it cannot
 * read with confidence (ragged borders, a span underline that lands
 * between columns) is left in the text untouched rather than guessed at
 * and mangled.
 *
 * The two parsers below follow docutils' own tableparser algorithms
 * rather than a bespoke scan, because both span forms defeat the obvious
 * "split on the rule line" approach:
 *
 *   - a grid row span punches a hole in an inner border, so borders can
 *     no longer be found by "the line starts with +";
 *   - a simple-table column span is a '---' underline that RE-SPECIFIES
 *     the columns for the single row above it.
 *
 * Following the reference algorithm also means the failure modes are the
 * spec's failure modes: both parsers verify that the cells they found
 * tile the table exactly, and return null (leaving ASCII art) otherwise.
 * ------------------------------------------------------------------ */

interface TableCell {
  text: string
  colspan: number
  rowspan: number
}

interface TableRow {
  cells: TableCell[]
  header: boolean
}

interface ParsedTable {
  rows: TableRow[]
  /** How many source lines the table occupied. */
  consumed: number
}

/** Marker left in the source in place of a table; survives the parser as a lone word. */
const tableToken = (i: number): string => `XRSTHUBTABLE${i}ENDX`
/** Every `tableToken` at once, alone in its own paragraph or bare. Keep in step with it. */
const TABLE_TOKEN = /<p>\s*XRSTHUBTABLE(\d+)ENDX\s*<\/p>|XRSTHUBTABLE(\d+)ENDX/g

/** A grid-table border: +---+---+ or the header rule +===+===+ */
const GRID_BORDER = /^\+[-=][-=+]*\+$/
/** A simple-table rule: two or more runs of '=' (one run is a section underline). */
const SIMPLE_RULE = /^=+(?: +=+)+$/

/** Inline markup that is worth keeping inside a cell. Escaped first, so this cannot inject tags. */
function inlineRst(text: string): string {
  return escapeHtml(text)
    .replace(/``([^`]+)``/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)/g, '$1<em>$2</em>')
}

function renderTable(rows: TableRow[]): string {
  // Plain integer colspan/rowspan attributes: that is what table-grid.ts reads
  // back out (and caps at MAX_SPAN) when it rebuilds the rectangular grid every
  // writer consumes. Cells covered by a span are simply absent from their row,
  // which is both valid HTML and what that expander expects.
  const cell = (c: TableCell, tag: string): string =>
    `<${tag}${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}` +
    `${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}>${inlineRst(c.text)}</${tag}>`
  const tr = (row: TableRow): string => `<tr>${row.cells.map((c) => cell(c, row.header ? 'th' : 'td')).join('')}</tr>`
  const head = rows.filter((r) => r.header)
  const body = rows.filter((r) => !r.header)
  return (
    '<table>' +
    (head.length ? `<thead>${head.map(tr).join('')}</thead>` : '') +
    (body.length ? `<tbody>${body.map(tr).join('')}</tbody>` : '') +
    '</table>'
  )
}

const rstrip = (line: string): string => line.replace(/\s+$/, '')

/** A grid cell found by the corner scan: a box plus the text inside it. */
interface GridCell {
  top: number
  left: number
  bottom: number
  right: number
  lines: string[]
}

/**
 * Find every cell rectangle in a grid table by walking corners, the way
 * docutils' GridTableParser does.
 *
 * Starting from a '+', walk RIGHT along the top edge to a candidate '+', DOWN
 * that column to a candidate '+', LEFT along the bottom edge and UP the left
 * edge. A box that closes on all four sides is a cell; the first one that
 * closes is the smallest one, which is what makes spans fall out for free —
 * a row-spanning cell simply has no closing corner at the intervening
 * separator, so the walk carries on down past it.
 *
 * Every boundary the walk touches is remembered even when that particular box
 * does not close, because it is still a real row/column separator somewhere
 * else in the table; those are what turn absolute character offsets into
 * row/column indices afterwards.
 *
 * The block is ragged. Every character comes through `at`, which reports the
 * space that lies past the end of a short line, so the walk sees the same
 * rectangle it would see in a block padded out to one width. Padding it for
 * real cost lines x longest-line: a single long line in the block — a runaway
 * cell, a pasted URL — inflated a few hundred kilobytes of source into
 * hundreds of megabytes of spaces before the walk had even started. Cell text
 * is unaffected: a short line simply yields a short slice, and `cellText`
 * trims every line anyway.
 */
function scanGridCells(
  block: string[],
): { cells: GridCell[]; rowseps: number[]; colseps: number[] } | null {
  const bottomEdge = block.length - 1
  const rightEdge = block.reduce((max, l) => Math.max(max, l.length), 0) - 1
  /** block[row][col] as if the block were padded to one width. */
  const at = (row: number, col: number): string => {
    const line = block[row]
    return col < line.length ? line[col] : ' '
  }
  // Top and bottom borders may legitimately be drawn with '=' (and the
  // head/body rule always is), so both count as horizontal rule characters.
  const isRule = (ch: string): boolean => ch === '-' || ch === '='

  /** The left edge must be unbroken '|' between the two corners. */
  const scanUp = (top: number, left: number, bottom: number): number[] | null => {
    const seps: number[] = []
    for (let i = bottom - 1; i > top; i--) {
      const ch = at(i, left)
      if (ch === '+') seps.push(i)
      else if (ch !== '|') return null
    }
    return seps
  }

  const scanLeft = (
    top: number,
    left: number,
    bottom: number,
    right: number,
  ): { rowseps: number[]; colseps: number[] } | null => {
    const colseps: number[] = []
    for (let i = right - 1; i > left; i--) {
      const ch = at(bottom, i)
      if (ch === '+') colseps.push(i)
      else if (!isRule(ch)) return null
    }
    if (at(bottom, left) !== '+') return null
    const rowseps = scanUp(top, left, bottom)
    return rowseps ? { rowseps, colseps } : null
  }

  const scanDown = (
    top: number,
    left: number,
    right: number,
  ): { bottom: number; rowseps: number[]; colseps: number[] } | null => {
    const rowseps: number[] = []
    for (let i = top + 1; i <= bottomEdge; i++) {
      const ch = at(i, right)
      if (ch === '+') {
        rowseps.push(i)
        const closed = scanLeft(top, left, i, right)
        if (closed) return { bottom: i, rowseps: [...rowseps, ...closed.rowseps], colseps: closed.colseps }
      } else if (ch !== '|') return null
    }
    return null
  }

  const scanRight = (
    top: number,
    left: number,
  ): { bottom: number; right: number; rowseps: number[]; colseps: number[] } | null => {
    const colseps: number[] = []
    for (let i = left + 1; i <= rightEdge; i++) {
      const ch = at(top, i)
      if (ch === '+') {
        colseps.push(i)
        const closed = scanDown(top, left, i)
        if (closed) {
          return { bottom: closed.bottom, right: i, rowseps: closed.rowseps, colseps: [...colseps, ...closed.colseps] }
        }
      } else if (!isRule(ch)) return null
    }
    return null
  }

  const cells: GridCell[] = []
  const rowseps = new Set<number>([0])
  const colseps = new Set<number>([0])
  // done[col] = the last line already covered by a cell in that column. It is
  // both the work queue's "skip what is already claimed" test and the proof at
  // the end that the cells tile the table with no gaps and no overlaps.
  const done = new Array<number>(rightEdge + 1).fill(-1)
  const corners: Array<[number, number]> = [[0, 0]]
  while (corners.length > 0) {
    const [top, left] = corners.shift()!
    if (top === bottomEdge || left === rightEdge || top <= done[left]) continue
    if (at(top, left) !== '+') continue
    const found = scanRight(top, left)
    if (!found) continue
    for (const s of found.rowseps) rowseps.add(s)
    for (const s of found.colseps) colseps.add(s)
    for (let col = left; col < found.right; col++) {
      // Overlapping cells mean the borders lie; refuse the whole table.
      if (done[col] !== top - 1) return null
      done[col] = found.bottom - 1
    }
    cells.push({
      top,
      left,
      bottom: found.bottom,
      right: found.right,
      lines: block.slice(top + 1, found.bottom).map((l) => l.slice(left + 1, found.right)),
    })
    corners.push([top, found.right], [found.bottom, left])
    corners.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  }
  for (let col = 0; col < rightEdge; col++) if (done[col] !== bottomEdge - 1) return null
  return {
    cells,
    rowseps: [...rowseps].sort((a, b) => a - b),
    colseps: [...colseps].sort((a, b) => a - b),
  }
}

/** Cell text: each physical line trimmed, blank lines dropped, joined by a space. */
const cellText = (lines: string[]): string =>
  lines
    .map((l) => l.trim())
    .filter((t) => t !== '')
    .join(' ')

/** The head/body rule, +===+===+ — only meaningful on an interior line. */
const GRID_HEAD_RULE = /^\+=[=+]+=\+$/

/**
 * Grid table, including row and column spans. A row span is a cell box that
 * runs down through where a "+---+" separator would otherwise be; a column
 * span is a box that runs right through a '+' junction. Both come out of
 * `scanGridCells` as boxes wider or taller than one row/column band.
 */
function parseGridTable(block: string[]): ParsedTable | null {
  // The table is the run of non-blank lines at the head of the block.
  let n = 0
  while (n < block.length && block[n].trim() !== '') n++
  if (n < 3) return null
  const lines = block.slice(0, n).map(rstrip)
  if (!GRID_BORDER.test(lines[0]) || !GRID_BORDER.test(lines[n - 1])) return null

  let headSep = -1
  for (let i = 1; i < n - 1; i++) {
    if (!GRID_HEAD_RULE.test(lines[i])) continue
    if (headSep >= 0) return null // two head/body rules: which one wins is a guess
    headSep = i
  }

  const scanned = scanGridCells(lines)
  if (!scanned) return null
  const rowIndex = new Map(scanned.rowseps.map((v, i) => [v, i]))
  const colIndex = new Map(scanned.colseps.map((v, i) => [v, i]))
  const nrows = scanned.rowseps.length - 1
  const ncols = scanned.colseps.length - 1
  if (nrows < 1 || ncols < 1) return null

  const placed: Array<Array<TableCell | null>> = Array.from({ length: nrows }, () =>
    new Array<TableCell | null>(ncols).fill(null),
  )
  // Every band the cells cover, counted once. Anything but zero at the end
  // means the boxes overlap or leave a hole — i.e. we misread the borders.
  let uncovered = nrows * ncols
  for (const c of scanned.cells) {
    const r = rowIndex.get(c.top)
    const col = colIndex.get(c.left)
    const rEnd = rowIndex.get(c.bottom)
    const colEnd = colIndex.get(c.right)
    if (r === undefined || col === undefined || rEnd === undefined || colEnd === undefined) return null
    if (placed[r][col] !== null) return null
    const rowspan = rEnd - r
    const colspan = colEnd - col
    if (rowspan < 1 || colspan < 1) return null
    uncovered -= rowspan * colspan
    placed[r][col] = { text: cellText(c.lines), colspan, rowspan }
  }
  if (uncovered !== 0) return null

  let headerRows = 0
  if (headSep >= 0) {
    const at = rowIndex.get(headSep)
    // A cell spanning across the head/body rule leaves it off the row grid;
    // there is then no honest split, so decline rather than invent one.
    if (at === undefined || at < 1) return null
    headerRows = at
  }
  const rows: TableRow[] = placed.map((row, i) => ({
    cells: row.filter((c): c is TableCell => c !== null),
    header: i < headerRows,
  }))
  if (rows.length === 0) return null
  return { rows, consumed: n }
}

/** Column extents of a simple-table rule line: [start, end) of every '=' run. */
function ruleSpans(line: string): Array<[number, number]> | null {
  if (!SIMPLE_RULE.test(line)) return null
  const spans: Array<[number, number]> = []
  const re = /=+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) spans.push([m.index, m.index + m[0].length])
  return spans.length >= 2 ? spans : null
}

function isSameRule(line: string, spans: Array<[number, number]>): boolean {
  const other = ruleSpans(line)
  return !!other && other.length === spans.length && other.every((s, i) => s[0] === spans[i][0] && s[1] === spans[i][1])
}

/** Column extents of any rule/underline: [start, end) of every run of non-space. */
function runSpans(line: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push([m.index, m.index + m[0].length])
  return out
}

/** A column-span underline: one or more runs of '-'. Also every border, once normalised. */
const SPAN_UNDERLINE = /^-[ -]*$/
/** A rule drawn with '=': either the head/body separator or a stray border. */
const EQUALS_RULE = /^=[ =]*=$/

/**
 * One simple-table row. `spec` is the column layout for THIS row — normally a
 * copy of the table's columns, but a '---' underline replaces it with wider
 * runs, which is exactly how a column span is written.
 *
 * `columns` is the live table-wide layout and is deliberately mutable: the
 * rightmost column is unbounded in a simple table, so text running past the
 * rule widens it for the whole table.
 */
function parseSimpleRow(
  raw: string[],
  spec: Array<[number, number]>,
  columns: Array<[number, number]>,
): TableCell[] | null {
  const lines = [...raw]
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length === 0) return null
  const spans = spec.map((s) => [...s] as [number, number])

  for (let k = 0; k < spans.length; k++) {
    const [start, end] = spans[k]
    const nextStart = k + 1 < spans.length ? spans[k + 1][0] : Infinity
    for (const line of lines) {
      if (k === spans.length - 1) {
        if (line.slice(end).trim() === '') continue
        const newEnd = start + rstrip(line.slice(start)).length
        const last = columns[columns.length - 1]
        spans[k] = [start, Math.max(last[1], newEnd)]
        if (newEnd > last[1]) columns[columns.length - 1] = [last[0], newEnd]
      } else if (line.slice(end, nextStart).trim() !== '') {
        // Text sitting in a column margin: this is prose that happens to sit
        // under a rule, or a table we have misread. Either way, decline.
        return null
      }
    }
  }

  // Map each run of this row's spec onto whole table columns. A run that ends
  // where column i+n ends covers n+1 columns; a run that ends nowhere in
  // particular means the underline does not describe a span we can trust.
  const cells: TableCell[] = []
  let i = 0
  for (const [start, end] of spans) {
    if (i >= columns.length || start !== columns[i][0]) return null
    let colspan = 1
    while (i < columns.length && end !== columns[i][1]) {
      i++
      colspan++
    }
    if (i >= columns.length) return null
    cells.push({ text: '', colspan, rowspan: 1 })
    i++
  }
  cells.forEach((cell, k) => {
    cell.text = cellText(lines.map((l) => l.slice(spans[k][0], spans[k][1])))
  })
  return cells
}

/**
 * Simple table, following docutils' SimpleTableParser.
 *
 * Every border and the head/body rule are rewritten from '=' to '-' up front,
 * so one test ("is this line a run of dashes?") ends the current row in all
 * three cases and, for a genuine span underline, also supplies that row's
 * column layout. A row otherwise continues while its first column stays blank.
 */
function parseSimpleTable(block: string[]): ParsedTable | null {
  const top = ruleSpans(block[0])
  if (!top) return null
  // The closing rule repeats the top rule and is followed by a blank line or
  // the end of the block; anything up to there belongs to the table.
  let end = -1
  for (let i = 1; i < block.length; i++) {
    const next = block[i + 1]
    if (isSameRule(rstrip(block[i]), top) && (next === undefined || next.trim() === '')) {
      end = i
      break
    }
  }
  if (end < 1) return null

  const lines = block.slice(0, end + 1).map(rstrip)
  lines[0] = lines[0].replace(/=/g, '-')
  lines[end] = lines[end].replace(/=/g, '-')
  let headSep = -1
  for (let i = 1; i < end; i++) {
    if (!EQUALS_RULE.test(lines[i])) continue
    // An interior '=' rule that is not the table's own rule means the block is
    // not the shape we think it is — two tables run together, most likely.
    if (headSep >= 0 || !isSameRule(lines[i], top)) return null
    headSep = i
    lines[i] = lines[i].replace(/=/g, '-')
  }

  const columns = runSpans(lines[0])
  if (columns.length < 2) return null
  const [firstStart, firstEnd] = columns[0]
  const rows: Array<{ cells: TableCell[]; offset: number }> = []
  let start = 1
  let textFound = false
  for (let offset = 1; offset < lines.length; offset++) {
    const line = lines[offset]
    if (SPAN_UNDERLINE.test(line)) {
      // A border or a span underline: it closes the row above it and, when it
      // is a span underline, dictates that row's columns.
      const cells = parseSimpleRow(lines.slice(start, offset), runSpans(line), columns)
      if (cells === null && lines.slice(start, offset).some((l) => l.trim() !== '')) return null
      if (cells) rows.push({ cells, offset: start })
      start = offset + 1
      textFound = false
      continue
    }
    if (line.slice(firstStart, firstEnd).trim() !== '') {
      // First column has text, so a new row starts here and closes the last.
      if (textFound && offset !== start) {
        const cells = parseSimpleRow(lines.slice(start, offset), columns, columns)
        if (!cells) return null
        rows.push({ cells, offset: start })
      }
      start = offset
      textFound = true
      continue
    }
    if (!textFound) start = offset
  }
  if (textFound || rows.length === 0) return null

  // Rows that begin before the head/body rule are the header.
  const headerRows = headSep < 0 ? 0 : rows.findIndex((r) => r.offset > headSep)
  return {
    rows: rows.map((r, i) => ({ cells: r.cells, header: headerRows > 0 && i < headerRows })),
    consumed: end + 1,
  }
}

function parseTable(block: string[]): ParsedTable | null {
  if (block.length === 0) return null
  if (GRID_BORDER.test(block[0])) return parseGridTable(block)
  if (SIMPLE_RULE.test(block[0])) return parseSimpleTable(block)
  return null
}

const leadingSpace = (line: string): string => /^[ \t]*/.exec(line)![0]

/**
 * The lines from `start` up to `limit` that belong to a block indented by
 * `indent`.
 *
 * `limit` is what keeps `liftTables` linear. At top level `indent` is '', so
 * nothing here ever breaks and the whole remainder of the document used to be
 * copied for every candidate rule line: an ordinary reference manual with N
 * tables did N copies of O(N) lines, and 312 KB took 19 seconds on the main
 * process with no way to cancel it. Callers bound the block with the point
 * where the candidate's own syntax says its table must have ended.
 */
function collectBlock(lines: string[], start: number, indent: string, limit: number): string[] {
  const block: string[] = []
  for (let i = start; i < limit; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      block.push('')
      continue
    }
    if (indent && !line.startsWith(indent)) break
    block.push(line.slice(indent.length))
  }
  return block
}

/** A line made only of '=' runs, whatever its indent: a simple-table rule. */
const RULE_LINE = /^[ \t]*=[= \t]*$/

/**
 * Replace every table in the source with a one-word marker, returning the HTML
 * to splice back in once the rest of the document has been parsed.
 */
function liftTables(text: string): { text: string; tables: string[] } {
  const lines = text.split('\n')

  /**
   * Where every simple-table rule line sits, keyed by the line with its
   * trailing space cut. Two rules describe the same columns only if they are
   * the same string, so a table's own opening line is the key to the rules
   * that could close it.
   */
  const rules = new Map<string, number[]>()
  for (let k = 0; k < lines.length; k++) {
    if (!RULE_LINE.test(lines[k])) continue
    const key = rstrip(lines[k])
    const at = rules.get(key)
    if (at) at.push(k)
    else rules.set(key, [k])
  }

  /**
   * Does the rule line at `k` close a table — is it followed by a blank line,
   * the end of the input, or a line that dedents out of the block?
   *
   * A closing rule's own indent is necessarily the block's indent — the key
   * it shares with the opening rule has an '=' immediately after that indent —
   * so the dedent case can be settled from the rule line alone, without
   * knowing which candidate is asking.
   */
  const closes = (k: number): boolean => {
    const next = lines[k + 1]
    return next === undefined || next.trim() === '' || !next.startsWith(leadingSpace(lines[k]))
  }

  /** Index of the first rule line for `key` after `start`. */
  const ruleAfter = (at: number[], start: number): number => {
    let lo = 0
    let hi = at.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (at[mid] <= start) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * The last line a simple table opening at `start` can reach, or -1 when
   * there is no table there at all.
   *
   * It ends at the first repeat of its own rule that closes — but never later
   * than the SECOND repeat, because `parseSimpleTable` refuses a table with
   * more than one interior '=' rule (which one is the head/body split would be
   * a guess). docutils bounds its own isolate_simple_table the same way. That
   * ceiling is what keeps this linear: without it, a run of rule lines that
   * only close far away made every one of them claim the whole run.
   */
  const closingRule = (start: number): number => {
    // The candidate line matched SIMPLE_RULE, so it carries no trailing space
    // and is its own rstripped key.
    const at = rules.get(lines[start])
    if (!at) return -1
    const p = ruleAfter(at, start)
    if (p >= at.length) return -1
    if (closes(at[p])) return at[p]
    // The first repeat is interior, so a second one is the last line the table
    // can possibly end on; anything past it is refused either way.
    return p + 1 < at.length ? at[p + 1] : -1
  }

  /**
   * The block a table candidate at `start` can occupy — bounded by where its
   * own syntax says it ends, not by the end of the document.
   *
   * A grid table is the run of non-blank lines at the head of the block (its
   * borders leave no line blank), so it stops at the first blank line. A
   * simple table stops one line past its closing rule; with no closing rule
   * there is no table to find and the block is empty.
   */
  const tableBlock = (start: number, indent: string): string[] => {
    const body = lines[start].slice(indent.length)
    if (GRID_BORDER.test(body)) {
      let end = start
      while (end < lines.length && lines[end].trim() !== '') end++
      return collectBlock(lines, start, indent, end)
    }
    if (SIMPLE_RULE.test(body)) {
      const end = closingRule(start)
      return end < 0 ? [] : collectBlock(lines, start, indent, Math.min(lines.length, end + 2))
    }
    return []
  }

  const tables: string[] = []
  const out: string[] = []
  const push = (indent: string, html: string, next: string | undefined): void => {
    out.push(indent + tableToken(tables.length))
    tables.push(html)
    // The marker has to stand alone as its own paragraph, or the parser folds
    // it into the text that follows and the table lands inside a <p>.
    if (next !== undefined && next.trim() !== '') out.push('')
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const prevBlank = out.length === 0 || out[out.length - 1].trim() === ''
    if (!prevBlank || line.trim() === '') {
      out.push(line)
      i++
      continue
    }
    const indent = leadingSpace(line)
    const body = line.slice(indent.length)

    // ".. table:: caption" wraps a table in a directive. The AST renderer puts
    // directive bodies in a <pre>, so the directive is consumed here in full —
    // otherwise the table would be emitted twice, once as a table and once as
    // preformatted ASCII art.
    const directive = /^\.\.[ \t]+table::[ \t]*(.*)$/.exec(body)
    if (directive) {
      let j = i + 1
      while (j < lines.length && (lines[j].trim() === '' || /^[ \t]+:[^:\s][^:]*:/.test(lines[j]))) j++
      const inner = j < lines.length ? leadingSpace(lines[j]) : ''
      if (j < lines.length && inner.length > indent.length) {
        const parsed = parseTable(tableBlock(j, inner))
        const after = parsed ? lines[j + parsed.consumed] : undefined
        // Anything else left in the directive body means this is not a plain
        // "directive wrapping one table"; leave the whole directive alone.
        if (parsed && (after === undefined || after.trim() === '' || !after.startsWith(inner))) {
          const caption = directive[1].trim()
          const html = (caption ? `<p><strong>${inlineRst(caption)}</strong></p>` : '') + renderTable(parsed.rows)
          i = j + parsed.consumed
          push(indent, html, lines[i])
          continue
        }
      }
    }

    if (GRID_BORDER.test(body) || SIMPLE_RULE.test(body)) {
      const parsed = parseTable(tableBlock(i, indent))
      if (parsed) {
        i += parsed.consumed
        push(indent, renderTable(parsed.rows), lines[i])
        continue
      }
    }
    out.push(line)
    i++
  }
  return { text: out.join('\n'), tables }
}

export async function readRst(src: SourceInput): Promise<HubDocument> {
  const text = src.bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lifted = liftTables(text)
  let tree: RstNode
  try {
    const parser = resolveExport<{ parse(s: string): RstNode }>(await import('restructured'), 'parse')
    tree = parser.parse(lifted.text)
  } catch (err) {
    throw new ConversionError('read-failed', `Could not parse reStructuredText: ${(err as Error).message}`)
  }
  // One pass for every marker, not one pass per marker: re-scanning the whole
  // document once per table made a document with many tables quadratic in the
  // number of tables on top of its size. It also means a cell whose own text
  // spells a marker is left alone, because a replacement is never rescanned.
  const html = render(tree)
    .replace(/<p><\/p>/g, '')
    .replace(TABLE_TOKEN, (m, inParagraph: string | undefined, bare: string | undefined) => {
      const table = lifted.tables[Number(inParagraph ?? bare)]
      return table ?? m
    })
  const title = /<h1>([^<]*)<\/h1>/.exec(html)?.[1]?.trim()
  return { html, title: title || src.filename?.split(/[\\/]/).pop() }
}
