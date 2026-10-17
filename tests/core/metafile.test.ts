import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { DOMParser } from 'linkedom'
import { drawMetafile, type MetafileDrawing, type MetafileResult } from '../../src/core/metafile'
import { sanitizeSvg } from '../../src/core/svg-sanitize'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { EmfWriter, PlusWriter, WmfWriter, dib1, dib24, png } from '../../scripts/fixtures/lib-metafile.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import * as corpus from '../../scripts/fixtures/metafile-corpus.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { READING_ROOM } from '../../scripts/fixtures/vocabulary.mjs'

/*
 * The metafile drawing code (src/core/metafile): whole files from the
 * corpus (scripts/fixtures/metafile-corpus.mjs, the pictures in
 * tests/corpus/reading-room-metafiles.docx) and single records, read back
 * as SVG structure. Pixels are checked through the render host in
 * tests/main/metafile-render.test.ts.
 */

function drawn(r: MetafileResult): MetafileDrawing {
  if ('error' in r) throw new Error(r.error)
  return r
}

function svgOf(bytes: Buffer): { r: MetafileDrawing; doc: Document; root: Element } {
  const r = drawn(drawMetafile(bytes))
  const doc = new DOMParser().parseFromString(r.svg, 'image/svg+xml') as unknown as Document
  return { r, doc, root: doc.documentElement }
}

const all = (root: Element, sel: string): Element[] => [...root.querySelectorAll(sel)]
/** The shapes drawn: paths outside <defs> (pattern tiles and clip paths are not drawn as they stand). */
const shapes = (root: Element): Element[] => all(root, 'path').filter((p) => !p.closest('defs'))
const fills = (root: Element): string[] => shapes(root).map((p) => p.getAttribute('fill') ?? '')
const viewBox = (root: Element): number[] => root.getAttribute('viewBox')!.split(' ').map((v) => Math.round(Number(v)))

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

