import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mergePdfs } from '../../src/core/pdf-merge'

async function textPdf(text: string, pages = 1): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([300, 200])
    page.drawText(`${text} p${i + 1}`, { x: 30, y: 100, size: 14, font })
  }
  return Buffer.from(await pdf.save())
}

/** Image-only page — the "scanned" case that must pass through untouched. */
async function scannedPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const png = await pdf.embedPng(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  const page = pdf.addPage([300, 200])
  page.drawImage(png, { x: 0, y: 0, width: 300, height: 200 })
  return Buffer.from(await pdf.save())
}

describe('mergePdfs (page-for-page, uninterpreted)', () => {
  it('concatenates all pages in order, including image-only (scanned) pages', async () => {
    const a = await textPdf('alpha', 2)
    const b = await scannedPdf()
    const c = await textPdf('gamma', 1)
    const merged = await mergePdfs([
      { bytes: a, name: 'a.pdf' },
      { bytes: b, name: 'scan.pdf' },
      { bytes: c, name: 'c.pdf' },
    ])
    const out = await PDFDocument.load(merged)
    expect(out.getPageCount()).toBe(4)
    expect(merged.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('names the offending file when an input is not a valid PDF', async () => {
    await expect(
      mergePdfs([{ bytes: Buffer.from('not a pdf'), name: 'broken.pdf' }]),
    ).rejects.toMatchObject({ code: 'read-failed' })
    await expect(
      mergePdfs([{ bytes: Buffer.from('not a pdf'), name: 'broken.pdf' }]),
    ).rejects.toThrowError(/broken\.pdf/)
  })

  it('rejects an empty list', async () => {
    await expect(mergePdfs([])).rejects.toMatchObject({ code: 'merge-empty' })
  })
})
