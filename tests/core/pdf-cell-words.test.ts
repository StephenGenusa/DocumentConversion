import { describe, it, expect, vi } from 'vitest'
import { readPdf } from '../../src/core/readers/pdf'
import { tableGrid } from '../../src/core/table-grid'

// pdfjs's first load can outrun the 5s default when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 })

/**
 * Words glued together inside a table cell.
 *
 * A space between two words reaches us one of two ways. Usually pdfjs keeps it
 * inside the item — "Code Number" arrives as one string — and nothing can go
 * wrong. But when the page tightens the space (a negative `Tw`, tight tracking,
 * a kern after the space: everyday settings in a dense spreadsheet print)
 * pdfjs flushes the item at the space and hands back THREE items,
 *
 *   {"str":"Code",   x0:55,     w:21.51}
 *   {"str":" ",      x0:76.510, w:0.352, h:0}
 *   {"str":"Number", x0:76.862, w:32.00}
 *
 * — the middle one a blank marker carrying the width of the space it stands
 * for. `itemsToLines` drops blank items, so the table path saw only the two
 * words 0.352pt apart and, judging by geometry alone, ran them into
 * "CodeNumber". The prose path never had the problem: it concatenates every
 * item's `str`, blanks included.
 *
 * The space the page drew is evidence in its own right and has to be carried
 * through, whatever its width: no geometric threshold can separate a 0.35pt
 * space from a 0.35pt kern, because the difference is not in the geometry.
 */

interface Row {
  cells: string[]
  /** Word spacing in points applied to this row; negative tightens. */
  wordSpacing?: number
}

const COLUMNS = [55, 200, 420]
const SIZE = 9

async function makePdf(rows: Row[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts, setWordSpacing } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])
  rows.forEach((row, r) => {
    page.pushOperators(setWordSpacing(row.wordSpacing ?? 0))
    row.cells.forEach((text, c) => {
      if (text === '') return
      page.drawText(text, { x: COLUMNS[c], y: 650 - r * 20, size: SIZE, font })
    })
  })
  return Buffer.from(await pdf.save())
}

const BODY: Row[] = [
  { cells: ['0302', 'Abrasives and grinding wheels', '03'] },
  { cells: ['0318', 'Rope and twine', '03'] },
  { cells: ['0304', 'Adhesives', '03'] },
  { cells: ['0311', 'Anchors and guy hardware', '03'] },
]

describe('a table cell whose word space the page drew narrow', () => {
  it('keeps the words apart in the header', async () => {
    const rows: Row[] = [{ cells: ['Code Number', 'Description', 'Group'], wordSpacing: -2.15 }, ...BODY]
    const { html } = await readPdf({ bytes: await makePdf(rows), filename: 'tight-header.pdf' })
    expect(html).not.toContain('CodeNumber')
    const [grid] = tableGrid(html)
    expect(grid?.[0]).toEqual(['Code Number', 'Description', 'Group'])
  })

  it('keeps every word of a tightened body cell apart', async () => {
    const rows: Row[] = [
      { cells: ['Code', 'Description', 'Group'] },
      { cells: ['0302', 'Abrasives and grinding wheels', '03'], wordSpacing: -2.15 },
      ...BODY.slice(1),
    ]
    const { html } = await readPdf({ bytes: await makePdf(rows), filename: 'tight-cell.pdf' })
    expect(html).not.toContain('Abrasivesand')
    expect(html).not.toContain('andgrinding')
    const [grid] = tableGrid(html)
    expect(grid?.[1]).toEqual(['0302', 'Abrasives and grinding wheels', '03'])
  })

  it('still joins one word that pdfjs reported in two pieces', async () => {
    // The other half of the rule. A style change part way through a word gives
    // two items with no blank between them; they are one word and must not
    // gain a space.
    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const pdf = await PDFDocument.create()
    const regular = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const page = pdf.addPage([612, 792])
    page.drawText('Code', { x: COLUMNS[0], y: 650, size: SIZE, font: regular })
    page.drawText('Descrip', { x: COLUMNS[1], y: 650, size: SIZE, font: regular })
    page.drawText('tion', {
      x: COLUMNS[1] + regular.widthOfTextAtSize('Descrip', SIZE),
      y: 650,
      size: SIZE,
      font: bold,
    })
    page.drawText('Group', { x: COLUMNS[2], y: 650, size: SIZE, font: regular })
    BODY.forEach((row, r) =>
      row.cells.forEach((text, c) =>
        page.drawText(text, { x: COLUMNS[c], y: 630 - r * 20, size: SIZE, font: regular }),
      ),
    )
    const bytes = Buffer.from(await pdf.save())
    const { html } = await readPdf({ bytes, filename: 'split-word.pdf' })
    const [grid] = tableGrid(html)
    expect(grid?.[0]).toEqual(['Code', 'Description', 'Group'])
  })

  it('leaves the prose path as it was', async () => {
    // Nothing here is a table; the same tightened line must read normally.
    const { PDFDocument, StandardFonts, setWordSpacing } = await import('pdf-lib')
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([612, 792])
    page.pushOperators(setWordSpacing(-2.15))
    ;[
      'The commodity code number identifies the class of material being ordered.',
      'Estimators pick the code from the reference sheet issued each March.',
      'A code that no longer appears on the sheet has been retired entirely.',
    ].forEach((text, i) => page.drawText(text, { x: 55, y: 650 - i * 14, size: SIZE, font }))
    const { html } = await readPdf({ bytes: Buffer.from(await pdf.save()), filename: 'tight-prose.pdf' })
    expect(html).toContain('commodity code number identifies')
    expect(html).not.toContain('<table')
  })
})
