import { picturePages } from './lone-picture'
import { measureTables, pageColumns } from './page-fit'
import type { PdfLandscape, PdfPageInches, PdfPageSize } from './types'

/*
 * Automatic orientation (the toolbar's default; CLI --orientation auto).
 * Portrait and Landscape are exact: every page is printed as asked. Automatic
 * chooses from the document, and only where the document says plainly what
 * its page is:
 *
 * - Pictures alone (lone-picture.ts picturePages: a picture opened on its
 *   own, a TIFF of several pages): each page takes its picture's shape, so a
 *   wide drawing prints on a landscape page and a fax of portrait and
 *   landscape pages keeps each one's. A picture whose size cannot be told,
 *   or a square one, stays portrait.
 * - Wide tables (named paper sizes only): a document whose text is mostly in
 *   tables too wide for a portrait page, even with columns sized by what
 *   they hold (shell.ts autoTables), prints landscape. A report with one
 *   wide table among its prose stays portrait, and the page-fit tip says
 *   landscape would fit.
 *
 * Everything else is portrait, as it always was.
 */

/** What a page is printed with: one orientation for the whole document, or each page its own. */
export interface PageOrientation {
  /** The orientation printToPDF is given: every page's, or the default page's when `pages` is given. */
  landscape: boolean
  /**
   * Pictures a page whose pages are not all one way: per page, whether it is
   * landscape. The default page is then portrait and the landscape pages are
   * turned with a named page (shell.ts); a page sized from the default
   * page's is drawn wrong on a landscape default, so portrait it is.
   */
  pages?: boolean[]
}

/** The share of a document's text that must be in too-wide tables before Automatic turns the page. */
export const WIDE_TABLE_SHARE = 0.5

/** The document's text, roughly: characters outside tags, spaces left out, each reference one. */
function textLength(html: string): number {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&[#\w]+;/g, 'x')
    .replace(/\s+/g, '').length
}

/** Whether most of the document's text is in tables wider than a portrait page of this size. */
export function wideTablesDominate(html: string, pageSize: PdfPageSize): boolean {
  if (!/<table[\s>]/i.test(html)) return false
  const portrait = pageColumns(pageSize, false)
  const wide = measureTables(html)
    .filter((t) => t.needed > portrait)
    .reduce((sum, t) => sum + t.text, 0)
  if (wide === 0) return false
  return wide >= WIDE_TABLE_SHARE * textLength(html)
}

/**
 * The orientation a document is printed with. `landscape` is what was asked:
 * true or false is kept exactly; 'auto' is chosen here (see above).
 */
export function chooseOrientation(
  html: string,
  landscape: PdfLandscape,
  pageSize: PdfPageSize | PdfPageInches,
): PageOrientation {
  if (landscape !== 'auto') return { landscape }
  const pictures = picturePages(html)
  if (pictures) {
    const wide = pictures.sizes.map((size) => !!size && size.width > size.height)
    if (wide.every(Boolean)) return { landscape: true }
    if (!wide.some(Boolean)) return { landscape: false }
    return { landscape: false, pages: wide }
  }
  // Page-fit is measured in named paper; an inch page is one this app chose (the Kindle's).
  if (typeof pageSize === 'string' && wideTablesDominate(html, pageSize)) return { landscape: true }
  return { landscape: false }
}
