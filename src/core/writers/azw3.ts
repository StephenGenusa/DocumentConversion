import JSZip from 'jszip'
import { writeEpub } from './epub'
import { buildPalmDb } from './palmdb'
import { buildCncx, buildFdst, buildIndex, type IndexEntry } from './kf8-index'
import { EXTH, buildRecord0, exthString, exthUint, splitTextRecords, TEXT_RECORD_SIZE, type ExthRecord } from './mobi-header'
import { kindleFallback } from '../kindle-pictures'
import type { HubDocument } from '../types'

/**
 * AZW3 (KF8) output.
 *
 * KF8 is EPUB content in a PalmDB container - the same XHTML, the same spine -
 * so this writer does not re-derive anything. It calls `writeEpub`, takes the
 * chapters back out of the zip, and repackages them. Everything the EPUB writer
 * knows about splitting chapters and inlining images is reused rather than
 * reimplemented, which is what makes this cheap and what keeps the two outputs
 * consistent.
 *
 * Pictures: the EPUB's image files become KF8 resource records, after the
 * text and the indices, and each <img> points at its record as
 * `kindle:embed:XXXX?mime=...` (XXXX = the 1-based resource number in base
 * 32, as kindlegen and calibre write it). Before that every picture is made
 * one a Kindle stores - JPEG, PNG or GIF, under the size limit - by
 * Converter.write() (kindle-pictures.ts); any other still here becomes its
 * alt text. The EPUB writer's cover (never a drawn diagram) is named in
 * EXTH 201. No thumbnail (EXTH 202): a Kindle makes its own from the cover,
 * and making one would mean decoding the picture here.
 *
 * The text is stored uncompressed. PalmDOC LZ77 would shrink it, but every
 * modern reader handles uncompressed text and an incorrect compressor produces
 * a file that opens and shows nothing - a poor trade for a first version.
 */

/** Kindle screen widths mean fixed sizes read badly; strip them at the source. */
function chapterBody(xhtml: string): string {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml)?.[1] ?? xhtml
  return body.trim()
}

interface Resources {
  records: Buffer[]
  /** The EPUB's `images/<name>` to the reference that replaces it. */
  refs: Map<string, string>
  cover?: number
}

/** kindle:embed numbers are 1-based, base 32, four digits at least. */
function embedRef(index: number, mime: string): string {
  return `kindle:embed:${(index + 1).toString(32).toUpperCase().padStart(4, '0')}?mime=${mime}`
}

/** The EPUB's pictures, in manifest order, as resource records. */
async function resourcesOf(zip: JSZip): Promise<Resources> {
  const opf = (await zip.file('OEBPS/content.opf')?.async('string')) ?? ''
  const out: Resources = { records: [], refs: new Map() }
  for (const m of opf.matchAll(/<item id="[^"]*" href="images\/([^"]+)" media-type="(image\/[^"]+)"( properties="cover-image")?\/>/g)) {
    const bytes = await zip.file(`OEBPS/images/${m[1]}`)?.async('nodebuffer')
    if (!bytes) continue
    const index = out.records.length
    out.records.push(bytes)
    out.refs.set(`images/${m[1]}`, embedRef(index, m[2]))
    if (m[3]) out.cover = index
  }
  return out
}

/**
 * The record that ends the book: the four bytes kindlegen and Calibre write
 * (E9 8E CR LF). A lone NUL was read fine so far, but a reader that looks
 * for this marker to know where the resources stop would not find it.
 */
const EOF_RECORD = Buffer.from([0xe9, 0x8e, 0x0d, 0x0a])

