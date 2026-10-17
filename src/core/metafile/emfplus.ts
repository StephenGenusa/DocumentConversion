import { imageMime } from '../readers/image'
import { ShortRecord, View } from './bytes'
import { readPackedDib, toPicture, type Budget, type Picture, type Raster } from './dib'
import { MAX_RECORDS, type PlusHook } from './emf'
import { fontFamily, type Font } from './gdi'
import {
  apply,
  axisAligned,
  clipEmpty,
  clipExcludePath,
  clipExcludeRects,
  clipIntersectPath,
  clipIntersectRects,
  clipOffset,
  clipRects,
  clipUnion,
  esc,
  hex,
  IDENTITY,
  matrixAttr,
  num,
  PathData,
  rect,
  scaleOf,
  compose,
  TooLarge,
  union,
  type Clip,
  type ImageData,
  type Matrix,
  type Paint,
  type Rect,
  type Stroke,
  type SvgOut,
} from './svg'

/*
 * EMF+ records ([MS-EMFPLUS]), the GDI+ drawing Office writes inside an
 * EMF's comments. A "dual" file holds the same picture in EMF records too,
 * and those are what is drawn (emf.ts); this draws an EMF+-only file, and
 * finds the original JPEG or PNG a dual file's picture was made from
 * (index.ts). Objects (brushes, pens, paths, regions, images, fonts,
 * string formats) are kept in the 64-entry table the format has; one
 * split across records is put back together, up to the size it declared
 * and never past MAX_OBJECT_BYTES. Coordinates are world units, through
 * the world and page transforms to the EMF+ device, then scaled to the
 * EMF's own device (the reference device both describe).
 */

/** The largest object reassembled from continued records. */
const MAX_OBJECT_BYTES = 64 * 1024 * 1024
/** How deep a region's tree of nodes may go. */
const MAX_REGION_DEPTH = 32

type Brush =
  | { kind: 'solid'; argb: number }
  | { kind: 'hatch'; style: number; fore: number; back: number }
  | { kind: 'linear'; rect: [number, number, number, number]; stops: [number, number][]; transform: Matrix; wrap: number }

interface Pen {
  width: number
  unit: number
  brush: Brush
  dash?: number[]
  cap: Stroke['cap']
  join: Stroke['join']
  miter: number
}

interface Path {
  points: number[]
  types: number[]
}

type Region =
  | { op: 'rect'; rect: [number, number, number, number] }
  | { op: 'path'; path: Path }
  | { op: 'empty' }
  | { op: 'infinite' }
  | { op: 'and' | 'or' | 'xor' | 'exclude' | 'complement'; a: Region; b: Region }

type Image = { kind: 'bitmap'; picture: Picture } | { kind: 'nested'; image: ImageData }

interface PlusFont {
  emSize: number
  unit: number
  style: number
  family: string
}

interface Format {
  align: number
  lineAlign: number
}

type PlusObject =
  | { type: 'brush'; brush: Brush }
  | { type: 'pen'; pen: Pen }
  | { type: 'path'; path: Path }
  | { type: 'region'; region: Region }
  | { type: 'image'; image: Image }
  | { type: 'font'; font: PlusFont }
  | { type: 'format'; format: Format }

interface State {
  world: Matrix
  clip: Clip
  pageUnit: number
  pageScale: number
}

const argbPaint = (argb: number): Paint => ({ kind: 'color', rgb: argb & 0xffffff, alpha: (argb >>> 24) / 255 })

/** A metafile drawn on its own, for an EMF+ image that is one (index.ts provides it). */
export type NestedMetafile = (bytes: Buffer) => ImageData | null

export class EmfPlusPlayer implements PlusHook {
  gdi = false
  /** Whether the file is dual (EMF records draw the same picture); null until the header is read. */
  dual: boolean | null = null
  records = 0
  failed = 0
  private objects = new Map<number, PlusObject>()
  private partial: { id: number; type: number; total: number; chunks: Buffer[]; got: number } | null = null
  private state: State = { world: IDENTITY, clip: null, pageUnit: 2, pageScale: 1 }
  private saved = new Map<number, State>()
  private dpi: [number, number] = [96, 96]

  constructor(
    private readonly out: SvgOut,
    /** The EMF's device pixels per millimetre (its reference device). */
    private readonly pxPerMm: [number, number],
    private readonly budget: Budget,
    private readonly universe: Rect,
    readonly lost: Set<string>,
    private readonly nested: NestedMetafile,
  ) {}

  /* ---- transforms ----------------------------------------------------- */

  private unitPx(unit: number, axis: 0 | 1 = 0): number {
    const dpi = this.dpi[axis]
    switch (unit) {
      case 3:
        return dpi / 72
      case 4:
        return dpi
      case 5:
        return dpi / 300
      case 6:
        return dpi / 25.4
      default:
        return 1
    }
  }

  /** EMF+ device pixels to the EMF's device pixels. */
  private toGdi(): Matrix {
    return [(this.pxPerMm[0] * 25.4) / this.dpi[0], 0, 0, (this.pxPerMm[1] * 25.4) / this.dpi[1], 0, 0]
  }

  private page(): Matrix {
    const s = this.state.pageScale
    return [this.unitPx(this.state.pageUnit, 0) * s, 0, 0, this.unitPx(this.state.pageUnit, 1) * s, 0, 0]
  }

  /** World units to the EMF's device space. */
  private matrix(): Matrix {
    return compose(compose(this.state.world, this.page()), this.toGdi())
  }

  /* ---- reading -------------------------------------------------------- */

  comment(data: View): void {
    this.gdi = false
    let at = 0
    while (at + 12 <= data.length) {
      const type = data.u16(at)
      const flags = data.u16(at + 2)
      const size = data.u32(at + 4)
      const dataSize = data.u32(at + 8)
      if (size < 12 || at + size > data.length || ++this.records > MAX_RECORDS) return
      try {
        this.record(type, flags, data.sub(at + 12, Math.min(dataSize, size - 12)))
      } catch (err) {
        if (err instanceof TooLarge) throw err
        this.failed++
      }
      at += size
    }
  }

