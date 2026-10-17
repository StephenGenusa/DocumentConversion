import { describe, expect, it } from 'vitest'
import { drawMetafile, GlyphFonts, METAFILE_LIMITS } from '../../src/core/metafile'
import { glyphCharacters, sfntFaces, sfntName, sfntTables } from '../../src/core/metafile/sfnt'
import { MAX_RECORDS } from '../../src/core/metafile/emf'
import { MAX_CLIP_DEPTH } from '../../src/core/metafile/svg'
import { sanitizeSvg } from '../../src/core/svg-sanitize'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { EmfWriter, PlusWriter, WmfWriter, dib24 } from '../../scripts/fixtures/lib-metafile.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { metafileCorpus } from '../../scripts/fixtures/metafile-corpus.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { collection, sfnt } from '../../scripts/fixtures/lib-sfnt.mjs'

/*
 * A metafile is untrusted bytes: whatever it holds, drawing it answers a
 * picture or an error, never throws, never hangs, and never makes more
 * than the limits allow (src/core/metafile: bytes.ts, dib.ts, emf.ts,
 * svg.ts, index.ts).
 */

const u32 = (...v: number[]): Buffer => {
  const b = Buffer.alloc(v.length * 4)
  v.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4))
  return b
}
/** An EMF record as given: type, size, body (the size can lie). */
const record = (type: number, body: Buffer, size = 8 + body.length): Buffer => Buffer.concat([u32(type, size), body])

/** A small deterministic generator, so a failure can be replayed. */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 0x19660d) + 0x3c6ef35f) >>> 0
    return s / 0x100000000
  }
}

function answers(bytes: Buffer): 'picture' | 'error' {
  const r = drawMetafile(bytes)
  if ('error' in r) {
    expect(typeof r.error).toBe('string')
    return 'error'
  }
  expect(r.svg.startsWith('<svg ')).toBe(true)
  expect(r.width).toBeGreaterThanOrEqual(1)
  return 'picture'
}

