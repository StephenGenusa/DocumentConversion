/**
 * Infer a table grid from positioned text.
 *
 * Two very different sources produce the same shape of evidence: pdfjs gives
 * every text item a transform matrix (x, y) and a width, and tesseract gives
 * every recognized word a bounding box. Neither knows anything about tables —
 * but a table betrays itself geometrically: rows share a baseline, and columns
 * start at the same x down the page.
 *
 * This module turns those items into rows and columns, or declines. Declining
 * matters as much as succeeding: ordinary two-column prose looks table-ish at
 * a glance, and a false positive would shred running text into cells.
 */

export interface PositionedText {
  text: string
  /** Left edge. */
  x0: number
  /** Right edge. */
  x1: number
  /** Vertical midpoint. Direction does not matter; see `yIncreasesDownward`. */
  y: number
  /** Line height, used to size the row-grouping tolerance. */
  height?: number
}

export interface GridOptions {
  /** PDF y grows upward, OCR y grows downward. Affects row ORDER only. */
  yIncreasesDownward?: boolean
  minRows?: number
  minColumns?: number
  /** Column origins within this distance are the same column. */
  columnTolerance?: number
  /** Below this, the layout is treated as prose and rejected. */
  minConfidence?: number
  /**
   * Fold a visual row whose first column is empty into the row above BEFORE
   * scoring — see `foldContinuations`. Off by default because a source whose
   * items are whole lines (OCR words are not) can present a genuinely blank
   * leading cell; the PDF reader, which sees per-line geometry, turns it on.
   */
  foldContinuationRows?: boolean
}

export interface InferredGrid {
  rows: string[][]
  /** 0..1 — how table-like the layout is; see `scoreGrid`. */
  confidence: number
  columns: number
}

const DEFAULTS = {
  yIncreasesDownward: true,
  minRows: 3,
  minColumns: 2,
  columnTolerance: 2.5,
  minConfidence: 0.6,
  foldContinuationRows: false,
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Group items into visual lines by vertical proximity. */
export function groupIntoRows(items: PositionedText[], yIncreasesDownward: boolean): PositionedText[][] {
  if (items.length === 0) return []
  const heights = items.map((i) => i.height ?? 0).filter((h) => h > 0)
  // Half a line height is generous enough for sub/superscripts and OCR jitter,
  // tight enough not to merge adjacent rows.
  const tolerance = (median(heights) || estimateLineHeight(items)) * 0.5
  const sorted = [...items].sort((a, b) => a.y - b.y)
  const rows: PositionedText[][] = []
  let current: PositionedText[] = []
  let anchor = sorted[0].y
  for (const item of sorted) {
    if (current.length > 0 && Math.abs(item.y - anchor) > tolerance) {
      rows.push(current)
      current = []
      anchor = item.y
    }
    if (current.length === 0) anchor = item.y
    current.push(item)
  }
  if (current.length > 0) rows.push(current)
  for (const row of rows) row.sort((a, b) => a.x0 - b.x0)
  // Sorting by y ascending gives top-to-bottom only when y grows downward.
  return yIncreasesDownward ? rows : rows.reverse()
}

/** Fallback when items carry no height: use the gaps between distinct y values. */
function estimateLineHeight(items: PositionedText[]): number {
  const ys = [...new Set(items.map((i) => i.y))].sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < ys.length; i++) gaps.push(ys[i] - ys[i - 1])
  return median(gaps.filter((g) => g > 0)) || 10
}

/** Cluster the left edges seen across rows into column origins. */
export function inferColumns(rows: PositionedText[][], tolerance: number): number[] {
  const origins = rows.flatMap((row) => row.map((item) => item.x0)).sort((a, b) => a - b)
  if (origins.length === 0) return []
  const clusters: { center: number; count: number }[] = []
  for (const x of origins) {
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(x - last.center) <= tolerance) {
      // Running mean keeps the centre stable as members accumulate.
      last.center = (last.center * last.count + x) / (last.count + 1)
      last.count++
      continue
    }
    clusters.push({ center: x, count: 1 })
  }
  // A column that appears on only one row is a stray, not a column.
  const minMembers = Math.max(2, Math.ceil(rows.length * 0.25))
  return clusters.filter((c) => c.count >= minMembers).map((c) => c.center)
}

function assign(rows: PositionedText[][], columns: number[], tolerance: number): string[][] {
  return rows.map((row) => {
    const cells: string[][] = columns.map(() => [])
    for (const item of row) {
      // Nearest column origin at or left of the item, else the closest one.
      let index = 0
      let best = Infinity
      for (let c = 0; c < columns.length; c++) {
        const distance = item.x0 - columns[c]
        const score = distance >= -tolerance ? distance : Math.abs(distance) * 4
        if (score < best) {
          best = score
          index = c
        }
      }
      cells[index].push(item.text)
    }
    return cells.map((parts) => parts.join(' ').replace(/\s+/g, ' ').trim())
  })
}

/**
 * How table-like the result is: the share of rows that actually populate more
 * than one column. Prose scores low because every line lands in column one.
 */
export function scoreGrid(grid: string[][]): number {
  if (grid.length === 0) return 0
  const multi = grid.filter((row) => row.filter((cell) => cell !== '').length >= 2).length
  return multi / grid.length
}

/**
 * Fold wrapped cells back into the row they belong to.
 *
 * A cell whose text is too long for its column wraps onto a second visual
 * line, and that line has nothing in the first column — it is the tail of the
 * row above, not a row of its own. Folding matters twice over: the text ends
 * up in the right cell, and, because folding happens BEFORE scoring, the
 * half-empty visual rows stop dragging the confidence down. Measured on a
 * catalogue-code spreadsheet print where 62% of rows wrap: the raw score is
 * about 0.48 and the whole table is discarded; folded it is 1.0.
 *
 * Prose is untouched by this: every line of a paragraph starts at the left
 * margin, so its first column is never the empty one.
 */
export function foldContinuations(grid: string[][]): string[][] {
  const folded: string[][] = []
  for (const row of grid) {
    const previous = folded[folded.length - 1]
    if (previous && (row[0] ?? '') === '' && row.some((cell) => cell !== '')) {
      row.forEach((cell, c) => {
        if (cell === '') return
        previous[c] = previous[c] ? `${previous[c]} ${cell}` : cell
      })
      continue
    }
    folded.push([...row])
  }
  return folded
}

export function inferGrid(items: PositionedText[], options: GridOptions = {}): InferredGrid | null {
  const opts = { ...DEFAULTS, ...options }
  const usable = items.filter((i) => i.text.trim() !== '')
  if (usable.length === 0) return null

  const rows = groupIntoRows(usable, opts.yIncreasesDownward)
  if (rows.length < opts.minRows) return null

  const columns = inferColumns(rows, opts.columnTolerance)
  if (columns.length < opts.minColumns) return null

  const grid = opts.foldContinuationRows
    ? foldContinuations(assign(rows, columns, opts.columnTolerance))
    : assign(rows, columns, opts.columnTolerance)
  // Folding can take a run of visual rows below the row minimum; a table that
  // is only three lines tall because two of them wrapped is not three rows.
  if (grid.length < opts.minRows) return null
  const confidence = scoreGrid(grid)
  if (confidence < opts.minConfidence) return null

  // Drop trailing columns that ended up entirely empty.
  let width = columns.length
  while (width > 0 && grid.every((row) => (row[width - 1] ?? '') === '')) width--
  if (width < opts.minColumns) return null

  return {
    rows: grid.map((row) => row.slice(0, width)),
    confidence,
    columns: width,
  }
}
