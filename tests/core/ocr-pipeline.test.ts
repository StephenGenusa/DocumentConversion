import { describe, it, expect, afterAll } from 'vitest'

// tesseract's worker_threads/wasm need a moment to wind down after
// terminate(); exiting the vitest fork immediately races them and the pool
// reports "Worker forks emitted error" intermittently.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 750)))
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ocrPdf, ocrImage, ocrPicture } from '../../src/ocr/pipeline'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { tiff } from '../../scripts/fixtures/lib-tiff.mjs'

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

/** The same text drawn into raw pixels, for writing as another picture type. */
async function renderTextPixels(lines: string[], width = 1700, height = 900): Promise<(x: number, y: number) => number[]> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#000000'
  ctx.font = `bold 72px ${SANS}`
  lines.forEach((line, i) => ctx.fillText(line, 120, 260 + i * 160))
  const data = ctx.getImageData(0, 0, width, height).data
  return (x, y) => [data[(y * width + x) * 4], data[(y * width + x) * 4 + 1], data[(y * width + x) * 4 + 2]]
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

  it('recognizes each page of a multi-page TIFF (a fax), in order, previews left out', { timeout: 300000 }, async () => {
    const first = await renderTextPixels(['DOCUMENT CONVERSION'])
    const second = await renderTextPixels(['SEVENTY SEVEN'])
    const page = (pixel: (x: number, y: number) => number[], kind: string) => ({ width: 1700, height: 900, pixel, kind, compression: 'packbits', dpi: 200 })
    const fax = tiff({ pages: [page(first, 'bilevel'), { ...page(second, 'gray'), width: 170, height: 90, thumbnail: true }, page(second, 'gray')] })
    const stages: string[] = []
    const pages = await ocrPicture(fax, { langPath: LANG_DIR }, { onProgress: (s) => stages.push(s) })
    expect(pages).toHaveLength(2)
    expect(pages[0].text.toLowerCase()).toContain('document')
    expect(pages[1].text.toLowerCase()).toContain('seventy')
    expect(stages.some((s) => /page 2 of 2/i.test(s))).toBe(true)
  })

  it('recognizes a picture tesseract cannot read itself (an ICO), decoded first', { timeout: 300000 }, async () => {
    const png = await renderTextPng(['HELLO CONVERTER'])
    const dir = Buffer.alloc(22)
    dir.writeUInt16LE(1, 2)
    dir.writeUInt16LE(1, 4)
    dir.writeUInt16LE(1, 10)
    dir.writeUInt16LE(32, 12)
    dir.writeUInt32LE(png.length, 14)
    dir.writeUInt32LE(22, 18)
    const pages = await ocrPicture(Buffer.concat([dir, png]), { langPath: LANG_DIR })
    expect(pages).toHaveLength(1)
    expect(pages[0].text.toLowerCase()).toContain('converter')
  })

  it('refuses what is not a picture it reads, without taking the process down', { timeout: 300000 }, async () => {
    await expect(ocrPicture(Buffer.from('not a picture'), { langPath: LANG_DIR })).rejects.toMatchObject({ code: 'image-unsupported' })
  })

  it('reads with a best model, which is stored under its own name', { timeout: 300000 }, async () => {
    // The bundled English data copied under the best model's name, with no
    // fast file beside it: a pass means the pipeline loaded `eng.best`.
    const dir = mkdtempSync(join(tmpdir(), 'ocr-best-'))
    try {
      copyFileSync(join(LANG_DIR, 'eng.traineddata.gz'), join(dir, 'eng.best.traineddata.gz'))
      const png = await renderTextPng(['HELLO CONVERTER'])
      const { text } = await ocrImage(png, { langPath: dir, language: 'eng', set: 'best' })
      expect(text.toLowerCase()).toContain('hello')
      expect(text.toLowerCase()).toContain('converter')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
