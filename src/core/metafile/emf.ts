import { ShortRecord, View } from './bytes'
import { crop, isPicture, readDib, type Raster, type Picture } from './dib'
import {
  decodeAnsi,
  ETO_CLIPPED,
  ETO_GLYPH_INDEX,
  ETO_OPAQUE,
  ETO_PDY,
  Gdi,
  singleByte,
  stockObject,
  type Brush,
  type Font,
  type GdiObject,
  type Pen,
} from './gdi'
import { axisAligned, compose, IDENTITY, TooLarge, type Matrix, type Rect } from './svg'

/*
 * EMF records ([MS-EMF] 2.3), played into a Gdi device context. Each
 * record is read through a View bounded by its own size, so one that
 * claims more than it holds is skipped (ShortRecord), not read into its
 * neighbor; record sizes must be whole, at least 8 bytes, a multiple of
 * 4 and inside the file, and at most MAX_RECORDS are played. Records this
 * file does not draw are passed over.
 *
 * EMF+ records live inside EMR_COMMENT records; the caller decides whether
 * they are drawn (an EMF+-only file) or passed over (a dual file, whose
 * EMF records draw the same picture): `plus`.
 */

/** The most records played from one metafile. */
export const MAX_RECORDS = 500_000
/** The highest object index a metafile may use (EMF's handle count is 16-bit). */
export const MAX_OBJECTS = 0x10000

/** Record types, by number ([MS-EMF] 2.1.1). */
export const EMR = {
  HEADER: 0x01,
  POLYBEZIER: 0x02,
  POLYGON: 0x03,
  POLYLINE: 0x04,
  POLYBEZIERTO: 0x05,
  POLYLINETO: 0x06,
  POLYPOLYLINE: 0x07,
  POLYPOLYGON: 0x08,
  SETWINDOWEXTEX: 0x09,
  SETWINDOWORGEX: 0x0a,
  SETVIEWPORTEXTEX: 0x0b,
  SETVIEWPORTORGEX: 0x0c,
  SETBRUSHORGEX: 0x0d,
  EOF: 0x0e,
  SETPIXELV: 0x0f,
  SETMAPMODE: 0x11,
  SETBKMODE: 0x12,
  SETPOLYFILLMODE: 0x13,
  SETROP2: 0x14,
  SETSTRETCHBLTMODE: 0x15,
  SETTEXTALIGN: 0x16,
  SETTEXTCOLOR: 0x18,
  SETBKCOLOR: 0x19,
  OFFSETCLIPRGN: 0x1a,
  MOVETOEX: 0x1b,
  SETMETARGN: 0x1c,
  EXCLUDECLIPRECT: 0x1d,
  INTERSECTCLIPRECT: 0x1e,
  SCALEVIEWPORTEXTEX: 0x1f,
  SCALEWINDOWEXTEX: 0x20,
  SAVEDC: 0x21,
  RESTOREDC: 0x22,
  SETWORLDTRANSFORM: 0x23,
  MODIFYWORLDTRANSFORM: 0x24,
  SELECTOBJECT: 0x25,
  CREATEPEN: 0x26,
  CREATEBRUSHINDIRECT: 0x27,
  DELETEOBJECT: 0x28,
  ANGLEARC: 0x29,
  ELLIPSE: 0x2a,
  RECTANGLE: 0x2b,
  ROUNDRECT: 0x2c,
  ARC: 0x2d,
  CHORD: 0x2e,
  PIE: 0x2f,
  SELECTPALETTE: 0x30,
  CREATEPALETTE: 0x31,
  SETPALETTEENTRIES: 0x32,
  EXTFLOODFILL: 0x35,
  LINETO: 0x36,
  ARCTO: 0x37,
  POLYDRAW: 0x38,
  SETARCDIRECTION: 0x39,
  SETMITERLIMIT: 0x3a,
  BEGINPATH: 0x3b,
  ENDPATH: 0x3c,
  CLOSEFIGURE: 0x3d,
  FILLPATH: 0x3e,
  STROKEANDFILLPATH: 0x3f,
  STROKEPATH: 0x40,
  FLATTENPATH: 0x41,
  WIDENPATH: 0x42,
  SELECTCLIPPATH: 0x43,
  ABORTPATH: 0x44,
  COMMENT: 0x46,
  FILLRGN: 0x47,
  FRAMERGN: 0x48,
  INVERTRGN: 0x49,
  PAINTRGN: 0x4a,
  EXTSELECTCLIPRGN: 0x4b,
  BITBLT: 0x4c,
  STRETCHBLT: 0x4d,
  MASKBLT: 0x4e,
  PLGBLT: 0x4f,
  SETDIBITSTODEVICE: 0x50,
  STRETCHDIBITS: 0x51,
  EXTCREATEFONTINDIRECTW: 0x52,
  EXTTEXTOUTA: 0x53,
  EXTTEXTOUTW: 0x54,
  POLYBEZIER16: 0x55,
  POLYGON16: 0x56,
  POLYLINE16: 0x57,
  POLYBEZIERTO16: 0x58,
  POLYLINETO16: 0x59,
  POLYPOLYLINE16: 0x5a,
  POLYPOLYGON16: 0x5b,
  POLYDRAW16: 0x5c,
  CREATEMONOBRUSH: 0x5d,
  CREATEDIBPATTERNBRUSHPT: 0x5e,
  EXTCREATEPEN: 0x5f,
  POLYTEXTOUTA: 0x60,
  POLYTEXTOUTW: 0x61,
  SMALLTEXTOUT: 0x6c,
  ALPHABLEND: 0x72,
  SETLAYOUT: 0x73,
  TRANSPARENTBLT: 0x74,
  GRADIENTFILL: 0x76,
} as const

