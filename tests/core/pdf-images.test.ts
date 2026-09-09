import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readPdf } from '../../src/core/readers/pdf'

/**
 * A PDF's pictures.
 *
 * `getTextContent()` sees no images at all, so every one of them used to be
 * dropped without a word: the handbook's cover photo, the company logo and the
 * eleven scanned exhibit forms at the back all vanished, and the exhibits left
 * nothing behind but their one-line captions. The bitmaps are reachable through
 * `getOperatorList()` and `page.objs`, and the matrix in force when each is
 * painted says where on the page it sat — which is what lets a picture be
 * slotted back into the text flow rather than dumped at the end.
 */

const HANDBOOK = join(__dirname, '../corpus/visitor-handbook.pdf')
const SAMPLE_PNG = join(__dirname, '../fixtures/sample.png')

const ABOVE = 'The photograph below shows the insulators recovered from the old line.'
const BELOW = 'Every insulator in that photograph was catalogued before disposal.'

async function pdfWithPicture(): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const picture = await pdf.embedPng(await readFile(SAMPLE_PNG))
  const page = pdf.addPage([612, 792])
  page.drawText(ABOVE, { x: 55, y: 700, size: 11, font })
  page.drawImage(picture, { x: 55, y: 400, width: 240, height: 240 })
  page.drawText(BELOW, { x: 55, y: 340, size: 11, font })
  return Buffer.from(await pdf.save())
}

describe('a picture inside a pdf', () => {
  it('is carried over as an inline image instead of being dropped', async () => {
    const { html } = await readPdf({ bytes: await pdfWithPicture(), filename: 'picture.pdf' })
    expect(html).toMatch(/<img src="data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+"/)
  }, 60_000)

  it('sits where it sat on the page, between the prose above and below it', async () => {
    const { html } = await readPdf({ bytes: await pdfWithPicture(), filename: 'picture.pdf' })
    const above = html.indexOf(ABOVE)
    const image = html.indexOf('<img ')
    const below = html.indexOf(BELOW)
    expect(above).toBeGreaterThanOrEqual(0)
    expect(below).toBeGreaterThan(0)
    expect(image).toBeGreaterThan(above)
    expect(image).toBeLessThan(below)
  }, 60_000)

  it('recovers the handbook cover, the logo and the scanned exhibit forms', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const { html } = await readPdf({ bytes, filename: 'handbook.pdf' })
    // Thirteen paintImageXObject operators across the seventy pages: a cover
    // photo, a logo, and eleven scanned exhibit forms.
    expect((html.match(/<img /g) ?? []).length).toBeGreaterThanOrEqual(13)
    // Each exhibit page is a scan with a caption; the scan must follow it.
    const caption = html.indexOf('Exhibit A Incident Report Form Page 1')
    expect(caption).toBeGreaterThan(0)
    expect(html.indexOf('<img ', caption)).toBeGreaterThan(caption)
  }, 180_000)
})
