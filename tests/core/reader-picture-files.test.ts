import { describe, it, expect } from 'vitest'
import { detect } from '../../src/core/detect'
import { readImage } from '../../src/core/readers/image'
import { readMetafile } from '../../src/core/readers/metafile'
import { readSvg } from '../../src/core/readers/svg'
import { getReader } from '../../src/core/readers'
import { tiffPages } from '../../src/core/picture-headers'
import { pictureMime } from '../../src/core/picture-types'
import { picturePages } from '../../src/core/lone-picture'
import { allowedTargets } from '../../src/core/target-validity'
import { encodePng } from '../../src/core/metafile/png'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { tiff, emf, wmf } from '../../scripts/fixtures/lib-tiff.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { EmfWriter, WmfWriter } from '../../scripts/fixtures/lib-metafile.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { READING_ROOM } from '../../scripts/fixtures/vocabulary.mjs'

/*
 * TIFF, EMF and WMF files opened on their own (added, dropped, given to the
 * CLI), and the other pictures Chromium shows (BMP, AVIF, ICO). Each was
 * read as plain text before and came out as garbage.
 */

const gray = (x: number, y: number): number[] => [(x * 7 + y * 3) % 256, 0, 0]
const page = (width: number, height: number, extra: Record<string, unknown> = {}) => ({ width, height, pixel: gray, kind: 'gray', ...extra })

/** A 24-bit BMP: BITMAPFILEHEADER and a BITMAPINFOHEADER, rows bottom up. */
function bmp(width: number, height: number): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4
  const b = Buffer.alloc(54 + row * height, 0x80)
  b.write('BM', 0, 'latin1')
  b.writeUInt32LE(b.length, 2)
  b.writeUInt32LE(0, 6)
  b.writeUInt32LE(54, 10)
  b.writeUInt32LE(40, 14)
  b.writeInt32LE(width, 18)
  b.writeInt32LE(height, 22)
  b.writeUInt16LE(1, 26)
  b.writeUInt16LE(24, 28)
  b.writeUInt32LE(0, 30)
  return b
}

/** An ICO holding one PNG. */
function ico(width: number, height: number): Buffer {
  const png = encodePng(width, height, new Uint8Array(width * height * 4).fill(200), false)
  const dir = Buffer.alloc(22)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(1, 4)
  dir[6] = width % 256
  dir[7] = height % 256
  dir.writeUInt16LE(1, 10)
  dir.writeUInt16LE(32, 12)
  dir.writeUInt32LE(png.length, 14)
  dir.writeUInt32LE(22, 18)
  return Buffer.concat([dir, png])
}

/** The head of an ISO media file with these brands, and an 'ispe' of this size. */
function isoMedia(major: string, compatible: string[], width = 640, height = 480): Buffer {
  const ftyp = Buffer.alloc(16 + compatible.length * 4)
  ftyp.writeUInt32BE(ftyp.length, 0)
  ftyp.write('ftyp', 4, 'latin1')
  ftyp.write(major, 8, 'latin1')
  compatible.forEach((b, i) => ftyp.write(b, 16 + i * 4, 'latin1'))
  const ispe = Buffer.alloc(20)
  ispe.writeUInt32BE(20, 0)
  ispe.write('ispe', 4, 'latin1')
  ispe.writeUInt32BE(width, 12)
  ispe.writeUInt32BE(height, 16)
  return Buffer.concat([ftyp, Buffer.alloc(24), ispe])
}

/** An EMF holding the reading room plan's labels as text. */
function labeledEmf(): Buffer {
  const e = new EmfWriter({ width: 240, height: 160 })
  e.brush(1, 0, 0x3a6ea5).select(1).rectangle(10, 10, 230, 150)
  e.font(2, { height: -14 }).select(2).setTextColor(0x000000)
  e.text(20, 40, READING_ROOM.labels[0]).text(20, 80, READING_ROOM.labels[3])
  return e.bytes()
}

const srcOf = (html: string): string[] => [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1])
const bytesOf = (src: string): Buffer => Buffer.from(src.split(',')[1], 'base64')

