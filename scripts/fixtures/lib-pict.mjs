/**
 * QuickDraw pictures (Mac PICT, as RTF's \macpict holds them: no 512-byte
 * file header) and Windows device-dependent bitmaps (RTF's \wbitmap), built
 * byte by byte for the fixtures and tests. Each takes `rgb(x, y)`, a pixel's
 * color as [r, g, b].
 *
 *   pictPackBits   version 2, an 8-bit indexed PixMap in one PackBitsRect
 *   pictDirect     version 2, a 32-bit PixMap in DirectBitsRect bands
 *                  (packed by component), `bands` of them down the frame
 *   pictBits       version 1, a one-bit BitMap in a BitsRect
 *   pictQuickTime  version 2, an image (a JPEG) in a CompressedQuickTime
 *   pictDrawing    version 2, QuickDraw drawing only (a filled rectangle)
 *   ddb            the bits of a device-dependent bitmap, top row first
 */

const be16 = (n) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n & 0xffff)
  return b
}
const be32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const rect = (top, left, bottom, right) => Buffer.concat([be16(top), be16(left), be16(bottom), be16(right)])

/** PackBits: runs of three or more as repeats, the rest as literals. */
export function packBits(row) {
  const out = []
  let i = 0
  while (i < row.length) {
    let run = 1
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++
    if (run >= 3) {
      out.push(257 - run, row[i])
      i += run
      continue
    }
    const start = i
    while (i < row.length && i - start < 128) {
      if (i + 2 < row.length && row[i] === row[i + 1] && row[i] === row[i + 2]) break
      i++
    }
    out.push(i - start - 1, ...row.subarray(start, i))
  }
  return Buffer.from(out)
}

/** A packed row with its count, a byte or (rowBytes over 250) a word. */
const packedRow = (row, rowBytes) => {
  const p = packBits(row)
  return Buffer.concat([rowBytes > 250 ? be16(p.length) : Buffer.from([p.length]), p])
}

/** Version 2 header: size word, frame, VersionOp 0x0011 0x02FF, HeaderOp 0x0C00 (24 bytes). */
function v2(width, height, ops) {
  const header = Buffer.concat([be16(0x0c00), be16(0xfffe), be16(0), be32(0x00480000), be32(0x00480000), rect(0, 0, height, width), be32(0)])
  const body = Buffer.concat([be16(0x0011), be16(0x02ff), header, ...ops, be16(0x00ff)])
  return Buffer.concat([be16(0), rect(0, 0, height, width), body])
}

const align = (b) => (b.length % 2 ? Buffer.concat([b, Buffer.from([0])]) : b)

/** The PixMap fields after bounds: pmVersion … pmReserved. */
const pixmapFields = (packType, depth, cmpCount, cmpSize) =>
  Buffer.concat([be16(0), be16(packType), be32(0), be32(0x00480000), be32(0x00480000), be16(depth === 32 ? 16 : 0), be16(depth), be16(cmpCount), be16(cmpSize), be32(0), be32(0), be32(0)])

export function pictPackBits({ width, height, rgb }) {
  const colors = []
  const index = new Map()
  const pixels = Buffer.alloc(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const key = rgb(x, y).join(',')
      if (!index.has(key)) {
        index.set(key, colors.length)
        colors.push(rgb(x, y))
      }
      pixels[y * width + x] = index.get(key)
    }
  }
  if (colors.length > 256) throw new Error('pictPackBits: more than 256 colors')
  const rowBytes = width % 2 ? width + 1 : width
  const table = Buffer.concat([
    be32(0),
    be16(0),
    be16(colors.length - 1),
    ...colors.map(([r, g, b], i) => Buffer.concat([be16(i), be16(r * 257), be16(g * 257), be16(b * 257)])),
  ])
  const rows = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(rowBytes)
    pixels.copy(row, 0, y * width, (y + 1) * width)
    rows.push(packedRow(row, rowBytes))
  }
  const op = Buffer.concat([
    be16(0x0098),
    be16(0x8000 | rowBytes),
    rect(0, 0, height, width),
    pixmapFields(0, 8, 1, 8),
    table,
    rect(0, 0, height, width),
    rect(0, 0, height, width),
    be16(0),
    ...rows,
  ])
  return v2(width, height, [align(op)])
}

