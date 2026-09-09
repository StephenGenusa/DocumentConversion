import JSZip from 'jszip'
import { writeEpub } from './epub'
import { buildPalmDb } from './palmdb'
import { buildFdst, buildIndex, type IndexEntry } from './kf8-index'
import { EXTH, buildRecord0, exthString, splitTextRecords, TEXT_RECORD_SIZE } from './mobi-header'
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
 * The text is stored uncompressed. PalmDOC LZ77 would shrink it, but every
 * modern reader handles uncompressed text and an incorrect compressor produces
 * a file that opens and shows nothing - a poor trade for a first version.
 */

/** Kindle screen widths mean fixed sizes read badly; strip them at the source. */
function chapterBody(xhtml: string): string {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml)?.[1] ?? xhtml
  return body.trim()
}

export async function writeAzw3(doc: HubDocument): Promise<Buffer> {
  const epub = await writeEpub(doc)
  const zip = await JSZip.loadAsync(epub)

  const chapterFiles = Object.keys(zip.files)
    .filter((n) => /\.x?html$/i.test(n) && !/nav|toc/i.test(n))
    .sort()
  const chapters = await Promise.all(
    chapterFiles.map(async (name) => chapterBody(await zip.files[name].async('string'))),
  )
  const bodies = chapters.length > 0 ? chapters : ['<p></p>']

  /*
   * Build the flow, recording where each chapter's skeleton and body land.
   *
   * A skeleton is the wrapper a fragment is spliced into. Ours is the minimal
   * one - <html><body> ... </body></html> - with the chapter body as a single
   * fragment inserted at the point between them.
   */
  const SKEL_OPEN = '<html><head></head><body>'
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
        [2, [i]], // index into the CNCX strings
        [4, [i]], // which skeleton this fragment belongs to
        [6, [0, Buffer.byteLength(body, 'utf8')]],
      ]),
    })
  })

  const text = Buffer.from(flow, 'utf8')
  const textRecords = splitTextRecords(text, TEXT_RECORD_SIZE)

  const skelRecords = buildIndex(skeletons, [
    { tag: 1, numValues: 1, mask: 0x01 },
    { tag: 6, numValues: 2, mask: 0x02 },
  ])
  const fragRecords = buildIndex(
    fragments,
    [
      { tag: 2, numValues: 1, mask: 0x01 },
      { tag: 4, numValues: 1, mask: 0x02 },
      { tag: 6, numValues: 2, mask: 0x04 },
    ],
    selectors,
  )
  const fdst = buildFdst([[0, text.length]])

  /*
   * Record indices are assigned before record 0 is built, because record 0 has
   * to name them. Order: 0 = header, then text, then FDST, skeleton index,
   * fragment index, then EOF.
   */
  const firstNonBook = 1 + textRecords.length
  const fdstIndex = firstNonBook
  const skeletonIndex = fdstIndex + 1
  const fragmentIndex = skeletonIndex + skelRecords.length

  const title = doc.title?.trim() || doc.sourceName?.trim() || 'Untitled'
  const record0 = buildRecord0({
    title,
    fileVersion: 8,
    textLength: text.length,
    textRecordCount: textRecords.length,
    firstNonBookIndex: firstNonBook,
    firstImageIndex: 0xffffffff,
    fdstIndex,
    fdstCount: 1,
    skeletonIndex,
    fragmentIndex,
    exth: [
      exthString(EXTH.updatedTitle, title),
      exthString(EXTH.author, 'Unknown'),
      // 'EBOK' is what marks a file as a book rather than a personal document;
      // without it a Kindle files it under Docs and loses the cover.
      exthString(EXTH.cdeType, 'EBOK'),
      exthString(EXTH.language, 'en'),
    ],
  })

  return buildPalmDb({
    name: title.replace(/[^\x20-\x7e]/g, '_'),
    type: 'BOOK',
    creator: 'MOBI',
    records: [record0, ...textRecords, fdst, ...skelRecords, ...fragRecords, Buffer.from('\0', 'latin1')],
  })
}
