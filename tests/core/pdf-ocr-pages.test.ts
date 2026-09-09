import { describe, it, expect, vi } from 'vitest'
import type { OcrPage } from '../../src/ocr/pipeline'

// conversion.ts is main-process code; nothing on the path under test is
// actually Electron, so a stub is enough to exercise it in-process.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => { throw new Error('not used in these tests') } },
}))

// The recognizer itself is not what is being tested here — the merge is — and
// a real tesseract run would make the result depend on the OCR of the day.
const recognized: OcrPage[] = []
vi.mock('../../src/main/ocr-host', () => ({
  runOcr: vi.fn(async () => recognized),
  ocrLangDir: () => '',
}))

import { readForConversion } from '../../src/main/conversion'
import { tableGrid } from '../../src/core/table-grid'

const SCANNED_TABLE = [
  ['Item', 'Qty', 'Price'],
  ['Widget', '12', '4.50'],
  ['Gadget', '7', '19.95'],
  ['Sprocket', '140', '0.75'],
]

const NATIVE_TABLE = [
  ['Code', 'Description', 'Group'],
  ['0302', 'Abrasives and grinding wheels', '03'],
  ['0318', 'Rope and twine', '03'],
  ['0304', 'Adhesives', '03'],
]

const INTRO = 'The commodity codes below are maintained by the estimating team.'

/**
 * A PDF whose first page has a text layer and whose second page is a picture.
 * This is the shape that used to lose its grid: `readPdf` never throws
 * scanned-pdf for it, because most pages DO have text.
 */
async function mixedPdf(): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const { createCanvas } = await import('@napi-rs/canvas')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)

  const native = pdf.addPage([612, 792])
  native.drawText(INTRO, { x: 55, y: 700, size: 11, font })
  NATIVE_TABLE.forEach((row, r) =>
    row.forEach((text, c) =>
      native.drawText(text, { x: [55, 139, 505][c], y: 650 - r * 20, size: 11, font }),
    ),
  )

  // Page two carries no text-showing operators at all, only an image.
  const canvas = createCanvas(600, 400)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 600, 400)
  ctx.fillStyle = '#000000'
  ctx.fillRect(40, 40, 520, 4)
  const image = await pdf.embedPng(canvas.toBuffer('image/png'))
  pdf.addPage([612, 792]).drawImage(image, { x: 6, y: 200, width: 600, height: 400 })

  return Buffer.from(await pdf.save())
}

async function readMixed(pages: OcrPage[]): Promise<string> {
  recognized.length = 0
  recognized.push(...pages)
  const hub = await readForConversion(await mixedPdf(), 'mixed.pdf', 'pdf', true, {})
  return hub.html
}

describe('a PDF with a text layer on some pages and an image on others', () => {
  it('keeps the grid OCR reconstructed for the scanned page', async () => {
    const html = await readMixed([{ text: '' }, { text: 'Item Qty Price', grid: SCANNED_TABLE }])
    expect(tableGrid(html)).toContainEqual(SCANNED_TABLE)
    // The flattened OCR text is replaced by the table, never printed beside it.
    expect(html).not.toContain('<p>Item Qty Price</p>')
  })

  it('still analyses the native pages instead of flattening them to text', async () => {
    const html = await readMixed([{ text: '' }, { text: 'Item Qty Price', grid: SCANNED_TABLE }])
    expect(tableGrid(html)).toEqual([NATIVE_TABLE, SCANNED_TABLE])
    expect(html).toContain(INTRO)
    expect(html.indexOf(INTRO)).toBeLessThan(html.indexOf('<table>'))
  })

  it('falls back to the OCR text when that page is not a table', async () => {
    const html = await readMixed([{ text: '' }, { text: 'Scanned notes about the codes.' }])
    expect(html).toContain('Scanned notes about the codes.')
    expect(tableGrid(html)).toEqual([NATIVE_TABLE])
  })

  it('names the document after the file, as the other read paths do', async () => {
    recognized.length = 0
    recognized.push({ text: '' }, { text: '', grid: SCANNED_TABLE })
    const hub = await readForConversion(await mixedPdf(), 'mixed.pdf', 'pdf', true, {})
    expect(hub.title).toBe('mixed.pdf')
    expect(hub.sourceName).toBe('mixed.pdf')
  })
})
