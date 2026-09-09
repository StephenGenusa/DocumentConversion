import { parseDocument } from 'htmlparser2'
import { findAll } from 'domutils'
import { Element } from 'domhandler'
import render from 'dom-serializer'
import { ownRows } from './table-grid'
import type { AnyNode } from 'domhandler'

/** Rows per chunk. Chromium's printToPDF fails outright well below 16,000. */
export const MAX_ROWS_PER_CHUNK = 1500

/**
 * Cells per chunk, because a row budget alone describes only half the page.
 *
 * Measured against this app's shell on Letter portrait, printToPDF refused
 * 1,500 rows x 300 columns (450,000 cells) but printed 1,500 x 200 (300,000);
 * it refused 7,000 rows x 20 columns (140,000 cells) but printed 4,000 x 40
 * (160,000). Rows, cells, bytes and output pages each have counter-examples,
 * so there is no single number to sit just under — 60,000 is under half the
 * smallest cell count that ever failed at any shape, and at the 1,500-row cap
 * it still allows 40 columns. Anything the guess gets wrong is caught by the
 * pdf writer, which halves and retries whatever the renderer refuses.
 */
export const MAX_CELLS_PER_CHUNK = 60_000

/**
 * A table's own `<thead>`, never one belonging to a table nested in a cell.
 * `findAll` would happily return the inner one when the outer has none, and
 * the chunker would then repeat a stranger's header on every part.
 */
function theadOf(table: Element): Element | undefined {
  return (table.children as AnyNode[]).find(
    (n): n is Element => n.type === 'tag' && (n as Element).name === 'thead',
  )
}

/**
 * The rows this table may be CUT between: its own, minus its header's.
 *
 * A `<table>` inside a `<td>` is part of its parent row, not a row of the
 * parent table — the contract table-grid.ts already holds for every reader
 * that extracts tables. Offering an inner row as a cut point tears it out of
 * the cell it lives in and emits a `<tr>` belonging to nothing.
 */
function splittableRows(table: Element): Element[] {
  const head = theadOf(table)
  const headRows = new Set(head ? ownRows(head) : [])
  return ownRows(table).filter((row) => !headRows.has(row))
}

/**
 * What one row costs the printer: itself plus everything nested inside it,
 * each counted ONCE.
 *
 * Counting every `<tr>` in the table's subtree charged a nested table twice —
 * once inside its parent row's own cell count and again as rows of its own —
 * so a table that fits was split, and a split table was sized against a number
 * the page does not have. printToPDF fails outright on a page it cannot take,
 * which makes a mis-sized chunk a failed conversion.
 */
function rowsIn(row: Element): number {
  // findAll tests the roots it is given, so `row` itself is in this count.
  return findAll((el) => el.name === 'tr', [row]).length
}

function cellsIn(row: Element): number {
  return findAll((el) => el.name === 'td' || el.name === 'th', [row]).length
}

/** Attribute values come from the source document and may hold a quote. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function cloneWithRows(table: Element, head: Element | undefined, rows: Element[]): string {
  const parts = [head ? render(head, { decodeEntities: true }) : '']
  parts.push(`<tbody>${rows.map((r) => render(r, { decodeEntities: true })).join('')}</tbody>`)
  const attrs = Object.entries(table.attribs ?? {})
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('')
  return `<table${attrs}>${parts.join('')}</table>`
}

/**
 * Split a hub document into printable chunks.
 *
 * Chromium's printToPDF simply fails on a very large page — a 10,464-row
 * spreadsheet returned "Printing failed" after 13 seconds with no output. The
 * chunks are rendered separately and merged back into one PDF, so a big
 * table is split by rows with its header repeated on each part.
 */
export function chunkHtmlForPrinting(
  html: string,
  maxRows = MAX_ROWS_PER_CHUNK,
  maxCells = MAX_CELLS_PER_CHUNK,
): string[] {
  const dom = parseDocument(html)
  const chunks: string[] = []
  let current: string[] = []
  let rowBudget = maxRows
  let cellBudget = maxCells

  const flush = (): void => {
    if (current.length > 0) chunks.push(current.join(''))
    current = []
    rowBudget = maxRows
    cellBudget = maxCells
  }

  for (const node of dom.children as AnyNode[]) {
    if (node.type === 'tag' && (node as Element).name === 'table') {
      // A previous table may have spent the budget exactly; start a new chunk
      // rather than let this one ride along past the limit.
      if (rowBudget <= 0 || cellBudget <= 0) flush()
      const table = node as Element
      const head = theadOf(table)
      const bodyRows = splittableRows(table)
      // Each row is weighed with whatever it nests, so a row holding a table
      // costs what it really prints — and costs it once.
      const rowLoad = bodyRows.map(rowsIn)
      const cellLoad = bodyRows.map(cellsIn)
      const bodyRowCount = rowLoad.reduce((n, r) => n + r, 0)
      const bodyCells = cellLoad.reduce((n, w) => n + w, 0)
      if (bodyRowCount <= rowBudget && bodyCells <= cellBudget) {
        current.push(render(table, { decodeEntities: true }))
        rowBudget -= bodyRowCount
        cellBudget -= bodyCells
        continue
      }
      // Split this table across chunks, repeating its header each time.
      let offset = 0
      while (offset < bodyRows.length) {
        const rowRoom = rowBudget > 0 ? rowBudget : maxRows
        const cellRoom = cellBudget > 0 ? cellBudget : maxCells
        // At least one row always goes in, even when it alone busts a budget:
        // an empty chunk would loop forever and help no one. A row that nests
        // a whole table is the one place this really bites, and it is still
        // better than cutting the nested table open.
        let take = 0
        let rows = 0
        let cells = 0
        const fits = (): boolean =>
          offset + take < bodyRows.length &&
          (take === 0 ||
            (rows + rowLoad[offset + take] <= rowRoom && cells + cellLoad[offset + take] <= cellRoom))
        while (fits()) {
          rows += rowLoad[offset + take]
          cells += cellLoad[offset + take]
          take++
        }
        current.push(cloneWithRows(table, head, bodyRows.slice(offset, offset + take)))
        offset += take
        rowBudget = rowRoom - rows
        cellBudget = cellRoom - cells
        if (offset < bodyRows.length) flush()
      }
      continue
    }
    current.push(render(node, { decodeEntities: true }))
  }
  flush()
  return chunks.length > 0 ? chunks : [html]
}

/** Total body rows, used to decide whether chunking is needed at all. */
export function countRows(html: string): number {
  if (!html.includes('<table')) return 0
  return findAll((el) => el.name === 'tr', parseDocument(html).children).length
}

/** Total cells. A sheet can bust the printer on width alone, with few rows. */
export function countCells(html: string): number {
  if (!html.includes('<table')) return 0
  return findAll((el) => el.name === 'td' || el.name === 'th', parseDocument(html).children).length
}
