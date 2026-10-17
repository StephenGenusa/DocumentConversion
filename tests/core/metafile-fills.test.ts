import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { DOMParser } from 'linkedom'
import { drawMetafile, type MetafileDrawing, type MetafileResult } from '../../src/core/metafile'
import { Budget } from '../../src/core/metafile/dib'
import { fan, gouraud, shade, MAX_SHADE_SIDE } from '../../src/core/metafile/shade'
import { pathContains } from '../../src/core/metafile/svg'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { EmfWriter, PlusWriter, WmfWriter, png } from '../../scripts/fixtures/lib-metafile.mjs'

/*
 * Fills drawn from what SVG has no element for: GDI's triangle gradients
 * and GDI+ path gradients (shaded into a bitmap, shade.ts, or a radial
 * gradient), GDI+ texture brushes, old WMF pattern brushes, and flood
 * fill (the shape the point is in, filled again).
 */

function drawn(r: MetafileResult): MetafileDrawing {
  if ('error' in r) throw new Error(r.error)
  return r
}

function svgOf(bytes: Buffer): { r: MetafileDrawing; root: Element } {
  const r = drawn(drawMetafile(bytes))
  const doc = new DOMParser().parseFromString(r.svg, 'image/svg+xml') as unknown as Document
  return { r, root: doc.documentElement }
}

const all = (root: Element, sel: string): Element[] => [...root.querySelectorAll(sel)]
const shapes = (root: Element): Element[] => all(root, 'path').filter((p) => !p.closest('defs'))

function emf(build: (e: typeof EmfWriter.prototype) => void, size = { width: 100, height: 100 }) {
  const e = new EmfWriter(size)
  build(e)
  return svgOf(e.bytes())
}

function plus(build: (p: typeof PlusWriter.prototype) => void, size = { width: 100, height: 100 }) {
  const e = new EmfWriter(size)
  const p = new PlusWriter().header(false)
  build(p)
  e.comment(p.eof().bytes())
  return svgOf(e.bytes())
}

/** A pixel of an 8-bit RGB or RGBA PNG (no interlace): [r, g, b], or [r, g, b, a]. */
function pngPixel(bytes: Buffer, x: number, y: number): number[] {
  const width = bytes.readUInt32BE(16)
  const channels = bytes[25] === 6 ? 4 : 3
  const idat: Buffer[] = []
  for (let at = 8; at < bytes.length; ) {
    const len = bytes.readUInt32BE(at)
    if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  let prev = Buffer.alloc(stride)
  let row = prev
  for (let r = 0; r <= y; r++) {
    const filter = raw[r * (stride + 1)]
    const line = raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1))
    row = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]
      row[i] = (line[i] + pred) & 0xff
    }
    prev = row
  }
  return [...row.subarray(x * channels, x * channels + channels)]
}

/** The bitmap a drawn <use> of a defined <image> shows: its PNG bytes and its transform. */
function shown(root: Element): { bytes: Buffer; transform: string; clip: string | null }[] {
  return all(root, 'use')
    .filter((u) => !u.closest('defs'))
    .map((u) => {
      const id = u.getAttribute('xlink:href')!.slice(1)
      const img = root.querySelector(`[id="${id}"]`)!
      return {
        bytes: Buffer.from(img.getAttribute('xlink:href')!.replace(/^data:image\/png;base64,/, ''), 'base64'),
        transform: u.getAttribute('transform')!,
        clip: u.closest('g[clip-path]')?.getAttribute('clip-path') ?? null,
      }
    })
}

/** The device point a bitmap pixel's center is at, back to the pixel: its color there. */
function colorAt(s: { bytes: Buffer; transform: string }, x: number, y: number): number[] {
  const [a, , , d, e, f] = s.transform.replace(/^matrix\(|\)$/g, '').split(' ').map(Number)
  return pngPixel(s.bytes, Math.floor((x - e) / a), Math.floor((y - f) / d))
}

const near = (got: number[], want: number[], by = 8): boolean => want.every((v, i) => Math.abs(got[i] - v) <= by)

