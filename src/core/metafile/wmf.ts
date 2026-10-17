import { ShortRecord, View } from './bytes'
import { readPackedDib } from './dib'
import { MAX_OBJECTS, MAX_RECORDS } from './emf'
import { decodeAnsi, ETO_CLIPPED, ETO_OPAQUE, Gdi, singleByte, type Font, type GdiObject } from './gdi'
import { TooLarge, type Rect } from './svg'

/*
 * WMF records ([MS-WMF]), played into the same Gdi device context EMF
 * uses. WMF's coordinates are 16-bit logical units; the window (from the
 * Aldus placeable header, or the file's own SetWindowOrg/SetWindowExt)
 * is what maps onto the picture. Objects take the lowest free slot in the
 * object table as they are made, as GDI's playback does, so a record this
 * file does not read still takes its slot (a placeholder) and the indexes
 * after it stay right. A WMF that carries an EMF in its comments
 * (MFCOMMENT, "WMFC" - what Office writes for a picture it saved both
 * ways) is drawn from that EMF instead (embeddedEmf).
 */

export const META = {
  EOF: 0x0000,
  SAVEDC: 0x001e,
  REALIZEPALETTE: 0x0035,
  SETPALENTRIES: 0x0037,
  CREATEPALETTE: 0x00f7,
  SETBKMODE: 0x0102,
  SETMAPMODE: 0x0103,
  SETROP2: 0x0104,
  SETRELABS: 0x0105,
  SETPOLYFILLMODE: 0x0106,
  SETSTRETCHBLTMODE: 0x0107,
  SETTEXTCHAREXTRA: 0x0108,
  RESTOREDC: 0x0127,
  INVERTREGION: 0x012a,
  PAINTREGION: 0x012b,
  SELECTCLIPREGION: 0x012c,
  SELECTOBJECT: 0x012d,
  SETTEXTALIGN: 0x012e,
  RESIZEPALETTE: 0x0139,
  DIBCREATEPATTERNBRUSH: 0x0142,
  SETLAYOUT: 0x0149,
  DELETEOBJECT: 0x01f0,
  CREATEPATTERNBRUSH: 0x01f9,
  SETBKCOLOR: 0x0201,
  SETTEXTCOLOR: 0x0209,
  SETTEXTJUSTIFICATION: 0x020a,
  SETWINDOWORG: 0x020b,
  SETWINDOWEXT: 0x020c,
  SETVIEWPORTORG: 0x020d,
  SETVIEWPORTEXT: 0x020e,
  OFFSETWINDOWORG: 0x020f,
  OFFSETVIEWPORTORG: 0x0211,
  LINETO: 0x0213,
  MOVETO: 0x0214,
  OFFSETCLIPRGN: 0x0220,
  FILLREGION: 0x0228,
  SETMAPPERFLAGS: 0x0231,
  SELECTPALETTE: 0x0234,
  CREATEPENINDIRECT: 0x02fa,
  CREATEFONTINDIRECT: 0x02fb,
  CREATEBRUSHINDIRECT: 0x02fc,
  POLYGON: 0x0324,
  POLYLINE: 0x0325,
  SCALEWINDOWEXT: 0x0410,
  SCALEVIEWPORTEXT: 0x0412,
  EXCLUDECLIPRECT: 0x0415,
  INTERSECTCLIPRECT: 0x0416,
  ELLIPSE: 0x0418,
  FLOODFILL: 0x0419,
  RECTANGLE: 0x041b,
  SETPIXEL: 0x041f,
  FRAMEREGION: 0x0429,
  ANIMATEPALETTE: 0x0436,
  TEXTOUT: 0x0521,
  POLYPOLYGON: 0x0538,
  EXTFLOODFILL: 0x0548,
  ROUNDRECT: 0x061c,
  PATBLT: 0x061d,
  ESCAPE: 0x0626,
  CREATEREGION: 0x06ff,
  ARC: 0x0817,
  PIE: 0x081a,
  CHORD: 0x0830,
  BITBLT: 0x0922,
  DIBBITBLT: 0x0940,
  EXTTEXTOUT: 0x0a32,
  STRETCHBLT: 0x0b23,
  DIBSTRETCHBLT: 0x0b41,
  SETDIBTODEV: 0x0d33,
  STRETCHDIB: 0x0f43,
} as const

