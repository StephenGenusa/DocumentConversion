import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readPdf } from '../../src/core/readers/pdf'
import { ConversionError } from '../../src/core/errors'

describe('readPdf', () => {
  it('extracts text from a text-based pdf', async () => {
    const bytes = await readFile(join(__dirname, '../fixtures/sample.pdf'))
    const doc = await readPdf({ bytes })
    expect(doc.html).toContain('Hello PDF world')
  })

  it('throws scanned-pdf when there is no text layer', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const pdf = await PDFDocument.create()
    pdf.addPage([200, 200])
    const empty = Buffer.from(await pdf.save())
    await expect(readPdf({ bytes: empty })).rejects.toMatchObject({ code: 'scanned-pdf' })
    await expect(readPdf({ bytes: empty })).rejects.toBeInstanceOf(ConversionError)
  })
})
