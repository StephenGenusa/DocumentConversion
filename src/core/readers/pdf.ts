import type { HubDocument, SourceInput } from '../types'
import { ConversionError } from '../errors'
import { groupIntoRows, inferColumns, inferGrid, type PositionedText } from '../grid-infer'
import { looksLikeHeader, rowsToHtmlTable } from './csv'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * pdfjs-dist >= 5 no longer ships Node polyfills for DOMMatrix / Path2D /
 * ImageData. In Electron's main process (plain Node) `getDocument()` throws
 * "DOMMatrix is not defined" without them. Text extraction never draws, so a
 * minimal stub is sufficient; if `@napi-rs/canvas` is installed we prefer its
 * real implementations.
 */
async function ensureCanvasGlobals(): Promise<void> {
  const g = globalThis as Record<string, unknown>
  if (typeof g.DOMMatrix === 'function' && typeof g.Path2D === 'function' && typeof g.ImageData === 'function') return
  try {
    const canvas = await import('@napi-rs/canvas')
    if (!g.DOMMatrix && canvas.DOMMatrix) g.DOMMatrix = canvas.DOMMatrix
    if (!g.Path2D && canvas.Path2D) g.Path2D = canvas.Path2D
    if (!g.ImageData && canvas.ImageData) g.ImageData = canvas.ImageData
  } catch {
    // fall through to stubs
  }
  if (typeof g.DOMMatrix !== 'function') {
    g.DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
      constructor(init?: number[] | string) {
        if (Array.isArray(init) && init.length >= 6) {
          ;[this.a, this.b, this.c, this.d, this.e, this.f] = init
        }
      }
    }
  }
  if (typeof g.Path2D !== 'function') {
    g.Path2D = class Path2D {}
  }
  if (typeof g.ImageData !== 'function') {
    g.ImageData = class ImageData {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    }
  }
}

/**
 * A drawn piece, plus the one thing about it geometry cannot recover.
 *
 * pdfjs does not always keep a space inside the item it belongs to. When the
 * page draws the space narrow — a negative `Tw`, tight tracking, a kern taken
 * right after it — pdfjs ends the item there and stands the space up as a
 * BLANK item of its own, whose width is however many points the space got. A
 * blank item carries no text, so it is dropped when lines are rebuilt, and all
 * that is left of the space is a gap that can be a fraction of a point wide —
 * indistinguishable, by measurement alone, from two halves of one word butted
 * together. So the fact that a space was drawn is recorded here as a fact,
 * not re-derived later from what it happened to measure.
 */
export interface PdfText extends PositionedText {
  /** The page drew whitespace immediately before this piece. */
  spaceBefore?: boolean
}

export interface PdfLine {
  text: string
  /** Baseline position; used for paragraph-gap detection. */
  y: number
  /** Glyph height; used to spot headings. */
  height: number
  /**
   * The positioned pieces this line was rebuilt from, blank runs dropped.
   * Only a PDF text layer carries geometry — OCR text arrives as plain lines,
   * so this is absent there and table detection simply does not run.
   */
  items?: PdfText[]
  /**
   * A table-of-contents entry, already rewritten as "title — page". Such a line
   * joins its neighbours as a list item, never a paragraph or a table row; see
   * `markTocEntries`.
   */
  toc?: boolean
}

/**
 * A bitmap painted on a page, already encoded for `<img src>`.
 *
 * `top` is in the same PDF-point space as `PdfLine.y`, which is what lets a
 * picture be slotted back into the text flow instead of dumped at the end of
 * the page.
 */
export interface PdfImage {
  src: string
  top: number
  /** Drawn size on the page, in PDF points. */
  width: number
  height: number
}

interface TextItemish {
  str?: string
  hasEOL?: boolean
  height?: number
  width?: number
  transform?: number[]
}

/**
 * Rebuild real lines: pdfjs marks line ends with hasEOL, which must not be
 * ignored.
 *
 * A line's geometry may only come from glyphs that line actually drew. pdfjs
 * ends a visual line with a standalone BLANK item carrying `hasEOL: true`, and
 * that marker's transform is already the origin of the line BELOW it:
 *
 *   {"s":"customer satisfaction.", "eol":false, "y":596.87, "h":10.98}
 *   {"s":"",                       "eol":true,  "y":569.93, "h":0}
 *   {"s":"Elmwood strives to …",   "eol":true,  "y":569.93, "h":10.98}
 *
 * Letting it set `y` shifted every recorded baseline down one line, so
 * `pageToBlocks` saw each paragraph gap one line early — the tail of every
 * paragraph was glued to the front of the next — and a heading's gap collapsed
 * to zero, which buried it in the prose that followed. Those blank items stay
 * in the stream (table detection needs the ones that bridge column gaps); they
 * simply no longer speak for the line.
 */
