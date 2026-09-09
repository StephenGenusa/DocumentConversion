import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readPdf } from '../../src/core/readers/pdf'
import { tableGrid } from '../../src/core/table-grid'

/**
 * Recall harness for the spreadsheet-print case.
 *
 * The 20-page spreadsheet print the source comment in `pdf.ts` quotes was
 * never shipped as its own PDF fixture — what exists is the sheet that print
 * came from, `tests/corpus/catalogue-codes.xlsx`: 410 rows (1 header + 409
 * data), three columns, descriptions up to 100 characters. So the print is
 * reconstructed here from that same data, deterministically, with the two
 * traits that make a real spreadsheet print hard:
 *
 *  - the description column is narrower than the longest descriptions, so 62%
 *    of rows wrap (measured on this data at 9pt in a 140pt column: 2.08 visual
 *    lines per row on average, up to 5);
 *  - the Group column sits 8pt to the right of the description column's right
 *    edge, which is INSIDE the 0.9-line-height cell gap, so a description that
 *    fills its column runs into the next cell — and below about 7pt pdfjs
 *    stops emitting the blank bridge item and hands back the two cells as one
 *    string, which is the harder half of the same problem.
 *
 * Excel's own pagination is reproduced too: the column header repeats on every
 * page and a "Page n of 20" folio closes it, both of which `dropRepeatedEdges`
 * strips, so only the 409 data rows are recoverable.
 */

const SHEET = join(__dirname, '../corpus/catalogue-codes.xlsx')

const FONT_SIZE = 9
const LINE_HEIGHT = 13
const ROWS_PER_PAGE = 21
/** Catalogue, Description, Group — left edges in PDF points. */
const COLUMN_X = [36, 92, 240]
const DESCRIPTION_WIDTH = 140

interface Cells {
  code: string
  description: string
  group: string
}

async function sheetRows(): Promise<Cells[]> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await readFile(SHEET), { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false })
  return rows.slice(1).map((r) => ({ code: String(r[0]), description: String(r[1]), group: String(r[2]) }))
}

/** Greedy wrap, measured with the same font metrics the page is drawn with. */
function wrap(text: string, font: { widthOfTextAtSize(t: string, s: number): number }): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word
    if (current && font.widthOfTextAtSize(candidate, FONT_SIZE) > DESCRIPTION_WIDTH) {
      lines.push(current)
      current = word
    } else current = candidate
  }
  if (current) lines.push(current)
  return lines
}

async function spreadsheetPrint(rows: Cells[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const pageCount = Math.ceil(rows.length / ROWS_PER_PAGE)
  for (let p = 0; p < pageCount; p++) {
    const page = pdf.addPage([612, 792])
    let y = 740
    const put = (text: string, x: number): void => {
      page.drawText(text, { x, y, size: FONT_SIZE, font })
    }
    // Excel's "repeat header rows on every page".
    put('Catalogue', COLUMN_X[0])
    put('Description', COLUMN_X[1])
    put('Group', COLUMN_X[2])
    y -= LINE_HEIGHT
    for (const row of rows.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE)) {
      const lines = wrap(row.description, font)
      put(row.code, COLUMN_X[0])
      put(lines[0], COLUMN_X[1])
      put(row.group, COLUMN_X[2])
      y -= LINE_HEIGHT
      for (const continuation of lines.slice(1)) {
        put(continuation, COLUMN_X[1])
        y -= LINE_HEIGHT
      }
    }
    y = 40
    put(`Page ${p + 1} of ${pageCount}`, 280)
  }
  return Buffer.from(await pdf.save())
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

interface Recall {
  recovered: number
  exact: number
  total: number
  tables: number
}

/**
 * A source row counts as recovered when some emitted table row carries its
 * commodity code in the first cell and the head of its description in the
 * second; "exact" additionally demands the whole description and the group,
 * which is what a wrapped cell has to be folded back together to satisfy.
 */
function measure(html: string, rows: Cells[]): Recall {
  const tables = tableGrid(html)
  const byCode = new Map<string, string[][]>()
  for (const table of tables) {
    for (const row of table) {
      const code = normalize(row[0] ?? '')
      if (!byCode.has(code)) byCode.set(code, [])
      byCode.get(code)!.push(row.map(normalize))
    }
  }
  let recovered = 0
  let exact = 0
  for (const row of rows) {
    const candidates = byCode.get(row.code) ?? []
    const head = normalize(row.description).slice(0, 12)
    const hit = candidates.find((c) => c.slice(1).join(' ').includes(head))
    if (!hit) continue
    recovered++
    if (hit[1] === normalize(row.description) && hit[2] === row.group) exact++
  }
  return { recovered, exact, total: rows.length, tables: tables.length }
}

describe('spreadsheet-print recall', () => {
  const itIfFixture = existsSync(SHEET) ? it : it.skip

  itIfFixture('recovers the rows a printed spreadsheet holds', async () => {
    const rows = await sheetRows()
    const bytes = await spreadsheetPrint(rows)
    const { html } = await readPdf({ bytes, filename: 'commodity-codes.pdf' })
    const result = measure(html, rows)
    if (process.env.RECALL) process.stdout.write(`RECALL ${JSON.stringify(result)}\n`)
    // Before the wrapped-row and narrow-gap work: 144 of 409, spread over 28
    // fragments of table. After: 408 of 409 in 20 tables, one per printed page.
    // The floor sits a little under that so ordinary jitter cannot fail a build.
    expect(result.recovered).toBeGreaterThanOrEqual(400)
    expect(result.tables).toBeLessThanOrEqual(22)
  }, 120_000)

  itIfFixture('keeps the cells of a recovered row in their own columns', async () => {
    const rows = await sheetRows()
    const bytes = await spreadsheetPrint(rows)
    const { html } = await readPdf({ bytes, filename: 'commodity-codes.pdf' })
    const result = measure(html, rows)
    // "exact" means the whole wrapped description was folded back together AND
    // the group code did not get glued onto the end of it. Before: 117 of 409;
    // after: 406.
    expect(result.exact).toBeGreaterThanOrEqual(395)
  }, 120_000)
})
