/**
 * TIFF and EMF pictures written by hand, for fixtures and tests: there is no
 * encoder for either in the dependency tree, and a test picture is better
 * made than committed.
 *
 *   tiff({ width, height, pixel, ... })   a one-page baseline TIFF
 *   tiff({ pages: [{ ... }, { ... }] })   a multi-page one (a fax, a scanned letter)
 *   emf({ width, height })                a small EMF: a framed, filled box
 *   wmf({ width, height, placeable })     a small WMF: the same box (Aldus placeable header unless false)
 *
 * TIFF options:
 *   pixel(x, y)    [r, g, b] or [r, g, b, a], 0-255 (gray and bilevel use r)
 *   kind           'rgb' (default), 'rgba' (unassociated alpha), 'gray', 'bilevel'
 *   compression    'none' (default), 'packbits', 'lzw', 'deflate'
 *   bigEndian      MM byte order instead of II
 *   rowsPerStrip   rows in each strip (default 16), so most pictures have several
 *   claim          { width, height } written in place of the real size: a hostile file
 *   dpi            the resolution written (default 72)
 */
import { deflateSync } from 'node:zlib'

const COMPRESSION = { none: 1, lzw: 5, deflate: 8, packbits: 0x8005 }

/** The pixel rows packed as the TIFF stores them, one Buffer a row. */
function rows(width, height, pixel, kind) {
  const out = []
  for (let y = 0; y < height; y++) {
    if (kind === 'bilevel') {
      const row = Buffer.alloc(Math.ceil(width / 8))
      // BlackIsZero: a set bit is white.
      for (let x = 0; x < width; x++) if (pixel(x, y)[0] >= 128) row[x >> 3] |= 0x80 >> (x & 7)
      out.push(row)
      continue
    }
    const spp = { rgb: 3, rgba: 4, gray: 1 }[kind]
    const row = Buffer.alloc(width * spp)
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y)
      for (let s = 0; s < spp; s++) row[x * spp + s] = s === 3 ? (p[3] ?? 255) : p[s]
    }
    out.push(row)
  }
  return out
}

/** PackBits, row by row (a run never crosses a row, as the TIFF spec asks). */
function packBits(row) {
  const out = []
  let i = 0
  while (i < row.length) {
    let run = 1
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++
    if (run >= 2) {
      out.push(257 - run, row[i])
      i += run
      continue
    }
    let lit = 1
    while (i + lit < row.length && lit < 128 && !(i + lit + 1 < row.length && row[i + lit] === row[i + lit + 1])) lit++
    out.push(lit - 1, ...row.subarray(i, i + lit))
    i += lit
  }
  return Buffer.from(out)
}

/** TIFF LZW, MSB first, as libtiff writes it (a reader widens its codes one early). */
function lzw(data) {
  const bytes = []
  let acc = 0
  let bits = 0
  let width = 9
  const put = (code) => {
    acc = (acc << width) | code
    bits += width
    while (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 0xff)
      bits -= 8
    }
    acc &= (1 << bits) - 1
  }
  let table = new Map()
  let next = 258
  put(256)
  let w = ''
  for (const b of data) {
    const c = String.fromCharCode(b)
    const wc = w + c
    if (w === '' || table.has(wc) || wc.length === 1) {
      w = wc
      continue
    }
    put(w.length === 1 ? w.charCodeAt(0) : table.get(w))
    table.set(wc, next++)
    // libtiff's encoder: wider once the next code no longer fits (its decoder reads a code behind).
    if (next === 1 << width && width < 12) width++
    if (next === 4094) {
      put(256)
      table = new Map()
      next = 258
      width = 9
    }
    w = c
  }
  if (w !== '') put(w.length === 1 ? w.charCodeAt(0) : table.get(w))
  put(257)
  if (bits > 0) bytes.push((acc << (8 - bits)) & 0xff)
  return Buffer.from(bytes)
}

/**
 * A baseline TIFF. One page from the options above; several with `pages`,
 * an array of the same options for each page (byte order from the outer
 * options), chained in order. A page with `thumbnail: true` is marked as a
 * reduced-resolution copy (NewSubfileType 1), as cameras and scanners write
 * a preview; one with `pageNumber` carries the PageNumber tag (297).
 */
