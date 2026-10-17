import { toPicture, type Budget, type Picture } from './dib'
import type { Matrix } from './svg'

/*
 * Gradients SVG has no element for, shaded into a small bitmap that the
 * shape they fill cuts out (svg.ts, a Paint of kind 'image'):
 *
 *   triangles      GDI's GradientFill with GRADIENT_FILL_TRIANGLE: each
 *                  point the mix of its triangle's corner colors by how
 *                  near it is to each (Gouraud shading). All the triangles
 *                  of one record share one bitmap, so a mesh shows no seams
 *                  where its triangles meet.
 *   path gradient  GDI+'s PathGradientBrush on a boundary that is not an
 *                  ellipse (an ellipse is a radial gradient, emfplus.ts):
 *                  a fan of triangles from the center point to each edge of
 *                  the boundary. A point's share of the center color is its
 *                  weight at the center corner, which is how far along the
 *                  ray from the center to the boundary it is (one minus the
 *                  distance), and the boundary color there is the edge's
 *                  colors mixed by where the ray meets it: the same as GDI+
 *                  works it out ray by ray. The caller turns the share into
 *                  a color (blend factors, preset colors, focus scales).
 *
 * The bitmap is at most MAX_SHADE_SIDE pixels a side (two a CSS px below
 * that): these colors change smoothly, and the pixels in between are
 * filled in when the bitmap is scaled up. One pixel more on each side
 * keeps the shape's edges from fading. Its pixels come out of the
 * metafile's bitmap Budget, and the work (pixels tested, all triangles
 * together) is capped at MAX_SHADE_WORK: past either, null, and the caller
 * draws a single color as before.
 */

export const MAX_SHADE_SIDE = 256
export const MAX_SHADE_WORK = 16_000_000
/** The most triangles shaded together (a mesh, or a path gradient's fan). */
export const MAX_SHADE_TRIANGLES = 65_536

export type Point = readonly [number, number]
/** A triangle's three corners. */
export type Corners = readonly [a: Point, b: Point, c: Point]

/** A triangle in device space, and the color (ARGB) at a point given its weights at the three corners (which add up to 1). */
export interface ShadeTriangle {
  p: Corners
  color: (w0: number, w1: number, w2: number) => number
}

export interface Shaded {
  picture: Picture
  /** From the bitmap's pixels to device space. */
  m: Matrix
}

/** Triangles shaded into one bitmap, transparent where none is; null when that is too large or there is nothing to shade. */
export function shade(tris: readonly ShadeTriangle[], hairline: number, budget: Budget): Shaded | null {
  if (tris.length === 0 || tris.length > MAX_SHADE_TRIANGLES) return null
  let l = Infinity
  let t = Infinity
  let r = -Infinity
  let b = -Infinity
  for (const tri of tris) {
    for (const [x, y] of tri.p) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      l = Math.min(l, x)
      t = Math.min(t, y)
      r = Math.max(r, x)
      b = Math.max(b, y)
    }
  }
  const unit = hairline > 0 ? hairline : 1
  if (!(r - l > 0 && b - t > 0)) return null
  const side = (extent: number): number => Math.max(2, Math.min(MAX_SHADE_SIDE - 2, Math.ceil((2 * extent) / unit)))
  const w = side(r - l) + 2
  const h = side(b - t) + 2
  const sx = (r - l) / (w - 2)
  const sy = (b - t) / (h - 2)
  const left = l - sx
  const top = t - sy
  // In the bitmap's pixels, pixel (i, j) centered on (i, j).
  const toPx = ([x, y]: Point): Point => [(x - left) / sx - 0.5, (y - top) / sy - 0.5]
  const boxes = tris.map((tri) => {
    const q = tri.p.map(toPx) as unknown as Corners
    const x0 = Math.max(0, Math.floor(Math.min(q[0][0], q[1][0], q[2][0])))
    const x1 = Math.min(w - 1, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0])))
    const y0 = Math.max(0, Math.floor(Math.min(q[0][1], q[1][1], q[2][1])))
    const y1 = Math.min(h - 1, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1])))
    return { q, x0, x1, y0, y1 }
  })
  let work = 0
  for (const bx of boxes) work += Math.max(0, bx.x1 - bx.x0 + 1) * Math.max(0, bx.y1 - bx.y0 + 1)
  if (work > MAX_SHADE_WORK) return null
  if (!budget.take(w, h)) return null
  const rgba = new Uint8Array(w * h * 4)
  const set = new Uint8Array(w * h)
  boxes.forEach(({ q, x0, x1, y0, y1 }, k) => {
    const [[ax, ay], [bx, by], [cx, cy]] = q
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    if (!(Math.abs(area) > 1e-9)) return
    const color = tris[k].color
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const w1 = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / area
        const w2 = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / area
        const w0 = 1 - w1 - w2
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue
        put(rgba, set, y * w + x, color(w0, w1, w2))
      }
    }
  })
  // Two rings of pixels round what was shaded take their neighbors' colors: the shape's edge falls between pixels.
  for (let pass = 0; pass < 2; pass++) grow(rgba, set, w, h)
  let alpha = false
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      alpha = true
      break
    }
  }
  return { picture: toPicture({ width: w, height: h, rgba, alpha }), m: [sx, 0, 0, sy, left, top] }
}

