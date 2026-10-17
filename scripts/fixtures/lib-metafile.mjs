/**
 * EMF, EMF+ and WMF pictures written by hand, for fixtures and tests: a
 * small writer for each, record by record, little-endian as GDI writes
 * them. Record numbers are written in hex, as [MS-EMF], [MS-EMFPLUS] and
 * [MS-WMF] list them.
 *
 *   const e = new EmfWriter({ width: 240, height: 160 })   // CSS px; 1 device px each
 *   e.brush(1, 0, 0x3a6ea5).select(1).rectangle(10, 10, 100, 60)
 *   e.bytes()
 *
 *   const w = new WmfWriter({ width: 200, height: 80 })    // placeable, 96 units an inch
 *   w.brush(0, 0x3a6ea5).select(0).rectangle(4, 4, 196, 76)
 *   w.bytes()
 *
 *   new PlusWriter().header(true).fillEllipse(...).eof().bytes()   // EMF+ records, for EmfWriter.comment()
 *
 *   dib24(width, height, (x, y) => [r, g, b])   // a 24-bit DIB: { info, bits }
 *   png(width, height, (x, y) => [r, g, b])     // a PNG
 *
 * Colors are 0xRRGGBB here; the writers store them as COLORREF (0x00BBGGRR).
 */
import { deflateSync } from 'node:zlib'

const colorref = (rgb) => ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)

function u32s(...v) {
  const b = Buffer.alloc(v.length * 4)
  v.forEach((x, i) => (x < 0 ? b.writeInt32LE(x, i * 4) : b.writeUInt32LE(x >>> 0, i * 4)))
  return b
}
function i16s(...v) {
  const b = Buffer.alloc(v.length * 2)
  v.forEach((x, i) => b.writeInt16LE(x, i * 2))
  return b
}
function f32s(...v) {
  const b = Buffer.alloc(v.length * 4)
  v.forEach((x, i) => b.writeFloatLE(x, i * 4))
  return b
}
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b)
const utf16 = (s) => Buffer.from(s, 'utf16le')

/** A 24-bit bottom-up DIB: its BITMAPINFOHEADER and its pixel rows. */
export function dib24(width, height, pixel) {
  const info = Buffer.alloc(40)
  info.writeUInt32LE(40, 0)
  info.writeInt32LE(width, 4)
  info.writeInt32LE(height, 8)
  info.writeUInt16LE(1, 12)
  info.writeUInt16LE(24, 14)
  const stride = Math.ceil((width * 3) / 4) * 4
  const bits = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      bits[row + x * 3] = b
      bits[row + x * 3 + 1] = g
      bits[row + x * 3 + 2] = r
    }
  }
  info.writeUInt32LE(bits.length, 20)
  return { info, bits }
}

/** A 1-bit DIB (a monochrome pattern), its two colors black and white. */
export function dib1(width, height, set) {
  const info = Buffer.alloc(48)
  info.writeUInt32LE(40, 0)
  info.writeInt32LE(width, 4)
  info.writeInt32LE(height, 8)
  info.writeUInt16LE(1, 12)
  info.writeUInt16LE(1, 14)
  info.writeUInt32LE(2, 32)
  info.writeUInt32LE(0x00ffffff, 44)
  const stride = Math.ceil(width / 32) * 4
  const bits = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (set(x, y)) bits[(height - 1 - y) * stride + (x >> 3)] |= 0x80 >> (x & 7)
  }
  return { info, bits }
}

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  let c = 0xffffffff
  for (const b of Buffer.concat([head.subarray(4), data])) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** An 8-bit RGB PNG. */
export function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      const o = y * (width * 3 + 1) + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * An EMF. The reference device is 96 px an inch, so a device pixel is a
 * CSS px and the frame is the picture's size; logical units are device
 * pixels until a mapping mode or transform says otherwise.
 */
