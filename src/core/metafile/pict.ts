import { imageMime } from '../picture-types'
import { MAX_BITMAP_PIXELS, MAX_BITMAP_SIDE } from './dib'
import { encodePng } from './png'

/*
 * The pictures inside a QuickDraw picture (a Mac PICT, as RTF's `\macpict`
 * holds it: no 512-byte file header, though one is skipped if present).
 *
 * QuickDraw's drawing (lines, shapes, text) is not drawn here. What a PICT
 * pasted into a document mostly is, though, is a bitmap: a screenshot or a
 * scan as a BitsRect/PackBitsRect/DirectBitsRect (and their -Rgn forms), or a
 * photograph as a QuickTime-compressed image (a JPEG, in practice). Those are
 * read: a QuickTime image as its own bytes (JPEG, PNG, GIF or TIFF), else
 * the bitmaps laid on a white page of the picture's frame, each at its
 * destination rectangle (a large one is often written in bands), as a PNG.
 * Null when there is neither, or the opcodes cannot be followed to one.
 *
 * Version 1 (one-byte opcodes) and version 2 (two-byte, word-aligned) are
 * both walked. The pattern opcodes with a pixel pattern (PnPixPat, BkPixPat,
 * FillPixPat) end the walk; what was found before them is kept.
 */

export interface PictPicture {
  mime: string
  bytes: Buffer
  /** The picture's frame, in points (1/72 inch). */
  width: number
  height: number
}

class Short extends Error {}

class Reader {
  constructor(
    readonly b: Buffer,
    public at: number,
  ) {}
  need(n: number): void {
    if (n < 0 || this.at + n > this.b.length) throw new Short()
  }
  u8(): number {
    this.need(1)
    return this.b[this.at++]
  }
  u16(): number {
    this.need(2)
    const v = this.b.readUInt16BE(this.at)
    this.at += 2
    return v
  }
  i16(): number {
    this.need(2)
    const v = this.b.readInt16BE(this.at)
    this.at += 2
    return v
  }
  u32(): number {
    this.need(4)
    const v = this.b.readUInt32BE(this.at)
    this.at += 4
    return v
  }
  skip(n: number): void {
    this.need(n)
    this.at += n
  }
  bytes(n: number): Buffer {
    this.need(n)
    const v = this.b.subarray(this.at, this.at + n)
    this.at += n
    return v
  }
  rect(): Rect {
    const top = this.i16()
    const left = this.i16()
    const bottom = this.i16()
    const right = this.i16()
    return { top, left, bottom, right }
  }
}

interface Rect {
  top: number
  left: number
  bottom: number
  right: number
}

const width = (r: Rect): number => r.right - r.left
const height = (r: Rect): number => r.bottom - r.top

/** A decoded bitmap and where it goes. */
interface Placed {
  w: number
  h: number
  rgba: Uint8Array
  src: Rect
  dst: Rect
  bounds: Rect
}

/** The frame and the walk's start: version 1 or 2, past a 512-byte file header if there is one. */
function start(b: Buffer): { r: Reader; frame: Rect; v2: boolean } | null {
  for (const base of [0, 512]) {
    if (b.length < base + 12) continue
    const r = new Reader(b, base + 2)
    const frame = r.rect()
    if (b[base + 10] === 0x11 && b[base + 11] === 0x01) return { r: new Reader(b, base + 12), frame, v2: false }
    if (b.length >= base + 14 && b.readUInt16BE(base + 10) === 0x0011 && b.readUInt16BE(base + 12) === 0x02ff) return { r: new Reader(b, base + 14), frame, v2: true }
  }
  return null
}

/** PackBits: a count byte, then n+1 literal units or one unit repeated 1-n times; `unit` bytes a unit. */
function unpackBits(data: Buffer, out: Uint8Array, unit: number): void {
  let i = 0
  let o = 0
  while (i < data.length && o < out.length) {
    const n = data[i++]
    if (n < 128) {
      const len = (n + 1) * unit
      for (let k = 0; k < len && i < data.length && o < out.length; k++) out[o++] = data[i++]
    } else if (n > 128) {
      const run = data.subarray(i, i + unit)
      i += unit
      for (let k = 0; k < 257 - n; k++) for (let u = 0; u < unit && o < out.length; u++) out[o++] = run[u] ?? 0
    }
  }
}

