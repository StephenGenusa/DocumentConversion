import { createWorker, type Worker, type Page } from 'tesseract.js'
import { ConversionError } from '../core/errors'
import { groupIntoRows, inferColumns, inferGrid, type PositionedText } from '../core/grid-infer'
import { loadPdfjs } from '../core/pdfjs-loader'
import type { ReadContext } from '../core/types'
import { BUNDLED_LANGUAGE, confidenceFloorFor } from './languages'

/**
 * OCR pipeline — Electron-independent by design (spec F4): unit tests run it
 * in-process; the app hosts it in a utilityProcess so pdfjs rasterization
 * never blocks the main process's IPC broker.
 */
export interface OcrAssets {
  /**
   * Directory holding the .traineddata packs. Local, always — this pipeline
   * never reaches a CDN. Downloading a pack is the main process's job, done
   * only when the user asks, and by the time the pipeline runs the file is
   * already on disk.
   */
  langPath: string
  /**
   * Which language to recognise. Defaults to the bundled English pack, so
   * every existing caller keeps its behaviour unchanged.
   */
  language?: string
  /**
   * Whether the pack on disk is gzipped.
   *
   * The bundled English data ships as `eng.traineddata.gz`; the upstream
   * tessdata repositories serve plain `.traineddata`, so a downloaded pack is
   * not compressed. tesseract.js appends `.gz` itself when told to, and gets
   * ENOENT when told wrongly - which is exactly how a downloaded language
   * failed while English kept working. Defaults to true, matching the pack
   * this app has always shipped.
   */
  gzip?: boolean
}

/**
 * One recognized page.
 *
 * `text` is always present and is what non-tabular pages convert from. `grid`
 * is set only when the page's word boxes lay out convincingly as a table, and
 * it REPLACES the text for that page: emitting both would duplicate every
 * cell. Two fields rather than a union because the caller must always have a
 * usable fallback in hand — a table we are not sure of is worse than none.
 */
export interface OcrPage {
  text: string
  grid?: string[][]
}

/** The subset of a tesseract `Word` this module needs; also the test seam. */
export interface OcrWord {
  text: string
  /** 0..100, per word. */
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

const RASTER_SCALE = 200 / 72 // ~200 DPI

async function ensureCanvasGlobals(): Promise<typeof import('@napi-rs/canvas')> {
  const canvas = await import('@napi-rs/canvas')
  const g = globalThis as Record<string, unknown>
  if (!g.DOMMatrix) g.DOMMatrix = canvas.DOMMatrix
  if (!g.Path2D) g.Path2D = canvas.Path2D
  if (!g.ImageData) g.ImageData = canvas.ImageData
  return canvas
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConversionError('ocr-cancelled', 'OCR was cancelled')
}

async function newWorker(assets: OcrAssets, signal?: AbortSignal): Promise<Worker> {
  throwIfAborted(signal)
  const worker = await createWorker(assets.language ?? BUNDLED_LANGUAGE, undefined, {
    langPath: assets.langPath,
    gzip: assets.gzip ?? true,
    cacheMethod: 'none',
  })
  signal?.addEventListener('abort', () => void worker.terminate().catch(() => {}), { once: true })
  return worker
}

/**
 * Below this, tesseract is guessing at shapes rather than reading letters —
 * a stylised logo came back as "JECH Leroy" at exit 0. Confident nonsense is
 * worse than an honest failure, so the caller is told instead.
 *
 * The floor is per SCRIPT, not global. 55 is the number this pipeline was
 * actually tuned to, on Latin text, and there is no reason for it to hold for
 * Arabic or Han. `confidenceFloorFor` keeps Latin at 55 exactly and sets every
 * unmeasured script no lower, so adding a language cannot loosen the gate that
 * stops the reader emitting plausible nonsense.
 */
function minConfidenceFor(assets: OcrAssets): number {
  return confidenceFloorFor(assets.language ?? BUNDLED_LANGUAGE)
}

/**
 * A table needs a higher bar than "readable at all".
 *
 * Prose survives a few bad words — a reader repairs them from context. A table
 * cell is usually a bare number or code with no context to repair it from, and
 * a wrong digit becomes a silently wrong spreadsheet value that nothing
 * downstream can flag. Measured on rendered fixtures: a clean 200 DPI table
 * averages ~93% per word, while a degraded scan whose words still scatter into
 * plausible-looking columns averages 12–16%. 70 clears the 55% readability
 * floor above it, sits far above what noise produces, and still leaves room
 * for an ordinary imperfect scan.
 */
export const MIN_TABLE_CONFIDENCE = 70

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Flatten tesseract's block → paragraph → line → word nesting. */
export function collectWords(data: Pick<Page, 'blocks'>): OcrWord[] {
  const words: OcrWord[] = []
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          words.push({ text: word.text, confidence: word.confidence, bbox: word.bbox })
        }
      }
    }
  }
  return words
}

