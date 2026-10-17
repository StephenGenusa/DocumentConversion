/*
 * What a picture's header says, read in core without decoding a pixel: the
 * pages of a TIFF and their sizes, one page of a TIFF taken out on its own
 * (its strips copied byte for byte), and the size of an EMF or WMF. Every
 * offset is checked against the file before it is followed, and a TIFF's
 * chain of pages is followed each offset once, so a hostile file costs a
 * null, never a hang or a read out of bounds. Pixels are decoded only in the
 * render host's sandboxed page (pictures.ts).
 */

/** The most IFDs of one TIFF that are followed: past that, the file is refused. */
export const MAX_TIFF_IFDS = 1000

export interface TiffPage {
  /** The page's place in the file's chain of IFDs (0 for the first). */
  index: number
  width: number
  height: number
  /** Pixels per inch, when the file says (ResolutionUnit inch or centimetre). */
  dpi?: { x: number; y: number }
}

/** Bytes of one value of each TIFF field type (6.0 and the IFD type, 13). */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 }

interface Entry {
  tag: number
  type: number
  count: number
  /** Where the value's bytes are in the file, or -1 when they are not all in it. */
  at: number
  bytes: number
}

interface Tiff {
  bytes: Buffer
  be: boolean
  /** Each IFD: its offset and entries, in chain order. */
  ifds: { offset: number; entries: Entry[] }[]
}

function u16(t: Tiff, at: number): number {
  return t.be ? t.bytes.readUInt16BE(at) : t.bytes.readUInt16LE(at)
}
function u32(t: Tiff, at: number): number {
  return t.be ? t.bytes.readUInt32BE(at) : t.bytes.readUInt32LE(at)
}

/** The file's IFD chain, or null when it is not a classic TIFF or its chain is broken (loops, runs off the end, is too long). */
function readTiff(bytes: Buffer): Tiff | null {
  if (bytes.length < 8) return null
  const order = bytes.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') return null
  const t: Tiff = { bytes, be: order === 'MM', ifds: [] }
  if (u16(t, 2) !== 42) return null
  const seen = new Set<number>()
  let offset = u32(t, 4)
  while (offset !== 0) {
    if (seen.has(offset) || seen.size >= MAX_TIFF_IFDS) return null
    seen.add(offset)
    if (offset + 2 > bytes.length) return null
    const n = u16(t, offset)
    const end = offset + 2 + n * 12
    if (end + 4 > bytes.length) return null
    const entries: Entry[] = []
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12
      const type = u16(t, e + 2)
      const size = TYPE_SIZE[type]
      if (!size) continue
      const count = u32(t, e + 4)
      const total = count * size
      const at = total <= 4 ? e + 8 : u32(t, e + 8)
      entries.push({ tag: u16(t, e), type, count, at: at + total <= bytes.length ? at : -1, bytes: total })
    }
    t.ifds.push({ offset, entries })
    offset = u32(t, end)
  }
  return t
}

/** A SHORT or LONG field's values (empty when it has none, another type, or its bytes are not all in the file). */
function numbers(t: Tiff, entry: Entry | undefined): number[] {
  if (!entry || entry.at < 0 || (entry.type !== 3 && entry.type !== 4)) return []
  const out: number[] = []
  for (let k = 0; k < entry.count; k++) out.push(entry.type === 3 ? u16(t, entry.at + k * 2) : u32(t, entry.at + k * 4))
  return out
}

function rational(t: Tiff, entry: Entry | undefined): number | undefined {
  if (!entry || entry.at < 0 || entry.type !== 5 || entry.count < 1) return undefined
  const d = u32(t, entry.at + 4)
  return d > 0 ? u32(t, entry.at) / d : undefined
}