export async function writeAzw3(doc: HubDocument): Promise<Buffer> {
  const html = kindleFallback(doc.html)
  const epub = await writeEpub(html === doc.html ? doc : { ...doc, html }, { notes: 'plain' })
  const zip = await JSZip.loadAsync(epub)
  const resources = await resourcesOf(zip)

  const chapterFiles = Object.keys(zip.files)
    .filter((n) => /\.x?html$/i.test(n) && !/nav|toc/i.test(n))
    .sort()
  const chapters = await Promise.all(
    chapterFiles.map(async (name) => chapterBody(await zip.files[name].async('string'))),
  )
  const bodies = (chapters.length > 0 ? chapters : ['<p></p>']).map((body) =>
    resources.records.length === 0
      ? body
      : body.replace(/(<img\b[^>]*?\bsrc=")(images\/[^"]+)"/g, (whole, head: string, src: string) => {
          const ref = resources.refs.get(src)
          return ref ? `${head}${ref}"` : whole
        }),
  )

  /*
   * Build the flow, recording where each chapter's skeleton and body land.
   *
   * A skeleton is the wrapper a fragment is spliced into. Ours is the minimal
   * one - <html><body> ... </body></html> - with the chapter body as a single
   * fragment inserted at the point between them.
   */
  /*
   * The EPUB's stylesheet is the book's second flow (FDST entry 1), linked
   * from each skeleton's head the way kindlegen does. Before it was, every
   * rule in style.css - code colouring among them - never reached the book.
   */
  const css = (await zip.file('OEBPS/style.css')?.async('string')) ?? ''
  const SKEL_OPEN = css
    ? '<html><head><link href="kindle:flow:0001?mime=text/css" rel="stylesheet" type="text/css"/></head><body>'
    : '<html><head></head><body>'
  const SKEL_CLOSE = '</body></html>'

  let flow = ''
  const skeletons: IndexEntry[] = []
  const fragments: IndexEntry[] = []
  const selectors: string[] = []

  bodies.forEach((body, i) => {
    const skeleton = SKEL_OPEN + SKEL_CLOSE
    const skelStart = Buffer.byteLength(flow, 'utf8')
    flow += skeleton
    flow += body

    skeletons.push({
      name: `SKEL${String(i).padStart(10, '0')}`,
      values: new Map([
        [1, [1]], // one fragment belongs to this skeleton
        [6, [skelStart, Buffer.byteLength(skeleton, 'utf8')]],
      ]),
    })
    selectors.push(`P-//*[@id='c${i}']`)
    fragments.push({
      /*
       * Two different frames of reference, and swapping them yields a chapter
       * that decodes but comes out sliced at the wrong byte:
       *
       *   name (insertOffset)  ABSOLUTE in the flow. The reader computes
       *                        `insertOffset - skel.offset` to place it.
       *   tag 6, first value   RELATIVE to the END of the skeleton, because
       *                        the reader computes `skel.length + offset`.
       */
      name: String(skelStart + Buffer.byteLength(SKEL_OPEN, 'utf8')),
      values: new Map([
        [2, [i]], // the selector's CNCX offset: set below, once all are known
        [3, [i]], // which skeleton (file) this fragment belongs to
        [4, [i]], // the fragment's sequence number
        [6, [0, Buffer.byteLength(body, 'utf8')]],
      ]),
    })
  })

  /*
   * Fragment tags, as kindlegen writes them and calibre and KindleUnpack read
   * them: 2 the selector's BYTE offset in the CNCX record (not its number),
   * 3 the skeleton (file) it belongs to, 4 its sequence number, 6 where its
   * bytes are. Without tag 3 calibre cannot open the book at all.
   */
  const { offsets: selectorOffsets } = buildCncx(selectors)
  fragments.forEach((f, i) => f.values.set(2, [selectorOffsets[i]]))

  const bookText = Buffer.from(flow, 'utf8')
  const text = Buffer.concat([bookText, Buffer.from(css, 'utf8')])
  const textRecords = splitTextRecords(text, TEXT_RECORD_SIZE)

  const skelRecords = buildIndex(skeletons, [
    { tag: 1, numValues: 1, mask: 0x01 },
    { tag: 6, numValues: 2, mask: 0x02 },
  ])
  const fragRecords = buildIndex(
    fragments,
    [
      { tag: 2, numValues: 1, mask: 0x01 },
      { tag: 3, numValues: 1, mask: 0x02 },
      { tag: 4, numValues: 1, mask: 0x04 },
      { tag: 6, numValues: 2, mask: 0x08 },
    ],
    selectors,
  )
  const flows: Array<[number, number]> = [[0, bookText.length]]
  if (css) flows.push([bookText.length, text.length])
  const fdst = buildFdst(flows)

  /*
   * Record indices are assigned before record 0 is built, because record 0 has
   * to name them. Order: 0 = header, then text, then FDST, skeleton index,
   * fragment index, then the pictures, then EOF. Pictures last but for EOF,
   * so a reader walking resources from firstImageIndex meets nothing else.
   */
  const firstNonBook = 1 + textRecords.length
  const fdstIndex = firstNonBook
  const skeletonIndex = fdstIndex + 1
  const fragmentIndex = skeletonIndex + skelRecords.length
  const firstResource = fragmentIndex + fragRecords.length
  const hasResources = resources.records.length > 0

  const pictureExth: ExthRecord[] = []
  if (hasResources) pictureExth.push(exthUint(EXTH.resourceCount, resources.records.length))
  if (resources.cover !== undefined) {
    pictureExth.push(exthUint(EXTH.coverOffset, resources.cover), exthUint(EXTH.hasFakeCover, 0))
  }

  const title = doc.title?.trim() || doc.sourceName?.trim() || 'Untitled'
  const record0 = buildRecord0({
    title,
    fileVersion: 8,
    textLength: text.length,
    textRecordCount: textRecords.length,
    firstNonBookIndex: firstNonBook,
    firstImageIndex: hasResources ? firstResource : 0xffffffff,
    fdstIndex,
    fdstCount: flows.length,
    skeletonIndex,
    fragmentIndex,
    exth: [
      exthString(EXTH.updatedTitle, title),
      exthString(EXTH.author, 'Unknown'),
      // 'EBOK' is what marks a file as a book rather than a personal document;
      // without it a Kindle files it under Docs and loses the cover.
      exthString(EXTH.cdeType, 'EBOK'),
      exthString(EXTH.language, 'en'),
      ...pictureExth,
    ],
  })

  return buildPalmDb({
    name: title.replace(/[^\x20-\x7e]/g, '_'),
    type: 'BOOK',
    creator: 'MOBI',
    records: [
      record0,
      ...textRecords,
      fdst,
      ...skelRecords,
      ...fragRecords,
      ...resources.records,
      EOF_RECORD,
    ],
  })
}
