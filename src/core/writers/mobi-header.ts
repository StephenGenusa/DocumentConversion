/**
 * The record-0 headers every Kindle format shares: PalmDOC, MOBI and EXTH.
 *
 * All big-endian. Offsets here are not negotiable - a reader seeks to them
 * absolutely - so each field is written by name with its offset stated, rather
 * than by appending and hoping the cursor is where it should be.
 *
 * References: the MOBI format is not published by Amazon; these layouts come
 * from the long-standing community documentation that KindleUnpack, calibre
 * and mobi-parser all implement.
 */

/** Uncompressed. PalmDOC LZ77 is 2, HUFF/CDIC 17480; we write neither. */
export const COMPRESSION_NONE = 1
/** Text is UTF-8. The alternative, 1252, cannot carry most of the world. */
export const ENCODING_UTF8 = 65001
/** Text records are 4096 bytes by convention, and readers assume it. */
export const TEXT_RECORD_SIZE = 4096

export const MOBI_TYPE_BOOK = 2
/** 6 is MOBI, 8 is KF8 (AZW3). */
export type MobiFileVersion = 6 | 8

export interface ExthRecord {
  type: number
  data: Buffer
}

/** EXTH record types we set. There are ~130; these are the ones that matter. */
export const EXTH = {
  author: 100,
  publisher: 101,
  description: 103,
  isbn: 104,
  subject: 105,
  publishingDate: 106,
  contributor: 108,
  rights: 109,
  source: 112,
  asin: 113,
  cdeType: 501,
  updatedTitle: 503,
  language: 524,
} as const

export function exthString(type: number, value: string): ExthRecord {
  return { type, data: Buffer.from(value, 'utf8') }
}

/**
 * The EXTH block: 'EXTH', length, count, then each record as type/length/data.
 * The whole block is padded to a 4-byte boundary, which readers assume when
 * they compute where the full title begins.
 */
export function buildExth(records: ExthRecord[]): Buffer {
  const bodies = records.map(({ type, data }) => {
    const buf = Buffer.alloc(8 + data.length)
    buf.writeUInt32BE(type, 0)
    buf.writeUInt32BE(8 + data.length, 4)
    data.copy(buf, 8)
    return buf
  })
  const bodyLength = bodies.reduce((n, b) => n + b.length, 0)
  const unpadded = 12 + bodyLength
  const padding = (4 - (unpadded % 4)) % 4
  const head = Buffer.alloc(12)
  head.write('EXTH', 0, 'latin1')
  head.writeUInt32BE(unpadded + padding, 4)
  head.writeUInt32BE(records.length, 8)
  return Buffer.concat([head, ...bodies, Buffer.alloc(padding)])
}

export interface Record0Input {
  title: string
  fileVersion: MobiFileVersion
  /** Total length of the uncompressed text, in bytes. */
  textLength: number
  /** How many text records follow record 0. */
  textRecordCount: number
  /** Index of the first record that is not text. */
  firstNonBookIndex: number
  /** Index of the first image record, or 0xffffffff when there are none. */
  firstImageIndex: number
  exth: ExthRecord[]
  /** KF8 only: record index of the FDST record, and how many flows it names. */
  fdstIndex?: number
  fdstCount?: number
  /** KF8 only: record indices of the skeleton and fragment indices. */
  skeletonIndex?: number
  fragmentIndex?: number
}

const MOBI_HEADER_LENGTH = 264

/**
 * Record 0. PalmDOC header, then the MOBI header, then EXTH, then the title.
 *
 * `fullNameOffset` is relative to the start of RECORD 0, not the file, and a
 * reader that finds the wrong bytes there shows a book called whatever it hit -
 * which is the usual symptom of getting the EXTH padding wrong.
 */