export interface EmfHeader {
  /** Device pixels the picture covers (inclusive). */
  bounds: Rect
  /** The picture's frame, in 0.01 mm (inclusive). */
  frame: Rect
  /** The reference device's pixels per millimeter. */
  pxPerMm: [number, number]
}

/** An EMF's header record, or null when it is not one. */
export function readEmfHeader(file: View): EmfHeader | null {
  if (!file.has(0, 88) || file.u32(0) !== EMR.HEADER || file.u32(40) !== 0x464d4520) return null
  const size = file.u32(4)
  const box = (at: number): Rect => ({ l: file.i32(at), t: file.i32(at + 4), r: file.i32(at + 8), b: file.i32(at + 12) })
  const dev: [number, number] = [file.i32(72), file.i32(76)]
  let mm: [number, number] = [file.i32(80), file.i32(84)]
  // Micrometers, when the header has them (its third extension), are the exact size.
  if (size >= 108 && file.has(100, 8) && file.i32(100) > 0 && file.i32(104) > 0) mm = [file.i32(100) / 1000, file.i32(104) / 1000]
  const per = (d: number, m: number): number => (d > 0 && m > 0 && d / m > 0.01 && d / m < 1000 ? d / m : 96 / 25.4)
  return { bounds: box(8), frame: box(24), pxPerMm: [per(dev[0], mm[0]), per(dev[1], mm[1])] }
}

/** What reads EMF+ records out of EMR_COMMENT (emfplus.ts); `gdi`: whether EMF records are drawn now. */
export interface PlusHook {
  comment(data: View): void
  readonly gdi: boolean
}

/** Every record, by type and its view, in order: at most MAX_RECORDS, stopping at EOF or the first malformed size. */
export function* emfRecords(file: View): Generator<{ type: number; r: View }> {
  let at = 0
  let n = 0
  while (at + 8 <= file.length && n++ < MAX_RECORDS) {
    const type = file.u32(at)
    const size = file.u32(at + 4)
    if (size < 8 || size % 4 !== 0 || at + size > file.length) return
    yield { type, r: file.sub(at, size) }
    if (type === EMR.EOF) return
    at += size
  }
}

/** Points, x then y, `count` of them at `at`: 32-bit, or 16-bit when `small`. */
function points(r: View, at: number, count: number, small: boolean): number[] {
  const size = small ? 4 : 8
  if (!r.has(at, count * size)) throw new ShortRecord()
  const out = new Array<number>(count * 2)
  for (let i = 0; i < count; i++) {
    out[2 * i] = small ? r.i16(at + i * 4) : r.i32(at + i * 8)
    out[2 * i + 1] = small ? r.i16(at + i * 4 + 2) : r.i32(at + i * 8 + 4)
  }
  return out
}

function box(r: View, at: number): [number, number, number, number] {
  return [r.i32(at), r.i32(at + 4), r.i32(at + 8), r.i32(at + 12)]
}