/** One row of pixel data: unpacked when rowBytes < 8 (or packing is off), else a byte or word count then PackBits. */
function row(r: Reader, rowBytes: number, packed: boolean, unit: number): Uint8Array {
  const out = new Uint8Array(rowBytes)
  if (!packed || rowBytes < 8) {
    out.set(r.bytes(rowBytes))
    return out
  }
  const count = rowBytes > 250 ? r.u16() : r.u8()
  unpackBits(r.bytes(count), out, unit)
  return out
}

function checkSize(w: number, h: number): void {
  if (!(w >= 1 && h >= 1 && w <= MAX_BITMAP_SIDE && h <= MAX_BITMAP_SIDE && w * h <= MAX_BITMAP_PIXELS)) throw new Short()
}

/** BitsRect, BitsRgn, PackBitsRect, PackBitsRgn: a one-bit BitMap or an indexed PixMap with its color table. */
function readIndexed(r: Reader, packedOp: boolean, region: boolean): Placed {
  const rawRowBytes = r.u16()
  const pixmap = (rawRowBytes & 0x8000) !== 0
  const rowBytes = rawRowBytes & 0x3fff
  const bounds = r.rect()
  let depth = 1
  let palette: number[] = [0xffffff, 0x000000]
  if (pixmap) {
    r.skip(2 + 2 + 4 + 4 + 4 + 2) // pmVersion, packType, packSize, hRes, vRes, pixelType
    depth = r.u16()
    r.skip(2 + 2 + 4 + 4 + 4) // cmpCount, cmpSize, planeBytes, pmTable, pmReserved
    r.skip(4) // ctSeed
    const flags = r.u16()
    const count = r.u16() + 1
    palette = new Array<number>(Math.max(count, 256)).fill(0)
    for (let k = 0; k < count; k++) {
      const value = r.u16()
      const red = r.u16() >> 8
      const green = r.u16() >> 8
      const blue = r.u16() >> 8
      const index = flags & 0x8000 ? k : value & 0xff
      palette[index] = (red << 16) | (green << 8) | blue
    }
  }
  if (![1, 2, 4, 8].includes(depth)) throw new Short()
  const src = r.rect()
  const dst = r.rect()
  r.skip(2) // mode
  if (region) r.skip(Math.max(0, r.u16() - 2))
  const w = width(bounds)
  const h = height(bounds)
  checkSize(w, h)
  if (rowBytes * 8 < w * depth) throw new Short()
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const line = row(r, rowBytes, packedOp, 1)
    for (let x = 0; x < w; x++) {
      const bit = x * depth
      const index = (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
      const c = palette[index] ?? 0
      const o = (y * w + x) * 4
      rgba[o] = c >> 16
      rgba[o + 1] = (c >> 8) & 0xff
      rgba[o + 2] = c & 0xff
      rgba[o + 3] = 255
    }
  }
  return { w, h, rgba, src, dst, bounds }
}

/** DirectBitsRect, DirectBitsRgn: a 16- or 32-bit PixMap, packed by words (16) or by component (32). */
function readDirect(r: Reader, region: boolean): Placed {
  r.skip(4) // baseAddr
  const rowBytes = r.u16() & 0x3fff
  const bounds = r.rect()
  r.skip(2) // pmVersion
  const packType = r.u16()
  r.skip(4 + 4 + 4 + 2) // packSize, hRes, vRes, pixelType
  const depth = r.u16()
  const cmpCount = r.u16()
  r.skip(2 + 4 + 4 + 4) // cmpSize, planeBytes, pmTable, pmReserved
  const src = r.rect()
  const dst = r.rect()
  r.skip(2) // mode
  if (region) r.skip(Math.max(0, r.u16() - 2))
  const w = width(bounds)
  const h = height(bounds)
  checkSize(w, h)
  if (depth !== 16 && depth !== 32) throw new Short()
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const o = y * w * 4
    if (depth === 16) {
      if (rowBytes < w * 2) throw new Short()
      const line = row(r, rowBytes, packType !== 1, 2)
      for (let x = 0; x < w; x++) {
        const v = (line[x * 2] << 8) | line[x * 2 + 1]
        const at = o + x * 4
        rgba[at] = (((v >> 10) & 31) * 255) / 31
        rgba[at + 1] = (((v >> 5) & 31) * 255) / 31
        rgba[at + 2] = ((v & 31) * 255) / 31
        rgba[at + 3] = 255
      }
      continue
    }
    if (packType === 1 || rowBytes < 8) {
      // Unpacked: xRGB, four bytes a pixel.
      const line = r.bytes(rowBytes)
      if (rowBytes < w * 4) throw new Short()
      for (let x = 0; x < w; x++) {
        rgba.set([line[x * 4 + 1], line[x * 4 + 2], line[x * 4 + 3], 255], o + x * 4)
      }
    } else if (packType === 2) {
      // The pad byte left out: RGB, three bytes a pixel, unpacked.
      const line = r.bytes(w * 3)
      for (let x = 0; x < w; x++) rgba.set([line[x * 3], line[x * 3 + 1], line[x * 3 + 2], 255], o + x * 4)
    } else {
      // By component: the row's reds, then its greens, then its blues (an alpha plane first when there are four).
      const planes = cmpCount === 4 ? 4 : 3
      const line = row(r, Math.max(rowBytes, w * planes), true, 1)
      const first = planes - 3
      for (let x = 0; x < w; x++) {
        rgba.set([line[(first) * w + x], line[(first + 1) * w + x], line[(first + 2) * w + x], 255], o + x * 4)
      }
    }
  }
  return { w, h, rgba, src, dst, bounds }
}