function pageOf(t: Tiff, index: number): TiffPage | null {
  const entries = t.ifds[index].entries
  const field = (tag: number): Entry | undefined => entries.find((e) => e.tag === tag)
  // NewSubfileType bit 0: a reduced-resolution copy of another page (a preview), not a page.
  if ((numbers(t, field(254))[0] ?? 0) & 1) return null
  const width = numbers(t, field(256))[0]
  const height = numbers(t, field(257))[0]
  if (!(width > 0 && height > 0)) return null
  const page: TiffPage = { index, width, height }
  const unit = numbers(t, field(296))[0] ?? 2
  const x = rational(t, field(282))
  const y = rational(t, field(283))
  const perInch = unit === 2 ? 1 : unit === 3 ? 2.54 : 0
  if (perInch && x && y && x * perInch >= 10 && y * perInch >= 10 && x * perInch <= 10000 && y * perInch <= 10000) {
    page.dpi = { x: x * perInch, y: y * perInch }
  }
  return page
}

/**
 * The pages a TIFF holds, in order: every IFD in its chain with a size, but
 * not a reduced-resolution copy (a preview a scanner or camera adds). Null
 * when the file is not a TIFF this app reads or its chain is broken.
 */
export function tiffPages(bytes: Buffer): TiffPage[] | null {
  const t = readTiff(bytes)
  if (!t) return null
  const pages: TiffPage[] = []
  for (let i = 0; i < t.ifds.length; i++) {
    const page = pageOf(t, i)
    if (page) pages.push(page)
  }
  return pages
}

/**
 * Fields that point at other places in the file (sub-IFDs, Exif, GPS and
 * interoperability IFDs): left out of a page taken out on its own, where
 * they would point at nothing. A page needs none of them to be shown.
 */
const POINTERS = new Set([330, 0x8769, 0x8825, 0xa005])

/** The data a page's offsets point at, by offsets tag and the tag of their byte counts. */
const DATA = [
  [273, 279], // StripOffsets, StripByteCounts
  [324, 325], // TileOffsets, TileByteCounts
  [513, 514], // JPEGInterchangeFormat (old-style JPEG), and its length
] as const

/**
 * The page at `index` in a TIFF's chain, as a one-page TIFF of its own: the
 * same byte order, the same fields, the same strips (or tiles) byte for
 * byte, so nothing is decoded or re-encoded. Null when there is no such
 * page or its data is not all in the file.
 */
export function tiffPage(bytes: Buffer, index: number): Buffer | null {
  const t = readTiff(bytes)
  if (!t || !t.ifds[index] || !pageOf(t, index)) return null
  const entries = t.ifds[index].entries.filter((e) => !POINTERS.has(e.tag))
  const field = (tag: number): Entry | undefined => entries.find((e) => e.tag === tag)
  // Each block of data: where it is, how long, and which field's which value names it.
  const blocks: { from: number; length: number }[] = []
  const rewritten = new Map<number, number[]>()
  for (const [offsetsTag, countsTag] of DATA) {
    const offsets = field(offsetsTag)
    if (!offsets) continue
    const at = numbers(t, offsets)
    const counts = numbers(t, field(countsTag))
    if (at.length === 0 || at.length !== counts.length) return null
    const first = blocks.length
    for (let k = 0; k < at.length; k++) {
      if (at[k] + counts[k] > bytes.length) return null
      blocks.push({ from: at[k], length: counts[k] })
    }
    rewritten.set(offsetsTag, at.map((_, k) => first + k))
  }
  if (!field(273) && !field(324)) return null

  // Layout: header, IFD, the values that do not fit in their entries, the data.
  const kept = entries.filter((e) => e.at >= 0 || rewritten.has(e.tag))
  const ifdLength = 2 + kept.length * 12 + 4
  let at = 8 + ifdLength
  const valueAt = new Map<Entry, number>()
  for (const e of kept) {
    // An offsets field is written as LONGs, whatever it was.
    const length = rewritten.has(e.tag) ? e.count * 4 : e.bytes
    if (length > 4) {
      valueAt.set(e, at)
      at += length + (length % 2)
    }
  }
  const blockAt: number[] = []
  for (const b of blocks) {
    blockAt.push(at)
    at += b.length + (b.length % 2)
  }
  const out = Buffer.alloc(at)
  const w16 = (v: number, p: number): number => (t.be ? out.writeUInt16BE(v, p) : out.writeUInt16LE(v, p))
  const w32 = (v: number, p: number): number => (t.be ? out.writeUInt32BE(v, p) : out.writeUInt32LE(v, p))
  out.write(t.be ? 'MM' : 'II', 0, 'latin1')
  w16(42, 2)
  w32(8, 4)
  w16(kept.length, 8)
  kept.forEach((e, i) => {
    const p = 8 + 2 + i * 12
    const blockIndexes = rewritten.get(e.tag)
    w16(e.tag, p)
    w16(blockIndexes ? 4 : e.type, p + 2)
    w32(e.count, p + 4)
    const target = valueAt.get(e) ?? p + 8
    if (target !== p + 8) w32(target, p + 8)
    if (blockIndexes) blockIndexes.forEach((b, k) => w32(blockAt[b], target + k * 4))
    else bytes.copy(out, target, e.at, e.at + e.bytes)
  })
  // Next IFD: none (already zero).
  blocks.forEach((b, i) => bytes.copy(out, blockAt[i], b.from, b.from + b.length))
  return out
}

