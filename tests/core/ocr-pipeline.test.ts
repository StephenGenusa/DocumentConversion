import { describe, it, expect, afterAll } from 'vitest'

// tesseract's worker_threads/wasm need a moment to wind down after
// terminate(); exiting the vitest fork immediately races them and the pool
// reports "Worker forks emitted error" intermittently.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 750)))
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ocrPdf, ocrImage } from '../../src/ocr/pipeline'

const LANG_DIR = join(__dirname, '../../resources/ocr')
const haveAssets = existsSync(join(LANG_DIR, 'eng.traineddata.gz'))

/**
 * Arial is a Windows font. On a stock Linux box it is absent, and skia draws
 * .notdef boxes rather than substituting, so tesseract reads the boxes instead
 * of the text. Naming Arial's metric-compatible substitutes keeps the fixture
 * legible — and its glyph advances unchanged — on both platforms.
 */
const SANS = 'Arial, "Liberation Sans", "DejaVu Sans", sans-serif'

/** Deterministic "scanned" fixtures: large clean text rendered to a raster. */
async function renderTextPng(lines: string[]): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(1700, 2200)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1700, 2200)
  ctx.fillStyle = '#000000'
  ctx.font = `bold 72px ${SANS}`
  lines.forEach((line, i) => ctx.fillText(line, 120, 260 + i * 160))
  return canvas.toBuffer('image/png')
}

async function scannedPdf(lines: string[]): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib')
  const png = await renderTextPng(lines)
  const pdf = await PDFDocument.create()
  const image = await pdf.embedPng(png)
  const page = pdf.addPage([612, 792])
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 })
  return Buffer.from(await pdf.save())
}

describe.skipIf(!haveAssets)('ocr pipeline (slow, offline assets)', () => {
  it('recognizes text from a scanned pdf, sequentially with progress', { timeout: 300000 }, async () => {
    const bytes = await scannedPdf(['DOCUMENT CONVERSION', 'PIPELINE QUALITY', 'SEVENTY SEVEN'])
    const stages: string[] = []
    const pages = await ocrPdf(bytes, { langPath: LANG_DIR }, { onProgress: (s) => stages.push(s) })
    expect(pages).toHaveLength(1)
    // Each page is now { text, grid? }; these fixtures are prose, so no grid.
    expect(pages[0].grid).toBeUndefined()
    const text = pages.map((p) => p.text).join(' ').toLowerCase()
    expect(text).toContain('document')
    expect(text).toContain('pipeline')
    expect(text).toContain('seventy')
    expect(stages.some((s) => /page 1/i.test(s))).toBe(true)
  })

  it('recognizes text from an image', { timeout: 300000 }, async () => {
    const png = await renderTextPng(['HELLO CONVERTER'])
    const { text } = await ocrImage(png, { langPath: LANG_DIR })
    expect(text.toLowerCase()).toContain('hello')
    expect(text.toLowerCase()).toContain('converter')
  })
})