export interface WmfHeader {
  /** The Aldus placeable header's box (logical units) and units an inch, when there is one. */
  placeable: { box: Rect; inch: number } | null
  /** Where the first record starts. */
  records: number
}

export function readWmfHeader(file: View): WmfHeader | null {
  let start = 0
  let placeable: WmfHeader['placeable'] = null
  if (file.has(0, 22) && file.u32(0) === 0x9ac6cdd7) {
    const box = { l: file.i16(6), t: file.i16(8), r: file.i16(10), b: file.i16(12) }
    placeable = { box, inch: file.u16(14) }
    start = 22
  }
  if (!file.has(start, 18)) return null
  const type = file.u16(start)
  const size = file.u16(start + 2)
  if ((type !== 1 && type !== 2) || size !== 9 || ![0x100, 0x300].includes(file.u16(start + 4))) return null
  return { placeable, records: start + 18 }
}

export function* wmfRecords(file: View, start: number): Generator<{ fn: number; r: View; words: number }> {
  let at = start
  let n = 0
  while (at + 6 <= file.length && n++ < MAX_RECORDS) {
    const words = file.u32(at)
    const fn = file.u16(at + 4)
    if (words < 3 || at + words * 2 > file.length) return
    yield { fn, r: file.sub(at, words * 2), words }
    if (fn === META.EOF) return
    at += words * 2
  }
}

/** The largest EMF put back together from a WMF's comments. */
const MAX_EMBEDDED_BYTES = 64 * 1024 * 1024

/** The EMF a WMF carries in its MFCOMMENT escapes ("WMFC" chunks), when it is all there. */
export function embeddedEmf(file: View, header: WmfHeader): Buffer | null {
  const chunks: Buffer[] = []
  let total = -1
  let got = 0
  for (const { fn, r } of wmfRecords(file, header.records)) {
    if (fn !== META.ESCAPE || !r.has(6, 4) || r.u16(6) !== 0x000f) continue
    if (!r.has(10, 34) || r.u32(10) !== 0x43464d57 || r.u32(14) !== 1) continue
    const size = r.u32(40)
    const current = r.u32(32)
    if (total < 0) {
      if (size === 0 || size > MAX_EMBEDDED_BYTES) return null
      total = size
    } else if (size !== total) return null
    if (got + current > total || !r.has(44, current)) return null
    chunks.push(r.bytes(44, current))
    got += current
    if (got === total) return Buffer.concat(chunks)
  }
  return null
}

export class WmfPlayer {
  failed = 0
  played = 0

  constructor(readonly gdi: Gdi) {}

  private create(obj: GdiObject): void {
    for (let i = 0; i < MAX_OBJECTS; i++) {
      if (!this.gdi.objects.has(i)) {
        this.gdi.objects.set(i, obj)
        return
      }
    }
  }

  play(file: View, header: WmfHeader): void {
    for (const { fn, r, words } of wmfRecords(file, header.records)) {
      this.played++
      try {
        this.record(fn, r, words)
      } catch (err) {
        if (err instanceof TooLarge) throw err
        this.failed++
        // A record that makes an object still takes its slot.
        if ((fn & 0xff) >= 0xf7 || fn === META.DIBCREATEPATTERNBRUSH) this.create({ type: 'brush', brush: { style: 1, color: 0, hatch: 0 } })
      }
    }
  }

