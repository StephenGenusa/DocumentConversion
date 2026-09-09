/**
 * The KF8 index records: FDST, and the INDX/TAGX pairs that map a flat text
 * flow back into chapters.
 *
 * KF8 does not store chapters. It stores one continuous run of XHTML and two
 * indices that say how to cut it up:
 *
 *   skeleton index  one entry per chapter: where its skeleton starts, how long
 *                   it is, and how many fragments belong to it
 *   fragment index  one entry per fragment: where in the skeleton it is
 *                   inserted, and where its own bytes live in the flow
 *
 * A reader rebuilds a chapter by taking its skeleton and splicing each fragment
 * in at the recorded offset. We emit one fragment per chapter - the whole
 * chapter body - which is the simplest arrangement the format allows and the
 * one least able to go subtly wrong.
 *
 * An INDX group is: a master record carrying a TAGX tag table, then one record
 * per block of entries, then the CNCX string records the entries point into.
 */

const INDX_HEADER_BYTES = 192

/** Tag values are stored 7 bits per byte, high bit set on the LAST byte. */
export function encodeVarLen(value: number): Buffer {
  const septets: number[] = []
  let v = value >>> 0
  do {
    septets.unshift(v & 0x7f)
    v >>>= 7
  } while (v > 0)
  septets[septets.length - 1] |= 0x80
  return Buffer.from(septets)
}

/** A CNCX record: each string prefixed by its length as a varlen. */
export function buildCncx(strings: string[]): { record: Buffer; offsets: number[] } {
  const parts: Buffer[] = []
  const offsets: number[] = []
  let at = 0
  for (const s of strings) {
    const body = Buffer.from(s, 'utf8')
    const len = encodeVarLen(body.length)
    offsets.push(at)
    parts.push(len, body)
    at += len.length + body.length
  }
  return { record: Buffer.concat(parts), offsets }
}

interface TagDefinition {
  tag: number
  numValues: number
  mask: number
}

/**
 * The TAGX table. Each definition is four bytes - tag, value count, bitmask,
 * end flag - and a terminating entry with the end flag set closes the control
 * byte. One control byte is enough for the handful of tags used here.
 */
function buildTagx(tags: TagDefinition[]): Buffer {
  const head = Buffer.alloc(12)
  head.write('TAGX', 0, 'latin1')
  head.writeUInt32BE(12 + (tags.length + 1) * 4, 4)
  head.writeUInt32BE(1, 8) // one control byte
  const rows = tags.map(({ tag, numValues, mask }) => Buffer.from([tag, numValues, mask, 0]))
  rows.push(Buffer.from([0, 0, 0, 1])) // end of control byte
  return Buffer.concat([head, ...rows])
}

function indxHeader(options: {
  length: number
  idxt: number
  numRecords: number
  numCncx: number
}): Buffer {
  const h = Buffer.alloc(INDX_HEADER_BYTES)
  h.write('INDX', 0, 'latin1')
  h.writeUInt32BE(options.length, 4)
  h.writeUInt32BE(0, 8) // type
  h.writeUInt32BE(options.idxt, 20)
  h.writeUInt32BE(options.numRecords, 24)
  h.writeUInt32BE(65001, 28) // encoding: UTF-8
  h.writeUInt32BE(0xffffffff, 32) // language
  h.writeUInt32BE(options.numRecords, 36) // total entries
  h.writeUInt32BE(0, 40) // ordt
  h.writeUInt32BE(0, 44) // ligt
  h.writeUInt32BE(0, 48) // numLigt
  h.writeUInt32BE(options.numCncx, 52)
  return h
}

export interface IndexEntry {
  /** The entry's name. For fragments this is the insertion offset, in decimal. */
  name: string
  /** Tag number to its values, in the order the TAGX table declares them. */
  values: Map<number, number[]>
}

/**
 * One INDX group: [master, entries, ...cncx].
 *
 * The entry record carries each entry as length-prefixed name, then one control
 * byte, then the tag values as varlens. IDXT at the end lists each entry's
 * offset so a reader can seek to it without walking.
 */
export function buildIndex(
  entries: IndexEntry[],
  tags: TagDefinition[],
  cncxStrings: string[] = [],
): Buffer[] {
  const tagx = buildTagx(tags)
  const master = Buffer.concat([
    indxHeader({ length: INDX_HEADER_BYTES, idxt: 0, numRecords: 1, numCncx: cncxStrings.length > 0 ? 1 : 0 }),
    tagx,
  ])

  const bodies: Buffer[] = []
  const offsets: number[] = []
  let at = INDX_HEADER_BYTES
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const parts: Buffer[] = [Buffer.from([name.length]), name]
    // One control byte: a bit per tag that is present.
    let control = 0
    for (const { tag, mask } of tags) if (entry.values.has(tag)) control |= mask
    parts.push(Buffer.from([control]))
    for (const { tag } of tags) {
      for (const value of entry.values.get(tag) ?? []) parts.push(encodeVarLen(value))
    }
    const body = Buffer.concat(parts)
    offsets.push(at)
    bodies.push(body)
    at += body.length
  }

  const idxtAt = at
  const idxt = Buffer.alloc(4 + offsets.length * 2 + ((offsets.length * 2) % 4 === 0 ? 0 : 2))
  idxt.write('IDXT', 0, 'latin1')
  offsets.forEach((o, i) => idxt.writeUInt16BE(o, 4 + i * 2))

  const entryRecord = Buffer.concat([
    indxHeader({ length: INDX_HEADER_BYTES, idxt: idxtAt, numRecords: entries.length, numCncx: 0 }),
    ...bodies,
    idxt,
  ])

  const records: Buffer[] = [master, entryRecord]
  if (cncxStrings.length > 0) records.push(buildCncx(cncxStrings).record)
  return records
}

/** FDST: the boundaries of each flow in the text. One flow here - the book. */
export function buildFdst(boundaries: Array<[number, number]>): Buffer {
  const head = Buffer.alloc(12)
  head.write('FDST', 0, 'latin1')
  head.writeUInt32BE(12, 4) // where the entries start
  head.writeUInt32BE(boundaries.length, 8)
  const rows = boundaries.map(([start, end]) => {
    const b = Buffer.alloc(8)
    b.writeUInt32BE(start, 0)
    b.writeUInt32BE(end, 4)
    return b
  })
  return Buffer.concat([head, ...rows])
}
