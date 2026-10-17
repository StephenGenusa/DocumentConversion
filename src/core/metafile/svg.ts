import { createHash } from 'node:crypto'
import type { Picture } from './dib'

/*
 * The SVG a metafile becomes, built as text (core has no DOM): every shape
 * a path in device space (the metafile's own pixels, which the root's
 * viewBox maps onto the picture's size), text and bitmaps placed by a
 * transform. Clipping is a chain of clipPaths in device space, each
 * clipped by the one before it (GDI's clip region intersected step by
 * step); a run of shapes under the same clip shares one group. Patterns,
 * gradients and bitmaps are defined once and referred to. The output is
 * counted as it grows: past maxChars the drawing stops (TooLarge).
 */

/** An affine transform [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f (SVG's order). */
export type Matrix = readonly [number, number, number, number, number, number]
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** `first`, then `second`. */
export function compose(first: Matrix, second: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = first
  const [a2, b2, c2, d2, e2, f2] = second
  return [a2 * a1 + c2 * b1, b2 * a1 + d2 * b1, a2 * c1 + c2 * d1, b2 * c1 + d2 * d1, a2 * e1 + c2 * f1 + e2, b2 * e1 + d2 * f1 + f2]
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

export function det(m: Matrix): number {
  return m[0] * m[3] - m[1] * m[2]
}

/** How much a length grows under `m`, on average over directions. */
export function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(det(m)))
}

/** Whether `m` keeps rectangles rectangles (no rotation or shear). */
export function axisAligned(m: Matrix): boolean {
  return Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9
}

export interface Rect {
  l: number
  t: number
  r: number
  b: number
}

export function rect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { l: Math.min(x0, x1), t: Math.min(y0, y1), r: Math.max(x0, x1), b: Math.max(y0, y1) }
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const r = { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) }
  return r.l < r.r && r.t < r.b ? r : null
}

export function area(r: Rect | null): number {
  return r ? (r.r - r.l) * (r.b - r.t) : 0
}

export function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  return { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) }
}

/** `a` with `b` taken out: up to four rectangles. */
function subtract(a: Rect, b: Rect): Rect[] {
  const i = intersect(a, b)
  if (!i) return [a]
  const out: Rect[] = []
  if (i.t > a.t) out.push({ l: a.l, t: a.t, r: a.r, b: i.t })
  if (i.b < a.b) out.push({ l: a.l, t: i.b, r: a.r, b: a.b })
  if (i.l > a.l) out.push({ l: a.l, t: i.t, r: i.l, b: i.b })
  if (i.r < a.r) out.push({ l: i.r, t: i.t, r: a.r, b: i.b })
  return out
}

/** A coordinate as written: two decimals at most, no "-0". */
export function num(v: number): string {
  const r = Math.round(v * 100) / 100
  return r === 0 ? '0' : String(r)
}

export function matrixAttr(m: Matrix): string {
  return `matrix(${m.map((v, i) => (i < 4 ? String(Math.round(v * 1e6) / 1e6) : num(v))).join(' ')})`
}

function rectPath(r: Rect): string {
  return `M${num(r.l)} ${num(r.t)}H${num(r.r)}V${num(r.b)}H${num(r.l)}Z`
}

/** Path data in device space, with what GDI's path bracket needs: the figure's start, the last point. */
export class PathData {
  private parts: string[] = []
  bounds: Rect | null = null
  /** The point the current figure started at, or null when no figure is open. */
  start: [number, number] | null = null
  last: [number, number] | null = null
  length = 0

  private see(x: number, y: number): void {
    this.bounds = union(this.bounds, { l: x, t: y, r: x, b: y })
  }
  private push(s: string): void {
    this.parts.push(s)
    this.length += s.length
  }
  moveTo(x: number, y: number): void {
    this.push(`M${num(x)} ${num(y)}`)
    this.see(x, y)
    this.start = [x, y]
    this.last = [x, y]
  }
  lineTo(x: number, y: number): void {
    if (!this.start) this.moveTo(...(this.last ?? [x, y]))
    this.push(`L${num(x)} ${num(y)}`)
    this.see(x, y)
    this.last = [x, y]
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    if (!this.start) this.moveTo(...(this.last ?? [x1, y1]))
    this.push(`C${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x)} ${num(y)}`)
    this.see(x1, y1)
    this.see(x2, y2)
    this.see(x, y)
    this.last = [x, y]
  }
  close(): void {
    if (!this.start) return
    this.push('Z')
    this.last = this.start
    this.start = null
  }
  append(other: PathData): void {
    for (const p of other.parts) this.push(p)
    this.bounds = union(this.bounds, other.bounds)
    this.start = other.start
    this.last = other.last
  }
  get empty(): boolean {
    return this.parts.length === 0
  }
  get d(): string {
    return this.parts.join('')
  }
}

