import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { loadImage } from '@napi-rs/canvas'

/*
 * Every PNG among the shared fixtures is a valid one: each chunk's CRC is
 * right and its pixels inflate. tests/fixtures/sample.png once was not (a
 * hand-typed 3x1 PNG whose CRCs libpng refused), so tests that needed a
 * readable picture drew their own (gen-fixtures.mjs draws it now).
 */

const DIR = join(__dirname, '../fixtures')

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

describe('fixture PNGs', () => {
  for (const name of readdirSync(DIR).filter((f) => f.endsWith('.png'))) {
    it(`${name}: every chunk's CRC is right, its data inflates, it decodes`, async () => {
      const png = readFileSync(join(DIR, name))
      expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
      const idat: Buffer[] = []
      let at = 8
      let last = ''
      while (at < png.length) {
        const length = png.readUInt32BE(at)
        const type = png.toString('latin1', at + 4, at + 8)
        expect(png.readUInt32BE(at + 8 + length), `${type} CRC`).toBe(crc32(png.subarray(at + 4, at + 8 + length)))
        if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length))
        last = type
        at += 12 + length
      }
      expect(last).toBe('IEND')
      expect(() => inflateSync(Buffer.concat(idat))).not.toThrow()
      const image = await loadImage(png)
      expect(image.width).toBeGreaterThan(0)
    })
  }
})
