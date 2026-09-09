import { createPdfWriter } from './pdf'
import { buildPalmDb } from './palmdb'
import { EXTH, buildRecord0, exthString } from './mobi-header'
import { KINDLE_PAGE_INCHES, type ConvertOptions, type HubDocument, type RenderHtmlToPdf } from '../types'

/**
 * AZW4: a PDF in a Kindle container.
 *
 * Unlike AZW3 this is not reflowable. The PDF is embedded whole and the device
 * displays it as a fixed page, so the page size chosen at render time is the
 * page size on the device, permanently.
 *
 * That is why the page is FORCED to the Kindle's own dimensions and the user's
 * Letter/A4 choice is deliberately ignored for this target. A Letter page on a
 * 6-inch screen renders at roughly a third of legible size, and unlike every
 * other target here there is no later opportunity to fix it: the reader cannot
 * reflow what it was given.
 *
 * `KINDLE_PAGE_INCHES` is 3.6 x 4.8 - the 6 inch is the screen's diagonal, and
 * 600x800 at about 167 ppi is what that measures out to.
 *
 * The PDF payload is preceded by a `%MOP` marker record, which is what
 * identifies a print-replica book to the tools that read this format.
 */

const PDF_MARKER = '%MOP'
/** Records are chunked so no single record is unreasonably large. */
const RECORD_SIZE = 4096

export function createAzw4Writer(render: RenderHtmlToPdf) {
  const writePdf = createPdfWriter(render)

  return async (doc: HubDocument, opts?: ConvertOptions): Promise<Buffer> => {
    /*
     * Everything about the page is overridden, not merged: scale and
     * orientation are as meaningless here as paper size, because the target
     * dictates all three.
     */
    const pdf = await writePdf(doc, {
      ...opts,
      pdf: {
        scale: 1,
        pageSize: KINDLE_PAGE_INCHES,
        landscape: false,
        headerFooter: false,
      },
    })

    const payload = Buffer.concat([Buffer.from(PDF_MARKER, 'latin1'), pdf])
    const dataRecords: Buffer[] = []
    for (let at = 0; at < payload.length; at += RECORD_SIZE) {
      dataRecords.push(payload.subarray(at, at + RECORD_SIZE))
    }

    const title = doc.title?.trim() || doc.sourceName?.trim() || 'Untitled'
    const record0 = buildRecord0({
      title,
      fileVersion: 6,
      textLength: payload.length,
      textRecordCount: dataRecords.length,
      firstNonBookIndex: 1 + dataRecords.length,
      firstImageIndex: 0xffffffff,
      exth: [
        exthString(EXTH.updatedTitle, title),
        exthString(EXTH.author, 'Unknown'),
        // PDOC, not EBOK: this is a print replica, and saying otherwise makes a
        // Kindle promise reflow it cannot deliver.
        exthString(EXTH.cdeType, 'PDOC'),
        exthString(EXTH.language, 'en'),
      ],
    })

    return buildPalmDb({
      name: title.replace(/[^\x20-\x7e]/g, '_'),
      type: 'BOOK',
      creator: 'MOBI',
      records: [record0, ...dataRecords, Buffer.from('\0', 'latin1')],
    })
  }
}

/**
 * Recover the embedded PDF. Exported because it is the only honest test we can
 * write for this format - there is no JS AZW4 reader, so "the bytes we put in
 * come back out" is the property available to assert.
 */
export function extractAzw4Pdf(bytes: Buffer): Buffer | null {
  const at = bytes.indexOf(Buffer.from(PDF_MARKER, 'latin1'))
  if (at === -1) return null
  const pdf = bytes.subarray(at + PDF_MARKER.length)
  const end = pdf.lastIndexOf(Buffer.from('%%EOF', 'latin1'))
  return end === -1 ? pdf : pdf.subarray(0, end + 5)
}