describe('metafile corpus: each drawing as SVG', () => {
  it('draws every picture in the corpus, at the size its header gives, and the sanitizer keeps it whole', () => {
    for (const p of corpus.metafileCorpus()) {
      const r = drawn(drawMetafile(p.bytes))
      expect([p.name, Math.round(r.width), Math.round(r.height)]).toEqual([p.name, p.width, p.height])
      const clean = sanitizeSvg(r.svg)
      expect(clean, p.name).not.toBeNull()
      // Nothing the drawing code writes is something the sanitizer takes out.
      const count = (s: string) => (s.match(/<(path|text|use|image|clipPath|pattern|linearGradient)\b/g) ?? []).length
      expect(count(clean!), p.name).toBe(count(r.svg))
    }
  })

  it('shapes: rectangles, a rounded rectangle, a dashed ellipse, a pie, a chord, a thick arc and a curve', () => {
    const { root } = svgOf(corpus.shapesEmf())
    expect(viewBox(root)).toEqual([0, 0, 320, 200])
    expect(fills(root)).toEqual(['#3a6ea5', '#e8a33d', 'none', '#4f9a52', '#e8a33d', 'none', 'none'])
    const paths = shapes(root)
    // The ellipse: a cosmetic dashed pen (18 on, 6 off), no fill.
    expect(paths[2].getAttribute('stroke')).toBe('#c0392b')
    expect(paths[2].getAttribute('stroke-dasharray')).toBe('18 6')
    // The rounded rectangle's corners are quarter ellipses of radius 15 (the corner ellipse is 30 wide).
    expect(paths[1].getAttribute('d')).toMatch(/^M145 10L215 10C/)
    // The pie closes through its center; the chord straight across.
    expect(paths[3].getAttribute('d')).toContain('L60 140Z')
    // A geometric pen 6 wide, round caps (EXTCREATEPEN's default).
    expect(paths[5].getAttribute('stroke-width')).toBe('6')
    expect(paths[5].getAttribute('stroke-linecap')).toBe('round')
    expect(paths[6].getAttribute('d')).toBe('M250 190C270 150 290 200 310 160')
  })

  it('transforms: an anisotropic mapping mode, a rotated world transform, then a scaled one', () => {
    const { root } = svgOf(corpus.transformsEmf())
    const [blue, orange, green] = shapes(root).map((p) => p.getAttribute('d'))
    // 1,000 logical units onto 300 by 200 px.
    expect(blue).toBe('M15 10L135 10L135 90L15 90Z')
    // Turned 30 degrees about (750, 500) in logical units, then mapped: no longer a rectangle.
    const pts = orange!.match(/-?\d+(\.\d+)?/g)!.map(Number)
    expect(new Set(pts.filter((_, i) => i % 2 === 0)).size).toBe(4)
    // MWT_IDENTITY then MWT_SET (half size, down 500): the ellipse spans 50..250 by 50+500..450+500 logical.
    expect(green!.startsWith('M75 150C')).toBe(true)
  })

  it('clipping: an ellipse path as the clip; a rectangle with a hole cut out, worked out as rectangles', () => {
    const { root } = svgOf(corpus.clippingEmf())
    const clips = all(root, 'clipPath')
    expect(clips).toHaveLength(2)
    expect(clips[0].querySelector('path')!.getAttribute('d')).toMatch(/^M140 80C/)
    // Intersect (150,20)-(230,140), exclude (170,60)-(210,100): four rectangles round the hole.
    expect(clips[1].querySelector('path')!.getAttribute('d')).toBe('M150 20H230V60H150ZM150 100H230V140H150ZM150 60H170V100H150ZM210 60H230V100H210Z')
    const groups = all(root, 'g[clip-path]')
    expect(groups.map((g) => g.querySelectorAll('path').length)).toEqual([1, 1])
  })

  it('text: placed character by character, turned by its escapement, in its weight, style and decoration, the face then metric twins', () => {
    const { root } = svgOf(corpus.textEmf())
    const texts = all(root, 'text')
    expect(texts.map((t) => t.textContent)).toEqual(READING_ROOM.signs)
    const [quiet, entrance, returns, media, fiction] = texts
    expect(quiet.getAttribute('x')).toBe(Array.from({ length: 12 }, (_, i) => i * 12).join(' '))
    expect(quiet.getAttribute('font-family')).toBe("'Arial','Liberation Sans','Arimo',sans-serif")
    expect(quiet.getAttribute('font-size')).toBe('24')
    // 90 degrees counter-clockwise on a y-down device: (0, -1, 1, 0).
    expect(entrance.getAttribute('transform')).toBe('matrix(0 -1 1 0 300 190)')
    expect(returns.getAttribute('font-weight')).toBe('bold')
    expect(returns.getAttribute('font-style')).toBe('italic')
    expect(returns.getAttribute('fill')).toBe('#c0392b')
    const r = +Math.SQRT1_2.toFixed(6)
    expect(returns.getAttribute('transform')).toBe(`matrix(${r} ${-r} ${r} ${r} 40 190)`)
    expect(media.getAttribute('text-anchor')).toBe('middle')
    expect(fiction.getAttribute('text-decoration')).toBe('underline')
    expect(fiction.getAttribute('font-family')).toBe("'Courier New','Liberation Mono','Cousine',monospace")
    // Top-aligned (TA_TOP): the baseline an ascent below the reference point.
    expect(fiction.getAttribute('y')).toBe('16.29')
    // An opaque background mode paints the text's box first.
    expect(fills(root)).toContain('#ffee88')
  })

  it('hatching: each hatch style a pattern tile, on its background where the mode is opaque; a monochrome pattern brush', () => {
    const { root } = svgOf(corpus.hatchEmf())
    const patterns = all(root, 'pattern')
    expect(patterns).toHaveLength(5)
    expect(patterns.map((p) => p.querySelector('rect')?.getAttribute('fill') ?? null)).toEqual([null, null, '#fff2cc', '#fff2cc', null])
    expect(patterns[0].querySelector('path')!.getAttribute('d')).toBe('M0 4H8')
    expect(patterns[1].querySelector('path')!.getAttribute('d')!.startsWith('M0 0L8 8')).toBe(true)
    expect(patterns[4].querySelector('image')!.getAttribute('xlink:href')).toMatch(/^data:image\/png;base64,/)
  })

  it('EMF+ dual: drawn from its EMF records', () => {
    const { r, root } = svgOf(corpus.dualEmf())
    expect(fills(root)).toEqual(['#3a6ea5', '#e8a33d'])
    expect(r.bitmap).toBeUndefined()
  })

  it('EMF+ only: drawn from its EMF+ records, its EMF records (not the picture) left out', () => {
    const { root } = svgOf(corpus.plusOnlyEmf())
    expect(fills(root)).toEqual(['#4f9a52', '#3a6ea5', 'none'])
    expect(shapes(root)[1].getAttribute('fill-opacity')).toBe('0.502')
    expect(shapes(root)[2].getAttribute('stroke')).toBe('#c0392b')
    expect(all(root, 'text').map((t) => t.textContent)).toEqual([READING_ROOM.signs[0]])
  })

  it('WMF: the placeable header and the window (twips) onto the picture; a hatched brush; text', () => {
    const { root } = svgOf(corpus.planWmf())
    expect(viewBox(root)).toEqual([0, 0, 200, 120])
    expect(shapes(root)[0].getAttribute('d')).toBe('M10 10L90 10L90 60L10 60Z')
    expect(all(root, 'pattern')).toHaveLength(1)
    // 14 px text: 210 twips, drawn under the window's scale (a fifteenth).
    expect(all(root, 'text').map((t) => [t.textContent, t.getAttribute('font-size'), t.getAttribute('transform')])).toEqual([
      [READING_ROOM.signs[1], '210', `matrix(${+(1 / 15).toFixed(6)} 0 0 ${+(1 / 15).toFixed(6)} 100 75)`],
    ])
  })
})