function itemsToLines(items: TextItemish[]): PdfLine[] {
  const lines: PdfLine[] = []
  let text = ''
  let y = 0
  let height = 0
  let positioned: PdfText[] = []
  // Whitespace the page drew since the last piece that carried text: either a
  // blank item of its own or the tail of the piece before. See `PdfText`.
  let pendingSpace = false
  const flush = (): void => {
    const trimmed = text.replace(/[ \t]+/g, ' ').trim()
    if (trimmed) lines.push({ text: trimmed, y, height, items: positioned })
    text = ''
    height = 0
    positioned = []
    pendingSpace = false
  }
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    text += item.str
    if (item.str.trim() !== '') {
      // transform[4] is x, transform[5] is y; width is in the same space.
      const x0 = item.transform?.[4] ?? 0
      const itemY = item.transform?.[5] ?? y
      // The first drawn glyph run fixes the line's baseline.
      if (positioned.length === 0) y = itemY
      height = Math.max(height, item.height ?? 0)
      positioned.push({
        text: item.str,
        x0,
        x1: x0 + (item.width ?? 0),
        y: itemY,
        height: item.height ?? 0,
        spaceBefore: pendingSpace || /^\s/.test(item.str),
      })
      pendingSpace = /\s$/.test(item.str)
    } else if (item.str !== '') {
      // A blank item stands for a space pdfjs took out of the text. The
      // end-of-line marker is the empty string and means nothing of the kind.
      pendingSpace = true
    }
    if (item.hasEOL) flush()
  }
  flush()
  return lines
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Letter-spaced headings: putting back the word gaps pdfjs squeezes out.
 *
 * The handbook's display headings are set with a space typed between every
 * letter and TWO between words — "T A B L E  O F  C O N T E N T S" is exactly
 * what the page draws. pdfjs collapses ANY run of whitespace glyphs to one
 * space (its `saveLastChar` pushes a single " " however many space glyphs it
 * just skipped), so `getTextContent` hands back
 *
 *   "T A B L E O F C O N T E N T S"
 *
 * with every gap identical and the word boundaries gone: you cannot tell where
 * one word ends. The same heading came back as "G E N E R A L I N F O R M A T I
 * ON" and the contents page was unreadable.
 *
 * The evidence survives one level down. `getOperatorList()` shows the glyphs as
 * they were actually shown, whitespace and all, so the double space is still
 * there to be counted.
 *
 * Counting is not enough on its own, because a wide gap reaches us two
 * different ways. "T A B L E  O F" is one text item whose glyph stream holds
 * two spaces; "G E N E R A L" and "I N F O R M A T I ON" are two items, and
 * there the extra width is the 12pt of empty page BETWEEN them, with a single
 * space in the stream. So each gap is read whichever way it presents — glyphs
 * counted inside an item, points measured across an item boundary — and each
 * reading is compared only against others of its own kind. See `gapWidth`.
 *
 * Either way the threshold is the run's OWN median, never a fixed number: a
 * heading whose letters are parted by two spaces and whose words are parted by
 * four reads the same way, at any type size. A run whose gaps are all alike (a
 * single letter-spaced word such as "I N T R O D U C T I O N") has nothing far
 * enough above its median and comes back untouched.
 */

/**
 * Four or more single-character words in a row, on their own word boundaries.
 *
 * Deliberately not sticky or global: a shared /g/ regex carries `lastIndex`
 * from one call to the next, and `matchAll` starts from whatever a preceding
 * `test` left behind.
 */
const LETTER_RUN = /(?<![^\s])(?:\S ){3,}\S(?![^\s])/

/**
 * A recovered word gap is drawn no-break so HTML cannot squeeze it away again —
 * which is the whole point, since a run of ordinary spaces collapses to one in
 * every HTML-derived target. It is as wide as the page drew it, so the heading
 * reads the way it was set.
 */
const WORD_GAP = '\u00A0'

function hasLetterRun(text: string): boolean {
  return LETTER_RUN.test(text)
}

/** Whitespace runs squeezed to one space, with each kept character's source index. */
function collapseWhitespace(raw: string): { text: string; at: number[] } {
  const out: string[] = []
  const at: number[] = []
  let inSpace = false
  for (let i = 0; i < raw.length; i++) {
    const space = /\s/.test(raw[i])
    if (space && inSpace) continue
    out.push(space ? ' ' : raw[i])
    at.push(i)
    inSpace = space
  }
  return { text: out.join(''), at }
}

interface ItemSpan {
  /** Where this item's text sits in the line, end exclusive. */
  from: number
  to: number
  x0: number
  x1: number
  /** Mean points per character; a space inside this item is worth one of these. */
  advance: number
}

/** Each drawn item located in the line it helped build, or none if it cannot be. */
function itemSpans(line: PdfLine, text: string): ItemSpan[] {
  const spans: ItemSpan[] = []
  let cursor = 0
  for (const item of line.items ?? []) {
    const piece = item.text.replace(/\s+/g, ' ').trim()
    if (piece === '') continue
    const from = text.indexOf(piece, cursor)
    if (from < 0) return []
    spans.push({
      from,
      to: from + piece.length,
      x0: item.x0,
      x1: item.x1,
      advance: (item.x1 - item.x0) / piece.length,
    })
    cursor = from + piece.length
  }
  return spans
}

interface Gap {
  /** Where the single space pdfjs left stands in the line. */
  at: number
  /** Whitespace glyphs the page really drew here. */
  spaces: number
  /** Empty page between two items, in points; 0 when the gap is inside one. */
  points: number
  /** Mean points per character either side: the fallback scale for `points`. */
  advance: number
}

/** Every gap inside one letter-spaced run, measured both ways. */
function runGaps(text: string, from: number, to: number, spans: ItemSpan[], spacesAt: (j: number) => number): Gap[] {
  const gaps: Gap[] = []
  for (let j = from; j < to; j++) {
    if (text[j] !== ' ') continue
    const inside = spans.find((span) => span.from <= j && j < span.to)
    const before = spans.filter((span) => span.to <= j).pop()
    const after = spans.find((span) => span.from > j)
    const parted = !inside && before && after
    gaps.push({
      at: j,
      spaces: spacesAt(j),
      points: parted ? after.x0 - before.x1 : 0,
      advance: parted ? Math.max(before.advance, after.advance) : (inside?.advance ?? 0),
    })
  }
  return gaps
}

/**
 * A gap has to stand this far above the run's median before it counts as a word
 * boundary. Two items of a heading rarely share an advance to the point, and a
 * quarter again is well clear of that jitter while a doubled gap is not.
 */
const WORD_GAP_RATIO = 1.25
/** A recovered gap is drawn between two and four wide: plain to see, never a chasm. */
const MIN_WORD_GAP = 2
const MAX_WORD_GAP = 4
/** Below this many item boundaries in a run there is no median to compare one against. */
const ENOUGH_BOUNDARIES = 3

/**
 * How many gaps wide this one should be drawn, or 0 to leave it alone.
 *
 * Two independent readings, because a wide gap reaches us two ways and each is
 * only meaningful against its own kind. Extra whitespace GLYPHS are counted
 * exactly and compared to the run's median count. Empty PAGE between two items
 * is measured in points and compared to the median of the run's other item
 * boundaries — or, when a run has too few boundaries to have a median (a
 * heading pdfjs broke into exactly two items), to the mean character advance,
 * which a letter's tracking never exceeds and a word gap does.
 */