export function tiff(opts) {
  const bigEndian = opts.bigEndian ?? false
  const pages = opts.pages ?? [opts]
  const u16 = (b, v, at) => (bigEndian ? b.writeUInt16BE(v, at) : b.writeUInt16LE(v, at))
  const u32 = (b, v, at) => (bigEndian ? b.writeUInt32BE(v, at) : b.writeUInt32LE(v, at))
  const header = Buffer.alloc(8)
  header.write(bigEndian ? 'MM' : 'II', 0, 'latin1')
  u16(header, 42, 2)
  const parts = [header]
  const ifdAts = []
  let at = 8
  for (const page of pages) {
    const block = tiffPage(page, at, u16, u32)
    parts.push(block.bytes)
    ifdAts.push(block.ifdAt)
    at += block.bytes.length
  }
  const out = Buffer.concat(parts)
  u32(out, ifdAts[0], 4)
  // Each page's IFD ends with the offset of the next one (0 after the last).
  ifdAts.forEach((ifdAt, i) => u32(out, ifdAts[i + 1] ?? 0, ifdAt + 2 + out[bigEndian ? ifdAt + 1 : ifdAt] * 12))
  return out
}

/** One page's strips, IFD and the arrays it points at, laid out from `base` in the file. */
function tiffPage({ width, height, pixel, kind = 'rgb', compression = 'none', rowsPerStrip = 16, claim, thumbnail, pageNumber, dpi = 72 }, base, u16, u32) {
  const packed = rows(width, height, pixel, kind)
  const strips = []
  for (let y = 0; y < height; y += rowsPerStrip) {
    const part = packed.slice(y, y + rowsPerStrip)
    const raw = Buffer.concat(part)
    strips.push(
      compression === 'packbits' ? Buffer.concat(part.map(packBits))
      : compression === 'lzw' ? lzw(raw)
      : compression === 'deflate' ? deflateSync(raw)
      : raw,
    )
  }
  const spp = { rgb: 3, rgba: 4, gray: 1, bilevel: 1 }[kind]
  const bps = kind === 'bilevel' ? 1 : 8
  const photometric = kind === 'rgb' || kind === 'rgba' ? 2 : 1

  // Layout: strip data, then the IFD and the arrays it points at.
  const offsets = []
  let at = base
  for (const s of strips) {
    offsets.push(at)
    at += s.length + (s.length % 2)
  }
  const data = Buffer.concat(strips.map((s) => (s.length % 2 ? Buffer.concat([s, Buffer.alloc(1)]) : s)))
  const SHORT = 3
  const LONG = 4
  const RATIONAL = 5
  const entries = [
    ...(thumbnail ? [[254, LONG, [1]]] : pageNumber !== undefined ? [[254, LONG, [2]]] : []),
    [256, LONG, [claim?.width ?? width]],
    [257, LONG, [claim?.height ?? height]],
    [258, SHORT, Array(spp).fill(bps)],
    [259, SHORT, [COMPRESSION[compression]]],
    [262, SHORT, [photometric]],
    [273, LONG, offsets],
    [277, SHORT, [spp]],
    [278, LONG, [rowsPerStrip]],
    [279, LONG, strips.map((s) => s.length)],
    [282, RATIONAL, [dpi, 1]],
    [283, RATIONAL, [dpi, 1]],
    [284, SHORT, [1]],
    [296, SHORT, [2]],
    ...(pageNumber !== undefined ? [[297, SHORT, pageNumber]] : []),
    ...(kind === 'rgba' ? [[338, SHORT, [2]]] : []),
  ]
  const ifdAt = base + data.length
  const ifd = Buffer.alloc(2 + entries.length * 12 + 4)
  u16(ifd, entries.length, 0)
  const extra = []
  let extraAt = ifdAt + ifd.length
  entries.forEach(([tag, type, values], i) => {
    const e = 2 + i * 12
    u16(ifd, tag, e)
    u16(ifd, type, e + 2)
    const count = type === RATIONAL ? values.length / 2 : values.length
    u32(ifd, count, e + 4)
    const size = type === SHORT ? 2 : 4
    const bytes = Buffer.alloc(values.length * size)
    values.forEach((v, k) => (size === 2 ? u16(bytes, v, k * 2) : u32(bytes, v, k * 4)))
    if (bytes.length <= 4) bytes.copy(ifd, e + 8)
    else {
      u32(ifd, extraAt, e + 8)
      extra.push(bytes)
      extraAt += bytes.length
    }
  })
  return { bytes: Buffer.concat([data, ifd, ...extra]), ifdAt }
}

/**
 * A small EMF (records written little-endian, as GDI does): the header, a
 * filled and framed rectangle, and the end-of-file record. Enough for a
 * reader or a converter to recognize it; this app does not draw EMF.
 */