/** A RGNDATA structure's rectangles. */
export function regionRects(v: View): Rect[] {
  const headerSize = v.u32(0)
  const count = v.u32(8)
  const at = Math.max(32, headerSize)
  const n = Math.min(count, Math.floor(Math.max(0, v.length - at) / 16))
  const out: Rect[] = []
  for (let i = 0; i < n; i++) {
    const [l, t, r, b] = box(v, at + i * 16)
    if (r > l && b > t) out.push({ l, t, r, b })
  }
  return out
}

export function readFontW(r: View, at: number): Font {
  return {
    height: r.i32(at),
    width: r.i32(at + 4),
    escapement: r.i32(at + 8),
    orientation: r.i32(at + 12),
    weight: r.i32(at + 16),
    italic: r.u8(at + 20) !== 0,
    underline: r.u8(at + 21) !== 0,
    strike: r.u8(at + 22) !== 0,
    charset: r.u8(at + 23),
    pitchFamily: r.u8(at + 27),
    face: r.has(at + 28, 64) ? r.utf16(at + 28, 32).replace(/\0[\s\S]*$/, '') : '',
  }
}

/** XFORM: eM11, eM12, eM21, eM22, eDx, eDy, as a Matrix (the same order). */
function xform(r: View, at: number): Matrix {
  return [r.f32(at), r.f32(at + 4), r.f32(at + 8), r.f32(at + 12), r.f32(at + 16), r.f32(at + 20)]
}

export class EmfPlayer {
  /** Records that could not be read. */
  failed = 0
  played = 0

  constructor(
    readonly gdi: Gdi,
    private readonly plus: PlusHook | null,
  ) {}

  play(file: View): void {
    for (const { type, r } of emfRecords(file)) {
      this.played++
      try {
        this.record(type, r)
      } catch (err) {
        if (err instanceof TooLarge) throw err
        this.failed++
      }
    }
  }

  private object(index: number, obj: GdiObject): void {
    if (index >= 1 && index < MAX_OBJECTS) this.gdi.objects.set(index, obj)
  }

  private dib(r: View, offBmi: number, cbBmi: number, offBits: number, cbBits: number, usage: number, keepAlpha = false): Raster | Picture | null {
    if (cbBmi === 0) return null
    return readDib(r.sub(offBmi, cbBmi), r.sub(offBits, cbBits), {
      budget: this.gdi.setup.budget,
      usage,
      palette: this.gdi.dc.palette ?? undefined,
      keepAlpha,
    })
  }

  /** A MaskBlt or PlgBlt mask (its usage, then its four offsets and sizes, at `at`): set bits white, clear ones black; null when there is none. */
  private mask(r: View, at: number): Raster | null {
    const [usage, offBmi, cbBmi, offBits, cbBits] = [r.u32(at), r.u32(at + 4), r.u32(at + 8), r.u32(at + 12), r.u32(at + 16)]
    if (cbBmi === 0) return null
    const m = readDib(r.sub(offBmi, cbBmi), r.sub(offBits, cbBits), { budget: this.gdi.setup.budget, usage, mono: [0, 0xffffff] })
    if (!m || isPicture(m)) {
      this.gdi.lost.add('a bitmap mask that could not be read')
      return null
    }
    return m
  }

  /**
   * MaskBlt and PlgBlt: the source bitmap's part `src` drawn into `dest`
   * (or onto the parallelogram `to`) through the mask, by the foreground
   * and background raster operations (MAKEROP4: the background's in the
   * top byte). Without a mask, a BitBlt by the foreground operation.
   */
  private masked(
    dest: [number, number, number, number],
    src: [number, number, number, number],
    bmp: Raster | Picture | null,
    mask: Raster | null,
    at: [number, number],
    rop: number,
    to?: number[],
  ): void {
    const g = this.gdi
    const fore = (rop >>> 16) & 0xff
    const back = (rop >>> 24) & 0xff
    if (!mask || !bmp || isPicture(bmp)) {
      if (mask && bmp) g.lost.add('a mask on a JPEG or PNG bitmap')
      g.bitmap(dest, src, bmp, fore << 16, { to })
      return
    }
    const part = crop(bmp, src[0], src[1], src[2] || bmp.width, src[3] || bmp.height)
    const raster = g.maskedRaster(part, mask, at[0], at[1], fore, back)
    g.bitmap(dest, [0, 0, part.width, part.height], raster, 0xcc0020, { to })
  }