export class EmfWriter {
  constructor({ width = 240, height = 160 } = {}) {
    this.width = width
    this.height = height
    this.records = []
    this.handles = 1
  }
  rec(type, ...parts) {
    const body = pad4(Buffer.concat(parts))
    const head = u32s(type, 8 + body.length)
    this.records.push(Buffer.concat([head, body]))
    return this
  }
  /** A record exactly as given (for hostile-file tests): type, size and body bytes. */
  raw(buf) {
    this.records.push(buf)
    return this
  }
  bounds() {
    return u32s(0, 0, this.width - 1, this.height - 1)
  }
  // State.
  setMapMode(m) { return this.rec(0x11, u32s(m)) }
  setWindowExt(x, y) { return this.rec(0x09, u32s(x, y)) }
  setWindowOrg(x, y) { return this.rec(0x0a, u32s(x, y)) }
  setViewportExt(x, y) { return this.rec(0x0b, u32s(x, y)) }
  setViewportOrg(x, y) { return this.rec(0x0c, u32s(x, y)) }
  setBkMode(m) { return this.rec(0x12, u32s(m)) }
  setPolyFillMode(m) { return this.rec(0x13, u32s(m)) }
  setRop2(m) { return this.rec(0x14, u32s(m)) }
  setTextAlign(a) { return this.rec(0x16, u32s(a)) }
  setTextColor(rgb) { return this.rec(0x18, u32s(colorref(rgb))) }
  setBkColor(rgb) { return this.rec(0x19, u32s(colorref(rgb))) }
  saveDC() { return this.rec(0x21) }
  restoreDC(n = -1) { return this.rec(0x22, u32s(n)) }
  setWorldTransform(m) { return this.rec(0x23, f32s(...m)) }
  modifyWorldTransform(m, mode) { return this.rec(0x24, f32s(...m), u32s(mode)) }
  setArcDirection(d) { return this.rec(0x39, u32s(d)) }
  // Objects.
  pen(ih, style, width, rgb) { return this.rec(0x26, u32s(ih, style, width, 0, colorref(rgb))) }
  extPen(ih, style, width, rgb, dashes = []) {
    return this.rec(0x5f, u32s(ih, 0, 0, 0, 0, style, width, 0, colorref(rgb), 0, dashes.length, ...dashes))
  }
  brush(ih, style, rgb, hatch = 0) { return this.rec(0x27, u32s(ih, style, colorref(rgb), hatch)) }
  patternBrush(ih, { info, bits }, mono = false) {
    const offBmi = 32
    const offBits = offBmi + info.length
    return this.rec(mono ? 0x5d : 0x5e, u32s(ih, 0, offBmi, info.length, offBits, bits.length), info, bits)
  }
  font(ih, { height = -16, weight = 400, italic = 0, underline = 0, strike = 0, escapement = 0, charset = 0, pitchFamily = 0, face = 'Arial' } = {}) {
    const lf = Buffer.alloc(92)
    lf.writeInt32LE(height, 0)
    lf.writeInt32LE(escapement, 8)
    lf.writeInt32LE(escapement, 12)
    lf.writeInt32LE(weight, 16)
    lf[20] = italic
    lf[21] = underline
    lf[22] = strike
    lf[23] = charset
    lf[27] = pitchFamily
    utf16(face).copy(lf, 28, 0, 62)
    return this.rec(0x52, u32s(ih), lf)
  }
  select(ih) { return this.rec(0x25, u32s(ih)) }
  stock(index) { return this.rec(0x25, u32s(0x80000000 + index)) }
  deleteObject(ih) { return this.rec(0x28, u32s(ih)) }
  // Drawing.
  moveTo(x, y) { return this.rec(0x1b, u32s(x, y)) }
  lineTo(x, y) { return this.rec(0x36, u32s(x, y)) }
  rectangle(l, t, r, b) { return this.rec(0x2b, u32s(l, t, r, b)) }
  ellipse(l, t, r, b) { return this.rec(0x2a, u32s(l, t, r, b)) }
  roundRect(l, t, r, b, w, h) { return this.rec(0x2c, u32s(l, t, r, b, w, h)) }
  arc(l, t, r, b, xs, ys, xe, ye) { return this.rec(0x2d, u32s(l, t, r, b, xs, ys, xe, ye)) }
  chord(l, t, r, b, xs, ys, xe, ye) { return this.rec(0x2e, u32s(l, t, r, b, xs, ys, xe, ye)) }
  pie(l, t, r, b, xs, ys, xe, ye) { return this.rec(0x2f, u32s(l, t, r, b, xs, ys, xe, ye)) }
  /** POLYGON16 / POLYLINE16 / POLYBEZIER16 (0x56, 0x57, 0x55); points flat. */
  poly16(type, pts) {
    return this.rec(type, this.bounds(), u32s(pts.length / 2), i16s(...pts))
  }
  polygon(pts) { return this.rec(0x03, this.bounds(), u32s(pts.length / 2, ...pts)) }
  polyline(pts) { return this.rec(0x04, this.bounds(), u32s(pts.length / 2, ...pts)) }
  polyPolygon16(polys) {
    const all = polys.flat()
    return this.rec(0x5b, this.bounds(), u32s(polys.length, all.length / 2, ...polys.map((p) => p.length / 2)), i16s(...all))
  }
  beginPath() { return this.rec(0x3b) }
  endPath() { return this.rec(0x3c) }
  closeFigure() { return this.rec(0x3d) }
  fillPath() { return this.rec(0x3e, this.bounds()) }
  strokeAndFillPath() { return this.rec(0x3f, this.bounds()) }
  strokePath() { return this.rec(0x40, this.bounds()) }
  selectClipPath(mode) { return this.rec(0x43, u32s(mode)) }
  intersectClipRect(l, t, r, b) { return this.rec(0x1e, u32s(l, t, r, b)) }
  excludeClipRect(l, t, r, b) { return this.rec(0x1d, u32s(l, t, r, b)) }
  /** EXTSELECTCLIPRGN: rectangles (device px) by mode, or none (mode 5: no clip). */
  clipRegion(rects, mode) {
    if (!rects) return this.rec(0x4b, u32s(0, mode))
    const rgn = Buffer.concat([u32s(32, 1, rects.length, rects.length * 16, 0, 0, 0, 0), u32s(...rects.flat())])
    return this.rec(0x4b, u32s(rgn.length, mode), rgn)
  }
  /** EXTTEXTOUTW at (x, y), each character `advance` apart when given. */
  text(x, y, s, { advance, options = 0, rect = [0, 0, 0, 0] } = {}) {
    const n = s.length
    const offString = 76
    const str = pad4(utf16(s))
    const offDx = advance ? offString + str.length : 0
    const dx = advance ? u32s(...Array.from({ length: n }, () => advance)) : Buffer.alloc(0)
    return this.rec(0x54, this.bounds(), u32s(1), f32s(1, 1), u32s(x, y, n, offString, options, ...rect, offDx), str, dx)
  }
  /** STRETCHDIBITS: a DIB drawn into (x, y, w, h). */
  stretchDIBits(x, y, w, h, { info, bits }, rop = 0x00cc0020) {
    const offBmi = 80
    const offBits = offBmi + info.length
    const width = info.readInt32LE(4)
    const height = Math.abs(info.readInt32LE(8))
    return this.rec(0x51, this.bounds(), u32s(x, y, 0, 0, width, height, offBmi, info.length, offBits, bits.length, 0, rop, w, h), info, bits)
  }
  /** BITBLT with no source (a pattern fill: PATCOPY) */
  patBlt(x, y, w, h, rop = 0x00f00021) {
    return this.rec(0x4c, this.bounds(), u32s(x, y, w, h, rop, 0, 0), f32s(1, 0, 0, 1, 0, 0), u32s(0, 0, 0, 0, 0, 0))
  }
  gradientRect(x0, y0, rgb0, x1, y1, rgb1, vertical = false) {
    const v = (x, y, rgb) => Buffer.concat([u32s(x, y), Buffer.from(new Uint16Array([((rgb >> 16) & 0xff) << 8, ((rgb >> 8) & 0xff) << 8, (rgb & 0xff) << 8, 0]).buffer)])
    return this.rec(0x76, this.bounds(), u32s(2, 1, vertical ? 1 : 0), v(x0, y0, rgb0), v(x1, y1, rgb1), u32s(0, 1))
  }
  /** EMR_COMMENT holding EMF+ records. */
  comment(plus) {
    return this.rec(0x46, u32s(plus.length + 4, 0x2b464d45), plus)
  }
  bytes() {
    const eof = Buffer.concat([u32s(0x0e, 20), u32s(0, 16, 20)])
    const h = Buffer.alloc(100)
    h.writeInt32LE(0, 0)
    h.writeInt32LE(0, 4)
    h.writeInt32LE(this.width - 1, 8)
    h.writeInt32LE(this.height - 1, 12)
    h.writeInt32LE(0, 16)
    h.writeInt32LE(0, 20)
    h.writeInt32LE(Math.round((this.width * 2540) / 96), 24)
    h.writeInt32LE(Math.round((this.height * 2540) / 96), 28)
    h.writeUInt32LE(0x464d4520, 32)
    h.writeUInt32LE(0x00010000, 36)
    h.writeUInt16LE(Math.max(2, this.handles), 48)
    // A 96 px-an-inch reference device: 1920 by 1080 px over 508 by 285.75 mm (micrometers exact).
    h.writeInt32LE(1920, 64)
    h.writeInt32LE(1080, 68)
    h.writeInt32LE(508, 72)
    h.writeInt32LE(286, 76)
    h.writeInt32LE(508_000, 92)
    h.writeInt32LE(285_750, 96)
    const header = Buffer.concat([u32s(1, 8 + h.length), h])
    const total = header.length + this.records.reduce((n, r) => n + r.length, 0) + eof.length
    header.writeUInt32LE(total, 48)
    header.writeUInt32LE(this.records.length + 2, 52)
    return Buffer.concat([header, ...this.records, eof])
  }
}