/*
 * Clipping, in device space. A clip made only of rectangles (GDI's
 * IntersectClipRect and ExcludeClipRect, rectangular regions) stays a
 * list of rectangles, worked out exactly; anything else is a path clipped
 * by the clip before it. null: nothing is clipped.
 */
export interface ClipNode {
  rects?: Rect[]
  d?: string
  rule?: 'nonzero' | 'evenodd'
  parent: ClipNode | null
  depth: number
}
export type Clip = ClipNode | null

/** How many clips may be chained: past that, a further clip is not applied (drawing more, never less). */
export const MAX_CLIP_DEPTH = 16
/** The most rectangles in one rectangular clip. */
export const MAX_CLIP_RECTS = 1000

function flat(c: Clip): c is ClipNode & { rects: Rect[] } {
  return !!c && !!c.rects && !c.parent
}

function chain(parent: Clip, node: Omit<ClipNode, 'parent' | 'depth'>): Clip {
  const depth = (parent?.depth ?? 0) + 1
  if (depth > MAX_CLIP_DEPTH) return parent
  return { ...node, parent, depth }
}

export function clipRects(rects: Rect[]): ClipNode {
  return { rects: rects.slice(0, MAX_CLIP_RECTS), parent: null, depth: 1 }
}

export function clipIntersectRects(c: Clip, rects: Rect[]): Clip {
  if (!c) return clipRects(rects)
  if (flat(c) && c.rects.length * rects.length <= MAX_CLIP_RECTS * 4) {
    const out: Rect[] = []
    for (const a of c.rects) for (const b of rects) {
      const i = intersect(a, b)
      if (i) out.push(i)
    }
    if (out.length <= MAX_CLIP_RECTS) return { rects: out, parent: null, depth: 1 }
  }
  return chain(c, { d: rects.map(rectPath).join(''), rule: 'nonzero' })
}

export function clipExcludeRects(c: Clip, rects: Rect[], universe: Rect): Clip {
  let base: Rect[] | null = !c ? [universe] : flat(c) ? c.rects : null
  if (base) {
    for (const b of rects) {
      base = base.flatMap((a) => subtract(a, b))
      if (base.length > MAX_CLIP_RECTS) break
    }
    if (base.length <= MAX_CLIP_RECTS) return { rects: base, parent: null, depth: 1 }
  }
  return chain(c, { d: rectPath(universe) + rects.map(rectPath).join(''), rule: 'evenodd' })
}

export function clipIntersectPath(c: Clip, d: string, rule: 'nonzero' | 'evenodd'): Clip {
  return chain(c, { d, rule })
}

export function clipExcludePath(c: Clip, d: string, universe: Rect): Clip {
  return chain(c, { d: rectPath(universe) + d, rule: 'evenodd' })
}

/** The union of a clip and a further area (GDI's RGN_OR, RGN_XOR as near as SVG goes). */
export function clipUnion(c: Clip, other: ClipNode): Clip {
  if (!c) return null
  if (flat(c) && other.rects && !other.parent) return clipRects([...c.rects, ...other.rects])
  if (!c.parent && !other.parent) {
    const d = (c.rects ? c.rects.map(rectPath).join('') : c.d ?? '') + (other.rects ? other.rects.map(rectPath).join('') : other.d ?? '')
    return { d, rule: 'nonzero', parent: null, depth: 1 }
  }
  // A union of chained clips is more than SVG's clipPath says simply: draw unclipped.
  return null
}

export function clipOffset(c: Clip, dx: number, dy: number): Clip {
  if (!c || !flat(c)) return c
  return clipRects(c.rects.map((r) => ({ l: r.l + dx, t: r.t + dy, r: r.r + dx, b: r.b + dy })))
}

/** Whether a clip shows nothing at all. */
export function clipEmpty(c: Clip): boolean {
  return flat(c) && c.rects.length === 0
}

/** The box a clip lies inside, when it is known (rectangles); null for none or a path. */
function clipBox(c: Clip): Rect | null {
  if (!flat(c)) return null
  return c.rects.reduce<Rect | null>((u, r) => union(u, r), null)
}

export type Paint = { kind: 'color'; rgb: number; alpha?: number } | { kind: 'url'; id: string }

export interface Stroke {
  paint: Paint
  /** Device units; 0 is a hairline (one CSS px). */
  width: number
  dash?: number[]
  cap: 'butt' | 'round' | 'square'
  join: 'miter' | 'round' | 'bevel'
  miter?: number
}