function gapWidth(gap: Gap, normalSpaces: number, normalPoints: number): number {
  let wide = gap.spaces > normalSpaces ? gap.spaces : 0
  if (gap.points > 0) {
    const parted =
      normalPoints > 0
        ? gap.points > normalPoints * WORD_GAP_RATIO
          ? Math.round(gap.points / normalPoints)
          : 0
        : gap.points > gap.advance
          ? MIN_WORD_GAP
          : 0
    wide = Math.max(wide, parted)
  }
  return wide === 0 ? 0 : Math.min(MAX_WORD_GAP, Math.max(MIN_WORD_GAP, wide))
}

/**
 * A line's text with the word gaps of its letter-spaced runs restored, using
 * `glyphs` — the page's own glyph stream, whitespace intact.
 *
 * Conservative by construction: a line with no letter-spaced run, one whose
 * items cannot be located in it, or one the glyph stream cannot be aligned to
 * (pdfjs also invents spaces from advances, which have no glyph behind them)
 * comes back byte for byte.
 */
function respaceLetterRuns(line: PdfLine, glyphs: string): string {
  const text = line.text
  const runs = [...text.matchAll(new RegExp(LETTER_RUN, 'g'))]
  if (runs.length === 0) return text
  const flat = collapseWhitespace(glyphs)
  const start = flat.text.indexOf(text)
  if (start < 0) return text
  const spans = itemSpans(line, text)
  if (spans.length === 0) return text
  // The next kept character starts just past this one's whitespace run.
  const spacesAt = (j: number): number => {
    const k = start + j
    return (k + 1 < flat.at.length ? flat.at[k + 1] : glyphs.length) - flat.at[k]
  }
  const widened: { at: number; width: number }[] = []
  for (const run of runs) {
    const gaps = runGaps(text, run.index, run.index + run[0].length, spans, spacesAt)
    const normalSpaces = median(gaps.map((g) => g.spaces))
    const boundaries = gaps.map((g) => g.points).filter((points) => points > 0)
    const normalPoints = boundaries.length >= ENOUGH_BOUNDARIES ? median(boundaries) : 0
    for (const gap of gaps) {
      const width = gapWidth(gap, normalSpaces, normalPoints)
      if (width > 0) widened.push({ at: gap.at, width })
    }
  }
  // Right to left, so the indices of the edits still to come stay valid.
  let out = text
  for (const gap of widened.reverse()) {
    out = out.slice(0, gap.at) + WORD_GAP.repeat(gap.width) + out.slice(gap.at + 1)
  }
  return out
}

/** Every glyph the page showed, in order, with its whitespace intact. */
function pageGlyphText(list: OperatorList, show: Set<number>): string {
  const out: string[] = []
  for (let i = 0; i < list.fnArray.length; i++) {
    if (!show.has(list.fnArray[i])) continue
    // Tj carries the glyphs alone; TJ mixes in kerning numbers, and the
    // spacing-setting forms put the glyphs after their operands.
    const glyphs = (list.argsArray[i] ?? []).find((arg) => Array.isArray(arg))
    if (!Array.isArray(glyphs)) continue
    for (const glyph of glyphs) {
      const unicode = (glyph as { unicode?: string } | null)?.unicode
      if (typeof unicode === 'string') out.push(unicode)
    }
  }
  return out.join('')
}

/**
 * Table-of-contents leader dots.
 *
 * A contents entry is "Title ...................... 12": the dots are real text
 * in the PDF, and run through the ordinary paragraph path the whole page came
 * out as one block —
 *
 *   General Information Mission ............ 5 Company History ...... 5 Code of
 *
 * — in which every page number reads as belonging to the entry that FOLLOWS it.
 * The shape is unmistakable (text, a run of leader dots, a page number, end of
 * line), so it is matched, the dots are dropped, and the entries of a page come
 * out as one list, which is what a contents page is.
 *
 * A list rather than a two-column table for two reasons. It has to survive to
 * the CSS-less targets, and it does: "Mission — 5" on a line of its own in txt,
 * "-   Mission — 5" in md, with the dash separating title from page number
 * rather than a column rule that only HTML can draw. And a contents page is
 * navigation, not the document's data, so calling it a table would put it in
 * the same bucket as the tables a reader actually wants extracted — including
 * the count that keeps this reader honest about inventing them.
 *
 * Conservative on both sides. Four dots is already more than any ellipsis, and
 * the number has to end the line, so prose is safe; and a lone line that
 * happens to end that way (a form's "Signed ......... 2024") is not enough —
 * a contents page is a RUN of entries, so a page needs several before any of
 * them is rewritten.
 *
 * The number may carry a character or two glued to it, with no space between:
 * one handbook entry really does read "Overtime ......... 40F", a stray glyph
 * in the source that would otherwise have kept its 127 leader dots. Faithful
 * beats tidy, so the tail is kept and only the dots go.
 */
const TOC_ENTRY = /^(.+?) *\.{4,}[. ]*(\d{1,4}\S{0,2})$/
const TOC_MIN_ENTRIES = 3

function tocEntry(text: string): string | null {
  const match = TOC_ENTRY.exec(text)
  if (!match) return null
  const title = match[1].trim()
  return title === '' ? null : `${title} — ${match[2]}`
}

function markTocEntries(lines: PdfLine[]): PdfLine[] {
  const entries = lines.map((line) => tocEntry(line.text))
  if (entries.filter((entry) => entry !== null).length < TOC_MIN_ENTRIES) return lines
  return lines.map((line, i) =>
    // `items` go with the dots: a contents entry is not a table row, and its
    // three x bands would otherwise be offered to table detection as columns.
    entries[i] === null ? line : { ...line, text: entries[i]!, items: [], toc: true },
  )
}

/**
 * Running heads and folios repeat on nearly every page and would otherwise be
 * spliced into the body text at each page break. Match on a digit-insensitive
 * form so "6 | Handbook" and "7 | Handbook" count as the same line.
 */
function dropRepeatedEdges(pages: PdfLine[][]): PdfLine[][] {
  if (pages.length < 4) return pages
  const key = (line: PdfLine): string => line.text.replace(/\d+/g, '#').trim()
  const counts = new Map<string, number>()
  for (const lines of pages) {
    for (const line of [lines[0], lines[1], lines[lines.length - 2], lines[lines.length - 1]]) {
      if (!line) continue
      counts.set(key(line), (counts.get(key(line)) ?? 0) + 1)
    }
  }
  const repeated = (line: PdfLine | undefined): boolean =>
    !!line && (counts.get(key(line)) ?? 0) > pages.length / 2
  return pages.map((lines) => {
    let start = 0
    let end = lines.length
    while (start < end && repeated(lines[start])) start++
    while (end > start && repeated(lines[end - 1])) end--
    return lines.slice(start, end)
  })
}