describe('hostile metafiles', () => {
  const files: { name: string; bytes: Buffer }[] = metafileCorpus()

  it('every corpus file cut short anywhere: a picture or an error, never a throw', () => {
    const t0 = Date.now()
    for (const { bytes } of files) {
      const step = Math.max(1, Math.floor(bytes.length / 400))
      for (let n = 0; n < bytes.length; n += step) answers(bytes.subarray(0, n))
    }
    expect(Date.now() - t0).toBeLessThan(20_000)
  })

  it('every corpus file with bytes changed at random: a picture or an error, never a throw', () => {
    const t0 = Date.now()
    const random = prng(0x5eed)
    for (const { bytes } of files) {
      for (let k = 0; k < 150; k++) {
        const b = Buffer.from(bytes)
        const changes = 1 + Math.floor(random() * 8)
        for (let i = 0; i < changes; i++) {
          const at = Math.floor(random() * b.length)
          // Mostly whole 32-bit fields (counts, sizes, offsets), sometimes single bytes.
          if (random() < 0.6 && at + 4 <= b.length) b.writeUInt32LE(Math.floor(random() * 0x100000000), at & ~3)
          else b[at] = Math.floor(random() * 256)
        }
        answers(b)
      }
    }
    expect(Date.now() - t0).toBeLessThan(30_000)
  })

  it('a record whose count claims more points than it holds is skipped; the rest still draws', () => {
    const e = new EmfWriter({ width: 50, height: 50 })
    e.raw(record(0x03, Buffer.concat([u32(0, 0, 49, 49), u32(0xffffffff), u32(1, 1, 2, 2)])))
    e.stock(4).rectangle(10, 10, 20, 20)
    const r = drawMetafile(e.bytes())
    expect('svg' in r && (r.svg.match(/<path/g) ?? []).length).toBe(1)
  })

  it('a record whose size is zero, odd, or past the end stops the reading there', () => {
    for (const size of [0, 4, 13, 0x7ffffff0]) {
      const e = new EmfWriter({ width: 50, height: 50 }).stock(4).rectangle(1, 1, 9, 9)
      e.raw(record(0x2b, u32(10, 10, 20, 20), size))
      e.rectangle(30, 30, 40, 40)
      const r = drawMetafile(e.bytes())
      expect('svg' in r && (r.svg.match(/<path/g) ?? []).length).toBe(1)
    }
  })

  it(`plays at most MAX_RECORDS (${MAX_RECORDS}) records`, () => {
    const filler = record(0x12, u32(1)) // SETBKMODE
    const e = new EmfWriter({ width: 50, height: 50 })
    e.raw(Buffer.concat(Array.from({ length: MAX_RECORDS + 10 }, () => filler)))
    e.stock(4).rectangle(1, 1, 9, 9)
    const t0 = Date.now()
    expect(drawMetafile(e.bytes())).toEqual({ error: 'it draws nothing this app can show' })
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  it('object indexes past the table are not kept; selecting one that is not there changes nothing', () => {
    const e = new EmfWriter({ width: 50, height: 50 }).brush(0xfffffff, 0, 0xff0000).select(0xfffffff).brush(0x10000, 0, 0xff0000).select(0x10000).stock(8).rectangle(1, 1, 49, 49)
    const r = drawMetafile(e.bytes())
    // The default brush (white) fills it, not the red one.
    expect('svg' in r && r.svg).toContain('fill="#ffffff"')
  })

  it('a bitmap that claims more than 20,000 px a side or 50 megapixels is not decoded (and nothing is allocated for it)', () => {
    for (const [w, h] of [[30_000, 1], [8_000, 8_000], [-5, 5], [0x7fffffff, 0x7fffffff]]) {
      const pic = dib24(2, 2, () => [1, 2, 3])
      pic.info.writeInt32LE(w, 4)
      pic.info.writeInt32LE(h, 8)
      const e = new EmfWriter({ width: 50, height: 50 }).stretchDIBits(0, 0, 50, 50, pic)
      const t0 = Date.now()
      expect(drawMetafile(e.bytes())).toMatchObject({ error: expect.any(String) })
      expect(Date.now() - t0).toBeLessThan(2_000)
    }
  })

  it('saved states, clip chains and region rectangles stay within their caps', () => {
    const e = new EmfWriter({ width: 100, height: 100 }).stock(4)
    for (let i = 0; i < 20_000; i++) e.saveDC()
    for (let i = 0; i < 200; i++) e.beginPath().ellipse(i % 50, 0, 100 - (i % 50), 100).endPath().selectClipPath(1)
    for (let i = 0; i < 2_000; i++) e.excludeClipRect(i % 97, i % 89, (i % 97) + 1, (i % 89) + 1)
    e.rectangle(0, 0, 100, 100)
    const r = drawMetafile(e.bytes())
    if ('error' in r) throw new Error(r.error)
    // Each clip is clipped by the one before it, MAX_CLIP_DEPTH at most.
    expect((r.svg.match(/<clipPath /g) ?? []).length).toBeLessThanOrEqual(MAX_CLIP_DEPTH + 1)
  })

  it('an SVG that would pass the limit stops being drawn: an error, not a huge picture', () => {
    const e = new EmfWriter({ width: 100, height: 100 }).stock(4)
    for (let i = 0; i < 2_000; i++) e.rectangle(i % 90, i % 70, (i % 90) + 10, (i % 70) + 10)
    expect(drawMetafile(e.bytes(), { maxChars: 10_000 })).toEqual({ error: 'it is too large to convert' })
    expect(METAFILE_LIMITS.maxChars).toBeGreaterThan(10_000)
  })

  it('EMF+: an object split across records that claims 4 GB is dropped; a region nested a thousand deep is refused', () => {
    const big = Buffer.alloc(12 + 8)
    big.writeUInt16LE(0x4008, 0)
    big.writeUInt16LE(0x8000 | 0x500 | 1, 2)
    big.writeUInt32LE(20, 4)
    big.writeUInt32LE(8, 8)
    big.writeUInt32LE(0xffffffff, 12)
    const deep = Buffer.concat([u32(0xdbc01002, 1001), ...Array.from({ length: 1000 }, () => u32(0)), u32(0x10000003)])
    const region = Buffer.concat([Buffer.from([0x08, 0x40, 0x02, 0x04]), u32(12 + deep.length, deep.length), deep])
    const p = Buffer.concat([new PlusWriter().header(false).bytes(), big, region, new PlusWriter().fillRects(0xff00ff00, [[0, 0, 10, 10]]).eof().bytes()])
    const r = drawMetafile(new EmfWriter({ width: 50, height: 50 }).comment(p).bytes())
    expect('svg' in r && r.svg).toContain('#00ff00')
  })

  it('metafiles nested in metafiles are drawn two deep at most', () => {
    // Each level an EMF+ picture that is the level below, drawn over the whole frame.
    let inner: Buffer = new EmfWriter({ width: 20, height: 20 }).stock(4).rectangle(0, 0, 20, 20).bytes()
    for (let level = 0; level < 6; level++) {
      const image = Buffer.concat([u32(0xdbc01002, 2, 3, inner.length), inner])
      const obj = Buffer.alloc(12)
      obj.writeUInt16LE(0x4008, 0)
      obj.writeUInt16LE(0x500 | 1, 2)
      obj.writeUInt32LE(12 + image.length, 4)
      obj.writeUInt32LE(image.length, 8)
      const p = Buffer.concat([new PlusWriter().header(false).bytes(), obj, image, new PlusWriter().drawImage(1, [0, 0, 20, 20], [0, 0, 20, 20]).eof().bytes()])
      inner = new EmfWriter({ width: 20, height: 20 }).comment(p).bytes()
    }
    const t0 = Date.now()
    answers(inner)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it('WMF: records of no size or past the end stop the reading; a region claiming a million scans reads what is there', () => {
    const w = new WmfWriter({ width: 50, height: 50 }).brush(0, 0xff0000).select(0).rectangle(1, 1, 20, 20)
    const bytes = w.bytes()
    for (const words of [0, 1, 0x7fffffff]) {
      const b = Buffer.from(bytes)
      // The first record after the 22-byte placeable and 18-byte metafile headers.
      b.writeUInt32LE(words, 40)
      answers(b)
    }
    const region = new WmfWriter({ width: 50, height: 50 })
    region.rec(0x06ff, 0, 6, 0, 0, 0, 0x7fff, 0, 0, 0, 10, 10)
    region.rec(0x012c, 0).brush(0, 0xff0000).select(1).rectangle(1, 1, 20, 20)
    answers(region.bytes())
  })

  it('text and font names are written as text: no markup from the file reaches the SVG', () => {
    const e = new EmfWriter({ width: 200, height: 50 })
    e.font(1, { face: '"/><script>x</script>' }).select(1).text(10, 30, '<script>alert(1)</script>&')
    const r = drawMetafile(e.bytes())
    if ('error' in r) throw new Error(r.error)
    expect(r.svg).not.toMatch(/<script/i)
    expect(r.svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp;')
    const clean = sanitizeSvg(r.svg)!
    expect(clean).toContain('&lt;script&gt;')
    expect(clean).not.toMatch(/<script/i)
  })
})

/*
 * The fonts glyph numbers are read with (sfnt.ts) are read as untrusted
 * too: a broken font answers no characters or some, never throws, never
 * hangs.
 */
describe('hostile fonts', () => {
  const be32 = (...v: number[]): Buffer => {
    const b = Buffer.alloc(v.length * 4)
    v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4))
    return b
  }
  /** Every reading of a font file, as the metafile code does it. */
  const read = (font: Buffer): void => {
    for (const face of sfntFaces(font)) {
      const tables = sfntTables(font, face)
      sfntName(font, tables)
      glyphCharacters(font, tables)
    }
    new GlyphFonts(() => font).characters('Reading Sans', false, false)
  }
  const good = sfnt({ family: 'Reading Sans', cmap: [[0x41, 3], [0x1f4d6, 7], [0x42, 4]], names: { 9: 'f_i', 10: 'uni00E9' } })

  it('a font cut short anywhere, or with bytes changed at random: never a throw', () => {
    const t0 = Date.now()
    for (const font of [good, collection([{ family: 'Reading Sans', cmap: [[0x41, 3]] }, { family: 'Reading Serif', cmap: [[0x42, 3]] }])]) {
      for (let n = 0; n < font.length; n++) read(font.subarray(0, n))
      const random = prng(0xf0a7)
      for (let k = 0; k < 2000; k++) {
        const b = Buffer.from(font)
        for (let i = 0, changes = 1 + Math.floor(random() * 6); i < changes; i++) {
          const at = Math.floor(random() * b.length)
          if (random() < 0.5 && at + 4 <= b.length) b.writeUInt32BE(Math.floor(random() * 0x100000000), at & ~3)
          else b[at] = Math.floor(random() * 256)
        }
        read(b)
      }
    }
    expect(Date.now() - t0).toBeLessThan(20_000)
  })

  it('a character map claiming all of Unicode, many times over, is read within its cap', () => {
    const groups = 5000
    const sub = Buffer.concat([Buffer.from([0, 12, 0, 0]), be32(16 + groups * 12, 0, groups), ...Array.from({ length: groups }, () => be32(0, 0x10ffff, 1))])
    const cmap = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 3, 0, 10]), be32(12), sub])
    const font = Buffer.concat([be32(0x00010000), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from('cmap'), be32(0, 28, cmap.length), cmap])
    const t0 = Date.now()
    const chars = glyphCharacters(font, sfntTables(font, 0))!
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(chars.size).toBeLessThanOrEqual(0x10000)
  })

  it('counts that lie (faces, tables, names) read what is there', () => {
    const ttc = Buffer.concat([Buffer.from('ttcf'), be32(0x00010000, 0xffffffff, 16), be32(0x00010000), Buffer.from([0xff, 0xff, 0, 0, 0, 0, 0, 0])])
    const t0 = Date.now()
    read(ttc)
    expect(sfntFaces(ttc).length).toBeLessThanOrEqual(64)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('a font that is not one, or a font lookup that fails, leaves the text undrawn and the picture whole', () => {
    const emf = new EmfWriter({ width: 100, height: 40 }).stock(4).rectangle(0, 0, 10, 10).font(1, {}).select(1).text(0, 20, 'AB', { options: 0x10, advance: 8 }).bytes()
    const random = prng(7)
    const noise = Buffer.from(Array.from({ length: 4096 }, () => Math.floor(random() * 256)))
    for (const fonts of [new GlyphFonts(() => noise), new GlyphFonts(() => { throw new Error('no fonts here') })]) {
      const r = drawMetafile(emf, { fonts })
      if ('error' in r) throw new Error(r.error)
      expect(r.svg).not.toContain('<text')
    }
  })
})
