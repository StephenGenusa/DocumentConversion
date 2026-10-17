import type { PdfLandscape, PdfPageSize, PdfRenderOptions } from './types'

export const PDF_PAGE_SIZES: PdfPageSize[] = ['Letter', 'A4', 'Legal', 'A3', 'Tabloid']

/** Chromium's printToPDF throws on scale outside 0.1–2.0, so clamp rather than trust the caller. */
export const MIN_SCALE = 0.1
export const MAX_SCALE = 2

/**
 * The zoom a PDF gets when nobody chose one. The shell's prose size is right
 * for a screen and a little large for paper: at 100% a typical markdown
 * document printed with oversized type and too few words per page, and 90%
 * reads well. The UI, the CLI and the headless path all start here.
 */
export const DEFAULT_PDF_SCALE = 0.9

/**
 * The page's margins as printToPDF lays them (main/conversion.ts), in inches:
 * Chromium's own 1 cm all round, and the top and bottom made room for the
 * header and footer when they are on. A page turned the other way from the
 * rest (orientation.ts) is sized from these.
 */
export const PRINT_MARGIN_INCHES = 1 / 2.54
export const HEADER_FOOTER_MARGIN_INCHES = 0.67

export function normalizePdfOptions(raw: unknown): PdfRenderOptions {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const scale =
    typeof obj.scale === 'number' && Number.isFinite(obj.scale)
      ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, obj.scale))
      : DEFAULT_PDF_SCALE
  const pageSize = PDF_PAGE_SIZES.includes(obj.pageSize as PdfPageSize) ? (obj.pageSize as PdfPageSize) : 'Letter'
  // Anything but a plain true or false is Automatic, the default.
  const landscape: PdfLandscape = typeof obj.landscape === 'boolean' ? obj.landscape : 'auto'
  const headerFooter = obj.headerFooter === true
  // headerText is deliberately not read from the input: it is derived main-side by the pdf writer.
  return { scale, pageSize, landscape, headerFooter }
}