/** Group lines into paragraphs on vertical gaps, and mark large type as headings. */
function pageToBlocks(lines: PdfLine[], bodyHeight: number): Block[] {
  if (lines.length === 0) return []
  const gaps: number[] = []
  for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y))
  const normalGap = median(gaps.filter((g) => g > 0)) || 0

  const blocks: Block[] = []
  let current: PdfLine[] = []
  const looksLikeHeading = (line: PdfLine): boolean =>
    bodyHeight > 0 && line.height > bodyHeight * 1.25 && line.text.length < 100
  // A line ending in a hyphen glued to a word continues the next one without
  // a space (the hyphen is kept: "con-tinued" is recoverable, "selfaware" is
  // not). A hyphen standing alone after a space is punctuation — "10 -" / "20"
  // — and joining it tight made "10 -20".
  const brokenWord = /[\p{L}\p{N}]-$/u
  const join = (lines: PdfLine[]): string =>
    lines.reduce(
      (acc, line, i) => (i === 0 ? line.text : brokenWord.test(acc) ? acc + line.text : `${acc} ${line.text}`),
      '',
    )
  const emit = (lines: PdfLine[], tag: 'p' | 'h2'): void => {
    if (lines.length > 0) blocks.push({ tag, text: join(lines) })
  }
  const flush = (): void => {
    if (current.length === 0) return
    const block = current
    current = []
    if (block.length === 1) {
      emit(block, looksLikeHeading(block[0]) ? 'h2' : 'p')
      return
    }
    // A heading is often set hard against the paragraph it introduces, with no
    // vertical gap to flush it into a block of its own. Its type size still
    // gives it away — and it stands taller than the body line directly beneath
    // it, which an ordinary opening line never does — so lift it out rather
    // than demanding it be alone.
    if (looksLikeHeading(block[0]) && block[0].height > block[1].height * 1.15) {
      emit([block[0]], 'h2')
      emit(block.slice(1), 'p')
      return
    }
    emit(block, 'p')
  }
  for (let i = 0; i < lines.length; i++) {
    // Contents entries never join the prose around them, and never each other:
    // they are all set at the same pitch, so no vertical gap would ever part
    // them, which is exactly how a whole contents page became one paragraph.
    if (lines[i].toc) {
      flush()
      const entries: string[] = []
      while (i < lines.length && lines[i].toc) entries.push(lines[i++].text)
      i--
      blocks.push({ tag: 'toc', entries })
      continue
    }
    if (i > 0) {
      const gap = Math.abs(lines[i - 1].y - lines[i].y)
      // A gap noticeably larger than the norm means a new paragraph.
      if (normalGap > 0 && gap > normalGap * 1.5) flush()
    }
    current.push(lines[i])
  }
  flush()
  return blocks
}

/**
 * Table detection.
 *
 * A page is not tabular or prosaic as a whole — a handbook page often carries
 * an intro paragraph, a table, and a closing note. So detection works on
 * REGIONS: runs of consecutive lines that behave like table rows, with the
 * lines around them left to the ordinary paragraph path.
 *
 * The evidence a line is a table row is a horizontal gap inside it far wider
 * than a word space. pdfjs helpfully bridges such gaps with a synthetic blank
 * item whose `width` spans the whole gap, so the gap is only visible once the
 * blanks are dropped — hence `PdfLine.items` holds no blank runs.
 */

/** A gap this many line-heights wide separates cells, not words. */
const CELL_GAP_RATIO = 0.9
const TABLE_MIN_ROWS = 3
/** Real PDFs jitter a fraction of a point around each column origin. */
const TABLE_COLUMN_TOLERANCE = 3.5
/**
 * Deliberately above the shared 0.6 default: a false table is worse than a
 * missed one, because it shreds running prose into cells.
 *
 * The threshold is unchanged, and lowering it is still the wrong lever: at
 * 0.60 the 70-page prose handbook grew 3 false tables for 28 extra rows. What
 * WAS wrong is what the score was computed over. A wrapped cell is a visual
 * line with one column filled; on a dense spreadsheet print 62% of rows wrap
 * (2.08 visual lines per row), so a real table scored about 0.48 on its own
 * geometry and was thrown away whole. Scoring the folded
 * ROWS instead (`foldContinuationRows`), letting a region span a cell that
 * wraps more than once, and re-splitting cells along the region's own column
 * origins are all recall without any loosening of the bar to START a region.
 *
 * Measured on a 20-page spreadsheet print of a 409-row product listing (409 data
 * rows; see tests/core/pdf-table-recall.test.ts, which rebuilds it — the
 * owner's own print is not in the corpus) against the prose handbook:
 * before, 144 rows in 28 table fragments with 0 false tables; after, 408 rows
 * in 20 tables, one per printed page, still with 0 false tables.
 */
const TABLE_MIN_CONFIDENCE = 0.75

/**
 * Bullets and enumerators sit in their own x band, which makes every bulleted
 * list look like a two-column table. A column made of markers is the giveaway,
 * and it disqualifies the whole region.
 */
const LIST_MARKER = /^(?:[^\p{L}\p{N}]{1,2}|[oO]|\d{1,2}[.)]|[A-Za-z][.)])$/u

/**
 * A MAJORITY, not all of them.
 *
 * Requiring every cell to be a bare marker was enough while a region could not
 * grow across more than one wrapped line. Once it can, the handbook's nested
 * FML leave list joins into one region: thirteen of its sixteen first-column
 * cells are a bare "o", but the other three are a "•" that pdfjs handed back
 * glued to the first word of its own line ("• Birthof"), and three impostors
 * were enough to let a page of prose through as a table. Two-thirds is well
 * above what a real table's column produces — catalogue codes, part numbers
 * and dates are none of them list markers — and well below a bulleted list's.
 */
