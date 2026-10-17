import { imageMime } from '../readers/image'
import { View } from './bytes'
import { encodePng } from './png'

/*
 * The bitmaps a metafile carries: device-independent bitmaps (DIBs: a
 * BITMAPINFOHEADER or BITMAPCOREHEADER, a color table, then the pixels)
 * and GDI+ bitmaps. Each is decoded to RGBA and written as a PNG for the
 * SVG, except a DIB that is a JPEG or PNG already (BI_JPEG, BI_PNG), which
 * is kept as it is. Sizes are checked before anything is allocated: a side
 * over MAX_BITMAP_SIDE, more than MAX_BITMAP_PIXELS in one bitmap, or more
 * than the metafile's Budget in all of them, and the bitmap is not drawn
 * (the render host's own rules for pictures are the same: 20,000 px a side,
 * 50 megapixels).
 */

export const MAX_BITMAP_SIDE = 20_000
export const MAX_BITMAP_PIXELS = 50_000_000
/** The most bitmap pixels decoded for one metafile, all its bitmaps together. */
export const MAX_METAFILE_PIXELS = 100_000_000

/** A decoded bitmap: RGBA, top row first. `alpha`: some pixel is not opaque. */
export interface Raster {
  width: number
  height: number
  rgba: Uint8Array
  alpha: boolean
}

/** A bitmap as the SVG holds it: PNG, JPEG or GIF bytes, and its size in pixels. */
export interface Picture {
  mime: 'image/png' | 'image/jpeg' | 'image/gif'
  bytes: Buffer
  width: number
  height: number
  /** Known to have no transparency (a JPEG; a bitmap decoded here with none). */
  opaque?: boolean
}

/** The pixels a metafile may still decode. */
export class Budget {
  constructor(public pixels = MAX_METAFILE_PIXELS) {}
  take(width: number, height: number): boolean {
    if (!(width >= 1 && height >= 1 && width <= MAX_BITMAP_SIDE && height <= MAX_BITMAP_SIDE)) return false
    const n = width * height
    if (n > MAX_BITMAP_PIXELS || n > this.pixels) return false
    this.pixels -= n
    return true
  }
}

export interface DibOptions {
  budget: Budget
  /** DIB_RGB_COLORS (0, the default) or DIB_PAL_COLORS (1: the color table holds indexes into `palette`). */
  usage?: number
  /** The logical palette selected (0xRRGGBB each), for DIB_PAL_COLORS. */
  palette?: readonly number[]
  /** A two-color bitmap's colors instead of its own (a monochrome brush: text color, background color). */
  mono?: readonly [number, number]
  /** Keep a 32-bit bitmap's alpha (AlphaBlend with AC_SRC_ALPHA); otherwise GDI ignores it. */
  keepAlpha?: boolean
}

interface DibHeader {
  size: number
  width: number
  height: number
  topDown: boolean
  bpp: number
  compression: number
  clrUsed: number
  masks: number[] | null
  /** Where the color table starts, from the header's start. */
  tableAt: number
  core: boolean
}

const BI_RGB = 0
const BI_RLE8 = 1
const BI_RLE4 = 2
const BI_BITFIELDS = 3
const BI_JPEG = 4
const BI_PNG = 5
const BI_ALPHABITFIELDS = 6

function readHeader(h: View): DibHeader | null {
  if (!h.has(0, 12)) return null
  const size = h.u32(0)
  if (size === 12) {
    return { size, width: h.u16(4), height: h.u16(6), topDown: false, bpp: h.u16(10), compression: BI_RGB, clrUsed: 0, masks: null, tableAt: 12, core: true }
  }
  if (size < 40 || !h.has(0, 40)) return null
  const rawHeight = h.i32(8)
  const compression = h.u32(16)
  let masks: number[] | null = null
  let tableAt = size
  if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
    const n = compression === BI_ALPHABITFIELDS ? 4 : 3
    if (size >= 52) {
      masks = [h.u32(40), h.u32(44), h.u32(48), size >= 56 ? h.u32(52) : 0]
    } else if (h.has(40, n * 4)) {
      masks = [h.u32(40), h.u32(44), h.u32(48), n === 4 ? h.u32(52) : 0]
      tableAt = 40 + n * 4
    } else return null
  }
  return {
    size,
    width: h.i32(4),
    height: Math.abs(rawHeight),
    topDown: rawHeight < 0,
    bpp: h.u16(14),
    compression,
    clrUsed: h.u32(32),
    masks,
    tableAt,
    core: false,
  }
}

/** Entries in the color table. */
function tableEntries(d: DibHeader): number {
  if (d.bpp > 8) return 0
  const max = 1 << d.bpp
  return d.clrUsed > 0 ? Math.min(d.clrUsed, max) : max
}

/** The color table's size in bytes, as the header lays it out (with DIB_PAL_COLORS, 2 bytes an entry). */
function tableBytes(d: DibHeader, usage: number): number {
  if (d.bpp > 8) return d.clrUsed > 0 && !d.core ? d.clrUsed * 4 : 0
  return tableEntries(d) * (usage === 1 ? 2 : d.core ? 3 : 4)
}