describe('shading (shade.ts)', () => {
  it('a triangle is its corner colors mixed by how near each is; outside it the edge colors carry on a pixel or two, then nothing', () => {
    const tri = { p: [[0, 0], [100, 0], [0, 100]] as const, color: gouraud(0xffff0000, 0xff00ff00, 0xff0000ff) }
    const s = shade([tri], 1, new Budget())!
    expect(s.picture.width).toBeLessThanOrEqual(MAX_SHADE_SIDE)
    const at = (x: number, y: number) => pngPixel(s.picture.bytes, Math.floor((x - s.m[4]) / s.m[0]), Math.floor((y - s.m[5]) / s.m[3]))
    expect(near(at(1, 1), [255, 0, 0], 16)).toBe(true)
    expect(near(at(97, 1), [0, 255, 0], 16)).toBe(true)
    expect(near(at(1, 97), [0, 0, 255], 16)).toBe(true)
    expect(near(at(25, 25), [128, 64, 64], 12)).toBe(true)
    // Far beyond the long edge: transparent.
    expect(at(95, 95)[3]).toBe(0)
  })

  it('a fan from a center: the center color there, the boundary color at the edge, its share by how far out', () => {
    const square: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]]
    const tris = fan([50, 50], square, [0xff0000ff, 0xff0000ff, 0xff0000ff, 0xff0000ff], (edge, share) => (share > 0.5 ? 0xffffffff : edge))
    const s = shade(tris, 1, new Budget())!
    const at = (x: number, y: number) => pngPixel(s.picture.bytes, Math.floor((x - s.m[4]) / s.m[0]), Math.floor((y - s.m[5]) / s.m[3]))
    expect(at(50, 50).slice(0, 3)).toEqual([255, 255, 255])
    expect(at(5, 50).slice(0, 3)).toEqual([0, 0, 255])
    expect(at(95, 95).slice(0, 3)).toEqual([0, 0, 255])
  })

  it('too much: past the bitmap budget or the work cap, nothing (the caller draws one color)', () => {
    const tri = { p: [[0, 0], [100, 0], [0, 100]] as const, color: gouraud(0xffff0000, 0xff00ff00, 0xff0000ff) }
    expect(shade([tri], 1, new Budget(10))).toBeNull()
    // Many triangles each across the whole bitmap: more pixels tested than the cap.
    expect(shade(Array.from({ length: 400 }, () => ({ p: [[0, 0], [1000, 0], [0, 1000]] as const, color: tri.color })), 0.1, new Budget())).toBeNull()
    expect(shade([{ p: [[0, 0], [NaN, 0], [0, 1]] as const, color: tri.color }], 1, new Budget())).toBeNull()
    expect(shade([{ p: [[0, 0], [10, 0], [20, 0]] as const, color: tri.color }], 1, new Budget())).toBeNull()
  })
})

describe('GDI triangle gradients', () => {
  it('GRADIENT_FILL_TRIANGLE: one shaded bitmap for the record, cut out by its triangles, no seam between them', () => {
    const { r, root } = emf((e) =>
      e.gradientTriangles(
        [[0, 0, 0xff0000], [100, 0, 0x00ff00], [100, 100, 0x0000ff], [0, 100, 0xffffff]],
        [[0, 1, 2], [0, 2, 3]],
      ),
    )
    expect(r.lost).toEqual([])
    const [s] = shown(root)
    expect(shown(root)).toHaveLength(1)
    // The clip is both triangles.
    const clip = root.querySelector(`clipPath[id="${s.clip!.slice(5, -1)}"] path`)!
    expect(clip.getAttribute('d')).toBe('M0 0L100 0L100 100ZM0 0L100 100L0 100Z')
    expect(near(colorAt(s, 1, 1), [255, 0, 0], 12)).toBe(true)
    expect(near(colorAt(s, 99, 50), [0, 128, 128], 12)).toBe(true)
    expect(near(colorAt(s, 1, 99), [255, 255, 255], 12)).toBe(true)
    // Not taken for "the metafile is one bitmap".
    expect(r.bitmap).toBeUndefined()
  })

  it('a mesh too fine to shade: each triangle in its mean color, and lost says so', () => {
    const verts: number[][] = []
    const tris: number[][] = []
    for (let i = 0; i < 400; i++) verts.push([0, 0, 0xe00000], [100, 0, 0x00e000], [0, 100, 0x0000e0])
    for (let i = 0; i < 400; i++) tris.push([3 * i, 3 * i + 1, 3 * i + 2])
    const { r, root } = emf((e) => e.gradientTriangles(verts, tris), { width: 1000, height: 1000 })
    expect(r.lost.some((l) => l.startsWith('triangle gradients too large to shade'))).toBe(true)
    expect(shapes(root)[0].getAttribute('fill')).toBe('#4b4b4b')
  })
})