const MARKER_COLUMN_SHARE = 0.6

function isMarkerColumn(cells: string[]): boolean {
  const filled = cells.filter((c) => c !== '')
  if (filled.length === 0) return false
  const markers = filled.filter((c) => LIST_MARKER.test(c)).length
  return markers / filled.length >= MARKER_COLUMN_SHARE
}

/** The non-blank pieces of a line, left to right. */
function lineItems(line: PdfLine): PdfText[] {
  return (line.items ?? []).filter((i) => i.text.trim() !== '').sort((a, b) => a.x0 - b.x0)
}

/**
 * Recover a cell boundary that pdfjs erased.
 *
 * When two cells are separated by only a few points, pdfjs does not emit the
 * synthetic blank item it uses for wider gaps — it hands back ONE item, e.g.
 * `"Adhesive, caulk, sealer and joint compound 03" x=139 w=230.2`, and the
 * geometry of the boundary is gone with it. Glyph positions inside an item are
 * not exposed, so the split point is estimated from the mean advance
 * (width / characters) and only ever taken at a space: for the item above the
 * estimate puts the last space at x=359 against a column origin of 357, 2pt
 * out over 45 characters. `slack` bounds that error; a long cell that merely
 * overflows its column has no space near the origin and is left alone.
 */
function splitItemAtBoundaries(item: PdfText, boundaries: number[], height: number): PdfText[] {
  const width = item.x1 - item.x0
  if (width <= 0 || item.text.length === 0) return [item]
  const advance = width / item.text.length
  const slack = Math.max(height * 0.5, advance * 3)
  for (const boundary of boundaries) {
    if (boundary <= item.x0 + TABLE_COLUMN_TOLERANCE || boundary >= item.x1 - TABLE_COLUMN_TOLERANCE) continue
    let at = -1
    let distance = Infinity
    for (let k = 0; k < item.text.length; k++) {
      if (item.text[k] !== ' ') continue
      // The cell starts at the character after the space.
      const d = Math.abs(item.x0 + advance * (k + 1) - boundary)
      if (d < distance) {
        distance = d
        at = k
      }
    }
    if (at < 0 || distance > slack) continue
    const left = item.text.slice(0, at).trim()
    const right = item.text.slice(at + 1).trim()
    if (left === '' || right === '') continue
    return [
      { ...item, text: left, x1: item.x0 + advance * at },
      // Snap to the origin: the column is where the evidence says it is. The
      // cut was taken AT a space, so that space is what parted the two halves —
      // if they turn out to belong to one cell after all, it goes back between.
      ...splitItemAtBoundaries({ ...item, text: right, x0: boundary, spaceBefore: true }, boundaries, height),
    ]
  }
  return [item]
}

/**
 * Split a line into cell-sized segments: item runs with no wide gap between
 * them.
 *
 * `boundaries` is the second pass. `CELL_GAP_RATIO` cannot be lowered without
 * letting a stretched word space in justified prose pass for a column, but a
 * dense spreadsheet print routinely parks the next column 5-8pt after a cell
 * that fills its width — inside the 0.9-line-height gap — and the two cells
 * then read as one. Once the region's column origins are known (they are: the
 * rows that do NOT fill their cells show them plainly), a piece that starts on
 * an origin its segment began left of starts a new cell whatever the gap. This
 * only ever runs inside a region that already qualified as a table, so it
 * cannot manufacture a column in prose.
 */
function lineSegments(items: PdfText[], lineHeight: number, boundaries: number[] = []): PdfText[] {
  if (items.length === 0) return []
  const height = Math.max(...items.map((i) => i.height ?? 0), lineHeight, 1)
  const cellGap = height * CELL_GAP_RATIO
  const pieces =
    boundaries.length === 0 ? items : items.flatMap((i) => splitItemAtBoundaries(i, boundaries, height))
  const segments: PdfText[] = []
  let current: PdfText | null = null
  for (const item of pieces) {
    const gap = current ? item.x0 - current.x1 : 0
    const startsColumn =
      current !== null &&
      // A touching item is the rest of a word, never the start of a cell.
      gap > 1 &&
      boundaries.some(
        (b) => Math.abs(item.x0 - b) <= TABLE_COLUMN_TOLERANCE && current!.x0 < b - TABLE_COLUMN_TOLERANCE,
      )
    if (current && (gap > cellGap || startsColumn)) {
      segments.push(current)
      current = null
    }
    if (!current) {
      current = { ...item }
      continue
    }
    // Rejoin the way the glyphs sat. A space between two pieces reaches us two
    // ways and BOTH have to be honoured: as empty page, when the items were set
    // apart, and as `spaceBefore`, when the page drew the space too narrow for
    // that — see `PdfText`. Trimming the pieces here is what used to throw the
    // second kind away and hand back "CodeNumber".
    current.text += (gap > 0.5 || item.spaceBefore ? ' ' : '') + item.text
    current.x1 = Math.max(current.x1, item.x1)
    current.height = Math.max(current.height ?? 0, item.height ?? 0)
  }
  if (current) segments.push(current)
  return segments.map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() })).filter((s) => s.text !== '')
}

interface TableRegion {
  /** Line index range this table occupies, end exclusive. */
  start: number
  end: number
  rows: string[][]
}

const GRID_OPTIONS = {
  // PDF space grows upward, so the first row carries the LARGEST y.
  yIncreasesDownward: false,
  minRows: TABLE_MIN_ROWS,
  minColumns: 2,
  columnTolerance: TABLE_COLUMN_TOLERANCE,
  minConfidence: TABLE_MIN_CONFIDENCE,
  // Judge the table by its ROWS, not by its visual lines: a wrapped cell is
  // folded back into the row above before the confidence is scored.
  foldContinuationRows: true,
}