/** EMF+ records, to be carried in an EMR_COMMENT. Coordinates are world units (pixels unless a page transform says). */
export class PlusWriter {
  constructor() {
    this.parts = []
  }
  rec(type, flags, ...data) {
    const body = Buffer.concat(data)
    const head = Buffer.alloc(12)
    head.writeUInt16LE(type, 0)
    head.writeUInt16LE(flags, 2)
    head.writeUInt32LE(12 + body.length, 4)
    head.writeUInt32LE(body.length, 8)
    this.parts.push(Buffer.concat([head, body]))
    return this
  }
  header(dual) { return this.rec(0x4001, dual ? 1 : 0, u32s(0xdbc01002, 1, 96, 96)) }
  eof() { return this.rec(0x4002, 0) }
  getDC() { return this.rec(0x4004, 0) }
  /** A solid brush object. */
  solidBrush(id, argb) { return this.rec(0x4008, 0x100 | id, u32s(0xdbc01002, 0, argb >>> 0)) }
  /** A pen object, its width in world units, drawn with a solid brush. */
  pen(id, width, argb) { return this.rec(0x4008, 0x200 | id, u32s(0xdbc01002, 0, 0, 0), f32s(width), u32s(0xdbc01002, 0, argb >>> 0)) }
  /** A compressed (PNG or JPEG) bitmap image object. */
  image(id, bytes, width, height) {
    return this.rec(0x4008, 0x500 | id, u32s(0xdbc01002, 1, width, height, 0, 0, 1), bytes)
  }
  /** A font object. */
  font(id, emSize, family, style = 0) {
    return this.rec(0x4008, 0x600 | id, u32s(0xdbc01002), f32s(emSize), u32s(2, style, 0, family.length), utf16(family))
  }
  fillRects(argb, rects) { return this.rec(0x400a, 0x8000, u32s(argb >>> 0, rects.length), f32s(...rects.flat())) }
  fillEllipse(argb, rect) { return this.rec(0x400e, 0x8000, u32s(argb >>> 0), f32s(...rect)) }
  drawLines(penId, pts, closed = false) { return this.rec(0x400d, penId | (closed ? 0x2000 : 0), u32s(pts.length / 2), f32s(...pts)) }
  drawImage(imageId, src, dest) { return this.rec(0x401a, imageId, u32s(0, 2), f32s(...src), f32s(...dest)) }
  drawString(fontId, argb, rect, s) { return this.rec(0x401c, 0x8000 | fontId, u32s(argb >>> 0, 0xffffffff, s.length), f32s(...rect), pad4(utf16(s))) }
  /** DRAWDRIVERSTRING: `glyphs` (code units, or glyph numbers when `cmap` is false) each at its [x, y]. */
  drawDriverString(fontId, argb, glyphs, positions, { cmap = true } = {}) {
    const units = Buffer.alloc(glyphs.length * 2)
    glyphs.forEach((g, i) => units.writeUInt16LE(g, i * 2))
    return this.rec(0x4036, 0x8000 | fontId, u32s(argb >>> 0, cmap ? 1 : 0, 0, glyphs.length), units, f32s(...positions.flat()))
  }
  setWorldTransform(m) { return this.rec(0x402a, 0, f32s(...m)) }
  bytes() {
    return Buffer.concat(this.parts)
  }
}