export function buildRecord0(input: Record0Input): Buffer {
  const exth = buildExth(input.exth)
  const title = Buffer.from(input.title, 'utf8')

  const palmdoc = Buffer.alloc(16)
  palmdoc.writeUInt16BE(COMPRESSION_NONE, 0)
  palmdoc.writeUInt16BE(0, 2)
  palmdoc.writeUInt32BE(input.textLength, 4)
  palmdoc.writeUInt16BE(input.textRecordCount, 8)
  palmdoc.writeUInt16BE(TEXT_RECORD_SIZE, 10)
  palmdoc.writeUInt16BE(0, 12) // encryption: none
  palmdoc.writeUInt16BE(0, 14)

  const mobi = Buffer.alloc(MOBI_HEADER_LENGTH)
  mobi.write('MOBI', 0, 'latin1')
  mobi.writeUInt32BE(MOBI_HEADER_LENGTH, 4)
  mobi.writeUInt32BE(MOBI_TYPE_BOOK, 8)
  mobi.writeUInt32BE(ENCODING_UTF8, 12)
  mobi.writeUInt32BE(Math.floor(Math.random() * 0xffffffff) >>> 0, 16) // unique id
  mobi.writeUInt32BE(input.fileVersion, 20)
  // 24..63 are index offsets we do not use; 0xffffffff means "absent".
  for (let at = 24; at < 64; at += 4) mobi.writeUInt32BE(0xffffffff, at)
  mobi.writeUInt32BE(input.firstNonBookIndex, 64)
  // The title sits immediately after EXTH, measured from the start of record 0.
  mobi.writeUInt32BE(16 + MOBI_HEADER_LENGTH + exth.length, 68)
  mobi.writeUInt32BE(title.length, 72)
  mobi.writeUInt32BE(0, 76) // locale
  mobi.writeUInt32BE(0, 80) // input language
  mobi.writeUInt32BE(0, 84) // output language
  mobi.writeUInt32BE(input.fileVersion, 88) // minimum reader version
  mobi.writeUInt32BE(input.firstImageIndex, 92)
  mobi.writeUInt32BE(0, 96) // huffman record offset
  mobi.writeUInt32BE(0, 100) // huffman record count
  mobi.writeUInt32BE(0, 104) // huffman table offset
  mobi.writeUInt32BE(0, 108) // huffman table length
  mobi.writeUInt32BE(0x40, 112) // EXTH present
  mobi.writeUInt32BE(0xffffffff, 128) // DRM offset: none
  mobi.writeUInt32BE(0, 132) // DRM count
  mobi.writeUInt32BE(0, 136) // DRM size
  mobi.writeUInt32BE(0, 140) // DRM flags
  mobi.writeUInt32BE(0xffffffff, 228) // NCX index: none

  /*
   * KF8 index pointers.
   *
   * The published field offsets for these are stated relative to the START OF
   * RECORD 0, not to the start of the MOBI header - fdst at 192, frag at 248,
   * skel at 252 - and the MOBI header begins 16 bytes into record 0 after the
   * PalmDOC header. So every one of them is written 16 bytes earlier here.
   * Getting this wrong produces a file whose headers all validate and whose
   * text is unreachable, because the reader seeks 16 bytes past each table.
   */
  if (input.fileVersion === 8) {
    mobi.writeUInt32BE(input.fdstIndex ?? 0xffffffff, 192 - 16)
    mobi.writeUInt32BE(input.fdstCount ?? 0, 196 - 16)
    mobi.writeUInt32BE(input.fragmentIndex ?? 0xffffffff, 248 - 16)
    mobi.writeUInt32BE(input.skeletonIndex ?? 0xffffffff, 252 - 16)
  }

  return Buffer.concat([palmdoc, mobi, exth, title, Buffer.alloc(2)])
}

/** Split a UTF-8 buffer into fixed-size records, the last one short. */
export function splitTextRecords(text: Buffer, size = TEXT_RECORD_SIZE): Buffer[] {
  const out: Buffer[] = []
  for (let at = 0; at < text.length; at += size) out.push(text.subarray(at, at + size))
  return out.length > 0 ? out : [Buffer.alloc(0)]
}