  private rectF(v: View, at: number, compressed: boolean): [number, number, number, number] {
    return compressed ? [v.i16(at), v.i16(at + 2), v.i16(at + 4), v.i16(at + 6)] : [v.f32(at), v.f32(at + 4), v.f32(at + 8), v.f32(at + 12)]
  }

  /** `count` points at `at`: floats, 16-bit integers (compressed), or relative (EmfPlusPointR); and where they end. */
  private points(v: View, at: number, count: number, compressed: boolean, relative: boolean): { pts: number[]; end: number } {
    if (count > v.length) throw new ShortRecord()
    const pts: number[] = []
    if (relative) {
      let x = 0
      let y = 0
      let p = at
      const one = (): number => {
        const b = v.u8(p)
        if (b & 0x80) {
          const raw = ((b & 0x7f) << 8) | v.u8(p + 1)
          p += 2
          return raw & 0x4000 ? raw - 0x8000 : raw
        }
        p += 1
        return b & 0x40 ? b - 0x80 : b
      }
      for (let i = 0; i < count; i++) {
        x += one()
        y += one()
        pts.push(x, y)
      }
      return { pts, end: p }
    }
    const size = compressed ? 4 : 8
    if (!v.has(at, count * size)) throw new ShortRecord()
    for (let i = 0; i < count; i++) {
      if (compressed) pts.push(v.i16(at + i * 4), v.i16(at + i * 4 + 2))
      else pts.push(v.f32(at + i * 8), v.f32(at + i * 8 + 4))
    }
    return { pts, end: at + count * size }
  }

  private readBrush(v: View): Brush {
    const type = v.u32(4)
    switch (type) {
      case 0:
        return { kind: 'solid', argb: v.u32(8) }
      case 1:
        return { kind: 'hatch', style: v.u32(8), fore: v.u32(12), back: v.u32(16) }
      case 4: {
        const flags = v.u32(8)
        const wrap = v.i32(12)
        const rect = this.rectF(v, 16, false)
        const start = v.u32(32)
        const end = v.u32(36)
        let at = 48
        let transform: Matrix = IDENTITY
        if (flags & 0x02) {
          transform = [v.f32(at), v.f32(at + 4), v.f32(at + 8), v.f32(at + 12), v.f32(at + 16), v.f32(at + 20)]
          at += 24
        }
        let stops: [number, number][] = [
          [0, start],
          [1, end],
        ]
        if (flags & 0x04) {
          const n = v.u32(at)
          if (n >= 2 && n <= 256 && v.has(at + 4, n * 8)) {
            stops = []
            for (let i = 0; i < n; i++) stops.push([v.f32(at + 4 + i * 4), v.u32(at + 4 + n * 4 + i * 4)])
          }
        } else if (flags & 0x08) {
          // Blend factors: the mix of the end colour at each position.
          const n = v.u32(at)
          if (n >= 2 && n <= 256 && v.has(at + 4, n * 8)) {
            stops = []
            for (let i = 0; i < n; i++) stops.push([v.f32(at + 4 + i * 4), mix(start, end, v.f32(at + 4 + n * 4 + i * 4))])
          }
        }
        return { kind: 'linear', rect, stops, transform, wrap }
      }
      case 3:
        // A path gradient: its centre colour.
        return { kind: 'solid', argb: v.u32(16) }
      default:
        this.lost.add('texture brushes')
        return { kind: 'solid', argb: 0xff808080 }
    }
  }