describe('picture files are detected by their bytes and their names', () => {
  it('detects TIFF in either byte order, as .tif, .tiff or with no name', () => {
    const le = tiff(page(8, 8))
    const be = tiff({ ...page(8, 8), bigEndian: true })
    expect(le.toString('latin1', 0, 4)).toBe('II*\0')
    expect(be.toString('latin1', 0, 4)).toBe('MM\0*')
    for (const name of [undefined, 'fax.tif', 'fax.TIFF', 'fax.pdf']) {
      expect(detect(le, name)).toEqual({ kind: 'ok', format: 'image' })
      expect(detect(be, name)).toEqual({ kind: 'ok', format: 'image' })
    }
  })

  it('detects EMF and WMF (placeable or bare) as drawings', () => {
    const files = [emf(), wmf(), wmf({ placeable: false })]
    for (const bytes of files) {
      for (const name of [undefined, 'plan.emf', 'plan.wmf', 'plan.doc']) expect(detect(bytes, name)).toEqual({ kind: 'ok', format: 'metafile' })
    }
  })

  it('believes the bytes over a picture name: a PNG called .emf is an image, an EMF called .png a drawing', () => {
    const png = encodePng(2, 2, new Uint8Array(16), false)
    expect(detect(png, 'plan.emf')).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(emf(), 'plan.png')).toEqual({ kind: 'ok', format: 'metafile' })
    expect(detect(emf(), 'plan.svg')).toEqual({ kind: 'ok', format: 'metafile' })
  })

  it('detects BMP, AVIF and ICO, and not a text file that opens with "BM"', () => {
    expect(detect(bmp(4, 3))).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(isoMedia('avif', ['mif1', 'miaf']))).toEqual({ kind: 'ok', format: 'image' })
    // An AVIF whose major brand is the generic one says so among its compatible brands.
    expect(pictureMime(isoMedia('mif1', ['avif']))).toBe('image/avif')
    expect(detect(ico(16, 16))).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(Buffer.from('BMW club newsletter, spring issue: the meeting moves to Tuesday.'))).toEqual({ kind: 'ok', format: 'txt' })
  })

  it('refuses HEIC by name, since nothing here can decode it', async () => {
    const heic = isoMedia('heic', ['mif1', 'heic'])
    const found = detect(heic)
    expect(found.kind).toBe('unsupported')
    expect(found.kind === 'unsupported' && found.reason).toMatch(/HEIC/)
    // Named .jpg (as phones often send them): the reader says the same.
    await expect(readImage({ bytes: heic, filename: 'photo.jpg' })).rejects.toThrow(/HEIC/)
  })
})

describe('a TIFF file', () => {
  it('is one picture when it is one page, its bytes as they are, sized at its resolution', async () => {
    const bytes = tiff(page(300, 150, { dpi: 150 }))
    const hub = await readImage({ bytes, filename: 'scan.tif' })
    const srcs = srcOf(hub.html)
    expect(srcs).toHaveLength(1)
    expect(srcs[0].startsWith('data:image/tiff;base64,')).toBe(true)
    expect(bytesOf(srcs[0]).equals(bytes)).toBe(true)
    expect(hub.html).toContain('alt="scan.tif"')
    // 300 px at 150 dpi is two inches: 192 CSS px.
    expect(hub.html).toContain('width="192" height="96"')
    expect(hub.html).not.toContain('<hr')
    expect(hub.title).toBe('scan.tif')
  })

  it('is a picture a page when it has several, in order, a rule between each two, previews left out', async () => {
    const bytes = tiff({ pages: [page(40, 50), { ...page(10, 12), thumbnail: true }, page(41, 51), { ...page(42, 52), kind: 'bilevel', compression: 'packbits' }] })
    const hub = await readImage({ bytes, filename: 'lease.tiff' })
    const srcs = srcOf(hub.html)
    expect(srcs).toHaveLength(3)
    // Each page a one-page TIFF of its own, so Word still keeps each as it is.
    expect(srcs.map((s) => tiffPages(bytesOf(s))?.map((p) => [p.index, p.width]))).toEqual([[[0, 40]], [[0, 41]], [[0, 42]]])
    expect([...hub.html.matchAll(/alt="([^"]*)"/g)].map((m) => m[1])).toEqual([
      'lease.tiff (page 1 of 3)',
      'lease.tiff (page 2 of 3)',
      'lease.tiff (page 3 of 3)',
    ])
    expect(hub.html.match(/<hr>/g)).toHaveLength(2)
    // A picture a page: printed each filling a page of its own (lone-picture.ts).
    expect(picturePages(hub.html)?.sizes).toHaveLength(3)
  })

})