  private text(r: View, at: number, wide: boolean): void {
    const g = this.gdi
    const x = r.i32(at)
    const y = r.i32(at + 4)
    const n = r.u32(at + 8)
    const offString = r.u32(at + 12)
    const options = r.u32(at + 16)
    const rc = box(r, at + 20)
    const offDx = r.u32(at + 36)
    if (n === 0 && !(options & ETO_OPAQUE)) return
    const charset = g.dc.font.charset
    // Glyph numbers are 16-bit (GDI reads them so from the A call too, when the record holds that many).
    const glyphs = (options & ETO_GLYPH_INDEX) !== 0
    const str =
      n === 0 ? ''
      : wide || (glyphs && r.has(offString, n * 2)) ? r.utf16(offString, n)
      : glyphs ? Array.from(r.bytes(offString, n), (c) => String.fromCharCode(c)).join('')
      : decodeAnsi(r.bytes(offString, n), charset)
    const step = options & ETO_PDY ? 8 : 4
    let dx: number[] | null = null
    if (offDx > 0 && n > 0 && r.has(offDx, n * step) && (wide || glyphs || singleByte(charset))) {
      dx = []
      for (let i = 0; i < n; i++) dx.push(r.i32(offDx + i * step))
    }
    g.text(x, y, str, dx, options, options & (ETO_OPAQUE | ETO_CLIPPED) ? rc : null)
  }

