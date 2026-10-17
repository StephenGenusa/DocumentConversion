import { tableGrid } from './table-grid'
import type { PdfPageSize } from './types'

/** Printable width in characters at the shell's ~11pt body font, per page size. */
const PORTRAIT_COLUMNS: Record<PdfPageSize, number> = {
  Letter: 95,
  A4: 92,
  Legal: 95,
  A3: 132,
  Tabloid: 128,
}
const LANDSCAPE_RATIO: Record<PdfPageSize, number> = {
  Letter: 1.29,
  A4: 1.41,
  Legal: 1.65,
  A3: 1.41,
  Tabloid: 1.55,
}

export interface PageFitAdvice {
  /** True when the widest table needs more width than portrait can give. */
  recommendLandscape: boolean
  /**
   * False when no page this app offers is wide enough, in any orientation.
   *
   * This is a different answer from "turn the page sideways", and the user has
   * to hear it: a sheet of 24-47 narrow columns under the shell's fixed table
   * layout wraps every cell to a character or two and runs to thousands of
   * pages (a 12k-row workbook of narrow columns makes 19,511 of them) with no hint as
   * to why. There is no page setup to recommend in that case — only a target
   * format that has no page width at all.
   */
  fitsAnyPage: boolean
  /** The smallest page setup that fits, when the current one does not. */
  suggestion?: { pageSize: PdfPageSize; landscape: boolean }
  /** Estimated characters needed by the widest table. */
  widestTable: number
  /** Characters available across the page in portrait. */
  portraitFits: number
  columns: number
  reason?: string
}

/** Page setups in increasing width, so the first fit is the least disruptive. */
const SETUPS: { pageSize: PdfPageSize; landscape: boolean }[] = [
  { pageSize: 'Letter', landscape: false },
  { pageSize: 'A4', landscape: true },
  { pageSize: 'Letter', landscape: true },
  { pageSize: 'Legal', landscape: true },
  { pageSize: 'A3', landscape: false },
  { pageSize: 'Tabloid', landscape: true },
  { pageSize: 'A3', landscape: true },
]

function widthOf(setup: { pageSize: PdfPageSize; landscape: boolean }): number {
  const base = PORTRAIT_COLUMNS[setup.pageSize]
  return setup.landscape ? Math.round(base * LANDSCAPE_RATIO[setup.pageSize]) : base
}

function describe(setup: { pageSize: PdfPageSize; landscape: boolean }): string {
  return `${setup.pageSize} ${setup.landscape ? 'landscape' : 'portrait'}`
}

/** One table's natural width (characters across, at the shell's body font), its columns, and how much text it holds. */
export interface TableMeasure {
  needed: number
  columns: number
  text: number
}

/**
 * Each table's natural width: per column the longest word (a column is never
 * taken narrower than its own unbreakable content), plus padding and a
 * border. Checked against the shell's content-sized columns (shell.ts
 * autoTables) in Chromium: a table this calls wider than the page ran past
 * it, one it calls narrower fit, or needed up to a fifth less than said.
 */
export function measureTables(html: string): TableMeasure[] {
  const out: TableMeasure[] = []
  for (const grid of tableGrid(html)) {
    const width = grid.reduce((max, row) => Math.max(max, row.length), 0)
    if (width === 0) continue
    // Per column, the longest single word: below this, text breaks mid-word.
    const perColumn: number[] = []
    let text = 0
    for (let c = 0; c < width; c++) {
      let longestWord = 3
      for (const row of grid) {
        const cell = row[c] ?? ''
        text += cell.replace(/\s+/g, '').length
        for (const word of cell.split(/\s+/)) {
          longestWord = Math.max(longestWord, Math.min(word.length, 24))
        }
      }
      perColumn.push(longestWord)
    }
    // Two characters of padding and a border per column.
    out.push({ needed: perColumn.reduce((sum, w) => sum + w + 3, 0), columns: width, text })
  }
  return out
}

/** Characters across a page of this size, in either orientation (at the shell's body font). */
export function pageColumns(pageSize: PdfPageSize, landscape: boolean): number {
  return widthOf({ pageSize, landscape })
}

/**
 * Estimate whether a document's widest table fits the page in portrait.
 *
 * Cell text wraps, so a table is never truly unprintable — but a wide one
 * squeezed into portrait wraps every cell to a few characters and becomes
 * unreadable. This measures the natural width (longest word per column, so a
 * column is never advised narrower than its own unbreakable content) and says
 * whether turning the page sideways would actually help.
 */
export function advisePageFit(html: string, pageSize: PdfPageSize = 'Letter', landscape = false): PageFitAdvice {
  const portraitFits = PORTRAIT_COLUMNS[pageSize]
  let widest = 0
  let columns = 0
  for (const table of measureTables(html)) {
    if (table.needed > widest) {
      widest = table.needed
      columns = table.columns
    }
  }
  if (widest === 0) {
    return { recommendLandscape: false, fitsAnyPage: true, widestTable: 0, portraitFits, columns: 0 }
  }

  const current = { pageSize, landscape }
  // Already fits: say nothing rather than nag.
  if (widest <= widthOf(current)) {
    return { recommendLandscape: false, fitsAnyPage: true, widestTable: widest, portraitFits, columns }
  }

  const fitting = SETUPS.filter((s) => widthOf(s) >= widest).sort((a, b) => widthOf(a) - widthOf(b))[0]
  if (fitting) {
    const sameSize = fitting.pageSize === pageSize
    return {
      recommendLandscape: fitting.landscape,
      fitsAnyPage: true,
      suggestion: fitting,
      widestTable: widest,
      portraitFits,
      columns,
      reason:
        `the widest table needs about ${widest} characters across (${columns} columns) and ` +
        `${describe(current)} fits about ${widthOf(current)}; ` +
        (sameSize ? `landscape fits about ${widthOf(fitting)}` : `${describe(fitting)} fits about ${widthOf(fitting)}`),
    }
  }

  // Nothing fits. Name the roomiest setup so the choice is still the user's —
  // the paper is never changed for them (Automatic may turn it: orientation.ts)
  // — but say plainly that no page will hold
  // this table, and name the targets that have no page width to run out of.
  // Without that last part the user gets a thousand-page PDF of two-character
  // columns and no explanation of what to do instead.
  const widestSetup = [...SETUPS].sort((a, b) => widthOf(b) - widthOf(a))[0]
  return {
    recommendLandscape: widestSetup.landscape,
    fitsAnyPage: false,
    suggestion: widestSetup,
    widestTable: widest,
    portraitFits,
    columns,
    reason:
      `the widest table (${columns} columns, about ${widest} characters across) is wider than any page setup; ` +
      `${describe(widestSetup)} gives the most room (about ${widthOf(widestSetup)}), but cells will still wrap ` +
      'and the PDF will run long. To keep the table whole, convert to xlsx, csv or html instead: ' +
      'those have no page width',
  }
}