/**
 * The share of rows a column boundary may be straddled on and still count as a
 * boundary. Above zero so a spanning title or a stray merged cell does not
 * disqualify an otherwise clean table; low enough that prose, where every line
 * straddles every interior position, never qualifies.
 */
const MAX_STRADDLED_ROWS = 0.2

/**
 * Is every inferred column boundary a real whitespace gutter?
 *
 * This is the check that keeps paragraphs out of tables. grid-infer sees
 * per-WORD boxes here, not per-line ones, and prose word origins scatter
 * enough that a few of them cluster by luck; every line then has text on both
 * sides of the invented boundary, so the "share of rows using two columns"
 * score comes back near 1.0 and a page of running text turns into a
 * seventeen-column grid of fragments. A table is different in kind: its
 * columns are separated by white space that runs the height of the table, so
 * no word crosses the boundary. Prose has no such lane.
 */
function columnsHaveGutters(rows: PositionedText[][], columns: number[], tolerance: number): boolean {
  const allowed = Math.floor(rows.length * MAX_STRADDLED_ROWS)
  for (const origin of columns.slice(1)) {
    const straddled = rows.filter((row) =>
      row.some((item) => item.x0 < origin - tolerance && item.x1 > origin + tolerance),
    ).length
    if (straddled > allowed) return false
  }
  return true
}

/**
 * A table from word boxes, or null.
 *
 * Three independent gates, all of which must pass:
 *  1. mean per-word confidence — noise must never become a confident grid;
 *  2. whitespace gutters between the columns — see `columnsHaveGutters`;
 *  3. `inferGrid`'s own geometry score.
 *
 * The column tolerance is derived from the text size rather than fixed:
 * grid-infer's 2.5px default is calibrated for PDF points, and at the ~200 DPI
 * this pipeline rasterizes at, a single column's left edges already scatter by
 * 4–6px, which would split every column in two.
 */
export function gridFromWords(words: OcrWord[]): string[][] | null {
  const usable = words.filter((w) => w.text.trim() !== '')
  if (usable.length === 0) return null
  const meanConfidence = usable.reduce((sum, w) => sum + w.confidence, 0) / usable.length
  if (meanConfidence < MIN_TABLE_CONFIDENCE) return null

  const items: PositionedText[] = usable.map((w) => ({
    text: w.text.trim(),
    x0: w.bbox.x0,
    x1: w.bbox.x1,
    // OCR y grows downward; grid-infer wants the vertical midpoint.
    y: (w.bbox.y0 + w.bbox.y1) / 2,
    height: w.bbox.y1 - w.bbox.y0,
  }))
  const columnTolerance = Math.max(4, median(items.map((i) => i.height ?? 0)) * 0.4)

  const rows = groupIntoRows(items, true)
  const columns = inferColumns(rows, columnTolerance)
  if (columns.length < 2 || !columnsHaveGutters(rows, columns, columnTolerance)) return null

  const grid = inferGrid(items, { yIncreasesDownward: true, columnTolerance })
  return grid ? grid.rows : null
}