/** A picture's size as it is meant to be shown, in CSS px (96 to the inch). */
export interface PictureSize {
  width: number
  height: number
}

/** The largest side a header may claim and still be believed, in CSS px (about 5 m). */
const MAX_SIDE_PX = 20000

function sane(width: number, height: number): PictureSize | null {
  const w = Math.round(width)
  const h = Math.round(height)
  return w >= 1 && h >= 1 && w <= MAX_SIDE_PX && h <= MAX_SIDE_PX ? { width: w, height: h } : null
}

/**
 * A one-page TIFF's size: its pixels at its resolution (a 300 dpi scan is
 * shown at its paper size), or at 96 to the inch when it gives none. Null
 * for a TIFF of several pages, whose first page alone is what Word shows.
 */
export function tiffSize(bytes: Buffer): PictureSize | null {
  const pages = tiffPages(bytes)
  if (!pages || pages.length !== 1 || pages[0].index !== 0) return null
  const { width, height, dpi } = pages[0]
  return dpi ? sane((width * 96) / dpi.x, (height * 96) / dpi.y) : sane(width, height)
}

/**
 * An EMF's size, from its header record (EMR_HEADER): rclFrame, the
 * picture's frame in hundredths of a millimetre, which is the size Word
 * shows it at; rclBounds (device pixels) when the frame is empty.
 */
export function emfSize(bytes: Buffer): PictureSize | null {
  if (bytes.length < 88 || bytes.readUInt32LE(0) !== 1 || bytes.readUInt32LE(40) !== 0x464d4520) return null
  const box = (at: number): [number, number] => [bytes.readInt32LE(at + 8) - bytes.readInt32LE(at), bytes.readInt32LE(at + 12) - bytes.readInt32LE(at + 4)]
  const [fw, fh] = box(24)
  if (fw > 0 && fh > 0) return sane((fw / 2540) * 96, (fh / 2540) * 96)
  const [bw, bh] = box(8)
  return sane(bw + 1, bh + 1)
}

/**
 * A WMF's size, from its Aldus placeable header (the bounding box, and how
 * many of its units make an inch). A WMF without one says nothing of its
 * size (null): the RTF reader gives such a picture the header its document
 * sizes it with.
 */
export function wmfSize(bytes: Buffer): PictureSize | null {
  if (bytes.length < 22 + 18 || bytes.readUInt32LE(0) !== 0x9ac6cdd7) return null
  const inch = bytes.readUInt16LE(14)
  if (inch < 1) return null
  const w = Math.abs(bytes.readInt16LE(10) - bytes.readInt16LE(6))
  const h = Math.abs(bytes.readInt16LE(12) - bytes.readInt16LE(8))
  return sane((w / inch) * 96, (h / inch) * 96)
}

/** The size of a picture Word keeps as it is but html-to-docx cannot size (TIFF, EMF, WMF), by its type; null when its header does not say. */
export function originalSize(mime: string, bytes: Buffer): PictureSize | null {
  if (mime === 'image/tiff') return tiffSize(bytes)
  if (mime === 'image/x-emf') return emfSize(bytes)
  if (mime === 'image/x-wmf') return wmfSize(bytes)
  return null
}