/** Where the pixels of a packed DIB (header, table, pixels in one block, as WMF and GDI+ hold them) start. */
export function packedBitsOffset(dib: View, usage = 0): number | null {
  const d = readHeader(dib)
  if (!d) return null
  return d.tableAt + tableBytes(d, usage)
}

function colors(h: View, d: DibHeader, opts: DibOptions): number[] {
  const n = tableEntries(d)
  const out: number[] = []
  if (opts.mono && d.bpp === 1) return [opts.mono[0], opts.mono[1]]
  for (let i = 0; i < n; i++) {
    if (opts.usage === 1) {
      const at = d.tableAt + i * 2
      const index = h.has(at, 2) ? h.u16(at) : 0
      out.push(opts.palette?.[index] ?? (index === 0 ? 0 : 0xffffff))
      continue
    }
    const at = d.tableAt + i * (d.core ? 3 : 4)
    if (!h.has(at, 3)) {
      // A table cut short: the rest as a gray ramp, so the picture still shows.
      const g = Math.round((i * 255) / Math.max(1, n - 1))
      out.push((g << 16) | (g << 8) | g)
      continue
    }
    out.push((h.u8(at + 2) << 16) | (h.u8(at + 1) << 8) | h.u8(at))
  }
  return out
}

function maskShift(mask: number): { shift: number; max: number } {
  if (mask === 0) return { shift: 0, max: 0 }
  let shift = 0
  while (shift < 32 && ((mask >>> shift) & 1) === 0) shift++
  return { shift, max: mask >>> shift }
}

/** Indexed pixels of an RLE8 or RLE4 bitmap, bottom row first as stored; -1 where the encoding skips a pixel. */
function decodeRle(bits: View, width: number, height: number, four: boolean): Int16Array {
  const out = new Int16Array(width * height).fill(-1)
  const set = (x: number, y: number, v: number): void => {
    if (x >= 0 && x < width && y >= 0 && y < height) out[y * width + x] = v
  }
  let x = 0
  let y = 0
  let p = 0
  const n = bits.length
  while (p + 1 < n && y < height) {
    const count = bits.u8(p)
    const code = bits.u8(p + 1)
    p += 2
    if (count > 0) {
      for (let k = 0; k < count; k++) set(x++, y, four ? (k & 1 ? code & 0x0f : code >> 4) : code)
    } else if (code === 0) {
      x = 0
      y++
    } else if (code === 1) {
      break
    } else if (code === 2) {
      if (p + 1 >= n) break
      x += bits.u8(p)
      y += bits.u8(p + 1)
      p += 2
    } else {
      const bytes = four ? (code + 1) >> 1 : code
      for (let k = 0; k < code; k++) {
        const at = p + (four ? k >> 1 : k)
        if (at >= n) break
        const b = bits.u8(at)
        set(x++, y, four ? (k & 1 ? b & 0x0f : b >> 4) : b)
      }
      p += bytes + (bytes & 1)
    }
  }
  return out
}

/**
 * A DIB: its header and color table in `info`, its pixels in `bits`.
 * Decoded to RGBA (a Raster), or kept as it is when it is a JPEG or PNG
 * (a Picture). Null when it cannot be read or is over the limits.
 */