/** Recognize one raster: always text, plus a grid when the page is a table. */
async function recognizePage(worker: Worker, image: Buffer): Promise<{ page: OcrPage; confidence: number }> {
  const { data } = await worker.recognize(image, {}, { text: true, blocks: true })
  const grid = gridFromWords(collectWords(data))
  return {
    page: grid ? { text: data.text, grid } : { text: data.text },
    confidence: typeof data.confidence === 'number' ? data.confidence : 100,
  }
}

export async function ocrImage(bytes: Buffer, assets: OcrAssets, ctx?: ReadContext): Promise<OcrPage> {
  const worker = await newWorker(assets, ctx?.signal)
  try {
    ctx?.onProgress?.('Recognizing image')
    const { page, confidence } = await recognizePage(worker, bytes)
    throwIfAborted(ctx?.signal)
    if (page.text.trim() !== '' && confidence < minConfidenceFor(assets)) {
      throw new ConversionError(
        'ocr-failed',
        `OCR could not read this image reliably (${Math.round(confidence)}% confidence). ` +
          'It may be a logo, handwriting, or too low-resolution to recognize.',
      )
    }
    return page
  } catch (err) {
    if (err instanceof ConversionError) throw err
    throwIfAborted(ctx?.signal)
    throw new ConversionError('ocr-failed', `OCR failed: ${(err as Error).message}`)
  } finally {
    await worker.terminate().catch(() => {})
  }
}

/**
 * pdfjs sees process.versions.electron and takes its browser path, reaching
 * for document.createElement when it needs internal scratch canvases (masks,
 * patterns) — supply a @napi-rs/canvas-backed factory instead.
 */
function makeCanvasFactory(canvasMod: typeof import('@napi-rs/canvas')): new () => unknown {
  interface CanvasAndContext {
    canvas: { width: number; height: number; getContext(kind: '2d'): unknown } | null
    context: unknown
  }
  return class NapiCanvasFactory {
    create(width: number, height: number): CanvasAndContext {
      const canvas = canvasMod.createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)))
      return { canvas, context: canvas.getContext('2d') }
    }
    reset(cc: CanvasAndContext, width: number, height: number): void {
      if (!cc.canvas) return
      cc.canvas.width = Math.max(1, Math.ceil(width))
      cc.canvas.height = Math.max(1, Math.ceil(height))
    }
    destroy(cc: CanvasAndContext): void {
      if (cc.canvas) {
        cc.canvas.width = 0
        cc.canvas.height = 0
      }
      cc.canvas = null
      cc.context = null
    }
  }
}

/** Sequential per-page rasterize→recognize; buffers released page by page. */
export async function ocrPdf(bytes: Buffer, assets: OcrAssets, ctx?: ReadContext): Promise<OcrPage[]> {
  const canvasMod = await ensureCanvasGlobals()
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    CanvasFactory: makeCanvasFactory(canvasMod),
    isOffscreenCanvasSupported: false,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise
  const worker = await newWorker(assets, ctx?.signal)
  const pages: OcrPage[] = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      throwIfAborted(ctx?.signal)
      ctx?.onProgress?.(`OCR page ${i} of ${doc.numPages}`, ((i - 1) / doc.numPages) * 100)
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale: RASTER_SCALE })
      const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const canvasContext = canvas.getContext('2d')
      await page
        .render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: canvasContext as unknown as CanvasRenderingContext2D,
          viewport,
        })
        .promise
      const png = canvas.toBuffer('image/png')
      page.cleanup()
      throwIfAborted(ctx?.signal)
      const { page: recognized } = await recognizePage(worker, png)
      pages.push({ ...recognized, text: recognized.text.trim() })
    }
    ctx?.onProgress?.('OCR complete', 100)
    return pages
  } catch (err) {
    if (err instanceof ConversionError) throw err
    throwIfAborted(ctx?.signal)
    throw new ConversionError('ocr-failed', `OCR failed: ${(err as Error).message}`)
  } finally {
    await worker.terminate().catch(() => {})
    await doc.cleanup()
  }
}
