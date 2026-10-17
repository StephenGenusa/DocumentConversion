/*
 * What a picture's header says, read in core without decoding a pixel: the
 * pages of a TIFF and their sizes, one page of a TIFF taken out on its own
 * (its strips copied byte for byte), the size of an EMF or WMF, and a PNG,
 * JPEG, GIF, WebP, BMP, ICO or AVIF's size (rasterSize). Every offset is
 * checked against the file before it is followed, and a TIFF's chain of
 * pages is followed each offset once, so a hostile file costs a null, never
 * a hang or a read out of bounds. Pixels are decoded only in the render
 * host's sandboxed page (pictures.ts).
 */

/** The most IFDs of one TIFF that are followed: past that, the file is refused. */
export const MAX_TIFF_IFDS = 1000

export interface TiffPage {
  /** The page's place in the file's chain of IFDs (0 for the first). */
  index: number
  width: number
  height: number
  /** Pixels per inch, when the file says (ResolutionUnit inch or centimeter). */
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
 * The size a TIFF page is meant to be shown at, its pixels at its
 * resolution (a 300 dpi scan at its paper size), for the page at `index` in
 * the file's chain (the first page when not given). Null when the file says
 * no resolution: the page is then shown at its pixel size, as anywhere.
 */
export function tiffShownSize(bytes: Buffer, index?: number): PictureSize | null {
  const pages = tiffPages(bytes)
  const page = index === undefined ? pages?.[0] : pages?.find((p) => p.index === index)
  return page?.dpi ? sane((page.width * 96) / page.dpi.x, (page.height * 96) / page.dpi.y) : null
}

/**
 * An EMF's size, from its header record (EMR_HEADER): rclFrame, the
 * picture's frame in hundredths of a millimeter, which is the size Word
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

/**
 * A raster picture's pixel size, believed as its header gives it: unlike a
 * metafile's frame, each format's field is bounded already, and a long
 * panorama is a real picture (only its shape is asked of it here).
 */
function pixels(width: number, height: number): PictureSize | null {
  return width >= 1 && height >= 1 ? { width, height } : null
}

/**
 * The EXIF orientation (1 to 8) a JPEG's APP1 segment gives, from the
 * segment's body (after its length); undefined when it gives none.
 */
function exifOrientation(seg: Buffer): number | undefined {
  if (seg.length < 14 || seg.toString('latin1', 0, 6) !== 'Exif\0\0') return undefined
  const t = seg.subarray(6)
  const be = t.toString('latin1', 0, 2) === 'MM'
  if (!be && t.toString('latin1', 0, 2) !== 'II') return undefined
  const r16 = (at: number) => (be ? t.readUInt16BE(at) : t.readUInt16LE(at))
  const ifd = be ? t.readUInt32BE(4) : t.readUInt32LE(4)
  if (ifd + 2 > t.length) return undefined
  const count = r16(ifd)
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12
    if (at + 12 > t.length) return undefined
    if (r16(at) === 0x0112) return r16(at + 8)
  }
  return undefined
}

/** A JPEG's size from its frame header (SOFn), turned as its EXIF orientation shows it. */
function jpegSize(bytes: Buffer): PictureSize | null {
  let at = 2
  let turned = false
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    // Fill bytes, and markers that stand alone (RSTn, TEM).
    if (marker === 0xff) {
      at++
      continue
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    const len = bytes.readUInt16BE(at + 2)
    if (len < 2 || at + 2 + len > bytes.length) return null
    if (marker === 0xe1) {
      const o = exifOrientation(bytes.subarray(at + 4, at + 2 + len))
      if (o !== undefined) turned = o >= 5 && o <= 8
    }
    // SOF0-15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len < 7) return null
      const h = bytes.readUInt16BE(at + 5)
      const w = bytes.readUInt16BE(at + 7)
      return turned ? pixels(h, w) : pixels(w, h)
    }
    if (marker === 0xda || marker === 0xd9) return null
    at += 2 + len
  }
  return null
}

/** An ICO's size: its largest picture's (a width or height byte of 0 is 256). */
function icoSize(bytes: Buffer): PictureSize | null {
  const count = bytes.readUInt16LE(4)
  let best: PictureSize | null = null
  for (let k = 0; k < count && 6 + k * 16 + 16 <= bytes.length; k++) {
    const width = bytes[6 + k * 16] || 256
    const height = bytes[6 + k * 16 + 1] || 256
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best
}

/** An AVIF's size, from its image spatial extents property ('ispe', in its meta box near the start). */
function avifSize(bytes: Buffer): PictureSize | null {
  const at = bytes.subarray(0, 64 * 1024).indexOf('ispe', 0, 'latin1')
  if (at < 4 || at + 16 > bytes.length) return null
  return pixels(bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 12))
}

/**
 * A PNG, JPEG, GIF, WebP, BMP, ICO or AVIF's size in pixels (shown at 96 to
 * the inch), from its header alone; null when the header cannot be read. A
 * JPEG a camera stored on its side (EXIF orientation 5 to 8) is given as it
 * is shown.
 */
export function rasterSize(bytes: Buffer): PictureSize | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG' && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return pixels(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegSize(bytes)
  if (bytes.length >= 10 && /^GIF8[79]a/.test(bytes.toString('latin1', 0, 6))) {
    return pixels(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
  }
  if (bytes.length >= 16 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const kind = bytes.toString('latin1', 12, 16)
    if (kind === 'VP8 ' && bytes.length >= 30) return pixels(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
    if (kind === 'VP8L' && bytes.length >= 25) {
      const v = bytes.readUInt32LE(21)
      return pixels((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1)
    }
    if (kind === 'VP8X' && bytes.length >= 30) return pixels(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)
  }
  if (bytes.length >= 26 && bytes.toString('latin1', 0, 2) === 'BM') {
    // A core header (12 bytes) gives its size in words, every later one in long words; rows bottom up or top down.
    if (bytes.readUInt32LE(14) === 12) return pixels(bytes.readUInt16LE(18), bytes.readUInt16LE(20))
    return pixels(Math.abs(bytes.readInt32LE(18)), Math.abs(bytes.readInt32LE(22)))
  }
  if (bytes.length >= 22 && bytes.readUInt32BE(0) === 0x00000100) return icoSize(bytes)
  if (bytes.length >= 16 && bytes.toString('latin1', 4, 8) === 'ftyp') return avifSize(bytes)
  return null
}
