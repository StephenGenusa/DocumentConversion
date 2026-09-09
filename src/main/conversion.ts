import { BrowserWindow } from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { createConverter } from '../core/convert'
import { getReader } from '../core/readers'
import { normalizePdfOptions } from '../core/pdf-options'
import { ConversionError } from '../core/errors'
import { mergeHubDocuments } from '../core/merge'
import { mergePdfs, type PdfMergeInput } from '../core/pdf-merge'
import { escapeHtml } from '../core/shell'
import { runOcr } from './ocr-host'
import { throwIfCancelled, untilCancelled } from './jobs'
import { looksLikeHeader, rowsToHtmlTable } from '../core/readers/csv'
import { extractPdfPageLines, pdfPagesToHub, type PdfPageSource } from '../core/readers/pdf'
import type { OcrPage } from '../ocr/pipeline'
import { advisePageFit } from '../core/page-fit'
import type {
  ConvertOptions,
  HubDocument,
  PdfRenderOptions,
  ReadContext,
  SourceFormat,
  TargetFormat,
  WriteResult,
} from '../core/types'

export async function renderHtmlToPdf(html: string, opts?: PdfRenderOptions): Promise<Buffer> {
  const { scale, pageSize, landscape, headerFooter, headerText } = opts ?? normalizePdfOptions(undefined)
  // Chromium draws header/footer templates inside the page margin: templates
  // need explicit font-size (default renders invisibly) and ~48pt of margin.
  const headerFooterOpts = headerFooter
    ? {
        displayHeaderFooter: true,
        headerTemplate: `<div style="font-size:9px; width:100%; padding:0 0.4in; display:flex; justify-content:space-between;"><span>${headerText ?? ''}</span><span class="date"></span></div>`,
        footerTemplate: `<div style="font-size:9px; width:100%; text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
        margins: { top: 0.67, bottom: 0.67 },
      }
    : {}
  const dir = await mkdtemp(join(tmpdir(), 'docconv-'))
  const file = join(dir, 'doc.html')
  await writeFile(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false, webSecurity: true },
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await win.loadFile(file)
    const data = await win.webContents.printToPDF({
      printBackground: true,
      scale,
      pageSize,
      landscape,
      ...headerFooterOpts,
    })
    return data
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await rm(dir, { recursive: true, force: true })
  }
}

export const converter = createConverter(renderHtmlToPdf)

/**
 * OCR pages to one hub document.
 *
 * Pages the OCR pipeline reconstructed as a grid become real `<table>` markup
 * — which is what lets a scanned table reach csv/json/xlsx at all, and what
 * stops columns from collapsing into whitespace on the way to md/docx/pdf.
 * Everything else still goes through the txt reader as paragraphs, and
 * consecutive text pages are handed over in one piece so a paragraph broken
 * across a page boundary is not split into two.
 */
export async function ocrPagesToHub(pages: OcrPage[], filename?: string): Promise<HubDocument> {
  const parts: string[] = []
  let pending: string[] = []
  const flushText = async (): Promise<void> => {
    const text = pending.join('\n\n').trim()
    pending = []
    if (text === '') return
    parts.push((await getReader('txt')({ bytes: Buffer.from(text, 'utf8') })).html)
  }
  for (const page of pages) {
    if (page.grid && page.grid.length > 0) {
      await flushText()
      parts.push(rowsToHtmlTable(page.grid, looksLikeHeader(page.grid)))
      continue
    }
    pending.push(page.text)
  }
  await flushText()
  const hub: HubDocument = { html: parts.join('\n') || '<p></p>' }
  if (filename) {
    hub.title ??= filename
    hub.sourceName ??= filename
  }
  return hub
}

/** OCR-aware read: image OCR mode, and scanned-pdf recovery when opted in. */
export async function readForConversion(
  bytes: Buffer,
  filename: string | undefined,
  source: SourceFormat,
  ocr: boolean,
  ctx: ReadContext,
  ocrLanguage?: string,
): Promise<HubDocument> {
  throwIfCancelled(ctx.signal)
  if (source === 'image' && ocr) {
    return ocrPagesToHub(await runOcr('image', bytes, ctx, ocrLanguage), filename)
  }
  // A PDF with SOME image-only pages never throws scanned-pdf, so those pages
  // would silently vanish; with --ocr on, fill just those pages from OCR.
  if (source === 'pdf' && ocr) {
    const pageLines = await untilCancelled(extractPdfPageLines({ bytes, filename }), ctx.signal)
    if (pageLines.some((lines) => lines.length === 0)) {
      const recognized = await runOcr('pdf', bytes, ctx, ocrLanguage)
      // Every page contributes its BEST representation, not its lowest common
      // one. Merging through text alone used to drop two things at once: the
      // grid OCR had already reconstructed for a scanned page, and the column
      // geometry of the native pages, which is what their own table detection
      // runs on. Both survived on a wholly scanned PDF and on a plain image,
      // so a scanned table lost its columns only when it sat inside an
      // otherwise-native document — the case hardest to notice.
      const pages: PdfPageSource[] = pageLines.map((lines, i) => {
        if (lines.length > 0) return { kind: 'lines', lines }
        const page = recognized[i]
        if (page?.grid && page.grid.length > 0) return { kind: 'table', rows: page.grid }
        return { kind: 'text', text: page?.text ?? '' }
      })
      const hub = pdfPagesToHub(pages)
      if (filename) {
        hub.title ??= filename
        hub.sourceName ??= filename
      }
      return hub
    }
  }
  try {
    return await untilCancelled(converter.read({ bytes, filename }, source, ctx), ctx.signal)
  } catch (err) {
    if (err instanceof ConversionError && err.code === 'scanned-pdf' && ocr) {
      return ocrPagesToHub(await runOcr('pdf', bytes, ctx, ocrLanguage), filename)
    }
    throw err
  }
}

export async function runConversion(
  bytes: Buffer,
  filename: string | undefined,
  source: SourceFormat,
  target: TargetFormat,
  opts: ConvertOptions,
  ctx: ReadContext,
): Promise<WriteResult> {
  throwIfCancelled(ctx.signal)
  // PDF -> PDF is a re-save, not a re-typesetting: route it through the
  // page-for-page copier so images, signatures and vector art survive.
  // (Rendering the extracted text instead silently discarded all graphics.)
  if (source === 'pdf' && target === 'pdf' && !opts.ocr) {
    const copied = await untilCancelled(mergePdfs([{ bytes, name: filename }]), ctx.signal)
    return { parts: [{ suffix: '', bytes: copied }] }
  }
  const hub = await readForConversion(bytes, filename, source, opts.ocr === true, ctx, opts.ocrLanguage)
  // Cancel between read and write: the read cannot be unwound, but nothing
  // downstream — writing, and the file the caller would save — must happen.
  throwIfCancelled(ctx.signal)
  if (target === 'pdf' && opts.pdf) {
    // Tell the user when a different page setup would fit their tables; never
    // change orientation or paper size behind their back.
    // Page-fit advice is about named paper sizes; an explicit inch page is one
    // this app chose (AZW4), not one the user can act on.
    const named = typeof opts.pdf.pageSize === 'string' ? opts.pdf.pageSize : undefined
    const advice = advisePageFit(hub.html, named, opts.pdf.landscape)
    if (advice.suggestion) ctx.onAdvice?.('landscape', advice.reason ?? '', advice.suggestion)
  }
  return untilCancelled(converter.write(hub, target, opts), ctx.signal)
}

/**
 * The two flavours "copy as HTML" puts on the clipboard: rich, for Word, Teams
 * and Outlook paste targets, and plain, for editors. One read serves both.
 * This used to be two full conversions, and the second ran with no signal at
 * all — so a cancel during it was ignored, the clipboard was overwritten and
 * the reply said "copied". A large PDF was also read twice.
 */
export async function clipboardFlavors(
  bytes: Buffer,
  filename: string | undefined,
  source: SourceFormat,
  opts: ConvertOptions,
  ctx: ReadContext,
): Promise<{ html: string; text: string }> {
  throwIfCancelled(ctx.signal)
  const hub = await readForConversion(bytes, filename, source, opts.ocr === true, ctx, opts.ocrLanguage)
  throwIfCancelled(ctx.signal)
  const html = await untilCancelled(converter.write(hub, 'html', opts), ctx.signal)
  const text = await untilCancelled(converter.write(hub, 'txt', opts), ctx.signal)
  throwIfCancelled(ctx.signal)
  return { html: html.parts[0].bytes.toString('utf8'), text: text.parts[0].bytes.toString('utf8') }
}

export interface MergeItem {
  bytes: Buffer
  filename?: string
  source: SourceFormat
  ocr: boolean
}

/**
 * Merge to any target. Merging TO PDF is a real page-for-page merge: PDF
 * inputs pass through verbatim via pdf-lib (text layers, images, everything —
 * no interpretation, so scanned PDFs merge fine and never need OCR); only
 * non-PDF inputs are rendered to PDF fragments. Other targets concatenate
 * through the HTML hub as before.
 */
export async function mergeToTarget(
  items: MergeItem[],
  target: TargetFormat,
  opts: ConvertOptions,
  headings: boolean,
  ctx: ReadContext,
): Promise<WriteResult> {
  if (items.length === 0) throw new ConversionError('merge-empty', 'Nothing to merge')
  if (target === 'pdf') {
    const fragments: PdfMergeInput[] = []
    for (let i = 0; i < items.length; i++) {
      // Per input, not just per read: a pdf input is copied rather than read,
      // so without this a cancelled merge of PDFs ran to the last page.
      throwIfCancelled(ctx.signal)
      const item = items[i]
      const name = item.filename ?? `document ${i + 1}`
      if (item.source === 'pdf') {
        ctx.onProgress?.(`Adding ${name} (${i + 1} of ${items.length})`)
        fragments.push({ bytes: item.bytes, name })
        continue
      }
      ctx.onProgress?.(`Rendering ${name} (${i + 1} of ${items.length})`)
      const hub = await readForConversion(item.bytes, item.filename, item.source, item.ocr, ctx)
      const withHeading = headings
        ? { ...hub, html: `<h1 class="doc-title">${escapeHtml(hub.sourceName ?? name)}</h1>\n${hub.html}` }
        : hub
      const rendered = await untilCancelled(converter.write(withHeading, 'pdf', opts), ctx.signal)
      fragments.push({ bytes: rendered.parts[0].bytes, name })
    }
    throwIfCancelled(ctx.signal)
    return { parts: [{ suffix: '', bytes: await untilCancelled(mergePdfs(fragments), ctx.signal) }] }
  }
  const hubs: HubDocument[] = []
  for (let i = 0; i < items.length; i++) {
    throwIfCancelled(ctx.signal)
    const item = items[i]
    ctx.onProgress?.(`Reading ${item.filename ?? `document ${i + 1}`} (${i + 1} of ${items.length})`)
    hubs.push(await readForConversion(item.bytes, item.filename, item.source, item.ocr, ctx))
  }
  throwIfCancelled(ctx.signal)
  return untilCancelled(converter.write(mergeHubDocuments(hubs, { headings }), target, opts), ctx.signal)
}