  private record(fn: number, r: View, words: number): void {
    const g = this.gdi
    const w = (i: number): number => r.i16(6 + i * 2)
    const u = (i: number): number => r.u16(6 + i * 2)
    const pts = (at: number, count: number): number[] => {
      if (!r.has(at, count * 4)) throw new ShortRecord()
      const out: number[] = []
      for (let i = 0; i < count; i++) out.push(r.i16(at + i * 4), r.i16(at + i * 4 + 2))
      return out
    }
    // A bit-block record without a bitmap is its parameters and one reserved word, no more.
    const noBitmap = words === (fn >> 8) + 3
    switch (fn) {
      case META.SETBKCOLOR:
        g.set('bkColor', r.u32(6))
        return
      case META.SETBKMODE:
        g.set('bkMode', u(0))
        return
      case META.SETMAPMODE:
        g.set('mapMode', u(0))
        return
      case META.SETROP2:
        g.set('rop2', u(0))
        return
      case META.SETPOLYFILLMODE:
        g.set('fillMode', u(0))
        return
      case META.SETTEXTALIGN:
        g.set('textAlign', u(0))
        return
      case META.SETTEXTCOLOR:
        g.set('textColor', r.u32(6))
        return
      case META.SETWINDOWORG:
        g.set('winOrg', [w(1), w(0)])
        return
      case META.SETWINDOWEXT:
        g.set('winExt', [w(1), w(0)])
        g.windowKnown = true
        g.changed()
        return
      case META.OFFSETWINDOWORG:
        g.set('winOrg', [g.dc.winOrg[0] + w(1), g.dc.winOrg[1] + w(0)])
        return
      case META.SCALEWINDOWEXT: {
        const [yd, yn, xd, xn] = [w(0), w(1), w(2), w(3)]
        if (xd && yd) g.set('winExt', [(g.dc.winExt[0] * xn) / xd, (g.dc.winExt[1] * yn) / yd])
        return
      }
      case META.LINETO:
        g.lineTo(w(1), w(0))
        return
      case META.MOVETO:
        g.moveTo(w(1), w(0))
        return
      case META.EXCLUDECLIPRECT:
        g.excludeClipRect(w(3), w(2), w(1), w(0))
        return
      case META.INTERSECTCLIPRECT:
        g.intersectClipRect(w(3), w(2), w(1), w(0))
        return
      case META.ARC:
      case META.PIE:
      case META.CHORD:
        g.arc(fn === META.ARC ? 'arc' : fn === META.PIE ? 'pie' : 'chord', w(7), w(6), w(5), w(4), w(3), w(2), w(1), w(0))
        return
      case META.ELLIPSE:
        g.ellipse(w(3), w(2), w(1), w(0))
        return
      case META.RECTANGLE:
        g.rectangle(w(3), w(2), w(1), w(0))
        return
      case META.ROUNDRECT:
        g.roundRect(w(5), w(4), w(3), w(2), w(1), w(0))
        return
      case META.PATBLT:
        g.patBlt(w(5), w(4), w(3), w(2), r.u32(6))
        return
      case META.SAVEDC:
        g.save()
        return
      case META.RESTOREDC:
        g.restore(w(0))
        return
      case META.SETPIXEL:
        g.setPixel(w(3), w(2), r.u32(6))
        return
      case META.OFFSETCLIPRGN:
        g.offsetClip(w(1), w(0))
        return
      case META.TEXTOUT: {
        const n = u(0)
        const bytes = r.bytes(8, n)
        const at = 8 + n + (n & 1)
        g.text(r.i16(at + 2), r.i16(at), decodeAnsi(bytes, g.dc.font.charset), null, 0, null)
        return
      }
      case META.EXTTEXTOUT: {
        const [y, x, n, options] = [w(0), w(1), u(2), u(3)]
        let at = 14
        let box: [number, number, number, number] | null = null
        if (options & (ETO_OPAQUE | ETO_CLIPPED)) {
          box = [r.i16(14), r.i16(16), r.i16(18), r.i16(20)]
          at = 22
        }
        const bytes = r.bytes(at, n)
        at += n + (n & 1)
        let dx: number[] | null = null
        const charset = g.dc.font.charset
        if (singleByte(charset) && r.has(at, n * 2)) {
          dx = []
          for (let i = 0; i < n; i++) dx.push(r.i16(at + i * 2))
        }
        g.text(x, y, decodeAnsi(bytes, charset), dx, options, box)
        return
      }
      case META.POLYGON:
      case META.POLYLINE:
        g.poly(pts(8, u(0)), fn === META.POLYGON)
        return
      case META.POLYPOLYGON: {
        const n = u(0)
        if (!r.has(8, n * 2)) throw new ShortRecord()
        const counts = Array.from({ length: n }, (_, i) => r.u16(8 + i * 2))
        let at = 8 + n * 2
        const polys = counts.map((c) => {
          const p = pts(at, c)
          at += c * 4
          return p
        })
        g.polyPoly(polys, true)
        return
      }
      case META.ESCAPE:
        return
      case META.FILLREGION:
      case META.PAINTREGION:
      case META.FRAMEREGION:
      case META.INVERTREGION: {
        const region = g.objects.get(u(0))
        if (region?.type !== 'region') return
        if (fn === META.PAINTREGION) g.fillRegion(region.rects)
        else if (fn === META.INVERTREGION) {
          const saved = g.dc.rop2
          g.set('rop2', 6)
          g.fillRegion(region.rects, { style: 0, color: 0xffffff, hatch: 0 })
          g.set('rop2', saved)
        } else {
          const brush = g.objects.get(u(1))
          const b = brush?.type === 'brush' ? brush.brush : g.dc.brush
          if (fn === META.FILLREGION) g.fillRegion(region.rects, b)
          else g.frameRegion(region.rects, b, w(3), w(2))
        }
        return
      }
      case META.SELECTCLIPREGION: {
        const region = g.objects.get(u(0))
        g.selectClipRegion(region?.type === 'region' ? g.regionToDevice(region.rects) : null, 5)
        return
      }
      case META.SELECTOBJECT:
      case META.SELECTPALETTE:
        g.select(g.objects.get(u(0)))
        return
      case META.DELETEOBJECT:
        g.objects.delete(u(0))
        return
      case META.CREATEPENINDIRECT: {
        const width = Math.abs(w(1))
        this.create({ type: 'pen', pen: { style: u(0), width, color: r.u32(12), geometric: width !== 0, extended: false } })
        return
      }
      case META.CREATEBRUSHINDIRECT:
        this.create({ type: 'brush', brush: { style: u(0), color: r.u32(8), hatch: u(3) } })
        return
      case META.DIBCREATEPATTERNBRUSH: {
        const usage = u(1)
        const dib = r.rest(10)
        const bitsAt = dibBitsOffset(dib, usage)
        if (bitsAt === null) throw new ShortRecord()
        this.create({ type: 'brush', brush: { style: 5, color: 0x808080, hatch: 0, dib: { info: dib.sub(0, bitsAt), bits: dib.rest(bitsAt), usage } } })
        return
      }
      case META.CREATEPATTERNBRUSH:
        g.lost.add('old-style pattern brushes')
        this.create({ type: 'brush', brush: { style: 0, color: 0x808080, hatch: 0 } })
        return
      case META.CREATEFONTINDIRECT: {
        const faceBytes = r.has(24, 1) ? r.bytes(24, Math.min(32, r.length - 24)) : Buffer.alloc(0)
        const end = faceBytes.indexOf(0)
        const charset = r.u8(19)
        const font: Font = {
          height: w(0),
          width: w(1),
          escapement: w(2),
          orientation: w(3),
          weight: w(4),
          italic: r.u8(16) !== 0,
          underline: r.u8(17) !== 0,
          strike: r.u8(18) !== 0,
          charset,
          pitchFamily: r.u8(23),
          face: decodeAnsi(end >= 0 ? faceBytes.subarray(0, end) : faceBytes, charset === 2 ? 0 : charset),
        }
        this.create({ type: 'font', font })
        return
      }
      case META.CREATEPALETTE: {
        const n = u(1)
        const colors: number[] = []
        for (let i = 0; i < n && r.has(10 + i * 4, 4); i++) colors.push((r.u8(10 + i * 4) << 16) | (r.u8(11 + i * 4) << 8) | r.u8(12 + i * 4))
        this.create({ type: 'palette', colors })
        return
      }
      case META.CREATEREGION:
        this.create({ type: 'region', rects: regionScans(r) })
        return
      case META.STRETCHDIB: {
        const rop = r.u32(6)
        const usage = u(2)
        const [sh, sw, sy, sx, dh, dw, dy, dx] = [w(3), w(4), w(5), w(6), w(7), w(8), w(9), w(10)]
        const dib = readPackedDib(r.rest(28), { budget: g.setup.budget, usage, palette: g.dc.palette ?? undefined })
        g.bitmap([dx, dy, dw, dh], [sx, sy, sw, sh], dib, rop)
        return
      }
      case META.DIBSTRETCHBLT:
      case META.STRETCHBLT: {
        const rop = r.u32(6)
        if (noBitmap) {
          g.patBlt(w(10), w(9), w(8), w(7), rop)
          return
        }
        if (fn === META.STRETCHBLT) {
          g.lost.add('device-dependent bitmaps')
          return
        }
        const [sh, sw, sy, sx, dh, dw, dy, dx] = [w(2), w(3), w(4), w(5), w(6), w(7), w(8), w(9)]
        const dib = readPackedDib(r.rest(26), { budget: g.setup.budget, palette: g.dc.palette ?? undefined })
        g.bitmap([dx, dy, dw, dh], [sx, sy, sw, sh], dib, rop)
        return
      }
      case META.DIBBITBLT:
      case META.BITBLT: {
        const rop = r.u32(6)
        if (noBitmap) {
          g.patBlt(w(8), w(7), w(6), w(5), rop)
          return
        }
        if (fn === META.BITBLT) {
          g.lost.add('device-dependent bitmaps')
          return
        }
        const [sy, sx, h, wd, dy, dx] = [w(2), w(3), w(4), w(5), w(6), w(7)]
        const dib = readPackedDib(r.rest(22), { budget: g.setup.budget, palette: g.dc.palette ?? undefined })
        g.bitmap([dx, dy, wd, h], [sx, sy, wd, h], dib, rop)
        return
      }
      case META.SETDIBTODEV: {
        const usage = u(0)
        const [sy, sx, h, wd, dy, dx] = [w(3), w(4), w(5), w(6), w(7), w(8)]
        const dib = readPackedDib(r.rest(24), { budget: g.setup.budget, usage, palette: g.dc.palette ?? undefined })
        g.bitmap([dx, dy, wd, h], [sx, sy, wd, h], dib, 0xcc0020)
        return
      }
      case META.FLOODFILL:
      case META.EXTFLOODFILL:
        g.lost.add('flood fill')
        return
      default:
        return
    }
  }
}