function buildRegion(items: PositionedText[][], heights: number[], start: number, end: number): TableRegion | null {
  if (end - start < TABLE_MIN_ROWS) return null
  const segments = items.map((line, i) => lineSegments(line, heights[i]))
  const first = inferGrid(segments.flat(), GRID_OPTIONS)
  if (!first) return null
  // Now that the region has qualified, re-split its lines along the column
  // origins it revealed; see `lineSegments`. Extra evidence only, so the
  // second pass can add columns but never rescue a layout the first refused.
  const origins = inferColumns(groupIntoRows(segments.flat(), false), TABLE_COLUMN_TOLERANCE)
  const resplit = items.map((line, i) => lineSegments(line, heights[i], origins))
  const grid = inferGrid(resplit.flat(), GRID_OPTIONS) ?? first
  for (let c = 0; c < grid.columns; c++) {
    if (isMarkerColumn(grid.rows.map((row) => row[c] ?? ''))) return null
  }
  if (grid.rows.length < TABLE_MIN_ROWS) return null
  return { start, end, rows: grid.rows }
}

/** Non-overlapping tabular runs on one page, in reading order. */
function findTableRegions(lines: PdfLine[]): TableRegion[] {
  const items = lines.map(lineItems)
  const heights = lines.map((line) => line.height)
  const segments = items.map((line, i) => lineSegments(line, heights[i]))
  const tabular = segments.map((s) => s.length >= 2)
  const regions: TableRegion[] = []
  let i = 0
  while (i < lines.length) {
    if (!tabular[i]) {
      i++
      continue
    }
    let end = i + 1
    let leftEdge = Math.min(...segments[i].map((s) => s.x0))
    while (end < lines.length) {
      if (tabular[end]) {
        leftEdge = Math.min(leftEdge, ...segments[end].map((s) => s.x0))
        end++
        continue
      }
      // Wrapped cells: single-segment lines indented past the first column. A
      // dense print wraps a cell onto two or three lines, so consume the whole
      // run, not one line of it — stopping after the first used to end the
      // region and drop every row of the table below it. A table row has to
      // follow, unless the page itself ends: the tail of the last row is still
      // part of the table.
      let look = end
      while (
        look < lines.length &&
        segments[look].length === 1 &&
        segments[look][0].x0 > leftEdge + TABLE_COLUMN_TOLERANCE
      ) {
        look++
      }
      if (look > end && (look >= lines.length || tabular[look])) {
        end = look
        continue
      }
      break
    }
    const region = buildRegion(items.slice(i, end), heights.slice(i, end), i, end)
    if (region) regions.push(region)
    i = Math.max(end, i + 1)
  }
  return regions
}

type TextBlock = { tag: 'p' | 'h2'; text: string }

type Block =
  | TextBlock
  | { tag: 'table'; rows: string[][] }
  | { tag: 'img'; image: PdfImage }
  | { tag: 'toc'; entries: string[] }

/** One page: tables where the geometry proves them, paragraphs everywhere else. */
function pageToText(lines: PdfLine[], bodyHeight: number): Block[] {
  const regions = findTableRegions(lines)
  if (regions.length === 0) return pageToBlocks(lines, bodyHeight)
  const blocks: Block[] = []
  let cursor = 0
  for (const region of regions) {
    if (region.start > cursor) blocks.push(...pageToBlocks(lines.slice(cursor, region.start), bodyHeight))
    blocks.push({ tag: 'table', rows: region.rows })
    cursor = region.end
  }
  if (cursor < lines.length) blocks.push(...pageToBlocks(lines.slice(cursor), bodyHeight))
  return blocks
}

/**
 * One page, pictures included, in reading order.
 *
 * A picture divides the page's lines the way a paragraph break does: PDF space
 * grows upward, so every line whose baseline is above the picture's top edge
 * belongs before it and the rest after. Cutting the line run at that point
 * (rather than slotting the picture between finished paragraphs) matters
 * because two lines separated by a picture are not one paragraph, and on a
 * sparse page the gap between them is the only gap there is — nothing else
 * would tell them apart. The cut is by position in the run, never by sorting,
 * so reading order survives a page whose lines are not in y order.
 */
function pageToContent(page: PdfLine[], bodyHeight: number, images: PdfImage[] = []): Block[] {
  // Whether this page is a contents page is a judgement about the whole page,
  // so it is made once, here, before the page is cut up by pictures or tables.
  const lines = markTocEntries(page)
  if (images.length === 0) return pageToText(lines, bodyHeight)
  const blocks: Block[] = []
  let rest = lines
  for (const image of [...images].sort((a, b) => b.top - a.top)) {
    const cut = rest.findIndex((line) => line.y < image.top)
    const at = cut < 0 ? rest.length : cut
    blocks.push(...pageToText(rest.slice(0, at), bodyHeight))
    blocks.push({ tag: 'img', image })
    rest = rest.slice(at)
  }
  blocks.push(...pageToText(rest, bodyHeight))
  return blocks
}

/**
 * A picture is wrapped in a <p>: html-to-docx embeds an <img> twice whenever
 * the tag is not a direct child of a <p> or <li> (see writers/docx.ts). The
 * width attribute carries the size the picture was DRAWN at — a logo scaled
 * down to 215pt in the PDF is 652px of bitmap, and without it every such image
 * comes back three times its intended size.
 */
function imageToHtml(image: PdfImage): string {
  // PDF points are 1/72in and CSS pixels 1/96in.
  const width = Math.max(1, Math.round((image.width * 96) / 72))
  return `<p><img src="${image.src}" alt="image from pdf" width="${width}"></p>`
}

function blockToHtml(block: Block): string {
  if (block.tag === 'img') return imageToHtml(block.image)
  if (block.tag === 'table') return rowsToHtmlTable(block.rows, looksLikeHeader(block.rows))
  if (block.tag === 'toc') {
    return `<ul>${block.entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>`
  }
  return `<${block.tag}>${escapeHtml(block.text)}</${block.tag}>`
}

/**
 * Image extraction.
 *
 * `getTextContent()` cannot see a bitmap, so every picture in every PDF used to
 * be dropped in silence. `getOperatorList()` does see them: each paint operator
 * names an object in `page.objs`, and the transform in force at that point maps
 * the unit square onto the rectangle the picture was drawn into — which is both
 * its size on the page and its position, and so where it belongs in the text.
 *
 * Decoded pixels, not the embedded stream: pdfjs hands back raw RGB/RGBA (or
 * packed 1bpp) with the colour space already applied, which is why a CMYK JPEG
 * or an indexed PNG comes out right. Anything else — a stencil mask, an inline
 * image, an object that never resolved — is skipped rather than guessed at.
 */