export function pictDirect({ width, height, rgb, bands = 1 }) {
  const rowBytes = width * 4
  const ops = []
  const step = Math.ceil(height / bands)
  for (let top = 0; top < height; top += step) {
    const bottom = Math.min(height, top + step)
    const rows = []
    for (let y = top; y < bottom; y++) {
      const row = Buffer.alloc(width * 3)
      for (let x = 0; x < width; x++) {
        const [r, g, b] = rgb(x, y)
        row[x] = r
        row[width + x] = g
        row[2 * width + x] = b
      }
      rows.push(packedRow(row, rowBytes))
    }
    ops.push(
      align(
        Buffer.concat([
          be16(0x009a),
          be32(0xff),
          be16(0x8000 | rowBytes),
          rect(top, 0, bottom, width),
          pixmapFields(4, 32, 3, 8),
          rect(top, 0, bottom, width),
          rect(top, 0, bottom, width),
          be16(0x40),
          ...rows,
        ]),
      ),
    )
  }
  return v2(width, height, ops)
}

export function pictBits({ width, height, rgb }) {
  const rowBytes = Math.ceil(width / 16) * 2
  const rows = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(rowBytes)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y)
      // A set bit is black.
      if (r + g + b < 384) row[x >> 3] |= 0x80 >> (x & 7)
    }
    rows.push(row)
  }
  const body = Buffer.concat([
    Buffer.from([0x11, 0x01, 0x90]),
    be16(rowBytes),
    rect(0, 0, height, width),
    rect(0, 0, height, width),
    rect(0, 0, height, width),
    be16(0),
    ...rows,
    Buffer.from([0xff]),
  ])
  return Buffer.concat([be16(0), rect(0, 0, height, width), body])
}

export function pictQuickTime({ width, height, image }) {
  const description = Buffer.concat([
    be32(86),
    Buffer.from('jpeg', 'latin1'),
    be32(0),
    be16(0),
    be16(0),
    be16(0),
    be16(0),
    Buffer.from('appl', 'latin1'),
    be32(0),
    be32(512),
    be16(width),
    be16(height),
    be32(0x00480000),
    be32(0x00480000),
    be32(image.length),
    be16(1),
    Buffer.alloc(32),
    be16(24),
    be16(0xffff),
  ])
  const matrix = Buffer.concat([be32(0x10000), be32(0), be32(0), be32(0), be32(0x10000), be32(0), be32(0), be32(0), be32(0x40000000)])
  const data = Buffer.concat([matrix, be32(0), rect(0, 0, 0, 0), be16(0x40), rect(0, 0, height, width), be32(0), be32(0), description, image])
  return v2(width, height, [align(Buffer.concat([be16(0x8200), be32(data.length), data]))])
}

export function pictDrawing({ width, height }) {
  // RGBFgCol, then PaintRect over the frame.
  return v2(width, height, [Buffer.concat([be16(0x001a), be16(0x3a3a), be16(0x6e6e), be16(0xa5a5), be16(0x0031), rect(0, 0, height, width)])])
}

/** A device-dependent bitmap's bits at `depth` 1, 4 (VGA colors, nearest) or 24 bits, rows padded to words. */
export function ddb({ width, height, depth, rgb }) {
  const widthBytes = Math.ceil((width * depth) / 16) * 2
  const bits = Buffer.alloc(widthBytes * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y)
      const row = y * widthBytes
      if (depth === 1) {
        if (r + g + b >= 384) bits[row + (x >> 3)] |= 0x80 >> (x & 7)
      } else if (depth === 24) {
        bits[row + x * 3] = b
        bits[row + x * 3 + 1] = g
        bits[row + x * 3 + 2] = r
      } else throw new Error(`ddb: depth ${depth}`)
    }
  }
  return { bits, widthBytes }
}