export function emf({ width = 64, height = 48 } = {}) {
  const rec = (type, body) => {
    const b = Buffer.alloc(8 + body.length)
    b.writeUInt32LE(type, 0)
    b.writeUInt32LE(b.length, 4)
    body.copy(b, 8)
    return b
  }
  const rect = (l, t, r, bt) => {
    const b = Buffer.alloc(16)
    b.writeInt32LE(l, 0)
    b.writeInt32LE(t, 4)
    b.writeInt32LE(r, 8)
    b.writeInt32LE(bt, 12)
    return b
  }
  const brush = Buffer.alloc(16)
  brush.writeUInt32LE(1, 0) // object index
  brush.writeUInt32LE(0, 4) // BS_SOLID
  brush.writeUInt32LE(0x00a56e3a, 8) // COLORREF 0x00bbggrr
  const select = Buffer.alloc(4)
  select.writeUInt32LE(1, 0)
  const body = [
    rec(39, brush), // EMR_CREATEBRUSHINDIRECT
    rec(37, select), // EMR_SELECTOBJECT
    rec(43, rect(4, 4, width - 4, height - 4)), // EMR_RECTANGLE
  ]
  const eof = Buffer.alloc(12)
  eof.writeUInt32LE(0, 0)
  eof.writeUInt32LE(16, 4)
  eof.writeUInt32LE(20, 8)
  const end = rec(14, eof) // EMR_EOF
  // EMR_HEADER: bounds, frame (0.01 mm), signature " EMF", version, size, records, handles, device and mm sizes.
  const h = Buffer.alloc(80)
  rect(0, 0, width - 1, height - 1).copy(h, 0)
  rect(0, 0, Math.round((width * 2540) / 96), Math.round((height * 2540) / 96)).copy(h, 16)
  h.writeUInt32LE(0x464d4520, 32)
  h.writeUInt32LE(0x00010000, 36)
  const records = 2 + body.length
  h.writeUInt16LE(2, 48) // handles
  h.writeUInt32LE(1920, 64)
  h.writeUInt32LE(1080, 68)
  h.writeUInt32LE(508, 72)
  h.writeUInt32LE(286, 76)
  const header = rec(1, h)
  const total = header.length + body.reduce((n, b) => n + b.length, 0) + end.length
  header.writeUInt32LE(total, 8 + 40)
  header.writeUInt32LE(records, 8 + 44)
  return Buffer.concat([header, ...body, end])
}

/**
 * A small WMF (16-bit words, little-endian): a filled rectangle. With the
 * Aldus placeable header (its bounding box at 96 units to the inch, so in
 * CSS px) unless `placeable` is false - the bare metafile an RTF `\wmetafile8`
 * group holds, which says nothing of its size.
 */
export function wmf({ width = 64, height = 48, placeable = true } = {}) {
  const rec = (fn, params) => {
    const b = Buffer.alloc(6 + params.length * 2)
    b.writeUInt32LE(3 + params.length, 0)
    b.writeUInt16LE(fn, 4)
    params.forEach((p, i) => b.writeInt16LE(p, 6 + i * 2))
    return b
  }
  const records = [
    rec(0x020b, [0, 0]), // META_SETWINDOWORG y, x
    rec(0x020c, [height, width]), // META_SETWINDOWEXT y, x
    rec(0x02fc, [0, 0x6e3a, 0x00a5, 0]), // META_CREATEBRUSHINDIRECT: BS_SOLID, COLORREF 0x00a56e3a, hatch
    rec(0x012d, [0]), // META_SELECTOBJECT 0
    rec(0x041b, [height - 4, width - 4, 4, 4]), // META_RECTANGLE bottom, right, top, left
    rec(0x0000, []), // META_EOF
  ]
  const body = Buffer.concat(records)
  const header = Buffer.alloc(18)
  header.writeUInt16LE(1, 0) // memory metafile
  header.writeUInt16LE(9, 2) // header size in words
  header.writeUInt16LE(0x300, 4)
  header.writeUInt32LE((18 + body.length) / 2, 6) // size in words
  header.writeUInt16LE(1, 10) // objects
  header.writeUInt32LE(Math.max(...records.map((r) => r.length / 2)), 12) // largest record
  const meta = Buffer.concat([header, body])
  if (!placeable) return meta
  // 96 units to the inch here, so the box is the picture's size in CSS px.
  const ph = Buffer.alloc(22)
  ph.writeUInt32LE(0x9ac6cdd7, 0)
  ph.writeInt16LE(0, 6)
  ph.writeInt16LE(0, 8)
  ph.writeInt16LE(width, 10)
  ph.writeInt16LE(height, 12)
  ph.writeUInt16LE(96, 14)
  let sum = 0
  for (let i = 0; i < 20; i += 2) sum ^= ph.readUInt16LE(i)
  ph.writeUInt16LE(sum, 20)
  return Buffer.concat([ph, meta])
}
