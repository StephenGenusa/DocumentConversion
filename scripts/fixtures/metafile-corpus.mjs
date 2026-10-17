/**
 * The metafile corpus: EMF, EMF+ and WMF drawings made with lib-metafile.mjs,
 * one for each part of the drawing code (shapes, transforms, clipping, text,
 * hatching, a bitmap that is the whole picture, EMF+ dual and EMF+-only
 * files, WMF). build-metafiles-fixture.mjs puts them in
 * tests/corpus/reading-room-metafiles.docx; the tests draw them directly.
 * Every word comes from vocabulary.mjs (READING_ROOM).
 */
import { EmfWriter, PlusWriter, WmfWriter, dib1, dib24, png } from './lib-metafile.mjs'
import { READING_ROOM as R } from './vocabulary.mjs'

const BLUE = 0x3a6ea5
const ORANGE = 0xe8a33d
const GREEN = 0x4f9a52
const RED = 0xc0392b
const GRAY = 0x777777

/** A soft two-way gradient, for the pictures. */
const photo = (w, h) => (x, y) => [Math.round((x * 255) / (w - 1)), Math.round((y * 255) / (h - 1)), 160]

export function shapesEmf() {
  const e = new EmfWriter({ width: 320, height: 200 })
  e.pen(1, 0, 2, 0x000000).select(1)
  e.brush(2, 0, BLUE).select(2).rectangle(10, 10, 110, 70)
  e.brush(3, 0, ORANGE).select(3).roundRect(130, 10, 230, 70, 30, 30)
  e.pen(4, 1, 0, RED).select(4).stock(5).ellipse(250, 10, 310, 70)
  e.select(1).brush(5, 0, GREEN).select(5).pie(10, 90, 110, 190, 110, 140, 60, 90)
  e.select(3).chord(130, 90, 230, 190, 230, 140, 130, 140)
  // A thick geometric pen, round caps, for an arc and a curve.
  e.extPen(6, 0x10000 | 0x0000, 6, BLUE).select(6).arc(250, 90, 310, 150, 310, 120, 250, 120)
  e.poly16(0x55, [250, 190, 270, 150, 290, 200, 310, 160])
  e.select(1).stock(5).deleteObject(4)
  return e.bytes()
}

export function transformsEmf() {
  const e = new EmfWriter({ width: 300, height: 200 })
  e.setMapMode(8).setWindowExt(1000, 1000).setViewportExt(300, 200)
  e.brush(1, 0, BLUE).select(1).stock(8).rectangle(50, 50, 450, 450)
  // Turned 30 degrees about (750, 500), then drawn again scaled down.
  const a = Math.PI / 6
  const c = Math.cos(a)
  const s = Math.sin(a)
  const cx = 750
  const cy = 500
  e.setWorldTransform([c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy])
  e.brush(2, 0, ORANGE).select(2).rectangle(600, 350, 900, 650)
  e.modifyWorldTransform([1, 0, 0, 1, 0, 0], 1)
  e.modifyWorldTransform([0.5, 0, 0, 0.5, 0, 500], 4)
  e.brush(3, 0, GREEN).select(3).ellipse(100, 100, 500, 900)
  return e.bytes()
}

export function clippingEmf() {
  const e = new EmfWriter({ width: 240, height: 160 })
  e.stock(8)
  // A round window: the clip is an ellipse path.
  e.beginPath().ellipse(20, 20, 140, 140).endPath().selectClipPath(5)
  e.brush(1, 0, BLUE).select(1).rectangle(0, 0, 240, 160)
  e.clipRegion(null, 5)
  // A cut-out: a rectangle with a hole excluded from it.
  e.intersectClipRect(150, 20, 230, 140).excludeClipRect(170, 60, 210, 100)
  e.brush(2, 0, ORANGE).select(2).rectangle(140, 10, 240, 150)
  return e.bytes()
}

