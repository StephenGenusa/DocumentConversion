import { parseDocument } from 'htmlparser2'
import { findAll } from 'domutils'
import type { AnyNode, Element } from 'domhandler'

/** A hostile or broken colspan must not allocate an unbounded row. */
export const MAX_SPAN = 1000

const BLOCK = new Set([
  'p',
  'div',
  'br',
  'li',
  'ul',
  'ol',
  'tr',
  'td',
  'th',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
])

/**
 * Cell text with block boundaries preserved as spaces. Plain textContent()
 * concatenates across them, which is how "FromAlice" and "Widget3" happened
 * elsewhere; a cell holding two paragraphs or a nested table must not become
 * "onetwo" or "i1i2".
 */
function cellText(node: AnyNode): string {
  if (node.type === 'text') return (node as { data: string }).data
  if (node.type !== 'tag') return ''
  const el = node as Element
  const inner = el.children.map(cellText).join('')
  return BLOCK.has(el.name) ? ` ${inner} ` : inner
}

function normalizeText(node: Element): string {
  return cellText(node).replace(/\s+/g, ' ').trim()
}

/**
 * Rows belonging to THIS table — never rows of a table nested inside a cell.
 *
 * Exported unchanged so the print chunker asks the same question the five
 * table readers ask; two answers to "what are this table's rows" is how a
 * chunk came to be split inside a nested table.
 */
export function ownRows(table: Element): Element[] {
  const rows: Element[] = []
  const walk = (nodes: AnyNode[]): void => {
    for (const node of nodes) {
      if (node.type !== 'tag') continue
      const el = node as Element
      if (el.name === 'table') continue // a nested table is extracted separately
      if (el.name === 'tr') rows.push(el)
      else walk(el.children)
    }
  }
  walk(table.children)
  return rows
}

function span(value: string | undefined): number {
  const n = parseInt(value ?? '1', 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, MAX_SPAN)
}

export interface GridOptions {
  /**
   * Repeat a rowspan's value into the rows it covers instead of leaving them
   * blank. Data exports (csv/json/xlsx) want the category label on every row
   * it applies to; markdown renders the merge visually and does not.
   */
  fillRowspan?: boolean
}

export function gridForElement(table: Element, opts: GridOptions = {}): string[][] {
  const grid: string[][] = []
  // pending rowspans: column index -> { rows left, the spanned value }
  const pending = new Map<number, { left: number; value: string }>()

  for (const tr of ownRows(table)) {
    const out: string[] = []
    let col = 0
    const fillPending = (): void => {
      while (pending.has(col)) {
        const entry = pending.get(col)!
        out[col] = opts.fillRowspan ? entry.value : ''
        if (entry.left <= 1) pending.delete(col)
        else pending.set(col, { left: entry.left - 1, value: entry.value })
        col++
      }
    }
    const cells = tr.children.filter(
      (c): c is Element => c.type === 'tag' && (c.name === 'td' || c.name === 'th'),
    )
    for (const cell of cells) {
      fillPending()
      const text = normalizeText(cell)
      const colspan = span(cell.attribs.colspan)
      const rowspan = span(cell.attribs.rowspan)
      for (let i = 0; i < colspan; i++) {
        out[col] = i === 0 ? text : ''
        if (rowspan > 1) pending.set(col, { left: rowspan - 1, value: i === 0 ? text : '' })
        col++
      }
    }
    fillPending()
    grid.push(out)
  }

  // Ragged rows are common in real HTML; pad so every record has the same
  // field count (RFC 4180 §2 requires it, and consumers assume it).
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0)
  for (const row of grid) {
    for (let i = 0; i < width; i++) if (row[i] === undefined) row[i] = ''
  }
  return grid
}

/**
 * A table needs at least one non-empty cell to count. Layout wrappers (a
 * SharePoint page's `<table><tr><td id="scriptWPQ1"></td></tr></table>`, or
 * Word's spacer tables) otherwise extract to a "successful" empty CSV.
 */
function hasContent(grid: string[][]): boolean {
  return grid.some((row) => row.some((cell) => cell.trim() !== ''))
}

/**
 * Every <table> in the document as rows×cells with spans expanded.
 * Layout/spacer tables with no cells are dropped: real-world HTML from email
 * and Word is full of them, and counting one would push a single-table
 * document into multi-file output and write an empty file.
 */
export function tableGrid(html: string, opts: GridOptions = {}): string[][][] {
  const dom = parseDocument(html)
  return findAll((el) => el.name === 'table', dom.children)
    .map((table) => gridForElement(table, opts))
    .filter(hasContent)
}