  private readPen(v: View): Pen {
    const flags = v.u32(8)
    const unit = v.u32(12)
    const width = v.f32(16)
    let at = 20
    let cap: Stroke['cap'] = 'butt'
    let join: Stroke['join'] = 'miter'
    let miter = 10
    let style = 0
    let custom: number[] | undefined
    if (flags & 0x01) at += 24
    if (flags & 0x02) {
      const c = v.i32(at)
      cap = c === 1 ? 'square' : c === 2 || c >= 0x10 ? 'round' : 'butt'
      at += 4
    }
    if (flags & 0x04) at += 4
    if (flags & 0x08) {
      const j = v.i32(at)
      join = j === 1 ? 'bevel' : j === 2 ? 'round' : 'miter'
      at += 4
    }
    if (flags & 0x10) {
      miter = v.f32(at)
      at += 4
    }
    if (flags & 0x20) {
      style = v.i32(at)
      at += 4
    }
    if (flags & 0x40) at += 4
    if (flags & 0x80) at += 4
    if (flags & 0x100) {
      const n = v.u32(at)
      if (n > 1024) throw new ShortRecord()
      custom = []
      for (let i = 0; i < n; i++) custom.push(v.f32(at + 4 + i * 4))
      at += 4 + n * 4
    }
    if (flags & 0x200) at += 4
    if (flags & 0x400) at += 4 + v.u32(at) * 4
    if (flags & 0x800) at += 4 + v.u32(at)
    if (flags & 0x1000) at += 4 + v.u32(at)
    const patterns: Record<number, number[]> = { 1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1] }
    const dash = style === 5 ? custom : patterns[style]
    return { width, unit, brush: this.readBrush(v.rest(at)), dash, cap, join, miter }
  }

  private readPath(v: View): Path {
    const count = v.u32(4)
    const flags = v.u32(8)
    const { pts, end } = this.points(v, 12, count, (flags & 0x4000) !== 0, (flags & 0x0800) !== 0)
    const types: number[] = []
    if (flags & 0x1000) {
      // Run-length encoded types: a run count (6 bits, and a bezier bit), then the type.
      let p = end
      while (types.length < count) {
        const run = v.u8(p) & 0x3f
        const t = v.u8(p + 1)
        p += 2
        if (run === 0) break
        for (let k = 0; k < run && types.length < count; k++) types.push(t)
      }
    } else {
      if (!v.has(end, count)) throw new ShortRecord()
      for (let i = 0; i < count; i++) types.push(v.u8(end + i))
    }
    return { points: pts, types }
  }

  private readRegion(v: View): Region {
    let at = 8
    let nodes = 0
    const node = (depth: number): Region => {
      if (depth > MAX_REGION_DEPTH || ++nodes > 4096) throw new ShortRecord()
      const type = v.u32(at)
      at += 4
      switch (type) {
        case 0x10000000: {
          const r = this.rectF(v, at, false)
          at += 16
          return { op: 'rect', rect: r }
        }
        case 0x10000001: {
          const size = v.u32(at)
          const path = this.readPath(v.sub(at + 4, size))
          at += 4 + size
          return { op: 'path', path }
        }
        case 0x10000002:
          return { op: 'empty' }
        case 0x10000003:
          return { op: 'infinite' }
        default: {
          const ops = ['and', 'or', 'xor', 'exclude', 'complement'] as const
          const op = ops[type]
          if (!op) throw new ShortRecord()
          const a = node(depth + 1)
          const b = node(depth + 1)
          return { op, a, b }
        }
      }
    }
    return node(0)
  }

  /** A GDI+ bitmap: compressed (PNG, JPEG, GIF kept as they are; BMP decoded) or raw pixels. */
  private readImage(v: View): Image | null {
    const type = v.u32(4)
    if (type === 2) {
      const size = v.u32(12)
      const bytes = v.bytes(16, Math.min(size, v.length - 16))
      const image = this.nested(bytes)
      return image ? { kind: 'nested', image } : null
    }
    if (type !== 1) return null
    const width = v.i32(8)
    const height = v.i32(12)
    const stride = v.i32(16)
    const format = v.u32(20)
    const compressed = v.u32(24) === 1
    const data = v.rest(28)
    if (compressed) {
      const bytes = data.bytes(0, data.length)
      const mime = imageMime(bytes)
      if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif') {
        if (!this.budget.take(Math.max(1, width), Math.max(1, height))) return null
        return { kind: 'bitmap', picture: { mime, bytes, width, height, opaque: mime === 'image/jpeg' } }
      }
      if (bytes.length > 14 && bytes.toString('latin1', 0, 2) === 'BM') {
        const dib = readPackedDib(data.rest(14), { budget: this.budget })
        return dib ? { kind: 'bitmap', picture: toPicture(dib) } : null
      }
      this.lost.add('pictures in formats other than PNG, JPEG, GIF and BMP')
      return null
    }
    const raster = this.pixels(data, width, height, stride, format)
    return raster ? { kind: 'bitmap', picture: toPicture(raster) } : null
  }

  private pixels(v: View, width: number, height: number, stride: number, format: number): Raster | null {
    const bpp = (format >> 8) & 0xff
    const indexed = (format & 0x00010000) !== 0
    let palette: number[] = []
    let at = 0
    if (indexed) {
      const n = v.u32(4)
      if (n > 256) return null
      for (let i = 0; i < n; i++) palette.push(v.u32(8 + i * 4))
      at = 8 + n * 4
    }
    if (!(stride > 0) || stride < Math.ceil((width * bpp) / 8) || !v.has(at, stride * height)) return null
    if (![1, 4, 8, 16, 24, 32].includes(bpp)) return null
    if (!this.budget.take(width, height)) return null
    if (palette.length === 0 && bpp <= 8) palette = Array.from({ length: 1 << bpp }, (_, i) => 0xff000000 | (Math.round((i * 255) / ((1 << bpp) - 1)) * 0x010101))
    const rgba = new Uint8Array(width * height * 4)
    const hasAlpha = (format & 0x00040000) !== 0
    const premultiplied = (format & 0x00080000) !== 0
    let alpha = false
    const buf = v.buf
    for (let y = 0; y < height; y++) {
      const row = v.start + at + y * stride
      for (let x = 0; x < width; x++) {
        let argb: number
        if (bpp <= 8) {
          const per = 8 / bpp
          const byte = buf[row + Math.floor(x / per)]
          const shift = 8 - bpp * ((x % per) + 1)
          argb = palette[(byte >> shift) & ((1 << bpp) - 1)] ?? 0xff000000
        } else if (bpp === 16) {
          const p = buf.readUInt16LE(row + x * 2)
          const r5 = format === 0x00021006 ? (p >> 11) & 0x1f : (p >> 10) & 0x1f
          const g = format === 0x00021006 ? ((p >> 5) & 0x3f) * (255 / 63) : ((p >> 5) & 0x1f) * (255 / 31)
          argb = 0xff000000 | (Math.round(r5 * (255 / 31)) << 16) | (Math.round(g) << 8) | Math.round((p & 0x1f) * (255 / 31))
        } else if (bpp === 24) {
          const o = row + x * 3
          argb = 0xff000000 | (buf[o + 2] << 16) | (buf[o + 1] << 8) | buf[o]
        } else {
          argb = buf.readUInt32LE(row + x * 4)
          if (!hasAlpha) argb = (argb | 0xff000000) >>> 0
        }
        const o = (y * width + x) * 4
        const a = argb >>> 24
        let r = (argb >> 16) & 0xff
        let g = (argb >> 8) & 0xff
        let b = argb & 0xff
        if (premultiplied && a > 0 && a < 255) {
          r = Math.min(255, Math.round((r * 255) / a))
          g = Math.min(255, Math.round((g * 255) / a))
          b = Math.min(255, Math.round((b * 255) / a))
        }
        if (a !== 255) alpha = true
        rgba[o] = r
        rgba[o + 1] = g
        rgba[o + 2] = b
        rgba[o + 3] = a
      }
    }
    return { width, height, rgba, alpha }
  }

  private readFont(v: View): PlusFont {
    const n = v.u32(20)
    return { emSize: v.f32(4), unit: v.u32(8), style: v.i32(12), family: v.utf16(24, Math.min(n, 64)) }
  }

  private object(flags: number, v: View): void {
    const id = flags & 0xff
    const type = (flags >> 8) & 0x7f
    let data = v
    if (flags & 0x8000) {
      const total = v.u32(0)
      if (!this.partial || this.partial.id !== id || this.partial.type !== type) {
        if (total > MAX_OBJECT_BYTES) return
        this.partial = { id, type, total, chunks: [], got: 0 }
      }
      const chunk = v.bytes(4, v.length - 4)
      if (this.partial.got + chunk.length > this.partial.total) return
      this.partial.chunks.push(chunk)
      this.partial.got += chunk.length
      return
    }
    if (this.partial && this.partial.id === id && this.partial.type === type) {
      const whole = Buffer.concat([...this.partial.chunks, v.bytes(0, v.length)])
      this.partial = null
      data = new View(whole, 0, whole.length)
    } else this.partial = null
    let obj: PlusObject | null = null
    switch (type) {
      case 1:
        obj = { type: 'brush', brush: this.readBrush(data) }
        break
      case 2:
        obj = { type: 'pen', pen: this.readPen(data) }
        break
      case 3:
        obj = { type: 'path', path: this.readPath(data) }
        break
      case 4:
        obj = { type: 'region', region: this.readRegion(data) }
        break
      case 5: {
        const image = this.readImage(data)
        obj = image ? { type: 'image', image } : null
        break
      }
      case 6:
        obj = { type: 'font', font: this.readFont(data) }
        break
      case 7:
        obj = { type: 'format', format: { align: data.u32(12), lineAlign: data.u32(16) } }
        break
    }
    if (obj) this.objects.set(id, obj)
    else this.objects.delete(id)
  }

  /* ---- paint ---------------------------------------------------------- */

  private brushOf(flags: number, value: number): Brush | null {
    if (flags & 0x8000) return { kind: 'solid', argb: value }
    const o = this.objects.get(value & 0xff)
    return o?.type === 'brush' ? o.brush : null
  }

  private paint(brush: Brush | null): Paint | null {
    if (!brush) return null
    switch (brush.kind) {
      case 'solid':
        return brush.argb >>> 24 === 0 ? null : argbPaint(brush.argb)
      case 'hatch': {
        const map: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }
        const style = map[brush.style]
        if (style === undefined) {
          // The percentage and pattern hatches: their colours mixed.
          return argbPaint(mix(brush.back, brush.fore, 0.5))
        }
        const t = 8 * this.out.hairline
        const key = `phatch:${style}:${brush.fore}:${brush.back}`
        const T = num(t)
        const h = num(t / 2)
        const d = [`M0 ${h}H${T}`, `M${h} 0V${T}`, `M0 0L${T} ${T}`, `M0 ${T}L${T} 0`, `M0 ${h}H${T}M${h} 0V${T}`, `M0 0L${T} ${T}M0 ${T}L${T} 0`][style]
        const fore = argbPaint(brush.fore) as { rgb: number; alpha?: number }
        const back = argbPaint(brush.back) as { rgb: number; alpha?: number }
        const id = this.out.def(key, (id) =>
          `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${T}" height="${T}">` +
          ((back.alpha ?? 1) > 0 ? `<rect width="${T}" height="${T}" fill="${hex(back.rgb)}" fill-opacity="${num(back.alpha ?? 1)}"/>` : '') +
          `<path d="${d}" fill="none" stroke="${hex(fore.rgb)}" stroke-opacity="${num(fore.alpha ?? 1)}" stroke-width="${num(this.out.hairline)}"/></pattern>`,
        )
        return { kind: 'url', id }
      }
      case 'linear': {
        const [x, y, w] = brush.rect
        const m = compose(brush.transform, this.matrix())
        const [x1, y1] = apply(m, x, y + brush.rect[3] / 2)
        const [x2, y2] = apply(m, x + w, y + brush.rect[3] / 2)
        const spread = brush.wrap === 4 ? 'pad' : brush.wrap === 0 ? 'repeat' : 'reflect'
        const stops = brush.stops
          .map(([o, c]) => `<stop offset="${num(Math.min(1, Math.max(0, o)))}" stop-color="${hex(c & 0xffffff)}"${c >>> 24 < 255 ? ` stop-opacity="${num((c >>> 24) / 255)}"` : ''}/>`)
          .join('')
        const key = `plin:${num(x1)},${num(y1)},${num(x2)},${num(y2)},${spread},${stops}`
        const id = this.out.def(key, (id) =>
          `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" spreadMethod="${spread}">${stops}</linearGradient>`,
        )
        return { kind: 'url', id }
      }
    }
  }

  private stroke(id: number): Stroke | null {
    const o = this.objects.get(id & 0xff)
    if (o?.type !== 'pen') return null
    const pen = o.pen
    const paint = this.paint(pen.brush)
    if (!paint) return null
    const m = this.matrix()
    const width = pen.unit === 0 || pen.unit === 1 ? pen.width * scaleOf(m) : pen.width * this.unitPx(pen.unit) * scaleOf(this.toGdi())
    return { paint, width, dash: pen.dash?.map((v) => v * Math.max(width, this.out.hairline)), cap: pen.cap, join: pen.join, miter: pen.miter }
  }

  /* ---- geometry ------------------------------------------------------- */

  private pathData(path: Path): PathData {
    const m = this.matrix()
    const p = new PathData()
    const { points, types } = path
    for (let i = 0; i < types.length && 2 * i + 1 < points.length; i++) {
      const t = types[i] & 0x07
      const [x, y] = apply(m, points[2 * i], points[2 * i + 1])
      if (t === 0) p.moveTo(x, y)
      else if (t === 3 && 2 * i + 5 < points.length) {
        const [x2, y2] = apply(m, points[2 * i + 2], points[2 * i + 3])
        const [x3, y3] = apply(m, points[2 * i + 4], points[2 * i + 5])
        p.curveTo(x, y, x2, y2, x3, y3)
        i += 2
      } else p.lineTo(x, y)
      if (types[i] & 0x80) p.close()
    }
    return p
  }

  private polyData(pts: number[], closed: boolean): PathData {
    const m = this.matrix()
    const p = new PathData()
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const [x, y] = apply(m, pts[i], pts[i + 1])
      if (i === 0) p.moveTo(x, y)
      else p.lineTo(x, y)
    }
    if (closed) p.close()
    return p
  }

  private rectData(r: [number, number, number, number]): PathData {
    const [x, y, w, h] = r
    return this.polyData([x, y, x + w, y, x + w, y + h, x, y + h], true)
  }

  /** An ellipse (in its box) or part of one, angles in degrees clockwise from the x-axis, as GDI+ measures them. */
  private ellipseData(r: [number, number, number, number], start?: number, sweep?: number, pie = false): PathData {
    const m = this.matrix()
    const [x, y, w, h] = r
    const cx = x + w / 2
    const cy = y + h / 2
    const rx = w / 2
    const ry = h / 2
    const p = new PathData()
    const toParam = (deg: number): number => {
      const a = (deg * Math.PI) / 180
      return Math.atan2(rx * Math.sin(a), ry * Math.cos(a))
    }
    let t0 = 0
    let s = 2 * Math.PI
    if (start !== undefined && sweep !== undefined && Math.abs(sweep) < 360) {
      t0 = toParam(start)
      const t1 = toParam(start + sweep)
      s = sweep >= 0 ? (t1 - t0 + 4 * Math.PI) % (2 * Math.PI) : -((t0 - t1 + 4 * Math.PI) % (2 * Math.PI))
    }
    const at = (t: number): [number, number] => apply(m, cx + rx * Math.cos(t), cy + ry * Math.sin(t))
    if (pie) {
      p.moveTo(...apply(m, cx, cy))
      p.lineTo(...at(t0))
    } else p.moveTo(...at(t0))
    const n = Math.max(1, Math.ceil(Math.abs(s) / (Math.PI / 2) - 1e-9))
    const seg = s / n
    const k = (4 / 3) * Math.tan(seg / 4)
    for (let i = 0; i < n; i++) {
      const a = t0 + i * seg
      const b = a + seg
      p.curveTo(
        ...apply(m, cx + rx * (Math.cos(a) - k * Math.sin(a)), cy + ry * (Math.sin(a) + k * Math.cos(a))),
        ...apply(m, cx + rx * (Math.cos(b) + k * Math.sin(b)), cy + ry * (Math.sin(b) - k * Math.cos(b))),
        ...at(b),
      )
    }
    if (pie || start === undefined) p.close()
    return p
  }

  /** A cardinal spline through the points, as Béziers (DrawCurve, DrawClosedCurve, FillClosedCurve). */
  private curveData(pts: number[], tension: number, closed: boolean): PathData {
    const n = pts.length / 2
    const m = this.matrix()
    const p = new PathData()
    if (n < 2) return p
    const pt = (i: number): [number, number] => {
      const k = closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))
      return [pts[2 * k], pts[2 * k + 1]]
    }
    const t = tension / 3
    p.moveTo(...apply(m, ...pt(0)))
    const segments = closed ? n : n - 1
    for (let i = 0; i < segments; i++) {
      const [x0, y0] = pt(i - 1)
      const [x1, y1] = pt(i)
      const [x2, y2] = pt(i + 1)
      const [x3, y3] = pt(i + 2)
      p.curveTo(
        ...apply(m, x1 + (x2 - x0) * t, y1 + (y2 - y0) * t),
        ...apply(m, x2 - (x3 - x1) * t, y2 - (y3 - y1) * t),
        ...apply(m, x2, y2),
      )
    }
    if (closed) p.close()
    return p
  }

  private fill(p: PathData, brush: Brush | null, rule: 'nonzero' | 'evenodd' = 'evenodd', clip = this.state.clip): void {
    const paint = this.paint(brush)
    if (paint) this.out.shape(p, paint, null, rule, clip)
  }

  private draw(p: PathData, penId: number): void {
    const s = this.stroke(penId)
    if (s) this.out.shape(p, null, s, 'nonzero', this.state.clip)
  }

  /* ---- clipping ------------------------------------------------------- */

  /** `base` limited to a region (device space): exact for rectangles and paths, near for unions of chained clips. */
  private applyRegion(region: Region, base: Clip): Clip {
    const m = this.matrix()
    switch (region.op) {
      case 'rect': {
        const [x, y, w, h] = region.rect
        if (axisAligned(m)) {
          const [x0, y0] = apply(m, x, y)
          const [x1, y1] = apply(m, x + w, y + h)
          return clipIntersectRects(base, [rect(x0, y0, x1, y1)])
        }
        return clipIntersectPath(base, this.rectData(region.rect).d, 'nonzero')
      }
      case 'path':
        return clipIntersectPath(base, this.pathData(region.path).d || 'M0 0Z', 'evenodd')
      case 'empty':
        return clipRects([])
      case 'infinite':
        return base
      case 'and':
        return this.applyRegion(region.b, this.applyRegion(region.a, base))
      case 'exclude':
        return this.exclude(this.applyRegion(region.a, base), region.b)
      case 'complement':
        return this.exclude(this.applyRegion(region.b, base), region.a)
      default: {
        const a = this.applyRegion(region.a, null)
        const b = this.applyRegion(region.b, null)
        const u = a && b ? clipUnion(a, b) : null
        if (!u) return base
        if (u.rects && !u.parent) return clipIntersectRects(base, u.rects)
        if (u.d && !u.parent) return clipIntersectPath(base, u.d, u.rule ?? 'nonzero')
        return base
      }
    }
  }

  private exclude(base: Clip, region: Region): Clip {
    const m = this.matrix()
    if (region.op === 'rect' && axisAligned(m)) {
      const [x, y, w, h] = region.rect
      const [x0, y0] = apply(m, x, y)
      const [x1, y1] = apply(m, x + w, y + h)
      return clipExcludeRects(base, [rect(x0, y0, x1, y1)], this.universe)
    }
    if (region.op === 'rect') return clipExcludePath(base, this.rectData(region.rect).d, this.universe)
    if (region.op === 'path') return clipExcludePath(base, this.pathData(region.path).d, this.universe)
    if (region.op === 'infinite') return clipRects([])
    return base
  }

  private combine(mode: number, region: Region): void {
    const clip = this.state.clip
    let next: Clip
    switch (mode) {
      case 0:
        next = this.applyRegion(region, null)
        break
      case 1:
        next = this.applyRegion(region, clip)
        break
      case 2:
      case 3: {
        const r = this.applyRegion(region, null)
        next = r ? clipUnion(clip, r) : null
        break
      }
      case 4:
        next = this.exclude(clip, region)
        break
      default:
        next = this.applyRegion(region, null)
    }
    this.state = { ...this.state, clip: next }
  }

  /* ---- records -------------------------------------------------------- */

  private record(type: number, flags: number, v: View): void {
    const compressed = (flags & 0x4000) !== 0
    switch (type) {
      case 0x4001: // Header
        this.dual = (flags & 1) !== 0
        if (v.has(8, 8) && v.u32(8) > 0 && v.u32(12) > 0 && v.u32(8) < 10000 && v.u32(12) < 10000) this.dpi = [v.u32(8), v.u32(12)]
        return
      case 0x4002: // EndOfFile
        return
      case 0x4004: // GetDC: the EMF records that follow are drawn
        this.gdi = true
        return
      case 0x4008:
        this.object(flags, v)
        return
      case 0x4009: {
        // Clear: the whole picture, in a colour.
        const p = new PathData()
        const u = this.universe
        p.moveTo(u.l, u.t)
        p.lineTo(u.r, u.t)
        p.lineTo(u.r, u.b)
        p.lineTo(u.l, u.b)
        p.close()
        this.fill(p, { kind: 'solid', argb: v.u32(0) }, 'nonzero')
        return
      }
      case 0x400a: {
        const brush = this.brushOf(flags, v.u32(0))
        const n = v.u32(4)
        const size = compressed ? 8 : 16
        if (!v.has(8, n * size)) throw new ShortRecord()
        const p = new PathData()
        for (let i = 0; i < n; i++) p.append(this.rectData(this.rectF(v, 8 + i * size, compressed)))
        this.fill(p, brush, 'nonzero')
        return
      }
      case 0x400b: {
        const n = v.u32(0)
        const size = compressed ? 8 : 16
        if (!v.has(4, n * size)) throw new ShortRecord()
        const p = new PathData()
        for (let i = 0; i < n; i++) p.append(this.rectData(this.rectF(v, 4 + i * size, compressed)))
        this.draw(p, flags)
        return
      }
      case 0x400c: {
        const brush = this.brushOf(flags, v.u32(0))
        const { pts } = this.points(v, 8, v.u32(4), compressed, (flags & 0x0800) !== 0)
        this.fill(this.polyData(pts, true), brush)
        return
      }
      case 0x400d: {
        const { pts } = this.points(v, 4, v.u32(0), compressed, (flags & 0x0800) !== 0)
        this.draw(this.polyData(pts, (flags & 0x2000) !== 0), flags)
        return
      }
      case 0x400e:
        this.fill(this.ellipseData(this.rectF(v, 4, compressed)), this.brushOf(flags, v.u32(0)))
        return
      case 0x400f:
        this.draw(this.ellipseData(this.rectF(v, 0, compressed)), flags)
        return
      case 0x4010:
        this.fill(this.ellipseData(this.rectF(v, 12, compressed), v.f32(4), v.f32(8), true), this.brushOf(flags, v.u32(0)))
        return
      case 0x4011:
      case 0x4012:
        this.draw(this.ellipseData(this.rectF(v, 8, compressed), v.f32(0), v.f32(4), type === 0x4011), flags)
        return
      case 0x4013: {
        const o = this.objects.get(flags & 0xff)
        if (o?.type !== 'region') return
        const clip = this.applyRegion(o.region, this.state.clip)
        if (clipEmpty(clip)) return
        const p = new PathData()
        const u = this.universe
        p.moveTo(u.l, u.t)
        p.lineTo(u.r, u.t)
        p.lineTo(u.r, u.b)
        p.lineTo(u.l, u.b)
        p.close()
        this.fill(p, this.brushOf(flags, v.u32(0)), 'nonzero', clip)
        return
      }
      case 0x4014: {
        const o = this.objects.get(flags & 0xff)
        if (o?.type === 'path') {
          const p = this.pathData(o.path)
          p.close()
          this.fill(p, this.brushOf(flags, v.u32(0)))
        }
        return
      }
      case 0x4015: {
        const o = this.objects.get(flags & 0xff)
        if (o?.type === 'path') this.draw(this.pathData(o.path), v.u32(0))
        return
      }
      case 0x4016: {
        // FillClosedCurve: brush, tension, count, points; W: winding.
        const { pts } = this.points(v, 12, v.u32(8), compressed, (flags & 0x0800) !== 0)
        this.fill(this.curveData(pts, v.f32(4), true), this.brushOf(flags, v.u32(0)), flags & 0x2000 ? 'nonzero' : 'evenodd')
        return
      }
      case 0x4017: {
        const { pts } = this.points(v, 8, v.u32(4), compressed, (flags & 0x0800) !== 0)
        this.draw(this.curveData(pts, v.f32(0), true), flags)
        return
      }
      case 0x4018: {
        // DrawCurve: tension, offset, segments, count, points.
        const { pts } = this.points(v, 16, v.u32(12), compressed, false)
        const offset = v.u32(4)
        const segments = v.u32(8)
        this.draw(this.curveData(pts.slice(offset * 2, (offset + segments + 1) * 2), v.f32(0), false), flags)
        return
      }
      case 0x4019: {
        const { pts } = this.points(v, 4, v.u32(0), compressed, (flags & 0x0800) !== 0)
        const m = this.matrix()
        const p = new PathData()
        if (pts.length >= 2) p.moveTo(...apply(m, pts[0], pts[1]))
        for (let i = 2; i + 5 < pts.length; i += 6) {
          p.curveTo(...apply(m, pts[i], pts[i + 1]), ...apply(m, pts[i + 2], pts[i + 3]), ...apply(m, pts[i + 4], pts[i + 5]))
        }
        this.draw(p, flags)
        return
      }
      case 0x401a:
      case 0x401b: {
        const o = this.objects.get(flags & 0xff)
        if (o?.type !== 'image') return
        const bitmap = o.image.kind === 'bitmap'
        const pic = o.image.kind === 'bitmap' ? o.image.picture : o.image.image
        // The source rectangle is in a bitmap's pixels; a nested metafile is drawn whole.
        const src = this.rectF(v, 8, false)
        const sw = bitmap ? src[2] || pic.width : pic.width
        const sh = bitmap ? src[3] || pic.height : pic.height
        let local: Matrix
        if (type === 0x401a) {
          const [x, y, w, h] = this.rectF(v, 24, compressed)
          local = [w / sw, 0, 0, h / sh, x, y]
        } else {
          const { pts } = this.points(v, 28, Math.min(3, v.u32(24)), compressed, (flags & 0x0800) !== 0)
          if (pts.length < 6) return
          local = [(pts[2] - pts[0]) / sw, (pts[3] - pts[1]) / sw, (pts[4] - pts[0]) / sh, (pts[5] - pts[1]) / sh, pts[0], pts[1]]
        }
        const crop = bitmap ? { l: src[0], t: src[1], r: src[0] + sw, b: src[1] + sh } : undefined
        this.out.image(pic, compose(local, this.matrix()), this.state.clip, { crop })
        return
      }
      case 0x401c:
        this.drawString(flags, v)
        return
      case 0x4036:
        this.drawDriverString(flags, v)
        return
      case 0x4025: // Save
      case 0x4028: // BeginContainerNoParams
        if (this.saved.size < 1000) this.saved.set(v.u32(0), this.state)
        return
      case 0x4027: {
        // BeginContainer: dest rect, src rect, stack index.
        if (this.saved.size < 1000) this.saved.set(v.u32(32), this.state)
        const [dx, dy, dw, dh] = this.rectF(v, 0, false)
        const [sx, sy, sw, sh] = this.rectF(v, 16, false)
        if (sw && sh) {
          const c: Matrix = [dw / sw, 0, 0, dh / sh, dx - (sx * dw) / sw, dy - (sy * dh) / sh]
          this.state = { ...this.state, world: compose(c, this.state.world) }
        }
        return
      }
      case 0x4026: // Restore
      case 0x4029: {
        // EndContainer
        const s = this.saved.get(v.u32(0))
        if (s) {
          this.state = s
          this.saved.delete(v.u32(0))
        }
        return
      }
      case 0x402a:
        this.state = { ...this.state, world: [v.f32(0), v.f32(4), v.f32(8), v.f32(12), v.f32(16), v.f32(20)] }
        return
      case 0x402b:
        this.state = { ...this.state, world: IDENTITY }
        return
      case 0x402c:
        this.multiply([v.f32(0), v.f32(4), v.f32(8), v.f32(12), v.f32(16), v.f32(20)], flags)
        return
      case 0x402d:
        this.multiply([1, 0, 0, 1, v.f32(0), v.f32(4)], flags)
        return
      case 0x402e:
        this.multiply([v.f32(0), 0, 0, v.f32(4), 0, 0], flags)
        return
      case 0x402f: {
        const a = (v.f32(0) * Math.PI) / 180
        this.multiply([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0], flags)
        return
      }
      case 0x4030:
        this.state = { ...this.state, pageUnit: flags & 0xff, pageScale: v.f32(0) || 1 }
        return
      case 0x4031:
        this.state = { ...this.state, clip: null }
        return
      case 0x4032:
        this.combine((flags >> 8) & 0x0f, { op: 'rect', rect: this.rectF(v, 0, false) })
        return
      case 0x4033: {
        const o = this.objects.get(flags & 0xff)
        if (o?.type === 'path') this.combine((flags >> 8) & 0x0f, { op: 'path', path: o.path })
        return
      }
      case 0x4034: {
        const o = this.objects.get(flags & 0xff)
        if (o?.type === 'region') this.combine((flags >> 8) & 0x0f, o.region)
        return
      }
      case 0x4035: {
        const m = this.matrix()
        this.state = { ...this.state, clip: clipOffset(this.state.clip, v.f32(0) * m[0], v.f32(4) * m[3]) }
        return
      }
      default:
        return
    }
  }

  private multiply(x: Matrix, flags: number): void {
    // A (0x2000): append (after the world transform), else prepend.
    const world = flags & 0x2000 ? compose(this.state.world, x) : compose(x, this.state.world)
    this.state = { ...this.state, world }
  }

  private font(id: number): { font: PlusFont; em: number } | null {
    const o = this.objects.get(id & 0xff)
    if (o?.type !== 'font') return null
    const f = o.font
    // The em in world units: its size in its own unit, through the page and world transforms.
    const pageWorld = scaleOf(compose(this.state.world, this.page()))
    const em = f.unit === 0 ? f.emSize : (f.emSize * this.unitPx(f.unit)) / Math.max(1e-9, pageWorld)
    return em > 0 && Number.isFinite(em) ? { font: f, em } : null
  }

  private textAttrs(f: PlusFont, em: number, paint: Paint): string {
    const font: Font = { height: -em, width: 0, escapement: 0, orientation: 0, weight: f.style & 1 ? 700 : 400, italic: !!(f.style & 2), underline: !!(f.style & 4), strike: !!(f.style & 8), charset: 1, pitchFamily: 0, face: f.family.replace(/\0[\s\S]*$/, '') }
    const decoration = [font.underline ? 'underline' : '', font.strike ? 'line-through' : ''].filter(Boolean).join(' ')
    return (
      ` font-family="${esc(fontFamily(font))}" font-size="${num(em) === '0' ? '0.01' : num(em)}"` +
      (font.weight >= 700 ? ' font-weight="bold"' : '') +
      (font.italic ? ' font-style="italic"' : '') +
      (decoration ? ` text-decoration="${decoration}"` : '') +
      this.out.paint('fill', paint) +
      ' xml:space="preserve"'
    )
  }

  private drawString(flags: number, v: View): void {
    const f = this.font(flags)
    const paint = this.paint(this.brushOf(flags, v.u32(0)))
    if (!f || !paint) return
    const fmtObj = this.objects.get(v.u32(4) & 0xff)
    const format: Format = fmtObj?.type === 'format' ? fmtObj.format : { align: 0, lineAlign: 0 }
    const n = v.u32(8)
    const [x, y, w, h] = this.rectF(v, 12, false)
    const text = v.utf16(28, n)
    const lines = text.split(/\r\n|\r|\n/).map((l) => l.replace(/[\u0000-\u001f]/g, ''))
    if (!lines.some((l) => l.trim())) return
    const { em } = f
    const lineHeight = em * 1.2
    const total = lines.length * lineHeight
    const top = format.lineAlign === 1 ? y + h / 2 - total / 2 : format.lineAlign === 2 ? y + h - total : y
    const anchor = format.align === 1 ? 'middle' : format.align === 2 ? 'end' : 'start'
    // GDI+'s default layout (no string format) leaves a sixth of an em on each side.
    const padding = fmtObj?.type === 'format' ? 0 : em / 6
    const ax = w > 0 ? (format.align === 1 ? x + w / 2 : format.align === 2 ? x + w - padding : x + padding) : x + padding
    const m = this.matrix()
    const attrs = this.textAttrs(f.font, em, paint)
    lines.forEach((line, i) => {
      if (!line.trim()) return
      const by = top + i * lineHeight + em * 0.905
      const markup = `<text transform="${matrixAttr(m)}" x="${num(ax)}" y="${num(by)}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}${attrs}>${esc(line)}</text>`
      const width = line.length * em * 0.5
      const left = anchor === 'middle' ? ax - width / 2 : anchor === 'end' ? ax - width : ax
      const corners = [apply(m, left, by - em), apply(m, left + width, by + em * 0.3)]
      this.out.add(markup, this.state.clip, { kind: 'text', bounds: corners.reduce<Rect | null>((u, [px, py]) => union(u, { l: px, t: py, r: px, b: py }), null) })
    })
  }

  private drawDriverString(flags: number, v: View): void {
    const f = this.font(flags)
    const paint = this.paint(this.brushOf(flags, v.u32(0)))
    if (!f || !paint) return
    const options = v.u32(4)
    const hasMatrix = v.u32(8) !== 0
    const n = v.u32(12)
    if (!(options & 1)) {
      this.lost.add('text given as glyph numbers')
      return
    }
    if (n === 0 || !v.has(16, n * 2 + n * 8)) throw new ShortRecord()
    const text = v.utf16(16, n)
    const posAt = 16 + n * 2
    let m = this.matrix()
    if (hasMatrix && v.has(posAt + n * 8, 24)) {
      const at = posAt + n * 8
      m = compose([v.f32(at), v.f32(at + 4), v.f32(at + 8), v.f32(at + 12), v.f32(at + 16), v.f32(at + 20)], m)
    }
    const realized = (options & 4) !== 0
    const xs: string[] = []
    const ys: string[] = []
    let content = ''
    const chars = [...text]
    let unit = 0
    for (const c of chars) {
      const code = c.codePointAt(0)!
      if (code >= 0x20) {
        content += c
        if (!realized) {
          xs.push(num(v.f32(posAt + unit * 8)))
          ys.push(num(v.f32(posAt + unit * 8 + 4)))
        }
      }
      unit += c.length
    }
    if (!content.trim()) return
    const x0 = v.f32(posAt)
    const y0 = v.f32(posAt + 4)
    const markup = `<text transform="${matrixAttr(m)}" x="${realized ? num(x0) : xs.join(' ')}" y="${realized ? num(y0) : ys.join(' ')}"${this.textAttrs(f.font, f.em, paint)}>${esc(content)}</text>`
    const width = content.length * f.em * 0.5
    const corners = [apply(m, x0, y0 - f.em), apply(m, x0 + width, y0 + f.em * 0.3)]
    if (!realized) {
      const lastX = Number(xs[xs.length - 1] ?? x0)
      corners.push(apply(m, lastX + f.em, y0))
    }
    this.out.add(markup, this.state.clip, { kind: 'text', bounds: corners.reduce<Rect | null>((u, [px, py]) => union(u, { l: px, t: py, r: px, b: py }), null) })
  }
}

/** Two ARGB colours mixed, `t` of the way from the first to the second. */
function mix(a: number, b: number, t: number): number {
  t = Math.max(0, Math.min(1, t))
  const ch = (sh: number): number => Math.round(((a >>> sh) & 0xff) * (1 - t) + ((b >>> sh) & 0xff) * t)
  return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0
}
