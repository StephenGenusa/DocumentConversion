import { describe, it, expect } from 'vitest'
import {
  chunkHtmlForPrinting,
  countRows,
  countCells,
  MAX_ROWS_PER_CHUNK,
  MAX_CELLS_PER_CHUNK,
} from '../../src/core/html-chunk'

const bigTable = (rows: number): string =>
  `<h1>Report</h1><table><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody>${Array.from(
    { length: rows },
    (_, i) => `<tr><td>row${i}</td><td>${i}</td></tr>`,
  ).join('')}</tbody></table>`

const wideTable = (rows: number, cols: number): string =>
  `<table><tbody>${Array.from(
    { length: rows },
    (_, r) => `<tr>${Array.from({ length: cols }, (_, c) => `<td>r${r}c${c}</td>`).join('')}</tr>`,
  ).join('')}</tbody></table>`

describe('chunkHtmlForPrinting', () => {
  it('leaves a small document as a single chunk', () => {
    const chunks = chunkHtmlForPrinting(bigTable(10), 100)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('<h1>Report</h1>')
  })

  it('splits a large table across chunks', () => {
    const chunks = chunkHtmlForPrinting(bigTable(250), 100)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('repeats the header on every chunk of a split table', () => {
    const chunks = chunkHtmlForPrinting(bigTable(250), 100)
    for (const chunk of chunks) {
      expect(chunk).toContain('<th>Item</th>')
    }
  })

  it('loses no rows when splitting', () => {
    const chunks = chunkHtmlForPrinting(bigTable(250), 100)
    const seen = chunks.join('')
    for (const i of [0, 99, 100, 199, 249]) {
      expect(seen).toContain(`row${i}<`)
    }
    // Body rows total 250 regardless of how the header repeats.
    const bodyRows = (seen.match(/<td>row\d+<\/td>/g) ?? []).length
    expect(bodyRows).toBe(250)
  })

  it('keeps non-table content alongside the tables', () => {
    const chunks = chunkHtmlForPrinting(`${bigTable(250)}<p>Closing note.</p>`, 100)
    expect(chunks.join('')).toContain('Closing note.')
    expect(chunks[0]).toContain('<h1>Report</h1>')
  })
})

/**
 * A row budget alone describes only half the page. Chromium's ceiling moves
 * with the number of cells laid out as well: 1,500 rows of 200 columns
 * (300,000 cells) printed here, 1,500 rows of 300 columns (450,000) did not,
 * and 7,000 rows of 20 columns (140,000 cells) failed while 4,000 rows of 40
 * (160,000 cells) succeeded. Whatever the exact shape of that curve, a chunker
 * that counts only rows walks straight over it on a wide sheet.
 */
describe('chunking by cells as well as rows', () => {
  it('splits a wide table whose row count is comfortably under the row budget', () => {
    const rows = Math.floor(MAX_ROWS_PER_CHUNK * 0.8)
    const cols = Math.ceil((MAX_CELLS_PER_CHUNK * 3) / rows)
    const chunks = chunkHtmlForPrinting(wideTable(rows, cols))
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(countCells(chunk)).toBeLessThanOrEqual(MAX_CELLS_PER_CHUNK)
  })

  it('loses no rows when splitting by cells', () => {
    const chunks = chunkHtmlForPrinting(wideTable(60, 10), 1000, 100)
    expect(chunks.length).toBeGreaterThan(1)
    const seen = chunks.join('')
    for (let r = 0; r < 60; r++) expect(seen).toContain(`<td>r${r}c9</td>`)
  })

  it('still emits one row per chunk when a single row busts the cell budget', () => {
    // Never an empty chunk and never an infinite loop: progress must be made
    // even when the budget cannot be honoured.
    const chunks = chunkHtmlForPrinting(wideTable(4, 50), 1000, 10)
    expect(chunks).toHaveLength(4)
    expect(chunks.every((c) => countRows(c) === 1)).toBe(true)
  })

  it('leaves a narrow table alone at the same cell budget', () => {
    expect(chunkHtmlForPrinting(wideTable(20, 2), 1000, 100)).toHaveLength(1)
  })
})

describe('countRows', () => {
  it('counts table rows and ignores documents with none', () => {
    expect(countRows('<p>prose</p>')).toBe(0)
    expect(countRows(bigTable(5))).toBe(6) // 5 body rows + header row
  })
})

describe('countCells', () => {
  it('counts every td and th and ignores documents with no table', () => {
    expect(countCells('<p>prose</p>')).toBe(0)
    expect(countCells(bigTable(5))).toBe(12) // 5 body rows x 2 + 2 header cells
  })
})

/**
 * Nested tables. A `<table>` inside a `<td>` is part of its parent row, not a
 * row of the parent table — table-grid.ts settled that contract for the five
 * readers that extract tables, and the chunker has to honour it too.
 *
 * Counting every `<tr>` in the subtree does two things wrong at once: it offers
 * an inner row as a place to CUT, which rips it out of its cell and leaves
 * markup no printer can lay out, and it charges the inner cells twice — once
 * inside their parent row's own count and once again as rows of their own — so
 * the chunk is sized against a number the page does not have. printToPDF fails
 * outright on a page it cannot take, so a mis-sized chunk is a failed
 * conversion, not a cosmetic one.
 */
describe('chunking with nested tables', () => {
  const inner = (prefix: string, rows: number): string =>
    `<table><tbody>${Array.from(
      { length: rows },
      (_, i) => `<tr><td>${prefix}${i}a</td><td>${prefix}${i}b</td></tr>`,
    ).join('')}</tbody></table>`

  const outerWithNested = (outerRows: number, innerRows: number): string =>
    `<table><tbody>${Array.from(
      { length: outerRows },
      (_, r) => `<tr><td>outer${r}</td><td>${inner(`n${r}_`, innerRows)}</td></tr>`,
    ).join('')}</tbody></table>`

  const balanced = (chunk: string): boolean =>
    (chunk.match(/<table\b/g) ?? []).length === (chunk.match(/<\/table>/g) ?? []).length

  it('never cuts a table open, however tight the budget', () => {
    const chunks = chunkHtmlForPrinting(outerWithNested(4, 3), 1)
    for (const chunk of chunks) expect(balanced(chunk)).toBe(true)
  })

  it('emits every nested row exactly once and inside its own cell', () => {
    const html = outerWithNested(4, 3)
    const chunks = chunkHtmlForPrinting(html, 1)
    const seen = chunks.join('')
    for (let r = 0; r < 4; r++) {
      for (let i = 0; i < 3; i++) {
        expect((seen.match(new RegExp(`>n${r}_${i}a<`, 'g')) ?? []).length).toBe(1)
      }
      // A nested row must travel with the outer row whose cell holds it.
      const holder = chunks.find((c) => c.includes(`>n${r}_0a<`))
      expect(holder).toBeDefined()
      expect(holder).toContain(`>outer${r}<`)
    }
  })

  it('does not charge the cells of a nested table twice against the budget', () => {
    // One outer row: one own cell plus a 3x2 nested table = 7 cells in total.
    // Counting the nested rows separately as well makes it 13, which used to
    // push this table over a budget it comfortably fits.
    const html = `<table><tbody><tr><td>${inner('x', 3)}</td></tr></tbody></table>`
    expect(countCells(html)).toBe(7)
    const chunks = chunkHtmlForPrinting(html, 1000, 10)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('x0a')
    expect(chunks[0]).toContain('x2b')
  })

  it('still splits the outer table at its own row boundaries', () => {
    const chunks = chunkHtmlForPrinting(outerWithNested(6, 2), 2)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(balanced(chunk)).toBe(true)
    const seen = chunks.join('')
    for (let r = 0; r < 6; r++) expect((seen.match(new RegExp(`>outer${r}<`, 'g')) ?? []).length).toBe(1)
  })
})

/**
 * Attribute values on a table come from the source document, so a value
 * carrying a double quote must not be able to close the attribute when the
 * table is re-serialized for a chunk.
 */
describe('chunk serialization escapes attribute values', () => {
  it('escapes a quote in a table attribute when the table is split', () => {
    const rows = Array.from({ length: 4 }, (_, i) => `<tr><td>r${i}</td></tr>`).join('')
    const html = `<table class='a" onmouseover="alert(1)'><tbody>${rows}</tbody></table>`
    const chunks = chunkHtmlForPrinting(html, 1)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk).not.toContain('onmouseover="')
      expect(chunk).toMatch(/<table class="[^"]*">/)
    }
  })
})