export type Blend = 'multiply' | 'lighten' | 'difference' | 'screen'

export function hex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`
}

/** Text as XML character data or an attribute value. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** What was drawn, for deciding whether the metafile is one bitmap (index.ts). */
export interface Drawn {
  kind: 'shape' | 'text' | 'image'
  bounds: Rect | null
  clip: Clip
  /** An image: the bitmap, the transform from its pixels to device space, and whether it is drawn as it is (no blending, fully opaque). */
  picture?: Picture
  matrix?: Matrix
  plain?: boolean
  /** An image known to have no transparency. */
  opaque?: boolean
}

/** A picture placed in the SVG: a bitmap (PNG, JPEG, GIF) or a nested SVG. */
export interface ImageData {
  mime: string
  bytes: Buffer
  width: number
  height: number
  opaque?: boolean
}

export class TooLarge extends Error {
  constructor() {
    super('the drawing is too large')
  }
}

export class SvgOut {
  private defs: string[] = []
  private body: string[] = []
  private chars = 0
  /** The clip of the group open now; undefined when none is open. */
  private groupClip: Clip | undefined = undefined
  private ids = 0
  private clipIds = new Map<ClipNode, string>()
  private keyed = new Map<string, string>()
  readonly drawn: Drawn[] = []
  /** Where something visible was drawn, in device space. */
  bounds: Rect | null = null
  /** One CSS px in device units: the thinnest line drawn, and what a hairline is. */
  hairline = 1

  constructor(
    private readonly maxChars: number,
    private readonly prefix = 'm',
  ) {}

  private charge(n: number): void {
    this.chars += n
    if (this.chars > this.maxChars) throw new TooLarge()
  }

  private id(): string {
    return `${this.prefix}${++this.ids}`
  }

  /** A definition made once per key; its id. */
  def(key: string, make: (id: string) => string): string {
    const known = this.keyed.get(key)
    if (known) return known
    const id = this.id()
    const markup = make(id)
    this.charge(markup.length)
    this.defs.push(markup)
    this.keyed.set(key, id)
    return id
  }

  private clipId(c: ClipNode): string {
    const known = this.clipIds.get(c)
    if (known) return known
    const parent = c.parent ? ` clip-path="url(#${this.clipId(c.parent)})"` : ''
    const id = this.id()
    const d = c.rects ? c.rects.map(rectPath).join('') : c.d ?? ''
    const markup = `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"${parent}><path d="${d || 'M0 0Z'}"${c.rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`
    this.charge(markup.length)
    this.defs.push(markup)
    this.clipIds.set(c, id)
    return id
  }

  /** Whether a blend that depends on what is under it (lighten, difference) was used: those need the page under them. */
  private backdrop = false

  /** Take back the element added last (a bitmap about to be drawn again, combined with its mask). */
  undoLast(): void {
    if (this.drawn.length === 0) return
    this.drawn.pop()
    this.body.pop()
  }

  /** Add one element, under `clip`. Nothing is added where the clip shows nothing. */
  add(markup: string, clip: Clip, drawn: Omit<Drawn, 'clip'>): void {
    if (clipEmpty(clip)) return
    if (/mix-blend-mode:(lighten|difference)/.test(markup)) this.backdrop = true
    if (clip !== this.groupClip) {
      if (this.groupClip !== undefined && this.groupClip !== null) this.body.push('</g>')
      if (clip) {
        const open = `<g clip-path="url(#${this.clipId(clip)})">`
        this.charge(open.length + 4)
        this.body.push(open)
      }
      this.groupClip = clip
    }
    this.charge(markup.length)
    this.body.push(markup)
    this.drawn.push({ ...drawn, clip })
    const box = clipBox(clip)
    const seen = drawn.bounds && box ? intersect(drawn.bounds, box) : drawn.bounds
    if (seen) this.bounds = union(this.bounds, seen)
  }

  paint(name: 'fill' | 'stroke', p: Paint | null): string {
    if (!p) return ` ${name}="none"`
    if (p.kind === 'url') return ` ${name}="url(#${p.id})"`
    const a = p.alpha ?? 1
    return ` ${name}="${hex(p.rgb)}"${a < 1 ? ` ${name}-opacity="${Math.round(Math.max(0, a) * 1000) / 1000}"` : ''}`
  }

  strokeAttrs(s: Stroke | null): string {
    if (!s) return ' stroke="none"'
    const width = Math.max(s.width, this.hairline)
    let out = `${this.paint('stroke', s.paint)} stroke-width="${num(width) === '0' ? '0.01' : num(width)}"`
    if (s.cap !== 'butt') out += ` stroke-linecap="${s.cap}"`
    if (s.join !== 'miter') out += ` stroke-linejoin="${s.join}"`
    else out += ` stroke-miterlimit="${num(Math.max(1, s.miter ?? 10))}"`
    if (s.dash && s.dash.length && s.dash.some((v) => v > 0)) out += ` stroke-dasharray="${s.dash.map((v) => num(Math.max(v, 0.01))).join(' ')}"`
    return out
  }

  static blendAttr(blend?: Blend): string {
    return blend ? ` style="mix-blend-mode:${blend}"` : ''
  }

  /** A path filled and/or stroked. Bounds grow by half the stroke. */
  shape(path: PathData, fill: Paint | null, stroke: Stroke | null, rule: 'nonzero' | 'evenodd', clip: Clip, blend?: Blend): void {
    if (path.empty || (!fill && !stroke)) return
    const d = path.d
    const markup = `<path d="${d}"${this.paint('fill', fill)}${fill && rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${this.strokeAttrs(stroke)}${SvgOut.blendAttr(blend)}/>`
    const grow = stroke ? Math.max(stroke.width, this.hairline) / 2 : 0
    const b = path.bounds
    this.add(markup, clip, { kind: 'shape', bounds: b && { l: b.l - grow, t: b.t - grow, r: b.r + grow, b: b.b + grow } })
  }

  /**
   * A picture, its pixels mapped to device space by `m`; with `crop`, only
   * that part of it (in its pixels), `m` mapping the part's own top-left.
   */
  image(picture: ImageData, m: Matrix, clip: Clip, opts: { opacity?: number; blend?: Blend; crop?: Rect; pixelated?: boolean } = {}): void {
    const key = `img:${createHash('sha1').update(picture.bytes).digest('hex')}`
    const id = this.def(
      `${key}${opts.pixelated ? ':sharp' : ''}`,
      (id) =>
        `<image id="${id}" width="${picture.width}" height="${picture.height}" preserveAspectRatio="none"${opts.pixelated ? ' style="image-rendering:pixelated"' : ''} xlink:href="data:${picture.mime};base64,${picture.bytes.toString('base64')}"/>`,
    )
    const opacity = opts.opacity !== undefined && opts.opacity < 1 ? ` opacity="${Math.round(Math.max(0, opts.opacity) * 1000) / 1000}"` : ''
    const c = opts.crop
    const whole = !c || (c.l <= 0 && c.t <= 0 && c.r >= picture.width && c.b >= picture.height)
    const w = whole ? picture.width : c.r - c.l
    const h = whole ? picture.height : c.b - c.t
    if (!(w > 0 && h > 0)) return
    const markup = whole
      ? `<use xlink:href="#${id}" transform="${matrixAttr(m)}"${opacity}${SvgOut.blendAttr(opts.blend)}/>`
      : `<g transform="${matrixAttr(m)}"${opacity}${SvgOut.blendAttr(opts.blend)}><svg width="${num(w)}" height="${num(h)}" viewBox="${num(c.l)} ${num(c.t)} ${num(w)} ${num(h)}" preserveAspectRatio="none" overflow="hidden"><use xlink:href="#${id}"/></svg></g>`
    const corners = [apply(m, 0, 0), apply(m, w, 0), apply(m, 0, h), apply(m, w, h)]
    const bounds = corners.reduce<Rect | null>((u, [x, y]) => union(u, { l: x, t: y, r: x, b: y }), null)
    const plain = whole && !opts.blend && (opts.opacity ?? 1) >= 1 && /^image\/(png|jpeg|gif)$/.test(picture.mime)
    this.add(markup, clip, { kind: 'image', bounds, picture: plain ? (picture as Picture) : undefined, matrix: m, plain, opaque: plain && picture.opaque === true })
  }

  /** Whether anything at all was drawn. */
  get empty(): boolean {
    return this.drawn.length === 0
  }

  finish(viewBox: Rect, width: number, height: number): string {
    if (this.groupClip) this.body.push('</g>')
    this.groupClip = undefined
    const vb = `${num(viewBox.l)} ${num(viewBox.t)} ${num(viewBox.r - viewBox.l)} ${num(viewBox.b - viewBox.t)}`
    // GDI blends with the page under the picture: white paper, for the blends where that shows.
    const page = this.backdrop ? `<rect x="${vb.split(' ')[0]}" y="${vb.split(' ')[1]}" width="${num(viewBox.r - viewBox.l)}" height="${num(viewBox.b - viewBox.t)}" fill="#ffffff"/>` : ''
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${num(width)}" height="${num(height)}" viewBox="${vb}" preserveAspectRatio="none">` +
      (this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '') +
      page +
      this.body.join('') +
      '</svg>'
    )
  }
}