  private record(type: number, r: View): void {
    const g = this.gdi
    if (type === EMR.COMMENT) {
      const size = r.u32(8)
      if (this.plus && r.has(12, 4) && r.u32(12) === 0x2b464d45) this.plus.comment(r.sub(16, Math.min(size, r.length - 12) - 4))
      return
    }
    if (type === EMR.HEADER || type === EMR.EOF) return
    // An EMF+ file draws its EMF records only where EmfPlusGetDC says so.
    if (this.plus && !this.plus.gdi) return
    const dc = g.dc
    switch (type) {
      case EMR.POLYBEZIER:
      case EMR.POLYGON:
      case EMR.POLYLINE:
      case EMR.POLYBEZIERTO:
      case EMR.POLYLINETO:
      case EMR.POLYBEZIER16:
      case EMR.POLYGON16:
      case EMR.POLYLINE16:
      case EMR.POLYBEZIERTO16:
      case EMR.POLYLINETO16: {
        const small = type >= EMR.POLYBEZIER16
        const kind = small ? type - EMR.POLYBEZIER16 + EMR.POLYBEZIER : type
        const pts = points(r, 28, r.u32(24), small)
        if (kind === EMR.POLYBEZIER) g.bezier(pts, false)
        else if (kind === EMR.POLYBEZIERTO) g.bezier(pts, true)
        else if (kind === EMR.POLYGON) g.poly(pts, true)
        else if (kind === EMR.POLYLINE) g.poly(pts, false)
        else g.polyTo(pts)
        return
      }
      case EMR.POLYPOLYLINE:
      case EMR.POLYPOLYGON:
      case EMR.POLYPOLYLINE16:
      case EMR.POLYPOLYGON16: {
        const small = type === EMR.POLYPOLYLINE16 || type === EMR.POLYPOLYGON16
        const nPolys = r.u32(24)
        const total = r.u32(28)
        if (!r.has(32, nPolys * 4)) throw new ShortRecord()
        const all = points(r, 32 + nPolys * 4, total, small)
        const polys: number[][] = []
        let k = 0
        for (let i = 0; i < nPolys; i++) {
          const c = r.u32(32 + i * 4)
          if (k + c > total) break
          polys.push(all.slice(k * 2, (k + c) * 2))
          k += c
        }
        g.polyPoly(polys, type === EMR.POLYPOLYGON || type === EMR.POLYPOLYGON16)
        return
      }
      case EMR.POLYDRAW:
      case EMR.POLYDRAW16: {
        const small = type === EMR.POLYDRAW16
        const n = r.u32(24)
        const pts = points(r, 28, n, small)
        const typesAt = 28 + n * (small ? 4 : 8)
        if (!r.has(typesAt, n)) throw new ShortRecord()
        const types: number[] = []
        for (let i = 0; i < n; i++) types.push(r.u8(typesAt + i))
        g.polyDraw(pts, types)
        return
      }
      case EMR.SETWINDOWEXTEX:
        g.set('winExt', [r.i32(8), r.i32(12)])
        return
      case EMR.SETWINDOWORGEX:
        g.set('winOrg', [r.i32(8), r.i32(12)])
        return
      case EMR.SETVIEWPORTEXTEX:
        g.set('vpExt', [r.i32(8), r.i32(12)])
        return
      case EMR.SETVIEWPORTORGEX:
        g.set('vpOrg', [r.i32(8), r.i32(12)])
        return
      case EMR.SCALEVIEWPORTEXTEX:
      case EMR.SCALEWINDOWEXTEX: {
        const [xn, xd, yn, yd] = [r.i32(8), r.i32(12), r.i32(16), r.i32(20)]
        if (xd === 0 || yd === 0) return
        const key = type === EMR.SCALEVIEWPORTEXTEX ? 'vpExt' : 'winExt'
        const [ex, ey] = dc[key]
        g.set(key, [(ex * xn) / xd, (ey * yn) / yd])
        return
      }
      case EMR.SETPIXELV:
        g.setPixel(r.i32(8), r.i32(12), r.u32(16))
        return
      case EMR.SETMAPMODE:
        g.set('mapMode', r.u32(8))
        return
      case EMR.SETBKMODE:
        g.set('bkMode', r.u32(8))
        return
      case EMR.SETPOLYFILLMODE:
        g.set('fillMode', r.u32(8))
        return
      case EMR.SETROP2:
        g.set('rop2', r.u32(8))
        return
      case EMR.SETTEXTALIGN:
        g.set('textAlign', r.u32(8))
        return
      case EMR.SETTEXTCOLOR:
        g.set('textColor', r.u32(8))
        return
      case EMR.SETBKCOLOR:
        g.set('bkColor', r.u32(8))
        return
      case EMR.OFFSETCLIPRGN:
        g.offsetClip(r.i32(8), r.i32(12))
        return
      case EMR.MOVETOEX:
        g.moveTo(r.i32(8), r.i32(12))
        return
      case EMR.EXCLUDECLIPRECT:
        g.excludeClipRect(...box(r, 8))
        return
      case EMR.INTERSECTCLIPRECT:
        g.intersectClipRect(...box(r, 8))
        return
      case EMR.SAVEDC:
        g.save()
        return
      case EMR.RESTOREDC:
        g.restore(r.i32(8))
        return
      case EMR.SETWORLDTRANSFORM:
        g.set('world', xform(r, 8))
        return
      case EMR.MODIFYWORLDTRANSFORM: {
        const x = xform(r, 8)
        const mode = r.u32(32)
        if (mode === 1) g.set('world', IDENTITY)
        else if (mode === 2) g.set('world', compose(x, dc.world))
        else if (mode === 3) g.set('world', compose(dc.world, x))
        else if (mode === 4) g.set('world', x)
        return
      }
      case EMR.SELECTOBJECT: {
        const index = r.u32(8)
        g.select(index & 0x80000000 ? stockObject(index & 0x7fffffff) ?? undefined : g.objects.get(index))
        return
      }
      case EMR.DELETEOBJECT:
        g.objects.delete(r.u32(8))
        return
      case EMR.CREATEPEN: {
        const style = r.u32(12)
        const width = r.i32(16)
        const pen: Pen = { style: style & 0xff, width: Math.abs(width), color: r.u32(24), geometric: width !== 0, extended: false }
        this.object(r.u32(8), { type: 'pen', pen })
        return
      }
      case EMR.EXTCREATEPEN: {
        const style = r.u32(28)
        const width = r.u32(32)
        const n = r.u32(48)
        const user: number[] = []
        if ((style & 0x0f) === 7 && n > 0 && n <= 64 && r.has(52, n * 4)) for (let i = 0; i < n; i++) user.push(r.u32(52 + i * 4))
        const geometric = (style & 0x10000) !== 0
        const pen: Pen = { style, width: geometric ? width : 0, color: r.u32(40), geometric, extended: true, user }
        // A pen whose brush is the null brush (BS_NULL) draws nothing.
        this.object(r.u32(8), { type: 'pen', pen: r.u32(36) === 1 ? { ...pen, style: (style & ~0x0f) | 5 } : pen })
        return
      }
      case EMR.CREATEBRUSHINDIRECT: {
        const brush: Brush = { style: r.u32(12), color: r.u32(16), hatch: r.u32(20) }
        this.object(r.u32(8), { type: 'brush', brush })
        return
      }
      case EMR.CREATEMONOBRUSH:
      case EMR.CREATEDIBPATTERNBRUSHPT: {
        const usage = r.u32(12)
        const [offBmi, cbBmi, offBits, cbBits] = [r.u32(16), r.u32(20), r.u32(24), r.u32(28)]
        const brush: Brush = {
          style: type === EMR.CREATEMONOBRUSH ? 3 : 6,
          color: 0x808080,
          hatch: 0,
          dib: { info: r.sub(offBmi, cbBmi), bits: r.sub(offBits, cbBits), usage },
          mono: type === EMR.CREATEMONOBRUSH,
        }
        this.object(r.u32(8), { type: 'brush', brush })
        return
      }
      case EMR.EXTCREATEFONTINDIRECTW:
        this.object(r.u32(8), { type: 'font', font: readFontW(r, 12) })
        return
      case EMR.CREATEPALETTE: {
        const n = r.u16(14)
        const colors: number[] = []
        for (let i = 0; i < n && r.has(16 + i * 4, 4); i++) colors.push((r.u8(16 + i * 4) << 16) | (r.u8(17 + i * 4) << 8) | r.u8(18 + i * 4))
        this.object(r.u32(8), { type: 'palette', colors })
        return
      }
      case EMR.SETPALETTEENTRIES: {
        const pal = g.objects.get(r.u32(8))
        if (pal?.type !== 'palette') return
        const start = r.u32(12)
        const n = r.u32(16)
        const colors = pal.colors.slice()
        for (let i = 0; i < n && start + i < 0x10000 && r.has(20 + i * 4, 4); i++) {
          colors[start + i] = (r.u8(20 + i * 4) << 16) | (r.u8(21 + i * 4) << 8) | r.u8(22 + i * 4)
        }
        this.object(r.u32(8), { type: 'palette', colors })
        return
      }
      case EMR.SELECTPALETTE: {
        const index = r.u32(8)
        g.select(index & 0x80000000 ? stockObject(15) ?? undefined : g.objects.get(index))
        return
      }
      case EMR.ANGLEARC:
        g.angleArc(r.i32(8), r.i32(12), r.u32(16), r.f32(20), r.f32(24))
        return
      case EMR.ELLIPSE:
        g.ellipse(...box(r, 8))
        return
      case EMR.RECTANGLE:
        g.rectangle(...box(r, 8))
        return
      case EMR.ROUNDRECT:
        g.roundRect(...box(r, 8), r.i32(24), r.i32(28))
        return
      case EMR.ARC:
      case EMR.CHORD:
      case EMR.PIE:
      case EMR.ARCTO: {
        const kind = type === EMR.ARC ? 'arc' : type === EMR.CHORD ? 'chord' : type === EMR.PIE ? 'pie' : 'arcto'
        g.arc(kind, ...box(r, 8), r.i32(24), r.i32(28), r.i32(32), r.i32(36))
        return
      }
      case EMR.LINETO:
        g.lineTo(r.i32(8), r.i32(12))
        return
      case EMR.SETARCDIRECTION:
        g.set('arcCCW', r.u32(8) !== 2)
        return
      case EMR.SETMITERLIMIT: {
        const v = r.u32(8)
        // Written as a float by some programs, an integer by others.
        const f = r.f32(8)
        g.set('miter', v > 0 && v < 1000 ? v : f > 0 && f < 1000 ? f : 10)
        return
      }
      case EMR.BEGINPATH:
        g.beginPath()
        return
      case EMR.ENDPATH:
        g.endPath()
        return
      case EMR.CLOSEFIGURE:
        g.closeFigure()
        return
      case EMR.FILLPATH:
        g.drawPath(true, false)
        return
      case EMR.STROKEPATH:
        g.drawPath(false, true)
        return
      case EMR.STROKEANDFILLPATH:
        g.drawPath(true, true)
        return
      case EMR.ABORTPATH:
        g.abortPath()
        return
      case EMR.FLATTENPATH:
      case EMR.WIDENPATH:
        return
      case EMR.SELECTCLIPPATH:
        g.selectClipPath(r.u32(8))
        return
      case EMR.FILLRGN: {
        const ih = r.u32(28)
        const obj = ih & 0x80000000 ? stockObject(ih & 0x7fffffff) : g.objects.get(ih)
        const b = obj?.type === 'brush' ? obj.brush : dc.brush
        g.fillRegion(regionRects(r.sub(32, r.u32(24))), b)
        return
      }
      case EMR.PAINTRGN:
        g.fillRegion(regionRects(r.sub(28, r.u32(24))))
        return
      case EMR.FRAMERGN: {
        const brush = g.objects.get(r.u32(28))
        const b = brush?.type === 'brush' ? brush.brush : dc.brush
        g.frameRegion(regionRects(r.sub(40, r.u32(24))), b, r.i32(32), r.i32(36))
        return
      }
      case EMR.INVERTRGN: {
        const saved = dc.rop2
        g.set('rop2', 6)
        g.fillRegion(regionRects(r.sub(28, r.u32(24))), { style: 0, color: 0xffffff, hatch: 0 })
        g.set('rop2', saved)
        return
      }
      case EMR.EXTSELECTCLIPRGN: {
        const cb = r.u32(8)
        const mode = r.u32(12)
        g.selectClipRegion(cb === 0 ? null : regionRects(r.sub(16, cb)), mode)
        return
      }
      case EMR.BITBLT:
      case EMR.STRETCHBLT:
      case EMR.ALPHABLEND:
      case EMR.TRANSPARENTBLT: {
        const dest: [number, number, number, number] = [r.i32(24), r.i32(28), r.i32(32), r.i32(36)]
        const op = r.u32(40)
        const [xSrc, ySrc] = [r.i32(44), r.i32(48)]
        const usage = r.u32(80)
        const [offBmi, cbBmi, offBits, cbBits] = [r.u32(84), r.u32(88), r.u32(92), r.u32(96)]
        const stretch = type !== EMR.BITBLT && r.has(100, 8)
        const [cxSrc, cySrc] = stretch ? [r.i32(100), r.i32(104)] : [dest[2], dest[3]]
        if (type === EMR.BITBLT && (cbBmi === 0 || !Gdi.usesSource(op))) {
          g.patBlt(...dest, op)
          return
        }
        if (type === EMR.STRETCHBLT && (cbBmi === 0 || !Gdi.usesSource(op))) {
          g.patBlt(...dest, op)
          return
        }
        if (type === EMR.ALPHABLEND) {
          const constant = (op >>> 16) & 0xff
          const srcAlpha = ((op >>> 24) & 0xff) === 1
          const bmp = this.dib(r, offBmi, cbBmi, offBits, cbBits, usage, srcAlpha)
          g.bitmap(dest, [xSrc, ySrc, cxSrc, cySrc], bmp, 0xcc0020, { opacity: constant / 255, premultiplied: srcAlpha })
          return
        }
        const bmp = this.dib(r, offBmi, cbBmi, offBits, cbBits, usage)
        if (type === EMR.TRANSPARENTBLT) {
          g.bitmap(dest, [xSrc, ySrc, cxSrc, cySrc], bmp, 0xcc0020, { transparent: g.color(op) })
          return
        }
        g.bitmap(dest, [xSrc, ySrc, cxSrc, cySrc], bmp, op)
        return
      }
      case EMR.STRETCHDIBITS: {
        const dest: [number, number, number, number] = [r.i32(24), r.i32(28), r.i32(72), r.i32(76)]
        const src: [number, number, number, number] = [r.i32(32), r.i32(36), r.i32(40), r.i32(44)]
        const [offBmi, cbBmi, offBits, cbBits, usage, op] = [r.u32(48), r.u32(52), r.u32(56), r.u32(60), r.u32(64), r.u32(68)]
        if (cbBmi === 0 || !Gdi.usesSource(op)) {
          g.patBlt(...dest, op)
          return
        }
        g.bitmap(dest, src, this.dib(r, offBmi, cbBmi, offBits, cbBits, usage), op)
        return
      }
      case EMR.SETDIBITSTODEVICE: {
        const [xDest, yDest] = [r.i32(24), r.i32(28)]
        const src: [number, number, number, number] = [r.i32(32), r.i32(36), r.i32(40), r.i32(44)]
        const [offBmi, cbBmi, offBits, cbBits, usage] = [r.u32(48), r.u32(52), r.u32(56), r.u32(60), r.u32(64)]
        // A device pixel a pixel: its size in logical units is the bitmap's over the scale.
        const m = g.matrix()
        const w = axisAligned(m) && m[0] ? src[2] / Math.abs(m[0]) : src[2]
        const h = axisAligned(m) && m[3] ? src[3] / Math.abs(m[3]) : src[3]
        g.bitmap([xDest, yDest, w, h], src, this.dib(r, offBmi, cbBmi, offBits, cbBits, usage), 0xcc0020)
        return
      }
      case EMR.EXTTEXTOUTA:
      case EMR.EXTTEXTOUTW:
        this.text(r, 36, type === EMR.EXTTEXTOUTW)
        return
      case EMR.SMALLTEXTOUT: {
        const [x, y, n, options] = [r.i32(8), r.i32(12), r.u32(16), r.u32(20)]
        const hasRect = !(options & 0x100)
        const at = hasRect ? 52 : 36
        const rc = hasRect ? box(r, 36) : null
        const narrow = (options & 0x200) !== 0
        const str = narrow ? decodeAnsi(r.bytes(at, n), dc.font.charset) : r.utf16(at, n)
        g.text(x, y, str, null, options & 0xff, rc)
        return
      }
      case EMR.GRADIENTFILL: {
        const [nVer, nTri, mode] = [r.u32(24), r.u32(28), r.u32(32)]
        if (!r.has(36, nVer * 16)) throw new ShortRecord()
        const vertices: { x: number; y: number; rgb: number }[] = []
        for (let i = 0; i < nVer; i++) {
          const at = 36 + i * 16
          vertices.push({ x: r.i32(at), y: r.i32(at + 4), rgb: ((r.u16(at + 8) >> 8) << 16) | ((r.u16(at + 10) >> 8) << 8) | (r.u16(at + 12) >> 8) })
        }
        const per = mode === 2 ? 3 : 2
        const shapes: number[][] = []
        const at0 = 36 + nVer * 16
        for (let i = 0; i < nTri && r.has(at0 + (i + 1) * per * 4 - 4, 4); i++) {
          const s: number[] = []
          for (let k = 0; k < per; k++) s.push(r.u32(at0 + (i * per + k) * 4))
          shapes.push(s)
        }
        g.gradient(vertices, mode, shapes)
        return
      }
      case EMR.SETLAYOUT:
        g.set('layout', r.u32(8))
        return
      case EMR.MASKBLT: {
        const dest: [number, number, number, number] = [r.i32(24), r.i32(28), r.i32(32), r.i32(36)]
        const rop = r.u32(40)
        const [usage, offBmi, cbBmi, offBits, cbBits] = [r.u32(80), r.u32(84), r.u32(88), r.u32(92), r.u32(96)]
        const mask = this.mask(r, 108)
        if (cbBmi === 0) {
          // No source: a pattern fill, by the foreground operation (a mask on one is not drawn).
          if (mask) g.lost.add('masked pattern fills')
          g.patBlt(...dest, rop & 0xff0000)
          return
        }
        this.masked(dest, [r.i32(44), r.i32(48), dest[2], dest[3]], this.dib(r, offBmi, cbBmi, offBits, cbBits, usage), mask, [r.i32(100), r.i32(104)], rop)
        return
      }
      case EMR.PLGBLT: {
        const to = points(r, 24, 3, false)
        const src: [number, number, number, number] = [r.i32(48), r.i32(52), r.i32(56), r.i32(60)]
        const [usage, offBmi, cbBmi, offBits, cbBits] = [r.u32(92), r.u32(96), r.u32(100), r.u32(104), r.u32(108)]
        // The source is copied where the mask is set; where it is clear, the page is left alone.
        this.masked([0, 0, 0, 0], src, this.dib(r, offBmi, cbBmi, offBits, cbBits, usage), this.mask(r, 120), [r.i32(112), r.i32(116)], 0xaacc0020, to)
        return
      }
      case EMR.EXTFLOODFILL:
        g.lost.add('flood fill')
        return
      case EMR.POLYTEXTOUTA:
      case EMR.POLYTEXTOUTW: {
        // Strings each an EMRTEXT of their own, as ExtTextOut's: as many as the record holds.
        const n = Math.min(r.u32(36), Math.floor((r.length - 40) / 40))
        for (let i = 0; i < n; i++) this.text(r, 40 + i * 40, type === EMR.POLYTEXTOUTW)
        return
      }
      default:
        return
    }
  }
}