describe('GDI+ path gradients', () => {
  it('on an ellipse: a radial gradient centered on its center point, the center color in the middle, the boundary color at the edge', () => {
    const { r, root } = plus((p) =>
      p
        .pathGradientBrush(1, { center: [50, 50], centerArgb: 0xffffffff, surround: [0xff3a6ea5], boundary: { ellipse: [10, 20, 80, 60] } })
        .fillEllipseWith(1, [10, 20, 80, 60]),
    )
    expect(r.lost).toEqual([])
    const g = root.querySelector('radialGradient')!
    expect(g.getAttribute('gradientTransform')).toBe('matrix(40 0 0 30 50 50)')
    expect([g.getAttribute('fx'), g.getAttribute('fy')]).toEqual(['0', '0'])
    expect([...g.querySelectorAll('stop')].map((s) => [s.getAttribute('offset'), s.getAttribute('stop-color')])).toEqual([
      ['0', '#ffffff'],
      ['1', '#3a6ea5'],
    ])
    expect(shapes(root)[0].getAttribute('fill')).toBe(`url(#${g.getAttribute('id')})`)
  })

  it('an off-center point, blend factors and focus scales: the focal point moves, the stops follow the factors past the focus', () => {
    const { root } = plus((p) =>
      p
        .pathGradientBrush(1, {
          center: [70, 50],
          centerArgb: 0xffff0000,
          surround: [0xff0000ff],
          boundary: { ellipse: [10, 10, 80, 80] },
          factors: [[0, 0], [0.5, 0.2], [1, 1]],
          focus: [0.5, 0.5],
        })
        .fillEllipseWith(1, [10, 10, 80, 80]),
    )
    const g = root.querySelector('radialGradient')!
    expect([g.getAttribute('fx'), g.getAttribute('fy')]).toEqual(['0.5', '0'])
    // Positions 1, 0.5, 0 at offsets 0.5, 0.75, 1 (the inner half all center color).
    expect([...g.querySelectorAll('stop')].map((s) => [s.getAttribute('offset'), s.getAttribute('stop-color')])).toEqual([
      ['0.5', '#ff0000'],
      ['0.75', '#3300cc'],
      ['1', '#0000ff'],
    ])
  })

  it('on a polygon with a color at each corner: shaded into a bitmap the filled shape cuts out', () => {
    const { r, root } = plus((p) =>
      p
        .pathGradientBrush(1, {
          center: [50, 50],
          centerArgb: 0xffffffff,
          surround: [0xffff0000, 0xff00ff00, 0xff0000ff, 0xff000000],
          boundary: [0, 0, 100, 0, 100, 100, 0, 100],
        })
        .fillRectsWith(1, [[0, 0, 100, 100]]),
    )
    expect(r.lost).toEqual([])
    const [s] = shown(root)
    expect(near(colorAt(s, 50, 50), [255, 255, 255], 12)).toBe(true)
    expect(near(colorAt(s, 1, 1), [255, 0, 0], 16)).toBe(true)
    expect(near(colorAt(s, 99, 1), [0, 255, 0], 16)).toBe(true)
    // Half way from the center to the middle of the top edge: half white, half the edge's red and green mixed.
    expect(near(colorAt(s, 50, 25), [191, 191, 128], 12)).toBe(true)
    // Preset colors replace the center and boundary colors.
    const preset = plus((p) =>
      p
        .pathGradientBrush(1, { center: [50, 50], centerArgb: 0xffffffff, surround: [0xff000000], boundary: [0, 0, 100, 0, 100, 100, 0, 100], preset: [[0, 0xff00ff00], [1, 0xffff00ff]] })
        .fillRectsWith(1, [[0, 0, 100, 100]]),
    )
    const [q] = shown(preset.root)
    expect(near(colorAt(q, 50, 50), [255, 0, 255], 12)).toBe(true)
    expect(near(colorAt(q, 50, 1), [0, 255, 0], 16)).toBe(true)
  })

  it('text and lines in a path gradient brush: its center color', () => {
    const { root } = plus((p) => {
      p.pathGradientBrush(1, { center: [50, 50], centerArgb: 0xff12ab34, surround: [0xffff0000, 0xff00ff00, 0xff0000ff], boundary: [0, 0, 100, 0, 50, 100] })
      p.font(2, 20, 'Arial').rec(0x401c, 2, Buffer.from([1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 1, 0, 0, 0]), Buffer.from(new Float32Array([0, 0, 100, 40]).buffer), Buffer.from('A\0\0\0', 'latin1'))
    })
    expect(all(root, 'text')[0].getAttribute('fill')).toBe('#12ab34')
  })
})