export function readDib(info: View, bits: View, opts: DibOptions): Raster | Picture | null {
  const d = readHeader(info)
  if (!d || !(d.width > 0 && d.height > 0)) return null
  if (d.compression === BI_JPEG || d.compression === BI_PNG) {
    const bytes = bits.bytes(0, bits.length)
    const mime = imageMime(bytes)
    if (mime !== (d.compression === BI_JPEG ? 'image/jpeg' : 'image/png')) return null
    if (!opts.budget.take(d.width, d.height)) return null
    return { mime, bytes, width: d.width, height: d.height, opaque: mime === 'image/jpeg' } as Picture
  }
  if (![1, 4, 8, 16, 24, 32].includes(d.bpp)) return null
  if (d.compression === BI_RLE8 && d.bpp !== 8) return null
  if (d.compression === BI_RLE4 && d.bpp !== 4) return null
  if (![BI_RGB, BI_RLE8, BI_RLE4, BI_BITFIELDS, BI_ALPHABITFIELDS].includes(d.compression)) return null
  if (!opts.budget.take(d.width, d.height)) return null
  const { width, height } = d
  const rgba = new Uint8Array(width * height * 4).fill(255)
  const table = d.bpp <= 8 ? colors(info, d, opts) : []
  let alpha = false
  const put = (x: number, fileRow: number, rgb: number, a = 255): void => {
    const y = d.topDown ? fileRow : height - 1 - fileRow
    const o = (y * width + x) * 4
    rgba[o] = (rgb >> 16) & 0xff
    rgba[o + 1] = (rgb >> 8) & 0xff
    rgba[o + 2] = rgb & 0xff
    rgba[o + 3] = a
    if (a !== 255) alpha = true
  }

  if (d.compression === BI_RLE8 || d.compression === BI_RLE4) {
    const idx = decodeRle(bits, width, height, d.compression === BI_RLE4)
    for (let r = 0; r < height; r++) {
      for (let x = 0; x < width; x++) {
        const v = idx[r * width + x]
        if (v < 0) put(x, r, 0xffffff, 0)
        else put(x, r, table[v] ?? 0)
      }
    }
    return { width, height, rgba, alpha }
  }

  const stride = Math.floor((width * d.bpp + 31) / 32) * 4
  const rows = Math.min(height, Math.floor(bits.length / stride))
  if (rows < 1) return null
  const masks =
    d.masks ??
    (d.bpp === 16 ? [0x7c00, 0x03e0, 0x001f, 0] : d.bpp === 32 ? [0xff0000, 0x00ff00, 0x0000ff, opts.keepAlpha ? 0xff000000 : 0] : null)
  const m = masks?.map(maskShift)
  const scale = (v: number, s: { max: number }): number => (s.max ? Math.round((v * 255) / s.max) : 0)
  const buf = bits.buf
  for (let r = 0; r < rows; r++) {
    const row = bits.start + r * stride
    for (let x = 0; x < width; x++) {
      switch (d.bpp) {
        case 1:
          put(x, r, table[(buf[row + (x >> 3)] >> (7 - (x & 7))) & 1] ?? 0)
          break
        case 4:
          put(x, r, table[(buf[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 0x0f] ?? 0)
          break
        case 8:
          put(x, r, table[buf[row + x]] ?? 0)
          break
        case 24: {
          const o = row + x * 3
          put(x, r, (buf[o + 2] << 16) | (buf[o + 1] << 8) | buf[o])
          break
        }
        default: {
          const v = d.bpp === 16 ? buf.readUInt16LE(row + x * 2) : buf.readUInt32LE(row + x * 4)
          const [mr, mg, mb, ma] = m!
          const red = scale((v & masks![0]) >>> mr.shift, mr)
          const green = scale((v & masks![1]) >>> mg.shift, mg)
          const blue = scale((v & masks![2]) >>> mb.shift, mb)
          const a = masks![3] && opts.keepAlpha ? scale((v & masks![3]) >>> ma.shift, ma) : 255
          put(x, r, (red << 16) | (green << 8) | blue, a)
        }
      }
    }
  }
  if (alpha && opts.keepAlpha) {
    // A bitmap whose every alpha is zero was not meant to be transparent
    // (most 32-bit DIBs leave the byte unset): opaque instead.
    let any = false
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) any = true
    if (!any) {
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
      alpha = false
    }
  }
  return { width, height, rgba, alpha }
}

/** A packed DIB (header, table and pixels in one block). */
export function readPackedDib(dib: View, opts: DibOptions): Raster | Picture | null {
  const at = packedBitsOffset(dib, opts.usage ?? 0)
  if (at === null || at > dib.length) return null
  return readDib(dib.sub(0, at), dib.rest(at), opts)
}

/** The part of `r` from (x, y), `w` by `h` pixels, or `r` itself when that is all of it (or nothing sensible). */
export function crop(r: Raster, x: number, y: number, w: number, h: number): Raster {
  x = Math.max(0, Math.round(x))
  y = Math.max(0, Math.round(y))
  w = Math.min(r.width - x, Math.round(w))
  h = Math.min(r.height - y, Math.round(h))
  if (w < 1 || h < 1 || (x === 0 && y === 0 && w === r.width && h === r.height)) return r
  const out = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row++) out.set(r.rgba.subarray(((y + row) * r.width + x) * 4, ((y + row) * r.width + x + w) * 4), row * w * 4)
  return { width: w, height: h, rgba: out, alpha: r.alpha }
}

/** Premultiplied color (AlphaBlend's source) back to straight color. */
export function unpremultiply(r: Raster): void {
  const p = r.rgba
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3]
    if (a === 0 || a === 255) continue
    p[i] = Math.min(255, Math.round((p[i] * 255) / a))
    p[i + 1] = Math.min(255, Math.round((p[i + 1] * 255) / a))
    p[i + 2] = Math.min(255, Math.round((p[i + 2] * 255) / a))
  }
}

/** Every pixel of color `rgb` made transparent (TransparentBlt). */
export function keyOut(r: Raster, rgb: number): void {
  const p = r.rgba
  const red = (rgb >> 16) & 0xff
  const green = (rgb >> 8) & 0xff
  const blue = rgb & 0xff
  for (let i = 0; i < p.length; i += 4) {
    if (p[i] === red && p[i + 1] === green && p[i + 2] === blue) {
      p[i + 3] = 0
      r.alpha = true
    }
  }
}

export function isPicture(b: Raster | Picture): b is Picture {
  return 'mime' in b
}

/** A bitmap as the SVG holds it: a Picture as it is, a Raster as PNG. */
export function toPicture(b: Raster | Picture): Picture {
  if (isPicture(b)) return b
  return { mime: 'image/png', bytes: encodePng(b.width, b.height, b.rgba, b.alpha), width: b.width, height: b.height, opaque: !b.alpha }
}
