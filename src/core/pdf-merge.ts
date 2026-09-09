import { PDFDocument } from 'pdf-lib'
import { ConversionError } from './errors'

export interface PdfMergeInput {
  bytes: Buffer
  name?: string
}

/**
 * Real PDF merge: pages are copied verbatim (text layers, images, fonts,
 * vectors — no interpretation, no hub round-trip). This is why a scanned PDF
 * merges fine even though it has no extractable text.
 */
export async function mergePdfs(inputs: PdfMergeInput[]): Promise<Buffer> {
  if (inputs.length === 0) throw new ConversionError('merge-empty', 'Nothing to merge')
  const out = await PDFDocument.create()
  for (const input of inputs) {
    let src: PDFDocument
    try {
      src = await PDFDocument.load(input.bytes, { ignoreEncryption: false })
    } catch (err) {
      throw new ConversionError(
        'read-failed',
        `Could not read ${input.name ?? 'a PDF input'} for merging: ${(err as Error).message}`,
      )
    }
    const pages = await out.copyPages(src, src.getPageIndices())
    for (const page of pages) out.addPage(page)
  }
  return Buffer.from(await out.save())
}