describe('GDI+ texture brushes', () => {
  const tile = png(4, 4, (x: number) => (x < 2 ? [255, 0, 0] : [0, 0, 255]))

  it('tiled: a pattern of the image, a pixel a world unit, through the world transform', () => {
    const { r, root } = plus((p) => p.setWorldTransform([2, 0, 0, 2, 0, 0]).textureBrush(1, tile, 4, 4).fillRectsWith(1, [[0, 0, 40, 40]]))
    expect(r.lost).toEqual([])
    const pat = root.querySelector('pattern')!
    expect([pat.getAttribute('width'), pat.getAttribute('height'), pat.getAttribute('patternTransform')]).toEqual(['4', '4', 'matrix(2 0 0 2 0 0)'])
    expect(pat.querySelectorAll('use')).toHaveLength(1)
    expect(shapes(root)[0].getAttribute('fill')).toBe(`url(#${pat.getAttribute('id')})`)
  })

  it('flipped: a tile two images wide and high, the others mirrored; once: the image the shape cuts out', () => {
    const flipped = plus((p) => p.textureBrush(1, tile, 4, 4, 3).fillRectsWith(1, [[0, 0, 40, 40]]))
    const pat = flipped.root.querySelector('pattern')!
    expect([pat.getAttribute('width'), pat.getAttribute('height')]).toEqual(['8', '8'])
    expect([...pat.querySelectorAll('use')].map((u) => u.getAttribute('transform'))).toEqual([null, 'matrix(-1 0 0 1 8 0)', 'matrix(1 0 0 -1 0 8)', 'matrix(-1 0 0 -1 8 8)'])
    const once = plus((p) => p.textureBrush(1, tile, 4, 4, 4, [5, 0, 0, 5, 10, 10]).fillRectsWith(1, [[0, 0, 100, 100]]))
    expect(once.root.querySelector('pattern')).toBeNull()
    const [s] = shown(once.root)
    expect(s.transform).toBe('matrix(5 0 0 5 10 10)')
    expect(s.clip).not.toBeNull()
  })

  it('an image that cannot be read: gray, and lost says so', () => {
    const { r, root } = plus((p) => p.textureBrush(1, Buffer.from('not a picture'), 4, 4).fillRectsWith(1, [[0, 0, 40, 40]]))
    expect(r.lost).toContain('texture brushes whose image could not be read')
    expect(shapes(root)[0].getAttribute('fill')).toBe('#808080')
  })
})

describe('old WMF pattern brushes', () => {
  it('a one-bit Bitmap16: its 0 bits the text color, its 1 bits the background color, as a pattern tile', () => {
    const w = new WmfWriter({ width: 40, height: 40 })
    w.setWindowOrg(0, 0).setWindowExt(40, 40).setTextColor(0x3a6ea5)
    // 8 by 2, a row of 0 bits then a row of 1 bits, each row a word.
    w.oldPatternBrush(8, 2, 1, [Buffer.from([0x00, 0x00]), Buffer.from([0xff, 0x00])]).select(0).rectangle(0, 0, 40, 40)
    const { r, root } = svgOf(w.bytes())
    expect(r.lost).toEqual([])
    const img = root.querySelector('pattern image')!
    const bytes = Buffer.from(img.getAttribute('xlink:href')!.replace(/^data:image\/png;base64,/, ''), 'base64')
    expect(pngPixel(bytes, 3, 0).slice(0, 3)).toEqual([0x3a, 0x6e, 0xa5])
    expect(pngPixel(bytes, 3, 1).slice(0, 3)).toEqual([255, 255, 255])
  })

  it('a Bitmap16 in device colors (8 bits a pixel): gray, and lost says so', () => {
    const w = new WmfWriter({ width: 40, height: 40 })
    w.setWindowOrg(0, 0).setWindowExt(40, 40).oldPatternBrush(2, 2, 8, [Buffer.from([1, 2]), Buffer.from([3, 4])]).select(0).rectangle(0, 0, 40, 40)
    const { r, root } = svgOf(w.bytes())
    expect(r.lost).toContain('old-style pattern brushes in device colors')
    expect(shapes(root)[0].getAttribute('fill')).toBe('#808080')
  })
})

