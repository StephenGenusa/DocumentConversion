import { renderDocumentShell, escapeHtml } from '../shell'
import { colorizeStatusEmoji } from '../emoji'
import {
  chunkHtmlForPrinting,
  countRows,
  countCells,
  MAX_ROWS_PER_CHUNK,
  MAX_CELLS_PER_CHUNK,
} from '../html-chunk'
import { mergePdfs } from '../pdf-merge'
import { ConversionError } from '../errors'
import type { ConvertOptions, HubDocument, PdfRenderOptions, RenderHtmlToPdf } from '../types'

/**
 * How many times a refused piece may be halved before we admit defeat. Each
 * round doubles the number of renders, so six is already 64 attempts on one
 * chunk; past that the problem is a single row, not the budget.
 */
const MAX_RETRY_SPLITS = 6

/**
 * Chromium refuses a page it cannot lay out with a bare "Printing failed" and
 * no output, and the point at which it does so is not one number: measured
 * against this shell it printed 1,500 rows x 200 columns (300,000 cells) but
 * not 1,500 x 300, and printed 4,000 x 40 (160,000 cells) but not 7,000 x 20
 * (140,000). Rows, cells, bytes and output page count each have a
 * counter-example. So the budget in html-chunk is a conservative opening bid,
 * not a guarantee — anything it gets wrong shows up here as a throw, and the
 * answer is to halve that piece and try again rather than lose the document.
 */
function isPrintingRefusal(err: unknown): boolean {
  return /printing failed|generate pdf/i.test((err as Error)?.message ?? '')
}

export function createPdfWriter(render: RenderHtmlToPdf) {
  return async (doc: HubDocument, opts?: ConvertOptions): Promise<Buffer> => {
    let pdfOpts: PdfRenderOptions | undefined = opts?.pdf
    if (pdfOpts?.headerFooter) {
      pdfOpts = { ...pdfOpts, headerText: escapeHtml(doc.title ?? doc.sourceName ?? '') }
    }
    const html = colorizeStatusEmoji(doc.html)
    const shell = (body: string): string => renderDocumentShell({ ...doc, html: body }, { target: 'pdf' })

    /** Render one piece, splitting it further if the renderer refuses it. */
    const renderPiece = async (body: string, maxRows: number, maxCells: number, depth: number): Promise<Buffer[]> => {
      try {
        return [await render(shell(body), pdfOpts)]
      } catch (err) {
        if (err instanceof ConversionError) throw err
        if (!isPrintingRefusal(err)) throw err
        const rows = countRows(body)
        const cells = countCells(body)
        // A document with no table is described by its size, not by rows: only
        // tables can be split, so prose reaches here as one indivisible piece.
        const size =
          rows > 0
            ? `${rows.toLocaleString()} row${rows === 1 ? '' : 's'} and ${cells.toLocaleString()} cells`
            : `${(body.length / 1e6).toFixed(1)} MB of content`
        const giveUp = (why: string): never => {
          throw new ConversionError(
            'write-failed',
            `This document is too big to turn into a PDF: the page renderer refused a piece of it holding ${size}, ${why}. ` +
              'Convert to HTML, CSV or XLSX instead, or split the source into smaller files and convert those.',
          )
        }
        if (depth >= MAX_RETRY_SPLITS) giveUp(`even after ${MAX_RETRY_SPLITS} rounds of splitting it smaller`)
        // Halve the piece itself, not the nominal budget: a document can be
        // refused while sitting far below the budget, and halving a number it
        // never reached splits nothing.
        const halfRows = Math.max(1, Math.floor(Math.min(maxRows, rows) / 2))
        const halfCells = Math.max(1, Math.floor(Math.min(maxCells, cells) / 2))
        const pieces = chunkHtmlForPrinting(body, halfRows, halfCells)
        if (pieces.length < 2) giveUp('and it cannot be split any smaller')
        const out: Buffer[] = []
        for (const piece of pieces) out.push(...(await renderPiece(piece, halfRows, halfCells, depth + 1)))
        return out
      }
    }

    // Chromium refuses a very large page outright, so render big documents in
    // pieces and stitch them back together.
    const oversized = countRows(html) > MAX_ROWS_PER_CHUNK || countCells(html) > MAX_CELLS_PER_CHUNK
    const chunks = oversized ? chunkHtmlForPrinting(html) : [html]
    const parts: { bytes: Buffer; name?: string }[] = []
    for (const chunk of chunks) {
      for (const bytes of await renderPiece(chunk, MAX_ROWS_PER_CHUNK, MAX_CELLS_PER_CHUNK, 0)) {
        parts.push({ bytes, name: `part ${parts.length + 1}` })
      }
    }
    return parts.length === 1 ? parts[0].bytes : mergePdfs(parts)
  }
}
