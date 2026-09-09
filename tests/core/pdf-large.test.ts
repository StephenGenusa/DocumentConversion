import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { createPdfWriter } from '../../src/core/writers/pdf'
import { countRows, countCells, MAX_ROWS_PER_CHUNK, MAX_CELLS_PER_CHUNK } from '../../src/core/html-chunk'
import { ConversionError } from '../../src/core/errors'

/**
 * Chromium's printToPDF does not degrade on a document it cannot handle — it
 * throws "Failed to generate PDF: Printing failed" and produces nothing. The
 * measured ceiling is not a single number: 1,500 rows x 200 columns printed
 * and 1,500 x 300 did not; 4,000 x 40 printed and 7,000 x 20 did not. So the
 * writer cannot rely on getting its budget right first time — it has to react
 * to the refusal, and say something useful when even splitting cannot save it.
 */
async function onePagePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 200])
  return Buffer.from(await pdf.save())
}

const table = (rows: number, cols = 2): string =>
  `<table><tbody>${Array.from(
    { length: rows },
    (_, r) => `<tr>${Array.from({ length: cols }, (_, c) => `<td>r${r}c${c}</td>`).join('')}</tr>`,
  ).join('')}</tbody></table>`

const PRINTING_FAILED = 'Failed to generate PDF: Printing failed'

describe('pdf writer against Chromium’s printing ceiling', () => {
  it('splits and retries a piece the renderer refuses instead of failing the conversion', async () => {
    const rendered: string[] = []
    // Stands in for Chromium: anything past 400 rows on one page is refused.
    const render = async (html: string): Promise<Buffer> => {
      if (countRows(html) > 400) throw new Error(PRINTING_FAILED)
      rendered.push(html)
      return onePagePdf()
    }
    const out = await createPdfWriter(render)({ html: table(MAX_ROWS_PER_CHUNK * 2) })
    expect((await PDFDocument.load(out)).getPageCount()).toBe(rendered.length)
    // Every row reached exactly one successfully rendered piece.
    const seen = rendered.join('')
    for (const r of [0, 400, 1499, 1500, MAX_ROWS_PER_CHUNK * 2 - 1]) {
      expect(seen).toContain(`<td>r${r}c0</td>`)
    }
    expect((seen.match(/<td>r\d+c0<\/td>/g) ?? []).length).toBe(MAX_ROWS_PER_CHUNK * 2)
  })

  it('retries a refusal even on a document small enough to print in one piece', async () => {
    let refusals = 0
    const render = async (html: string): Promise<Buffer> => {
      if (countRows(html) > 5) {
        refusals++
        throw new Error(PRINTING_FAILED)
      }
      return onePagePdf()
    }
    const out = await createPdfWriter(render)({ html: table(20) })
    expect(refusals).toBeGreaterThan(0)
    expect((await PDFDocument.load(out)).getPageCount()).toBeGreaterThan(1)
  })

  it('reports a document that cannot be printed at any size as a ConversionError', async () => {
    const render = async (): Promise<Buffer> => {
      throw new Error(PRINTING_FAILED)
    }
    const err = await createPdfWriter(render)({ html: table(40) }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ConversionError)
    const message = (err as ConversionError).message
    // The raw Chromium string tells the user nothing they can act on.
    expect(message).not.toContain('Printing failed')
    expect(message).toMatch(/too (big|large)/i)
    expect(message).toMatch(/HTML|CSV|XLSX/)
    expect((err as ConversionError).code).toBe('write-failed')
  })

  it('describes a refused document with no table by its size, since prose cannot be split', async () => {
    const render = async (): Promise<Buffer> => {
      throw new Error(PRINTING_FAILED)
    }
    const err = await createPdfWriter(render)({ html: '<p>x</p>'.repeat(2000) }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ConversionError)
    expect((err as ConversionError).message).toMatch(/MB of content/)
    expect((err as ConversionError).message).not.toMatch(/0 rows/)
  })

  it('lets a real failure that is not the printing ceiling through untouched', async () => {
    const render = async (): Promise<Buffer> => {
      throw new Error('EACCES: permission denied')
    }
    await expect(createPdfWriter(render)({ html: '<p>hi</p>' })).rejects.toThrow(/EACCES/)
  })

  it('gives every piece a cell budget, not just a row budget', async () => {
    const sizes: { rows: number; cells: number }[] = []
    const render = async (html: string): Promise<Buffer> => {
      sizes.push({ rows: countRows(html), cells: countCells(html) })
      return onePagePdf()
    }
    const cols = Math.ceil((MAX_CELLS_PER_CHUNK * 3) / 1000)
    await createPdfWriter(render)({ html: table(1000, cols) })
    expect(sizes.length).toBeGreaterThan(1)
    for (const s of sizes) expect(s.cells).toBeLessThanOrEqual(MAX_CELLS_PER_CHUNK)
    // Builds and re-chunks a table of MAX_CELLS_PER_CHUNK * 3 cells: ~1.5 s on
    // its own, but past the 5 s default when the whole suite is running in
    // parallel around it. Every other heavy test here carries a timeout.
  }, 60_000)
})