describe('flood fill', () => {
  it('surface: the shape on top at the point, filled again with the brush, when it is the color asked for', () => {
    const { r, root } = emf((e) =>
      e.stock(8).brush(1, 0, 0xffffff).select(1).rectangle(10, 10, 90, 90).brush(2, 0, 0x3a6ea5).select(2).floodFill(50, 50, 0xffffff, 1),
    )
    expect(r.lost).toEqual([])
    expect(shapes(root).map((p) => [p.getAttribute('fill'), p.getAttribute('d')])).toEqual([
      ['#ffffff', 'M10 10L90 10L90 90L10 90Z'],
      ['#3a6ea5', 'M10 10L90 10L90 90L10 90Z'],
    ])
  })

  it('border: the smallest shape round the point outlined in the color; the paper, or a point already that color, fills nothing', () => {
    const { r, root } = emf((e) =>
      e
        .pen(1, 0, 1, 0xc0392b)
        .select(1)
        .stock(5)
        .rectangle(0, 0, 100, 100)
        .ellipse(20, 20, 80, 80)
        .brush(2, 0, 0x4f9a52)
        .select(2)
        .floodFill(50, 50, 0xc0392b, 0)
        .floodFill(5, 5, 0x000000, 0),
    )
    const d = shapes(root).map((p) => [p.getAttribute('fill'), (p.getAttribute('d') ?? '').slice(0, 6)])
    // The ellipse (smaller than the square) is filled; at (5, 5) no shape is outlined in black.
    expect(d).toEqual([
      ['none', 'M0 0L1'],
      ['none', 'M80 50'],
      ['#4f9a52', 'M80 50'],
    ])
    expect(r.lost).toEqual(['flood fill outside the shapes drawn before it'])
    // The outline is drawn again over the fill.
    expect(shapes(root)[2].getAttribute('stroke')).toBe('#c0392b')
  })

  it('WMF FLOODFILL and EXTFLOODFILL', () => {
    const w = new WmfWriter({ width: 100, height: 100 })
    w.setWindowOrg(0, 0).setWindowExt(100, 100).pen(0, 1, 0x000000).select(0).brush(0, 0xffffff).select(1).rectangle(10, 10, 90, 90)
    w.brush(0, 0xe8a33d).select(2).floodFill(50, 50, 0x000000).brush(0, 0x4f9a52).select(3).floodFill(50, 50, 0xe8a33d, 1)
    const { r, root } = svgOf(w.bytes())
    expect(r.lost).toEqual([])
    expect(shapes(root).map((p) => p.getAttribute('fill'))).toEqual(['#ffffff', '#e8a33d', '#4f9a52'])
  })

  it('a point inside a path: curves followed, the fill rule kept', () => {
    const ring = 'M0 0L100 0L100 100L0 100ZM25 25L75 25L75 75L25 75Z'
    expect(pathContains(ring, 'evenodd', 50, 50)).toBe(false)
    expect(pathContains(ring, 'nonzero', 50, 50)).toBe(true)
    expect(pathContains(ring, 'evenodd', 10, 50)).toBe(true)
    expect(pathContains('M0 50C0 -16 100 -16 100 50Z', 'nonzero', 50, 10)).toBe(true)
    expect(pathContains('M0 50C0 -16 100 -16 100 50Z', 'nonzero', 50, 60)).toBe(false)
    expect(pathContains('M10 10H90V90H10Z', 'nonzero', 50, 50)).toBe(true)
  })
})