function dibBitsOffset(dib: View, usage: number): number | null {
  if (!dib.has(0, 4)) return null
  const size = dib.u32(0)
  const bpp = size === 12 ? dib.u16(10) : dib.has(14, 2) ? dib.u16(14) : 0
  const used = size >= 40 && dib.has(32, 4) ? dib.u32(32) : 0
  const compression = size >= 40 && dib.has(16, 4) ? dib.u32(16) : 0
  const masks = size === 40 && (compression === 3 || compression === 6) ? (compression === 6 ? 16 : 12) : 0
  const entries = bpp <= 8 ? (used > 0 ? Math.min(used, 1 << bpp) : 1 << bpp) : 0
  return size + masks + entries * (usage === 1 ? 2 : size === 12 ? 3 : 4)
}

/** A WMF region's rectangles, from its scans (top, bottom, then left-right pairs). */
function regionScans(r: View): Rect[] {
  const scans = r.i16(16)
  const out: Rect[] = []
  let at = 28
  for (let s = 0; s < scans && out.length < 10000; s++) {
    const count = r.u16(at)
    const top = r.i16(at + 2)
    const bottom = r.i16(at + 4)
    for (let k = 0; k + 1 < count; k += 2) {
      const left = r.i16(at + 6 + k * 2)
      const right = r.i16(at + 8 + k * 2)
      if (right > left && bottom > top) out.push({ l: left, t: top, r: right, b: bottom })
    }
    at += 6 + count * 2 + 2
  }
  if (out.length === 0 && scans === 0) return []
  return out
}
