import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, type PDFPage } from 'pdf-lib'
import { ConversionError } from './errors'
import { joinPartLinks, type PartHeading } from './pdf-part-links'

export interface PdfMergeInput {
  bytes: Buffer
  name?: string
}

export interface PdfMergeOptions {
  /** The inputs are one document printed in parts, linked by pdf-part-links.ts: join its links. */
  partLinks?: boolean
  /** With `partLinks`: the document's headings, for the bookmarks sidebar no part's own outline survives the join to give. */
  headings?: PartHeading[]
}

/**
 * A link that names its destination (`/Dest /sources`) looks the name up in
 * its document's catalog, and only pages are copied, so in the merged file
 * every such link went nowhere. Each is given the place itself instead: the
 * destination the source's catalog holds, on the copied page.
 */
function keepNamedDestinations(src: PDFDocument, copied: PDFPage[], out: PDFDocument): void {
  const dests = src.catalog.lookup(PDFName.of('Dests'))
  if (!(dests instanceof PDFDict)) return
  const copyOf = new Map<PDFRef, PDFRef>()
  src.getPages().forEach((page, i) => copyOf.set(page.ref, copied[i].ref))
  for (const page of copied) {
    const annots = page.node.Annots()
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = annots!.lookup(i)
      if (!(annot instanceof PDFDict)) continue
      const name = annot.get(PDFName.of('Dest'))
      if (!(name instanceof PDFName)) continue
      let dest = dests.lookup(name)
      if (dest instanceof PDFDict) dest = dest.lookup(PDFName.of('D'))
      const target = dest instanceof PDFArray ? dest.get(0) : undefined
      const onPage = target instanceof PDFRef ? copyOf.get(target) : undefined
      if (!(dest instanceof PDFArray) || !onPage) continue
      // The rest of a destination is names, numbers and nulls, which belong to no one document.
      annot.set(PDFName.of('Dest'), out.context.obj([onPage, ...dest.asArray().slice(1)]))
    }
  }
}

/**
 * Real PDF merge: pages are copied verbatim (text layers, images, fonts,
 * vectors — no interpretation, no hub round-trip). This is why a scanned PDF
 * merges fine even though it has no extractable text.
 */
export async function mergePdfs(inputs: PdfMergeInput[], opts: PdfMergeOptions = {}): Promise<Buffer> {
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
    keepNamedDestinations(src, pages, out)
    for (const page of pages) out.addPage(page)
  }
  if (opts.partLinks) joinPartLinks(out, opts.headings)
  return Buffer.from(await out.save())
}

/** One part that was linked for joining and then printed whole: its links are joined in place. Its bookmarks are Chromium's own, and stay. */
export async function joinLinksInOnePart(bytes: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.load(bytes)
  joinPartLinks(doc)
  return Buffer.from(await doc.save())
}