/**
 * A WMF with its Aldus placeable header unless `placeable` is false: its
 * box is the picture's size in CSS px at `inch` units an inch (96: the box
 * is the size in px; 1440: twips, as Office writes them).
 */
export class WmfWriter {
  constructor({ width = 200, height = 80, placeable = true, inch = 96 } = {}) {
    this.width = width
    this.height = height
    this.placeable = placeable
    this.inch = inch
    this.records = []
  }
  rec(fn, ...words) {
    const params = Buffer.concat(words.map((w) => (Buffer.isBuffer(w) ? w : i16s(w))))
    const body = params.length % 2 ? Buffer.concat([params, Buffer.alloc(1)]) : params
    const head = Buffer.alloc(6)
    head.writeUInt32LE(3 + body.length / 2, 0)
    head.writeUInt16LE(fn, 4)
    this.records.push(Buffer.concat([head, body]))
    return this
  }
  color(rgb) {
    return u32s(colorref(rgb))
  }
  setWindowOrg(x, y) { return this.rec(0x020b, y, x) }
  setWindowExt(x, y) { return this.rec(0x020c, y, x) }
  setBkMode(m) { return this.rec(0x0102, m) }
  setTextColor(rgb) { return this.rec(0x0209, this.color(rgb)) }
  setTextAlign(a) { return this.rec(0x012e, a) }
  pen(style, width, rgb) { return this.rec(0x02fa, style, width, 0, this.color(rgb)) }
  brush(style, rgb, hatch = 0) { return this.rec(0x02fc, style, this.color(rgb), hatch) }
  font({ height = -16, weight = 400, escapement = 0, face = 'Arial' } = {}) {
    const lf = Buffer.alloc(50)
    lf.writeInt16LE(height, 0)
    lf.writeInt16LE(escapement, 4)
    lf.writeInt16LE(escapement, 6)
    lf.writeInt16LE(weight, 8)
    Buffer.from(face, 'latin1').copy(lf, 18, 0, 31)
    return this.rec(0x02fb, lf)
  }
  select(i) { return this.rec(0x012d, i) }
  deleteObject(i) { return this.rec(0x01f0, i) }
  rectangle(l, t, r, b) { return this.rec(0x041b, b, r, t, l) }
  ellipse(l, t, r, b) { return this.rec(0x0418, b, r, t, l) }
  roundRect(l, t, r, b, w, h) { return this.rec(0x061c, h, w, b, r, t, l) }
  pie(l, t, r, b, xs, ys, xe, ye) { return this.rec(0x081a, ye, xe, ys, xs, b, r, t, l) }
  polygon(pts) { return this.rec(0x0324, pts.length / 2, ...pts) }
  polyline(pts) { return this.rec(0x0325, pts.length / 2, ...pts) }
  moveTo(x, y) { return this.rec(0x0214, y, x) }
  lineTo(x, y) { return this.rec(0x0213, y, x) }
  intersectClipRect(l, t, r, b) { return this.rec(0x0416, b, r, t, l) }
  saveDC() { return this.rec(0x001e) }
  restoreDC(n = -1) { return this.rec(0x0127, n) }
  textOut(x, y, s) {
    const str = Buffer.from(s, 'latin1')
    return this.rec(0x0521, str.length, str.length % 2 ? Buffer.concat([str, Buffer.alloc(1)]) : str, y, x)
  }
  /** STRETCHDIB: a packed DIB drawn into (x, y, w, h). */
  stretchDIB(x, y, w, h, { info, bits }, rop = 0x00cc0020) {
    const width = info.readInt32LE(4)
    const height = Math.abs(info.readInt32LE(8))
    return this.rec(0x0f43, u32s(rop), 0, height, width, 0, 0, h, w, y, x, info, bits)
  }
  bytes() {
    const eof = Buffer.from([3, 0, 0, 0, 0, 0])
    const body = Buffer.concat([...this.records, eof])
    const header = Buffer.alloc(18)
    header.writeUInt16LE(1, 0)
    header.writeUInt16LE(9, 2)
    header.writeUInt16LE(0x300, 4)
    header.writeUInt32LE((18 + body.length) / 2, 6)
    header.writeUInt16LE(16, 10)
    header.writeUInt32LE(Math.max(...this.records.map((r) => r.length / 2), 3), 12)
    const meta = Buffer.concat([header, body])
    if (!this.placeable) return meta
    const ph = Buffer.alloc(22)
    ph.writeUInt32LE(0x9ac6cdd7, 0)
    ph.writeInt16LE(Math.round((this.width * this.inch) / 96), 10)
    ph.writeInt16LE(Math.round((this.height * this.inch) / 96), 12)
    ph.writeUInt16LE(this.inch, 14)
    let sum = 0
    for (let i = 0; i < 20; i += 2) sum ^= ph.readUInt16LE(i)
    ph.writeUInt16LE(sum, 20)
    return Buffer.concat([ph, meta])
  }
}