describe('metafile corpus: a metafile that is one bitmap is that bitmap', () => {
  it('a STRETCHDIBITS covering the frame: its pixels as PNG, exactly', () => {
    const r = drawn(drawMetafile(corpus.scanEmf()))
    expect(r.bitmap).toMatchObject({ mime: 'image/png', width: 100, height: 75 })
    const pixel = (x: number, y: number) => [Math.round((x * 255) / 99), Math.round((y * 255) / 74), 160]
    for (const [x, y] of [[0, 0], [99, 0], [0, 74], [57, 31], [99, 74]]) expect(pngPixel(r.bitmap!.bytes, x, y)).toEqual(pixel(x, y))
  })

  it("an EMF+ dual file's picture: the PNG it was made from, byte for byte", () => {
    const { emf, png: original } = corpus.plusPhoto()
    const r = drawn(drawMetafile(emf))
    expect(r.bitmap?.bytes.equals(original)).toBe(true)
  })

  it('a WMF STRETCHDIB covering the window', () => {
    const r = drawn(drawMetafile(corpus.scanWmf()))
    expect(r.bitmap).toMatchObject({ mime: 'image/png', width: 80, height: 50 })
  })

  it('not when anything else shows: a caption over it, a bitmap covering half, or one drawn mirrored', () => {
    const pic = dib24(20, 10, () => [10, 20, 30])
    const caption = new EmfWriter({ width: 200, height: 100 }).stretchDIBits(0, 0, 200, 100, pic).font(1, {}).select(1).text(10, 20, READING_ROOM.signs[0]).bytes()
    expect(drawn(drawMetafile(caption)).bitmap).toBeUndefined()
    const half = new EmfWriter({ width: 200, height: 100 }).stretchDIBits(0, 0, 100, 100, pic).bytes()
    expect(drawn(drawMetafile(half)).bitmap).toBeUndefined()
    const mirrored = new EmfWriter({ width: 200, height: 100 }).stretchDIBits(200, 0, -200, 100, pic).bytes()
    expect(drawn(drawMetafile(mirrored)).bitmap).toBeUndefined()
    // A white background under an opaque bitmap does not show: still the bitmap.
    const under = new EmfWriter({ width: 200, height: 100 }).stock(8).stock(0).rectangle(0, 0, 200, 100).stretchDIBits(0, 0, 200, 100, pic).bytes()
    expect(drawn(drawMetafile(under)).bitmap).toMatchObject({ width: 20, height: 10 })
  })
})