/** ImageKind, from pdfjs; not re-exported by the legacy build's types. */
const GRAYSCALE_1BPP = 1
const RGB_24BPP = 2
const RGBA_32BPP = 3

/**
 * Cap on the stored bitmap's longest side.
 *
 * The handbook's eleven exhibit scans are 1700x2200 apiece: carried at full
 * size they are 85MB of raw pixels and roughly 9MB of base64 in a document
 * whose text is 180KB. 1400px still comfortably out-resolves the ~500pt the
 * scans are drawn at.
 */
const MAX_IMAGE_SIDE = 1400
const JPEG_QUALITY = 80

/** A picture smaller than this on the page is a rule, a bullet or a hairline. */
const MIN_IMAGE_POINTS = 8

interface ImageObject {
  width?: number
  height?: number
  kind?: number
  data?: Uint8Array | Uint8ClampedArray
}

/** a x b, both as PDF's [a b c d e f]. */
function multiply(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

interface Bitmap {
  rgba: Uint8ClampedArray
  /** Only an RGBA source can carry any; the others are opaque by construction. */
  hasAlpha: boolean
}

/**
 * Straight to RGBA, the way pdfjs's own canvas backend does it.
 *
 * A page-sized scan is 11 million pixels, and a dozen of them go through here
 * on one handbook — so the RGB case fills a 32-bit view a pixel at a time
 * rather than writing four bytes, which is the same trick pdfjs uses and the
 * difference between a second of work and several.
 */
function toRgba(obj: ImageObject): Bitmap | null {
  const { width = 0, height = 0, kind, data } = obj
  if (!data || width <= 0 || height <= 0) return null
  const pixels = width * height
  const rgba = new Uint8ClampedArray(pixels * 4)
  if (kind === RGBA_32BPP) {
    if (data.length < pixels * 4) return null
    rgba.set(data.subarray(0, rgba.length))
    let hasAlpha = false
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] !== 255) {
        hasAlpha = true
        break
      }
    }
    return { rgba, hasAlpha }
  }
  if (kind === RGB_24BPP) {
    if (data.length < pixels * 3) return null
    if (LITTLE_ENDIAN) {
      const out = new Uint32Array(rgba.buffer)
      for (let p = 0, s = 0; p < pixels; p++, s += 3) {
        out[p] = 0xff000000 | data[s] | (data[s + 1] << 8) | (data[s + 2] << 16)
      }
    } else {
      for (let s = 0, d = 0; d < rgba.length; s += 3, d += 4) {
        rgba[d] = data[s]
        rgba[d + 1] = data[s + 1]
        rgba[d + 2] = data[s + 2]
        rgba[d + 3] = 255
      }
    }
    return { rgba, hasAlpha: false }
  }
  // Rows are byte aligned and a set bit is white, as pdfjs decodes it.
  if (kind === GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3
    if (data.length < rowBytes * height) return null
    for (let row = 0; row < height; row++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[row * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const d = (row * width + x) * 4
        rgba[d] = rgba[d + 1] = rgba[d + 2] = bit ? 255 : 0
        rgba[d + 3] = 255
      }
    }
    return { rgba, hasAlpha: false }
  }
  return null
}

/** PNG when the picture has real transparency, JPEG otherwise: photos and scans. */
async function encodeImage(obj: ImageObject, cache: Map<string, string>): Promise<string | null> {
  const bitmap = toRgba(obj)
  if (!bitmap) return null
  const width = obj.width ?? 0
  const height = obj.height ?? 0
  const { createHash } = await import('node:crypto')
  const key = createHash('sha1').update(bitmap.rgba).digest('hex')
  const seen = cache.get(key)
  if (seen) return seen
  let canvas: typeof import('@napi-rs/canvas')
  try {
    canvas = await import('@napi-rs/canvas')
  } catch {
    return null
  }
  const full = canvas.createCanvas(width, height)
  full.getContext('2d').putImageData(new canvas.ImageData(bitmap.rgba, width, height), 0, 0)

  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height))
  let out = full
  if (scale < 1) {
    out = canvas.createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
    out.getContext('2d').drawImage(full, 0, 0, out.width, out.height)
  }
  const mime = bitmap.hasAlpha ? 'image/png' : 'image/jpeg'
  const bytes = bitmap.hasAlpha ? out.toBuffer('image/png') : out.toBuffer('image/jpeg', JPEG_QUALITY)
  const src = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
  cache.set(key, src)
  return src
}

interface PageWithObjs {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
  objs: { get(id: string, callback: (obj: unknown) => void): void }
}

/**
 * pdfjs resolves an image object asynchronously even after the operator list
 * has arrived, so the callback form is the only reliable one — and a timeout
 * keeps an object that never resolves from hanging the whole conversion.
 */
function resolveObject(page: PageWithObjs, id: string): Promise<ImageObject | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (obj: ImageObject | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(obj)
    }
    const timer = setTimeout(() => finish(null), 10_000)
    try {
      page.objs.get(id, (obj) => finish((obj ?? null) as ImageObject | null))
    } catch {
      finish(null)
    }
  })
}

interface PageOps {
  paint: Set<number>
  /** The text-showing operators, whose glyph arrays keep their whitespace. */
  show: Set<number>
  save: number
  restore: number
  transform: number
}

type OperatorList = { fnArray: number[]; argsArray: unknown[][] }

/**
 * `cache` spans the whole document, keyed by the pixels themselves: pdfjs names
 * an image object per page (`img_p6_1`), so a logo repeated on every page of a
 * seventy-page handbook would otherwise be encoded and base64'd seventy times.
 */
