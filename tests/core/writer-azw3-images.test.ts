import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { initKf8File } from '../kf8-reader.mjs'
import { writeAzw3 } from '../../src/core/writers/azw3'
import { kindlePictures, KINDLE_IMAGE_MAX_BYTES, pictureMime, storableAsIs } from '../../src/core/kindle-pictures'
import { createConverter } from '../../src/core/convert'
import type { RenderBlocks, RenderRequest, RenderResult } from '../../src/core/rendered-blocks'
// @ts-expect-error: a plain .mjs fixture library, no types.
import { emf, tiff as makeTiff } from '../../scripts/fixtures/lib-tiff.mjs'

/*
 * Pictures in AZW3 (KF8). Read back two ways: our own record-level parse of
 * the PalmDB (record 0's first-resource index, EXTH 125/201/202, each image
 * record's bytes) and the independent @lingo-reader/mobi-parser, which
 * resolves every kindle:embed reference to a file it writes out.
 */

// ---------------------------------------------------------------------------
// Pictures, made here rather than committed.

function canvasPicture(width: number, height: number, draw?: (g: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void) {
  const c = createCanvas(width, height)
  const g = c.getContext('2d')
  g.fillStyle = '#3a6ea5'
  g.fillRect(0, 0, width, height)
  g.fillStyle = '#f2c14e'
  g.fillRect(width / 4, height / 4, width / 2, height / 2)
  draw?.(g)
  return c
}
const png = (w = 40, h = 30) => Buffer.from(canvasPicture(w, h).toBuffer('image/png'))
const jpeg = (w = 40, h = 30) => Buffer.from(canvasPicture(w, h).toBuffer('image/jpeg', 90))
const webp = (w = 40, h = 30) => Buffer.from(canvasPicture(w, h).toBuffer('image/webp'))
/** Random noise does not compress: a PNG of it is about 3 bytes a pixel. */
function noisePng(width: number, height: number): Buffer {
  const c = createCanvas(width, height)
  const g = c.getContext('2d')
  const data = g.createImageData(width, height)
  const noise = randomBytes(width * height * 3)
  for (let i = 0, j = 0; i < data.data.length; i += 4, j += 3) {
    data.data[i] = noise[j]
    data.data[i + 1] = noise[j + 1]
    data.data[i + 2] = noise[j + 2]
    data.data[i + 3] = 255
  }
  g.putImageData(data, 0, 0)
  return Buffer.from(c.toBuffer('image/png'))
}
/** A 2x2 24-bit BMP, written by hand: no encoder for it here. */
function bmp(): Buffer {
  const b = Buffer.alloc(54 + 16)
  b.write('BM', 0, 'latin1')
  b.writeUInt32LE(b.length, 2)
  b.writeUInt32LE(54, 10)
  b.writeUInt32LE(40, 14)
  b.writeInt32LE(2, 18)
  b.writeInt32LE(2, 22)
  b.writeUInt16LE(1, 26)
  b.writeUInt16LE(24, 28)
  b.writeUInt32LE(16, 34)
  b.fill(0x80, 54)
  return b
}
/** A TIFF header and nothing a decoder can use. */
const TIFF = Buffer.from('49492a000800000000000000', 'hex')
/** A real TIFF (LZW, as scanners write), and a big-endian one. */
const tiffPicture = (bigEndian = false): Buffer =>
  makeTiff({ width: 40, height: 30, pixel: (x: number, y: number) => [x * 6, y * 8, 128], compression: 'lzw', bigEndian })
/** Word's vector picture format, which nothing here draws. */
const EMF: Buffer = emf()

const uri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`
const imgTag = (mime: string, bytes: Buffer, attrs = 'alt="picture"') => `<img src="${uri(mime, bytes)}" ${attrs}>`

// ---------------------------------------------------------------------------
// Reading the file back at record level.

interface Book {
  records: Buffer[]
  firstResource: number
  exth: Map<number, Buffer[]>
  text: string
  resources: Buffer[]
}

function parseBook(file: Buffer): Book {
  const count = file.readUInt16BE(76)
  const offsets = Array.from({ length: count }, (_, i) => file.readUInt32BE(78 + i * 8))
  const records = offsets.map((o, i) => file.subarray(o, i + 1 < count ? offsets[i + 1] : file.length))
  const r0 = records[0]
  const textLength = r0.readUInt32BE(4)
  const textCount = r0.readUInt16BE(8)
  const firstResource = r0.readUInt32BE(16 + 92)
  const exth = new Map<number, Buffer[]>()
  const mobiLength = r0.readUInt32BE(16 + 4)
  let at = 16 + mobiLength
  expect(r0.toString('latin1', at, at + 4)).toBe('EXTH')
  const n = r0.readUInt32BE(at + 8)
  at += 12
  for (let i = 0; i < n; i++) {
    const type = r0.readUInt32BE(at)
    const len = r0.readUInt32BE(at + 4)
    exth.set(type, [...(exth.get(type) ?? []), r0.subarray(at + 8, at + len)])
    at += len
  }
  const text = Buffer.concat(records.slice(1, 1 + textCount)).subarray(0, textLength).toString('utf8')
  const resources: Buffer[] = []
  if (firstResource !== 0xffffffff) {
    // EXTH 125 says how many resource records there are.
    const count = exth.get(125)![0].readUInt32BE(0)
    resources.push(...records.slice(firstResource, firstResource + count))
    // Nothing follows them but the end-of-file record.
    expect(records.length).toBe(firstResource + count + 1)
  }
  return { records, firstResource, exth, text, resources }
}

const exthUint = (book: Book, type: number): number | undefined => book.exth.get(type)?.[0]?.readUInt32BE(0)

function sniff(bytes: Buffer): string {
  if (bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  if (bytes.toString('latin1', 0, 4) === 'GIF8') return 'gif'
  return 'other'
}

/** The kindle:embed references in the text, as resource indices (1-based, base 32). */
function embeds(text: string): Array<{ index: number; mime: string }> {
  return [...text.matchAll(/kindle:embed:([0-9A-V]{4})\?mime=(image\/[a-z+.-]+)/g)].map((m) => ({
    index: Number.parseInt(m[1], 32),
    mime: m[2],
  }))
}

async function readBack(bytes: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'azw3-img-'))
  const file = join(dir, 'book.azw3')
  writeFileSync(file, bytes)
  return initKf8File(file, dir)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the AZW3 end-of-file record', () => {
  it("is kindlegen's E9 8E 0D 0A, with pictures and without", async () => {
    for (const html of ['<h1>One</h1><p>Text.</p>', `<h1>One</h1><p>${imgTag('image/png', png())}</p>`]) {
      const book = parseBook(await writeAzw3({ html, title: 'T' }))
      expect(book.records[book.records.length - 1].toString('hex')).toBe('e98e0d0a')
    }
  })
})

describe('AZW3 pictures (KF8 image records)', () => {
  it('stores each picture as an image record after the text and indices, and says where they start', async () => {
    const a = png()
    const b = jpeg()
    const out = await writeAzw3({ html: `<h1>One</h1><p>${imgTag('image/png', a)}</p><h1>Two</h1><p>${imgTag('image/jpeg', b)}</p>`, title: 'T' })
    const book = parseBook(out)
    expect(book.firstResource).toBeGreaterThan(book.records[0].readUInt16BE(8))
    // Both pictures, unchanged, and nothing else but the cover's thumbnail.
    expect(book.resources[0].equals(a)).toBe(true)
    expect(book.resources[1].equals(b)).toBe(true)
    expect(exthUint(book, 125)).toBe(book.resources.length)
    // Every record before the first resource is text or an index, none a picture.
    for (const r of book.records.slice(1, book.firstResource)) expect(sniff(r)).toBe('other')
  })

  it('points every <img> at its record with kindle:embed, which an independent reader resolves', async () => {
    const a = png(41, 31)
    const b = jpeg(42, 32)
    const out = await writeAzw3({ html: `<h1>One</h1><p>${imgTag('image/png', a)}</p><h1>Two</h1><p>${imgTag('image/jpeg', b)}${imgTag('image/png', a)}</p>`, title: 'T' })
    const book = parseBook(out)
    expect(book.text).not.toContain('data:image')
    expect(book.text).not.toContain('images/')
    const refs = embeds(book.text)
    expect(refs).toEqual([
      { index: 1, mime: 'image/png' },
      { index: 2, mime: 'image/jpeg' },
      // The same picture twice is stored once.
      { index: 1, mime: 'image/png' },
    ])
    for (const ref of refs) expect(sniff(book.resources[ref.index - 1])).toBe(ref.mime.slice(6))

    const kf8 = await readBack(out)
    const spine = kf8.getSpine()
    const second = kf8.loadChapter(spine[1].id)!
    const srcs = [...second.html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1])
    expect(srcs).toHaveLength(2)
    expect(readFileSync(srcs[0]).equals(b)).toBe(true)
    expect(readFileSync(srcs[1]).equals(a)).toBe(true)
  })

  it('gives an independent reader every one of 40 pictures, in order', async () => {
    // Past the 32nd ("0010" in base 32), where mobi-parser on its own
    // (base 36) loads the wrong record; read through tests/kf8-reader.mjs.
    const pictures = Array.from({ length: 40 }, (_, i) => png(10 + i, 12))
    const out = await writeAzw3({ html: `<h1>Many</h1>${pictures.map((p) => `<p>${imgTag('image/png', p)}</p>`).join('')}`, title: 'T' })
    const kf8 = await readBack(out)
    const srcs = kf8.getSpine().flatMap((item) => [...kf8.loadChapter(item.id)!.html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]))
    expect(srcs).toHaveLength(40)
    srcs.forEach((src, i) => expect(readFileSync(src).equals(pictures[i]), `picture ${i + 1}`).toBe(true))
  })

  it('numbers kindle:embed in base 32, past the single digits', async () => {
    // Checked on the bytes as well, so the reader's own fix-up is not the
    // only judge: from 32 pictures on ("0010") base 32 and 36 disagree.
    const pictures = Array.from({ length: 35 }, (_, i) => png(10 + i, 10))
    const book = parseBook(await writeAzw3({ html: pictures.map((p) => `<p>${imgTag('image/png', p)}</p>`).join(''), title: 'T' }))
    const ids = [...book.text.matchAll(/kindle:embed:([0-9A-V]{4})/g)].map((m) => m[1])
    expect(ids.slice(30)).toEqual(['000V', '0010', '0011', '0012', '0013'])
    embeds(book.text).forEach((ref, i) => expect(book.resources[ref.index - 1].equals(pictures[i])).toBe(true))
  })

  it('names the first picture the cover (EXTH 201), and makes no thumbnail', async () => {
    const photo = jpeg(600, 800)
    const out = await writeAzw3({ html: `<p>${imgTag('image/jpeg', photo)}</p><p>Words.</p>`, title: 'T' })
    const book = parseBook(out)
    expect(exthUint(book, 201)).toBe(0)
    expect(exthUint(book, 203)).toBe(0)
    expect(book.exth.has(202)).toBe(false)
    expect(book.resources).toHaveLength(1)
    expect(book.resources[0].equals(photo)).toBe(true)
  })

  it('without a renderer, gives a picture it cannot store (WebP, TIFF, over the limit) as its alt text', async () => {
    const big = noisePng(1500, 1300)
    expect(big.length).toBeGreaterThan(KINDLE_IMAGE_MAX_BYTES)
    const html =
      `<p>Before ${imgTag('image/webp', webp(), 'alt="Media shelves"')} and ${imgTag('image/tiff', TIFF, 'alt="Bridge survey"')}</p>` +
      `${imgTag('image/png', big, 'alt="Noise"')}`
    const book = parseBook(await writeAzw3({ html, title: 'T' }))
    expect(book.firstResource).toBe(0xffffffff)
    expect(book.text).toContain('[image: Media shelves]')
    expect(book.text).toContain('[image: Bridge survey]')
    expect(book.text).toContain('[image: Noise]')
    expect(book.text).not.toContain('<img')
  }, 30_000)

  it('an <img> that points at no data (a path that resolved to nothing) becomes its alt text', async () => {
    const book = parseBook(await writeAzw3({ html: '<p>See <img src="images/missing-figure.png" alt="Missing figure"> here</p>', title: 'T' }))
    expect(book.text).toContain('[image: Missing figure]')
    expect(book.text).not.toContain('<img')
  })

  it('an SVG image that reaches the writer (no renderer) becomes its alt text', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
    const out = await writeAzw3({ html: `<p>${imgTag('image/svg+xml', svg, 'alt="Floor plan"')}</p>`, title: 'T' })
    const book = parseBook(out)
    expect(book.text).toContain('[image: Floor plan]')
    expect(book.text).not.toContain('svg')
  })

  it('tells the types apart by their bytes, not by what they claim', () => {
    expect(pictureMime(png())).toBe('image/png')
    expect(pictureMime(webp())).toBe('image/webp')
    expect(pictureMime(bmp())).toBe('image/bmp')
    expect(pictureMime(TIFF)).toBe('image/tiff')
    expect(pictureMime(tiffPicture())).toBe('image/tiff')
    expect(pictureMime(tiffPicture(true))).toBe('image/tiff')
    expect(pictureMime(EMF)).toBeNull()
    expect(storableAsIs(tiffPicture())).toBe(false)
    expect(storableAsIs(png())).toBe(true)
    expect(storableAsIs(webp())).toBe(false)
    expect(storableAsIs(png(), 10)).toBe(false)
  })

  it('a book with no pictures is byte for byte what it was before pictures were stored', async () => {
    // Golden hash of the writer's output before pictures were stored (as of
    // "Make Kindle (AZW3) books open in calibre"), with its two varying
    // inputs (the clock and the random unique id) held still. Updated once
    // since, when the stylesheet became the book's second flow ("Colour code
    // in EPUB and Kindle books"); before that, style.css never reached it.
    vi.useFakeTimers({ now: new Date('2026-01-02T03:04:05Z'), toFake: ['Date'] })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const bytes = await writeAzw3({
      html: '<h1>Chapter One</h1><p>The first chapter body.</p><h1>Chapter Two</h1><p>Second &amp; last.</p><table><tr><td>a</td></tr></table>',
      title: 'Golden',
    })
    expect(bytes.length).toBe(2145)
    expect(bytes.subarray(-4).toString('hex')).toBe('e98e0d0a')
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('8d94a5fc1d4939ecadf2198a503c303bcd5ad0a6f3e83ff8875614509a36308f')
  })
})

// ---------------------------------------------------------------------------
// Through the converter: diagrams and SVG images arrive as PNG.

const DIAGRAM_PNG = png(200, 100).toString('base64')
const RASTER_PNG = png(48, 48).toString('base64')

function fakeRenderer(): { render: RenderBlocks; kinds: string[] } {
  const kinds: string[] = []
  const render: RenderBlocks = async (requests) =>
    requests.map((r): RenderResult => {
      kinds.push(`${r.kind}:${r.format}`)
      return r.kind === 'svg' ? { png: RASTER_PNG, width: 24, height: 24 } : { png: DIAGRAM_PNG, width: 200, height: 100 }
    })
  return { render, kinds }
}

const pdf = async () => Buffer.from('%PDF-1.4')

describe('AZW3 through the converter', () => {
  it('draws a Mermaid diagram as a PNG picture, and an SVG image gets a PNG copy', async () => {
    const { render, kinds } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10"/></svg>')
    const page = Buffer.from(
      `<h1>Plan</h1><pre><code class="language-mermaid">flowchart TD\n  A --&gt; B</code></pre><p>${imgTag('image/svg+xml', svg, 'alt="Marker"')}</p>`,
    )
    const out = await conv.convert({ bytes: page, filename: 'plan.html' }, 'html', 'azw3', { renderedFormat: 'svg' })
    expect(kinds).toEqual(['mermaid:png', 'svg:png'])
    const book = parseBook(out.parts[0].bytes)
    const refs = embeds(book.text)
    expect(refs.map((r) => r.mime)).toEqual(['image/png', 'image/png'])
    expect(book.resources[refs[0].index - 1].toString('base64')).toBe(DIAGRAM_PNG)
    expect(book.resources[refs[1].index - 1].toString('base64')).toBe(RASTER_PNG)
    expect(book.text).not.toContain('language-mermaid')
    expect(book.text).not.toContain('svg+xml')
    // The diagram is never the cover; the picture the document carries is.
    expect(exthUint(book, 201)).toBe(refs[1].index - 1)
  })

  it('a book whose only picture is a drawn diagram has no cover', async () => {
    const { render } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const md = Buffer.from('# Plan\n\n```mermaid\nflowchart TD\n  A --> B\n```\n')
    const out = await conv.convert({ bytes: md, filename: 'plan.md' }, 'md', 'azw3')
    const book = parseBook(out.parts[0].bytes)
    expect(embeds(book.text)).toHaveLength(1)
    expect(book.exth.has(201)).toBe(false)
    expect(book.exth.has(202)).toBe(false)
  })

  it('re-encodes WebP, BMP and an oversize picture in the render host, and stores what it answers', async () => {
    const calls: RenderRequest[] = []
    const JPEG = jpeg(30, 20).toString('base64')
    const PNG_OUT = png(30, 20).toString('base64')
    const render: RenderBlocks = async (requests) =>
      requests.map((r): RenderResult => {
        calls.push(r)
        return r.source.startsWith('data:image/bmp') ? { png: PNG_OUT, width: 30, height: 20 } : { jpeg: JPEG, width: 30, height: 20 }
      })
    const conv = createConverter(pdf, { renderBlocks: render })
    const big = noisePng(1500, 1300)
    const kept = png(41, 31)
    // Two TIFFs, one labelled as a PNG: the bytes say what a picture is.
    const scan = tiffPicture(true)
    const page = Buffer.from(
      `<p>${imgTag('image/webp', webp())}${imgTag('image/bmp', bmp())}${imgTag('image/png', big)}${imgTag('image/png', kept)}` +
        `${imgTag('image/tiff', tiffPicture())}${imgTag('image/png', scan)}</p>`,
    )
    const out = await conv.convert({ bytes: page, filename: 'p.html' }, 'html', 'azw3')
    expect(calls.map((c) => [c.kind, c.source.slice(0, 15), c.fit])).toEqual([
      ['picture', 'data:image/webp', { maxBytes: KINDLE_IMAGE_MAX_BYTES }],
      ['picture', 'data:image/bmp;', { maxBytes: KINDLE_IMAGE_MAX_BYTES }],
      ['picture', 'data:image/png;', { maxBytes: KINDLE_IMAGE_MAX_BYTES }],
      ['picture', 'data:image/tiff', { maxBytes: KINDLE_IMAGE_MAX_BYTES }],
      ['picture', 'data:image/tiff', { maxBytes: KINDLE_IMAGE_MAX_BYTES }],
    ])
    expect(calls[4].source).toBe(`data:image/tiff;base64,${scan.toString('base64')}`)
    expect(calls[3].source).toBe(`data:image/tiff;base64,${tiffPicture().toString('base64')}`)
    const book = parseBook(out.parts[0].bytes)
    const refs = embeds(book.text)
    expect(refs.map((r) => r.mime)).toEqual(['image/jpeg', 'image/png', 'image/jpeg', 'image/png', 'image/jpeg', 'image/jpeg'])
    expect(book.resources.map((r) => r.toString('base64'))).toEqual([JPEG, PNG_OUT, kept.toString('base64')])
  }, 30_000)

  it('a picture nothing can decode, or the host refuses, becomes its alt text with a notice', async () => {
    const render: RenderBlocks = async (requests) => requests.map(() => ({ error: 'the picture could not be decoded' }))
    const conv = createConverter(pdf, { renderBlocks: render })
    const notices: string[] = []
    const page = Buffer.from(
      `<p>${imgTag('image/x-emf', EMF, 'alt="Bridge survey"')}</p><p>${imgTag('image/webp', webp(), 'alt="Media shelves"')}</p>` +
        `<p>${imgTag('image/tiff', TIFF, 'alt="Empty scan"')}</p>`,
    )
    const out = await conv.convert({ bytes: page, filename: 'p.html' }, 'html', 'azw3', undefined, {
      onAdvice: (_kind, message) => notices.push(message),
    })
    const book = parseBook(out.parts[0].bytes)
    expect(book.text).toContain('[image: Bridge survey]')
    expect(book.text).toContain('[image: Media shelves]')
    expect(book.text).toContain('[image: Empty scan]')
    expect(notices).toEqual([
      'Picture 1 could not be stored for Kindle: a Kindle cannot show EMF pictures',
      'Picture 2 could not be stored for Kindle: the picture could not be decoded',
      'Picture 3 could not be stored for Kindle: the picture could not be decoded',
    ])
  })

  it('asks nothing for other targets, or when every picture can be stored as it is', async () => {
    const render = vi.fn<RenderBlocks>(async () => [])
    const html = `<p>${imgTag('image/webp', webp())}</p>`
    expect(await kindlePictures(html, 'epub', { renderBlocks: render })).toBe(html)
    const fine = `<p>${imgTag('image/png', png())}${imgTag('image/jpeg', jpeg())}</p>`
    expect(await kindlePictures(fine, 'azw3', { renderBlocks: render })).toBe(fine)
    expect(render).not.toHaveBeenCalled()
  })
})