/** JPEG, PNG, GIF or TIFF, by signature. */
function quickTimeMime(bytes: Buffer): string | null {
  const mime = imageMime(bytes)
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif') return mime
  const head = bytes.toString('latin1', 0, 4)
  return head === 'II*\0' || head === 'MM\0*' ? 'image/tiff' : null
}

/** A QuickTime-compressed image's own bytes, when they are a picture format read elsewhere. */
function quickTimeImage(data: Buffer): Buffer | null {
  const r = new Reader(data, 0)
  r.skip(36) // matrix
  const matteSize = r.u32()
  r.skip(8 + 2 + 8 + 4) // matteRect, mode, srcRect, accuracy
  const maskSize = r.u32()
  r.skip(matteSize)
  r.skip(maskSize)
  const description = r.at
  const idSize = r.u32()
  r.skip(4 + 4 + 2 + 2 + 2 + 2 + 4 + 4 + 4 + 2 + 2 + 4 + 4) // cType … vRes
  const dataSize = r.u32()
  r.at = description + idSize
  const bytes = r.bytes(Math.min(dataSize, data.length - r.at))
  return quickTimeMime(bytes) ? Buffer.from(bytes) : null
}

/** Lengths of opcode data with a fixed size (version 2 numbering; version 1 uses the same for 0x00–0xFF). */
function fixedLength(op: number): number | undefined {
  switch (op) {
    case 0x00: case 0x1c: case 0x1e: return 0
    case 0x03: case 0x05: case 0x08: case 0x0d: case 0x15: case 0x16: case 0x23: case 0xa0: return 2
    case 0x04: return 1
    case 0x06: case 0x07: case 0x0b: case 0x0c: case 0x0e: case 0x0f: case 0x21: return 4
    case 0x1a: case 0x1b: case 0x1d: case 0x1f: case 0x22: return 6
    case 0x02: case 0x09: case 0x0a: case 0x10: case 0x20: return 8
    case 0x0c00: return 24
  }
  if (op >= 0x17 && op <= 0x19) return 0
  if (op >= 0x30 && op <= 0x37) return 8
  if (op >= 0x38 && op <= 0x3f) return 0
  if (op >= 0x40 && op <= 0x47) return 8
  if (op >= 0x48 && op <= 0x4f) return 0
  if (op >= 0x50 && op <= 0x57) return 8
  if (op >= 0x58 && op <= 0x5f) return 0
  if (op >= 0x60 && op <= 0x67) return 12
  if (op >= 0x68 && op <= 0x6f) return 4
  if (op >= 0x78 && op <= 0x7f) return 0
  if (op >= 0x88 && op <= 0x8f) return 0
  if (op >= 0xb0 && op <= 0xcf) return 0
  if (op >= 0x0100 && op <= 0x7fff) return (op >> 8) * 2
  if (op >= 0x8000 && op <= 0x80ff) return 0
  return undefined
}