describe('BMP, AVIF and ICO files', () => {
  it('are each one picture of their own type', async () => {
    for (const [bytes, mime] of [[bmp(4, 3), 'image/bmp'], [isoMedia('avif', ['mif1']), 'image/avif'], [ico(16, 16), 'image/x-icon']] as const) {
      const hub = await readImage({ bytes, filename: 'picture' })
      expect(srcOf(hub.html)).toEqual([`data:${mime};base64,${bytes.toString('base64')}`])
    }
  })
})

describe('an EMF or WMF file', () => {
  it('is a drawing: the file kept as it is, at the size its frame gives, its text as alt text', async () => {
    const bytes = labeledEmf()
    const hub = await getReader('metafile')({ bytes, filename: 'plan.emf' })
    const srcs = srcOf(hub.html)
    expect(srcs).toHaveLength(1)
    expect(srcs[0].startsWith('data:image/x-emf;base64,')).toBe(true)
    expect(bytesOf(srcs[0]).equals(bytes)).toBe(true)
    expect(hub.html).toContain('width="240" height="160"')
    expect(hub.html).toContain(`alt="${READING_ROOM.labels[0]} ${READING_ROOM.labels[3]}"`)
    expect(hub.title).toBe('plan.emf')
  })

  it('is named by its file when it holds no text', async () => {
    const hub = await readMetafile({ bytes: emf({ width: 64, height: 48 }), filename: 'box.emf' })
    expect(hub.html).toMatch(/^<img src="data:image\/x-emf;base64,[^"]+" alt="box\.emf" width="64" height="48">$/)
  })

  it('reads a WMF with a placeable header at its size, and a bare one at the size it is drawn', async () => {
    const w = new WmfWriter({ width: 200, height: 80 })
    w.brush(0, 0x3a6ea5).select(0).rectangle(4, 4, 196, 76)
    w.font({ height: -16 }).select(1).textOut(10, 40, READING_ROOM.labels[1])
    const placeable = await readMetafile({ bytes: w.bytes(), filename: 'label.wmf' })
    expect(placeable.html).toContain('data:image/x-wmf;base64,')
    expect(placeable.html).toContain('width="200" height="80"')
    expect(placeable.html).toContain(`alt="${READING_ROOM.labels[1]}"`)
    const bare = await readMetafile({ bytes: wmf({ width: 64, height: 48, placeable: false }), filename: 'bare.wmf' })
    expect(bare.html).toContain('data:image/x-wmf;base64,')
    expect(bare.html).toMatch(/width="\d+" height="\d+"/)
  })

  it('goes where an SVG goes: no Embed/OCR choice, no text or table targets', () => {
    expect(allowedTargets([{ format: 'metafile', imageMode: 'ocr' }])).toEqual(allowedTargets([{ format: 'svg' }]))
  })

  it('is read as the picture it is under another picture name', async () => {
    expect(srcOf((await readSvg({ bytes: emf(), filename: 'plan.svg' })).html)[0]).toMatch(/^data:image\/x-emf;/)
    expect(srcOf((await readImage({ bytes: wmf(), filename: 'plan.png' })).html)[0]).toMatch(/^data:image\/x-wmf;/)
    const png = encodePng(2, 2, new Uint8Array(16), false)
    expect(srcOf((await readMetafile({ bytes: png, filename: 'plan.emf' })).html)[0]).toMatch(/^data:image\/png;/)
  })

  it('refuses a file that only starts like one and has nothing to draw or to size it by', async () => {
    const junk = Buffer.concat([wmf({ placeable: false }).subarray(0, 18), Buffer.alloc(40, 0xff)])
    expect(detect(junk, 'junk.wmf')).toEqual({ kind: 'ok', format: 'metafile' })
    await expect(readMetafile({ bytes: junk, filename: 'junk.wmf' })).rejects.toMatchObject({ code: 'image-unsupported' })
  })
})