function put(rgba: Uint8Array, set: Uint8Array, i: number, argb: number): void {
  rgba[i * 4] = (argb >>> 16) & 0xff
  rgba[i * 4 + 1] = (argb >>> 8) & 0xff
  rgba[i * 4 + 2] = argb & 0xff
  rgba[i * 4 + 3] = (argb >>> 24) & 0xff
  set[i] = 1
}

function grow(rgba: Uint8Array, set: Uint8Array, w: number, h: number): void {
  const was = set.slice()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (was[i]) continue
      const from = x > 0 && was[i - 1] ? i - 1 : x < w - 1 && was[i + 1] ? i + 1 : y > 0 && was[i - w] ? i - w : y < h - 1 && was[i + w] ? i + w : -1
      if (from < 0) continue
      rgba.copyWithin(i * 4, from * 4, from * 4 + 4)
      set[i] = 1
    }
  }
}

/** Two ARGB colors mixed: `t` of the way from `a` to `b`. */
export function mixArgb(a: number, b: number, t: number): number {
  t = Math.max(0, Math.min(1, t))
  const ch = (sh: number): number => Math.round(((a >>> sh) & 0xff) * (1 - t) + ((b >>> sh) & 0xff) * t)
  return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0
}

/** A triangle's three corner colors (ARGB) mixed by a point's weights. */
export function gouraud(c0: number, c1: number, c2: number): ShadeTriangle['color'] {
  return (w0, w1, w2) => {
    const ch = (sh: number): number => Math.max(0, Math.min(255, Math.round(((c0 >>> sh) & 0xff) * w0 + ((c1 >>> sh) & 0xff) * w1 + ((c2 >>> sh) & 0xff) * w2)))
    return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0
  }
}

/**
 * A path gradient's fan: from `center` to each edge of the closed
 * `boundary` (device space), each boundary point's color `surround[i]`
 * (ARGB); `color(edge, share)` is the color where the boundary's color is
 * `edge` and the center's share is `share` (0 at the boundary, 1 at the
 * center).
 */
export function fan(center: Point, boundary: readonly Point[], surround: readonly number[], color: (edge: number, share: number) => number): ShadeTriangle[] {
  const tris: ShadeTriangle[] = []
  const n = boundary.length
  for (let i = 0; i < n && tris.length < MAX_SHADE_TRIANGLES; i++) {
    const a = surround[i]
    const b = surround[(i + 1) % n]
    tris.push({
      p: [center, boundary[i], boundary[(i + 1) % n]],
      color: (w0, w1, w2) => color(w1 + w2 > 0 ? mixArgb(a, b, w2 / (w1 + w2)) : a, w0),
    })
  }
  return tris
}