describe('metafile records', () => {
  const emf = (build: (e: typeof EmfWriter.prototype) => void, size = { width: 100, height: 100 }) => {
    const e = new EmfWriter(size)
    build(e)
    return svgOf(e.bytes())
  }

  it('MM_LOMETRIC: tenths of a millimeter, y up from the window origin', () => {
    const { root } = emf((e) => e.setMapMode(2).setWindowOrg(0, 0).setViewportOrg(0, 100).stock(4).stock(8).rectangle(0, 0, 100, 100))
    // 10 mm at 96 px an inch is 37.8 px, drawn upwards from y = 100.
    expect(shapes(root)[0].getAttribute('d')).toBe('M0 100L37.8 100L37.8 62.2L0 62.2Z')
  })

  it('SaveDC and RestoreDC bring back the brush and the transform', () => {
    const { root } = emf((e) =>
      e.stock(8).brush(1, 0, 0xff0000).select(1).saveDC().brush(2, 0, 0x00ff00).select(2).setWorldTransform([2, 0, 0, 2, 0, 0]).restoreDC(-1).rectangle(10, 10, 20, 20),
    )
    expect(shapes(root).map((p) => [p.getAttribute('fill'), p.getAttribute('d')])).toEqual([['#ff0000', 'M10 10L20 10L20 20L10 20Z']])
  })

  it('polygon fill mode: alternate is even-odd, winding is nonzero', () => {
    const star = [50, 5, 79, 95, 2, 39, 98, 39, 21, 95]
    const alt = emf((e) => e.stock(4).polygon(star)).root
    const wind = emf((e) => e.setPolyFillMode(2).stock(4).polygon(star)).root
    expect(shapes(alt)[0].getAttribute('fill-rule')).toBe('evenodd')
    expect(shapes(wind)[0].getAttribute('fill-rule')).toBeNull()
  })

  it('a path bracket: the figures drawn by StrokeAndFillPath, not where they were recorded', () => {
    const { root } = emf((e) => e.stock(4).beginPath().moveTo(10, 10).lineTo(90, 10).lineTo(50, 90).closeFigure().endPath().strokeAndFillPath())
    const paths = shapes(root)
    expect(paths).toHaveLength(1)
    expect(paths[0].getAttribute('d')).toBe('M10 10L90 10L50 90Z')
    expect(paths[0].getAttribute('fill')).toBe('#000000')
    expect(paths[0].getAttribute('stroke')).toBe('#000000')
  })

  it('ROP2: R2_NOP draws nothing, R2_WHITE draws white, R2_XORPEN blends by difference', () => {
    expect(drawMetafile(new EmfWriter({ width: 10, height: 10 }).setRop2(11).stock(4).rectangle(1, 1, 9, 9).bytes())).toEqual({ error: 'it draws nothing this app can show' })
    expect(fills(emf((e) => e.setRop2(16).stock(4).rectangle(1, 1, 9, 9)).root)).toEqual(['#ffffff'])
    expect(shapes(emf((e) => e.setRop2(7).stock(4).rectangle(1, 1, 9, 9)).root)[0].getAttribute('style')).toBe('mix-blend-mode:difference')
  })

  it('PatBlt-style BITBLT with no bitmap fills with the brush (PATCOPY), black, white', () => {
    const { root } = emf((e) => e.brush(1, 0, 0x12a4b6).select(1).patBlt(0, 0, 50, 50).patBlt(50, 0, 50, 50, 0x00000042).patBlt(0, 50, 50, 50, 0x00ff0062))
    expect(fills(root)).toEqual(['#12a4b6', '#000000', '#ffffff'])
  })

  it('a rectangle gradient: a linear gradient between its two vertex colors', () => {
    const { root } = emf((e) => e.gradientRect(0, 0, 0xff0000, 100, 100, 0x0000ff))
    const g = root.querySelector('linearGradient')!
    expect([g.getAttribute('x1'), g.getAttribute('x2'), g.getAttribute('y1'), g.getAttribute('y2')]).toEqual(['0', '100', '0', '0'])
    expect([...g.querySelectorAll('stop')].map((s) => s.getAttribute('stop-color'))).toEqual(['#ff0000', '#0000ff'])
  })

  it('ExtSelectClipRgn: a region of rectangles is the clip; none (RGN_COPY) clears it', () => {
    const { root } = emf((e) => e.stock(4).clipRegion([[0, 0, 50, 50], [50, 50, 100, 100]], 5).rectangle(0, 0, 100, 100).clipRegion(null, 5).rectangle(10, 10, 20, 20))
    expect(all(root, 'clipPath path')[0].getAttribute('d')).toBe('M0 0H50V50H0ZM50 50H100V100H50Z')
    expect(all(root, 'g[clip-path] path')).toHaveLength(1)
    expect(shapes(root)).toHaveLength(2)
  })

  it('arcs follow SetArcDirection: counter-clockwise as seen by default, clockwise when asked', () => {
    const ccw = shapes(emf((e) => e.stock(8).stock(4).pie(0, 0, 100, 100, 100, 50, 50, 0)).root)[0].getAttribute('d')!
    const cw = shapes(emf((e) => e.setArcDirection(2).stock(8).stock(4).pie(0, 0, 100, 100, 100, 50, 50, 0)).root)[0].getAttribute('d')!
    // From the right-hand point: up to the top (a quarter) one way, round by the bottom (three quarters) the other.
    expect((ccw.match(/C/g) ?? []).length).toBe(1)
    expect((cw.match(/C/g) ?? []).length).toBe(3)
  })

  it('stock objects: NULL_PEN and NULL_BRUSH draw nothing; BLACK_BRUSH fills black', () => {
    expect(drawMetafile(new EmfWriter({ width: 10, height: 10 }).stock(8).stock(5).rectangle(1, 1, 9, 9).bytes())).toMatchObject({ error: expect.any(String) })
    expect(fills(emf((e) => e.stock(8).stock(4).rectangle(1, 1, 9, 9)).root)).toEqual(['#000000'])
  })

  it('a 1-bit DIB takes its own two colors; drawn by STRETCHDIBITS as a PNG', () => {
    const r = drawn(drawMetafile(new EmfWriter({ width: 8, height: 8 }).stretchDIBits(0, 0, 8, 8, dib1(8, 8, (x: number) => x < 4)).bytes()))
    // Set bits take the table's second color (white), clear ones its first (black).
    expect(pngPixel(r.bitmap!.bytes, 0, 0)).toEqual([255, 255, 255])
    expect(pngPixel(r.bitmap!.bytes, 7, 7)).toEqual([0, 0, 0])
  })

  it("a mask and an image (SRCPAINT then SRCAND, or the XOR trick) are the one bitmap they mean, transparent where the page shows through", () => {
    const white = [255, 255, 255]
    const black = [0, 0, 0]
    const red = [200, 0, 0]
    // LibreOffice's order: the mask ORed (white where the image shows), the image ANDed.
    const orMask = dib24(2, 1, (x: number) => (x === 0 ? white : black))
    const image = dib24(2, 1, (x: number) => (x === 0 ? red : white))
    const pair = drawn(drawMetafile(new EmfWriter({ width: 20, height: 10 }).stretchDIBits(0, 0, 20, 10, orMask, 0x00ee0086).stretchDIBits(0, 0, 20, 10, image, 0x008800c6).bytes()))
    expect(pair.svg).not.toContain('mix-blend-mode')
    expect((pair.svg.match(/<use /g) ?? []).length).toBe(1)
    expect([pngPixel(pair.bitmap!.bytes, 0, 0), pngPixel(pair.bitmap!.bytes, 1, 0)[3]]).toEqual([[...red, 255], 0])
    // The XOR trick: image XORed, mask ANDed (black where the image shows), image XORed again.
    const andMask = dib24(2, 1, (x: number) => (x === 0 ? black : white))
    const sprite = dib24(2, 1, (x: number) => (x === 0 ? red : black))
    const trick = drawn(
      drawMetafile(
        new EmfWriter({ width: 20, height: 10 })
          .stretchDIBits(0, 0, 20, 10, sprite, 0x00660046)
          .stretchDIBits(0, 0, 20, 10, andMask, 0x008800c6)
          .stretchDIBits(0, 0, 20, 10, sprite, 0x00660046)
          .bytes(),
      ),
    )
    expect((trick.svg.match(/<use /g) ?? []).length).toBe(1)
    expect([pngPixel(trick.bitmap!.bytes, 0, 0), pngPixel(trick.bitmap!.bytes, 1, 0)[3]]).toEqual([[...red, 255], 0])
  })

  it('EMF+ DrawString and FillRects in an EMF+-only file; a semi-transparent brush keeps its alpha', () => {
    const p = new PlusWriter().header(false).fillRects(0x80ff0000, [[0, 0, 50, 50]]).font(1, 12, 'Calibri').drawString(1, 0xff000000, [0, 60, 100, 20], READING_ROOM.signs[2]).eof()
    const { root } = svgOf(new EmfWriter({ width: 100, height: 100 }).comment(p.bytes()).bytes())
    expect(shapes(root)[0].getAttribute('fill-opacity')).toBe('0.502')
    const t = root.querySelector('text')!
    expect(t.textContent).toBe(READING_ROOM.signs[2])
    expect(t.getAttribute('font-family')).toBe("'Calibri','Carlito',sans-serif")
  })

  it('an EMF+ picture inside a metafile is drawn from the PNG it carries', () => {
    const picture = png(4, 4, () => [0, 128, 255])
    const p = new PlusWriter().header(false).image(1, picture, 4, 4).drawImage(1, [0, 0, 4, 4], [10, 10, 40, 40]).eof()
    const { r, root } = svgOf(new EmfWriter({ width: 100, height: 100 }).comment(p.bytes()).bytes())
    expect(r.bitmap).toBeUndefined()
    expect(root.querySelector('image')!.getAttribute('xlink:href')).toBe(`data:image/png;base64,${picture.toString('base64')}`)
    expect(root.querySelector('use')!.getAttribute('transform')).toBe('matrix(10 0 0 10 10 10)')
  })

  it('WMF without a placeable header: the window the file sets is the picture', () => {
    const w = new WmfWriter({ width: 0, height: 0, placeable: false }).setWindowOrg(0, 0).setWindowExt(400, 200).brush(0, 0x00ff00).select(0).rectangle(0, 0, 200, 100)
    const { r, root } = svgOf(w.bytes())
    expect([r.width, r.height]).toEqual([400, 200])
    expect(shapes(root)[0].getAttribute('d')).toBe('M0 0L200 0L200 100L0 100Z')
  })

  it('text by glyph number is not drawn (it is noted), and alone it leaves nothing to show', () => {
    const r = drawMetafile(new EmfWriter({ width: 100, height: 40 }).font(1, {}).select(1).text(0, 20, READING_ROOM.signs[0], { options: 0x10 }).bytes())
    expect(r).toEqual({ error: 'it draws nothing this app can show' })
  })

  it('a drawing wholly outside its frame is not a picture', () => {
    expect(drawMetafile(new EmfWriter({ width: 50, height: 50 }).stock(4).rectangle(500, 500, 600, 600).bytes())).toEqual({ error: 'nothing it draws is inside its frame' })
  })
})