export function textEmf() {
  const [quiet, entrance, returns, media, fiction] = R.signs
  const e = new EmfWriter({ width: 320, height: 200 })
  e.setBkMode(1).setTextColor(0x000000).setTextAlign(24)
  e.font(1, { height: -24, face: 'Arial' }).select(1).text(10, 40, quiet, { advance: 12 })
  e.font(2, { height: -20, escapement: 900, face: 'Arial' }).select(2).text(300, 190, entrance)
  e.font(3, { height: -20, escapement: 450, weight: 700, italic: 1, face: 'Times New Roman' }).select(3).setTextColor(RED).text(40, 190, returns)
  e.font(4, { height: -22, face: 'Arial' }).select(4).setTextAlign(6 | 24).setTextColor(BLUE).text(160, 110, media)
  e.setBkMode(2).setBkColor(0xffee88).setTextAlign(0)
  e.font(5, { height: -18, underline: 1, face: 'Courier New', pitchFamily: 0x31 }).select(5).setTextColor(0x000000).text(190, 20, fiction)
  return e.bytes()
}

export function hatchEmf() {
  const e = new EmfWriter({ width: 240, height: 160 })
  e.stock(8).setBkMode(1)
  e.brush(1, 2, BLUE, 0).select(1).rectangle(0, 0, 120, 80)
  e.brush(2, 2, RED, 2).select(2).rectangle(120, 0, 240, 80)
  e.setBkMode(2).setBkColor(0xfff2cc)
  e.brush(3, 2, GREEN, 4).select(3).rectangle(0, 80, 120, 160)
  e.brush(4, 2, GRAY, 5).select(4).rectangle(120, 80, 180, 160)
  // A monochrome checked pattern brush.
  e.setTextColor(0x000000).setBkColor(0xffffff)
  e.patternBrush(5, dib1(8, 8, (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0), true).select(5).rectangle(180, 80, 240, 160)
  return e.bytes()
}

/** A pasted photograph: one bitmap covering the frame, and nothing else. */
export function scanEmf() {
  const e = new EmfWriter({ width: 200, height: 150 })
  e.saveDC().setMapMode(1)
  e.stretchDIBits(0, 0, 200, 150, dib24(100, 75, photo(100, 75)))
  e.restoreDC()
  return e.bytes()
}

/** EMF+ dual: EMF+ records and EMF records for the same picture. */
export function dualEmf() {
  const e = new EmfWriter({ width: 240, height: 160 })
  e.comment(new PlusWriter().header(true).fillEllipse(0xff3a6ea5, [20, 20, 200, 120]).fillRects(0xffe8a33d, [[60, 60, 120, 40]]).bytes())
  e.stock(8).brush(1, 0, BLUE).select(1).ellipse(20, 20, 220, 140)
  e.brush(2, 0, ORANGE).select(2).rectangle(60, 60, 180, 100)
  e.comment(new PlusWriter().eof().bytes())
  return e.bytes()
}

/** EMF+ only: the EMF records are not the picture (a gray box that must not show). */
export function plusOnlyEmf() {
  const [quiet] = R.signs
  const e = new EmfWriter({ width: 240, height: 160 })
  const p = new PlusWriter()
    .header(false)
    .fillRects(0xff4f9a52, [[10, 10, 100, 60]])
    .fillEllipse(0x803a6ea5, [120, 10, 100, 60])
    .pen(1, 4, 0xffc0392b)
    .drawLines(1, [10, 100, 120, 140, 230, 100])
    .font(2, 20, 'Arial')
    .drawString(2, 0xff000000, [10, 110, 220, 40], quiet)
    .eof()
  e.comment(p.bytes())
  e.stock(8).brush(1, 0, GRAY).select(1).rectangle(0, 0, 240, 160)
  return e.bytes()
}

/** EMF+ dual holding the original PNG of a pasted photograph; its EMF records draw the same pixels as a DIB. */
export function plusPhoto() {
  const pixel = photo(50, 40)
  const original = png(50, 40, pixel)
  const e = new EmfWriter({ width: 200, height: 160 })
  e.comment(new PlusWriter().header(true).image(1, original, 50, 40).drawImage(1, [0, 0, 50, 40], [0, 0, 200, 160]).bytes())
  e.stretchDIBits(0, 0, 200, 160, dib24(50, 40, pixel))
  e.comment(new PlusWriter().eof().bytes())
  return { emf: e.bytes(), png: original }
}

/** An older drawing as Office writes one: twips (1,440 an inch), the window the same box as the placeable header. */
export function planWmf() {
  const [, entrance] = R.signs
  const k = 15 // twips a CSS px
  const t = (...v) => v.map((n) => n * k)
  const w = new WmfWriter({ width: 200, height: 120, inch: 1440 })
  w.setWindowOrg(0, 0).setWindowExt(...t(200, 120))
  w.pen(0, 2 * k, 0x000000).select(0)
  w.brush(2, BLUE, 4).select(1).setBkMode(1).rectangle(...t(10, 10, 90, 60))
  w.brush(0, ORANGE).select(2).ellipse(...t(110, 10, 190, 60))
  w.brush(0, GREEN).select(3).polygon(t(20, 110, 50, 70, 80, 110))
  w.pie(...t(110, 70, 150, 110, 150, 90, 130, 70))
  w.font({ height: -14 * k, face: 'Arial' }).select(4).setTextColor(RED).textOut(...t(100, 75), entrance)
  return w.bytes()
}

export function scanWmf() {
  const w = new WmfWriter({ width: 160, height: 100 })
  w.setWindowOrg(0, 0).setWindowExt(160, 100)
  w.stretchDIB(0, 0, 160, 100, dib24(80, 50, photo(80, 50)))
  return w.bytes()
}

/**
 * A right-to-left program's drawing (SETLAYOUT LAYOUT_RTL): everything
 * mirrored across the frame, its text ending at its mirrored place with
 * its letters the right way round, a bitmap mirrored and one kept as it
 * is (LAYOUT_BITMAPORIENTATIONPRESERVED); then, laid out left to right,
 * Hebrew text read right to left (ETO_RTLREADING).
 */
export function rtlEmf() {
  const [, entrance] = R.signs
  const e = new EmfWriter({ width: 240, height: 160 })
  e.setLayout(1).stock(8)
  // A bar at the left of the page as the program sees it: on the right as drawn.
  e.brush(1, 0, BLUE).select(1).rectangle(10, 10, 40, 150)
  e.setBkMode(1).setTextAlign(24).setTextColor(0x000000)
  e.font(2, { height: -20, face: 'Arial' }).select(2).text(50, 40, entrance, { advance: 10 })
  // A bitmap red on its left, mirrored; the same kept the right way round.
  const halves = dib24(20, 10, (x) => (x < 10 ? [192, 57, 43] : [79, 154, 82]))
  e.stretchDIBits(50, 60, 60, 30, halves)
  e.setLayout(9).stretchDIBits(130, 60, 60, 30, halves)
  e.setLayout(0)
  e.font(3, { height: -22, charset: 177, face: 'Arial' }).select(3).setTextColor(RED).text(110, 140, R.rtlSign, { advance: 12, options: 0x80 })
  return e.bytes()
}

/**
 * Bitmaps through masks: a round marker by MaskBlt (the source where the
 * mask is set, the page left alone elsewhere) over a bar, a square by
 * MaskBlt with black where the mask is clear, a photograph slanted onto a
 * parallelogram by PlgBlt with its corner cut off by a mask, and two
 * labels by PolyTextOut.
 */
export function masksEmf() {
  const [quiet, , returns] = R.signs
  const e = new EmfWriter({ width: 240, height: 160 })
  e.stock(8).brush(1, 0, ORANGE).select(1).rectangle(0, 40, 120, 60)
  const marker = dib24(10, 10, () => [58, 110, 165])
  const round = dib1(10, 10, (x, y) => (x - 4.5) ** 2 + (y - 4.5) ** 2 <= 20)
  e.maskBlt(10, 10, 100, 100, marker, round, 0xaacc0020)
  e.maskBlt(130, 10, 40, 40, dib24(4, 4, () => [79, 154, 82]), dib1(4, 4, (x) => x < 2), 0x00cc0020)
  // Corners at (130, 70), (230, 90) and (120, 130); the mask cuts off its bottom-right quarter.
  e.plgBlt([130, 70, 230, 90, 120, 130], dib24(20, 12, photo(20, 12)), dib1(20, 12, (x, y) => x < 10 || y < 6))
  e.setBkMode(1).setTextAlign(24).setTextColor(0x000000).font(2, { height: -14, face: 'Arial' }).select(2)
  e.polyText([{ x: 10, y: 130, s: quiet, advance: 7 }, { x: 10, y: 150, s: returns }])
  return e.bytes()
}

/**
 * GDI fills worked out from what is drawn: a square of two Gouraud-shaded
 * triangles (GradientFill, a color at each corner), a red outline flood
 * filled green out to its border, and a white ellipse whose surface is
 * flood filled orange.
 */
export function shadingEmf() {
  const e = new EmfWriter({ width: 240, height: 160 })
  e.gradientTriangles(
    [[10, 10, BLUE], [110, 10, ORANGE], [110, 110, GREEN], [10, 110, 0xffffff]],
    [[0, 1, 2], [0, 2, 3]],
  )
  e.pen(1, 0, 2, RED).select(1).stock(5).rectangle(130, 10, 230, 70)
  e.brush(2, 0, GREEN).select(2).floodFill(180, 40, RED, 0)
  e.pen(3, 0, 1, 0x000000).select(3).stock(0).ellipse(130, 90, 230, 150)
  e.brush(4, 0, ORANGE).select(4).floodFill(180, 120, 0xffffff, 1)
  return e.bytes()
}

/**
 * EMF+ brushes drawn as gradients and patterns: a lamp's glow (a path
 * gradient on an ellipse, white in the middle), a pennant (a path gradient
 * on a triangle, a color at each corner, orange at its center) and a rug
 * tiled with a texture.
 */
export function plusFillsEmf() {
  const tile = png(16, 16, (x) => (x < 8 ? [58, 110, 165] : [232, 163, 61]))
  const e = new EmfWriter({ width: 240, height: 160 })
  const p = new PlusWriter()
    .header(false)
    .pathGradientBrush(1, { center: [60, 50], centerArgb: 0xffffffff, surround: [0xff3a6ea5], boundary: { ellipse: [10, 10, 100, 80] } })
    .fillEllipseWith(1, [10, 10, 100, 80])
    .pathGradientBrush(2, { center: [180, 40], centerArgb: 0xffe8a33d, surround: [0xffc0392b, 0xff4f9a52, 0xff3a6ea5], boundary: [130, 10, 230, 10, 180, 90] })
    .fillPolygonWith(2, [130, 10, 230, 10, 180, 90])
    .textureBrush(3, tile, 16, 16)
    .fillRectsWith(3, [[10, 100, 220, 50]])
    .eof()
  e.comment(p.bytes())
  return e.bytes()
}

/** Every picture, with its alt text and size (CSS px), in the order the document shows them. */
export function metafileCorpus() {
  return [
    { name: 'shapes', ext: 'emf', bytes: shapesEmf(), alt: R.shapesAlt, width: 320, height: 200 },
    { name: 'transforms', ext: 'emf', bytes: transformsEmf(), alt: R.transformsAlt, width: 300, height: 200 },
    { name: 'clipping', ext: 'emf', bytes: clippingEmf(), alt: R.clippingAlt, width: 240, height: 160 },
    { name: 'text', ext: 'emf', bytes: textEmf(), alt: R.textAlt, width: 320, height: 200 },
    { name: 'hatch', ext: 'emf', bytes: hatchEmf(), alt: R.hatchAlt, width: 240, height: 160 },
    { name: 'scan', ext: 'emf', bytes: scanEmf(), alt: R.scanAlt2, width: 200, height: 150 },
    { name: 'dual', ext: 'emf', bytes: dualEmf(), alt: R.dualAlt, width: 240, height: 160 },
    { name: 'plus', ext: 'emf', bytes: plusOnlyEmf(), alt: R.plusAlt, width: 240, height: 160 },
    { name: 'plusphoto', ext: 'emf', bytes: plusPhoto().emf, alt: R.plusPhotoAlt, width: 200, height: 160 },
    { name: 'plan', ext: 'wmf', bytes: planWmf(), alt: R.wmfPlanAlt, width: 200, height: 120 },
    { name: 'wmfscan', ext: 'wmf', bytes: scanWmf(), alt: R.wmfScanAlt, width: 160, height: 100 },
    { name: 'rtl', ext: 'emf', bytes: rtlEmf(), alt: R.rtlAlt, width: 240, height: 160 },
    { name: 'masks', ext: 'emf', bytes: masksEmf(), alt: R.masksAlt, width: 240, height: 160 },
    { name: 'shading', ext: 'emf', bytes: shadingEmf(), alt: R.shadingAlt, width: 240, height: 160 },
    { name: 'plusfills', ext: 'emf', bytes: plusFillsEmf(), alt: R.plusFillsAlt, width: 240, height: 160 },
  ]
}