/** The bitmaps on a white page of the frame, nearest-pixel scaled to each destination. */
function compose(frame: Rect, placed: Placed[]): Buffer {
  const w = width(frame)
  const h = height(frame)
  const rgba = new Uint8Array(w * h * 4).fill(255)
  for (const p of placed) {
    const dw = width(p.dst)
    const dh = height(p.dst)
    const sw = width(p.src)
    const sh = height(p.src)
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) continue
    for (let y = Math.max(0, p.dst.top - frame.top); y < Math.min(h, p.dst.bottom - frame.top); y++) {
      const sy = p.src.top - p.bounds.top + Math.floor(((y + frame.top - p.dst.top) * sh) / dh)
      if (sy < 0 || sy >= p.h) continue
      for (let x = Math.max(0, p.dst.left - frame.left); x < Math.min(w, p.dst.right - frame.left); x++) {
        const sx = p.src.left - p.bounds.left + Math.floor(((x + frame.left - p.dst.left) * sw) / dw)
        if (sx < 0 || sx >= p.w) continue
        const from = (sy * p.w + sx) * 4
        const to = (y * w + x) * 4
        rgba[to] = p.rgba[from]
        rgba[to + 1] = p.rgba[from + 1]
        rgba[to + 2] = p.rgba[from + 2]
      }
    }
  }
  return encodePng(w, h, rgba, false)
}

export function pictPicture(bytes: Buffer): PictPicture | null {
  const begun = start(bytes)
  if (!begun) return null
  const { r, frame, v2 } = begun
  const fw = width(frame)
  const fh = height(frame)
  if (!(fw >= 1 && fh >= 1 && fw <= MAX_BITMAP_SIDE && fh <= MAX_BITMAP_SIDE && fw * fh <= MAX_BITMAP_PIXELS)) return null
  const placed: Placed[] = []
  let quickTime: Buffer | null = null
  let pixels = 0
  try {
    for (let steps = 0; steps < 1_000_000; steps++) {
      if (v2 && r.at % 2 === 1) r.at++
      const op = v2 ? r.u16() : r.u8()
      if (op === 0xff) break
      if (op === 0x0011) {
        r.skip(v2 ? 2 : 1)
        continue
      }
      const fixed = fixedLength(op)
      if (fixed !== undefined) {
        r.skip(fixed)
        continue
      }
      if (op === 0x90 || op === 0x91 || op === 0x98 || op === 0x99 || op === 0x9a || op === 0x9b) {
        const p = op >= 0x9a ? readDirect(r, op === 0x9b) : readIndexed(r, op >= 0x98, op === 0x91 || op === 0x99)
        pixels += p.w * p.h
        if (pixels > MAX_BITMAP_PIXELS) break
        placed.push(p)
        continue
      }
      // Regions and polygons (and Clip) start with their own size, the word counted.
      if (op === 0x01 || (op >= 0x70 && op <= 0x77) || (op >= 0x80 && op <= 0x87)) {
        r.skip(Math.max(0, r.u16() - 2))
        continue
      }
      if (op === 0x28) {
        r.skip(4)
        r.skip(r.u8())
        continue
      }
      if (op === 0x29 || op === 0x2a) {
        r.skip(1)
        r.skip(r.u8())
        continue
      }
      if (op === 0x2b) {
        r.skip(2)
        r.skip(r.u8())
        continue
      }
      if (op === 0xa1) {
        r.skip(2)
        r.skip(r.u16())
        continue
      }
      if ((op >= 0x24 && op <= 0x27) || (op >= 0x2c && op <= 0x2f) || (op >= 0x92 && op <= 0x97) || (op >= 0x9c && op <= 0x9f) || (op >= 0xa2 && op <= 0xaf)) {
        r.skip(r.u16())
        continue
      }
      if (op === 0x8200 || op === 0x8201) {
        const data = r.bytes(r.u32())
        if (op === 0x8200 && !quickTime) {
          try {
            quickTime = quickTimeImage(data)
          } catch (err) {
            if (!(err instanceof Short)) throw err
          }
        }
        continue
      }
      if ((op >= 0xd0 && op <= 0xfe) || op >= 0x8100) {
        r.skip(r.u32())
        continue
      }
      // A pixel pattern (0x12–0x14), or an opcode no version names: the rest cannot be followed.
      break
    }
  } catch (err) {
    if (!(err instanceof Short)) throw err
  }
  const size = { width: fw, height: fh }
  if (quickTime) return { mime: quickTimeMime(quickTime)!, bytes: quickTime, ...size }
  if (placed.length === 0) return null
  return { mime: 'image/png', bytes: compose(frame, placed), ...size }
}