async function extractPageImages(
  page: PageWithObjs,
  list: OperatorList,
  ops: PageOps,
  cache: Map<string, string>,
): Promise<PdfImage[]> {
  const images: PdfImage[] = []
  const stack: number[][] = []
  let ctm = [1, 0, 0, 1, 0, 0]
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i]
    if (fn === ops.save) stack.push(ctm.slice())
    else if (fn === ops.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
    else if (fn === ops.transform) ctm = multiply(ctm, list.argsArray[i] as number[])
    else if (ops.paint.has(fn)) {
      const id = list.argsArray[i]?.[0]
      // The matrix maps the unit square onto the drawn rectangle, so the size
      // is the span of its transformed corners and the top edge their highest
      // y — which stays right for a rotated or flipped placement.
      const width = Math.abs(ctm[0]) + Math.abs(ctm[2])
      const height = Math.abs(ctm[1]) + Math.abs(ctm[3])
      if (typeof id !== 'string' || width < MIN_IMAGE_POINTS || height < MIN_IMAGE_POINTS) continue
      const obj = await resolveObject(page, id)
      const src = obj ? await encodeImage(obj, cache) : null
      const top = ctm[5] + Math.max(0, ctm[1]) + Math.max(0, ctm[3])
      if (src) images.push({ src, top, width, height })
    }
  }
  return images
}

/** Per-page text, with '' for pages that have no text layer (used by the OCR merge). */
export async function extractPdfPageTexts(src: SourceInput): Promise<string[]> {
  const pages = await extractPdfLines(src)
  return pages.map((lines) => lines.map((l) => l.text).join('\n'))
}

/**
 * Per-page lines WITH their geometry, empty for a page that has no text layer.
 *
 * The OCR merge needs this rather than `extractPdfPageTexts`: flattening a
 * native page to a string throws away the x/y that table detection runs on, so
 * a document that took the merge path lost every table on its native pages too.
 */
export async function extractPdfPageLines(src: SourceInput): Promise<PdfLine[][]> {
  return extractPdfLines(src)
}

interface PdfPage {
  lines: PdfLine[]
  images: PdfImage[]
}

async function extractPdfPages(src: SourceInput, withImages: boolean): Promise<PdfPage[]> {
  await ensureCanvasGlobals()
  const { loadPdfjs } = await import('../pdfjs-loader')
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(src.bytes),
    // Keep decoded bitmaps as plain typed arrays; an ImageBitmap is unreadable
    // outside a browser, and `page.objs` is where the pixels have to come from.
    isOffscreenCanvasSupported: false,
  }).promise
  const OPS = pdfjs.OPS as unknown as Record<string, number>
  const ops: PageOps = {
    paint: new Set([OPS.paintImageXObject, OPS.paintJpegXObject].filter((n) => typeof n === 'number')),
    show: new Set([OPS.showText, OPS.showSpacedText].filter((n) => typeof n === 'number')),
    save: OPS.save,
    restore: OPS.restore,
    transform: OPS.transform,
  }
  const pages: PdfPage[] = []
  const imageCache = new Map<string, string>()
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let lines = itemsToLines(content.items as TextItemish[])
      // The operator list is the only place the word gaps of a letter-spaced
      // heading survive, and it is expensive, so it is read when a picture is
      // wanted anyway or when a page actually holds such a heading — which is
      // three pages in seventy on the handbook and none at all in most PDFs.
      const spaced = lines.some((line) => hasLetterRun(line.text))
      // A content stream pdfjs cannot build an operator list for must not fail
      // a conversion that getTextContent() alone would have completed: the
      // text is already in hand, only the pictures and re-spacing are lost.
      const list =
        withImages || spaced
          ? await (page as unknown as PageWithObjs).getOperatorList().catch(() => null)
          : null
      if (list && spaced) {
        const glyphs = pageGlyphText(list, ops.show)
        lines = lines.map((line) => ({ ...line, text: respaceLetterRuns(line, glyphs) }))
      }
      const images =
        withImages && list ? await extractPageImages(page as unknown as PageWithObjs, list, ops, imageCache) : []
      pages.push({ lines, images })
      page.cleanup()
    }
  } finally {
    await doc.cleanup()
  }
  return pages
}

async function extractPdfLines(src: SourceInput): Promise<PdfLine[][]> {
  return (await extractPdfPages(src, false)).map((page) => page.lines)
}

/** Plain text as lines with no geometry: table detection cannot run on these. */
function textToLines(text: string): PdfLine[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => ({ text: line, y: -i, height: 0 }))
}

/**
 * What one page of a document contributes.
 *
 * A mixed PDF has pages of different KINDS — some with a text layer whose
 * geometry proves its tables, some recovered by OCR as a grid, some recovered
 * only as text — and each must contribute its best representation. Modelling
 * that per page (rather than flattening the document to one array of strings)
 * is what keeps a scanned table inside an otherwise-native PDF a table.
 */
export type PdfPageSource =
  | { kind: 'lines'; lines: PdfLine[]; images?: PdfImage[] }
  | { kind: 'text'; text: string }
  | { kind: 'table'; rows: string[][] }

/** Build hub HTML from per-page plain text (also used for OCR output). */
export function pdfTextToHub(pageTexts: string[]): HubDocument {
  return pdfPagesToHub(pageTexts.map((text) => ({ kind: 'text', text })))
}

/**
 * Build hub HTML from pages of mixed provenance, in page order.
 *
 * Running-head removal and the body type size are document-wide judgements, so
 * they are made here over every page that has lines; a page that arrives as a
 * finished grid has no lines to judge and passes straight through.
 */
export function pdfPagesToHub(sources: PdfPageSource[]): HubDocument {
  const linePages = dropRepeatedEdges(
    sources.map((page) =>
      page.kind === 'lines' ? page.lines : page.kind === 'text' ? textToLines(page.text) : [],
    ),
  )
  const heights = linePages.flat().map((l) => l.height).filter((h) => h > 0)
  const bodyHeight = median(heights)
  const html = sources
    .map((page, i) =>
      page.kind === 'table'
        ? rowsToHtmlTable(page.rows, looksLikeHeader(page.rows))
        : pageToContent(linePages[i], bodyHeight, page.kind === 'lines' ? page.images : [])
            .map(blockToHtml)
            .join('\n'),
    )
    .filter((part) => part !== '')
    .join('\n')
  return { html }
}

export async function readPdf(src: SourceInput): Promise<HubDocument> {
  const pages = await extractPdfPages(src, true)
  if (pages.every((page) => page.lines.length === 0)) {
    throw new ConversionError(
      'scanned-pdf',
      'No extractable text found (this PDF looks scanned). Convert again with OCR to read it.',
    )
  }
  return pdfPagesToHub(pages.map(({ lines, images }) => ({ kind: 'lines', lines, images })))
}
