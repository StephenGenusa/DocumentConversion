import { describe, it, expect } from 'vitest'
import { tiffPages, tiffPage } from '../../src/core/picture-headers'
// @ts-expect-error: a plain .mjs fixture library, no types.
import { tiff as makeTiff } from '../../scripts/fixtures/lib-tiff.mjs'

/*
 * TIFF headers read in core (picture-headers.ts): the pages a file holds,
 * their sizes, and each page taken out on its own, its data byte for byte.
 * Nothing is decoded here; the render host decodes.
 */

const shade = (x: number, y: number) => [x * 9, y * 7, 120]
const page = (width: number, height: number, extra: Record<string, unknown> = {}) => ({ width, height, pixel: shade, ...extra })

describe('tiffPages', () => {
  it('reads one page: its size and resolution', () => {
    const t = makeTiff({ ...page(40, 30), dpi: 300 })
    expect(tiffPages(t)).toEqual([{ index: 0, width: 40, height: 30, dpi: { x: 300, y: 300 } }])
  })

  it('reads every page of a multi-page TIFF, in order, either byte order', () => {
    for (const bigEndian of [false, true]) {
      const t = makeTiff({
        bigEndian,
        pages: [page(40, 30, { compression: 'lzw' }), page(20, 10, { kind: 'bilevel', compression: 'packbits' }), page(8, 8, { kind: 'gray' })],
      })
      expect(tiffPages(t)?.map((p) => [p.index, p.width, p.height])).toEqual([
        [0, 40, 30],
        [1, 20, 10],
        [2, 8, 8],
      ])
    }
  })

  it('leaves out a reduced-resolution copy (a preview), which is not a page', () => {
    const t = makeTiff({ pages: [page(40, 30), page(10, 8, { thumbnail: true }), page(40, 30)] })
    expect(tiffPages(t)?.map((p) => p.index)).toEqual([0, 2])
  })

  it('refuses a chain that loops, and a file that is not a TIFF', () => {
    const t = makeTiff(page(4, 4))
    const ifd = t.readUInt32LE(4)
    t.writeUInt32LE(ifd, ifd + 2 + t.readUInt16LE(ifd) * 12)
    expect(tiffPages(t)).toBeNull()
    expect(tiffPages(Buffer.from('not a tiff at all'))).toBeNull()
    expect(tiffPages(Buffer.from('49492a0008000000', 'hex'))).toBeNull()
    // An IFD that runs off the end of the file.
    const cut = makeTiff(page(4, 4)).subarray(0, -40)
    expect(tiffPages(cut)).toBeNull()
  })
})

describe('tiffPage', () => {
  it('takes one page out on its own: a one-page TIFF of the same strips, byte for byte', () => {
    for (const bigEndian of [false, true]) {
      const pages = [page(40, 30, { compression: 'lzw' }), page(20, 10, { kind: 'bilevel', compression: 'packbits' }), page(8, 8, { kind: 'gray', compression: 'deflate' })]
      const t = makeTiff({ bigEndian, pages })
      for (let i = 0; i < pages.length; i++) {
        const one = tiffPage(t, i)!
        // The same page written alone by the fixture library is the same picture.
        const alone = makeTiff({ ...pages[i], bigEndian })
        expect(tiffPages(one)).toEqual(tiffPages(alone)?.map((p) => ({ ...p, index: 0 })))
        expect(stripData(one)).toEqual(stripData(alone))
        expect(one.length).toBeLessThan(t.length)
      }
    }
  })

  it('answers null for a page that is not there or whose strips run off the end', () => {
    const t = makeTiff({ pages: [page(4, 4), page(4, 4)] })
    expect(tiffPage(t, 5)).toBeNull()
    const ifd = t.readUInt32LE(4)
    // The first page's strip offsets (tag 273) pointed past the end of the file.
    for (let e = 0; e < t.readUInt16LE(ifd); e++) {
      const at = ifd + 2 + e * 12
      if (t.readUInt16LE(at) === 273) t.writeUInt32LE(t.length + 100, at + 8)
    }
    expect(tiffPage(t, 0)).toBeNull()
  })
})

/** The bytes of every strip, in order (a little-endian or big-endian TIFF, strips as LONG). */
function stripData(t: Buffer): string {
  const be = t.toString('latin1', 0, 2) === 'MM'
  const u16 = (at: number) => (be ? t.readUInt16BE(at) : t.readUInt16LE(at))
  const u32 = (at: number) => (be ? t.readUInt32BE(at) : t.readUInt32LE(at))
  const ifd = u32(4)
  const tags = new Map<number, number[]>()
  for (let e = 0; e < u16(ifd); e++) {
    const at = ifd + 2 + e * 12
    const type = u16(at + 2)
    const count = u32(at + 4)
    const size = type === 3 ? 2 : 4
    const base = count * size <= 4 ? at + 8 : u32(at + 8)
    tags.set(u16(at), Array.from({ length: count }, (_, k) => (size === 2 ? u16(base + k * 2) : u32(base + k * 4))))
  }
  const offsets = tags.get(273)!
  const counts = tags.get(279)!
  return offsets.map((o, i) => t.subarray(o, o + counts[i]).toString('hex')).join('|')
}
