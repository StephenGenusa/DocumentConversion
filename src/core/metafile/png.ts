import { deflateSync } from 'node:zlib'

/*
 * A PNG encoder for the bitmaps a metafile carries (DIBs, GDI+ pixel
 * bitmaps): 8-bit RGB, or RGBA when the bitmap has transparency. Each row
 * gets whichever filter (0 none, 1 sub, 2 up) leaves it smallest by the
 * usual estimate (the sum of the filtered bytes as signed values).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(parts: Buffer[]): number {
  let c = 0xffffffff
  for (const b of parts) for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32([head.subarray(4), data]), 0)
  return Buffer.concat([head, data, crc])
}

/** `rgba` (4 bytes a pixel, top row first) as a PNG; RGB only unless `alpha`. */
export function encodePng(width: number, height: number, rgba: Uint8Array, alpha: boolean): Buffer {
  const bpp = alpha ? 4 : 3
  const stride = width * bpp
  const raw = Buffer.alloc((stride + 1) * height)
  const prev = Buffer.alloc(stride)
  const row = Buffer.alloc(stride)
  const sub = Buffer.alloc(stride)
  const up = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    let src = y * width * 4
    for (let x = 0; x < width; x++, src += 4) {
      const o = x * bpp
      row[o] = rgba[src]
      row[o + 1] = rgba[src + 1]
      row[o + 2] = rgba[src + 2]
      if (alpha) row[o + 3] = rgba[src + 3]
    }
    let costNone = 0
    let costSub = 0
    let costUp = 0
    for (let i = 0; i < stride; i++) {
      const s = (row[i] - (i >= bpp ? row[i - bpp] : 0)) & 0xff
      const u = (row[i] - prev[i]) & 0xff
      sub[i] = s
      up[i] = u
      costNone += row[i] < 128 ? row[i] : 256 - row[i]
      costSub += s < 128 ? s : 256 - s
      costUp += u < 128 ? u : 256 - u
    }
    const at = y * (stride + 1)
    if (costSub <= costNone && costSub <= costUp) {
      raw[at] = 1
      sub.copy(raw, at + 1)
    } else if (costUp < costNone) {
      raw[at] = 2
      up.copy(raw, at + 1)
    } else {
      raw[at] = 0
      row.copy(raw, at + 1)
    }
    row.copy(prev)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = alpha ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
