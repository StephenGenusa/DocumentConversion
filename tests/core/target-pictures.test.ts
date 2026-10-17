import { describe, it, expect, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { KINDLE_IMAGE_MAX_BYTES, targetPictures, pictureType, vectorMime } from '../../src/core/pictures'
import { MAX_FETCHED_IMAGE_BYTES } from '../../src/core/inline-images'
import { tiffPages } from '../../src/core/picture-headers'
import { createConverter } from '../../src/core/convert'
import type { RenderBlocks, RenderRequest, RenderResult } from '../../src/core/rendered-blocks'
import type { TargetFormat } from '../../src/core/types'
// @ts-expect-error: a plain .mjs fixture library, no types.
import { emf, tiff as makeTiff } from '../../scripts/fixtures/lib-tiff.mjs'
// @ts-expect-error: a plain .mjs fixture library, no types.
import { scanEmf } from '../../scripts/fixtures/metafile-corpus.mjs'

/*
 * The one picture step every writer gets (pictures.ts): what each target
 * holds stays as it is, the rest is converted in the render host (PNG
 * unless JPEG is chosen), and what nothing converts becomes its alt text.
 */

function canvasPicture(width: number, height: number) {
  const c = createCanvas(width, height)
  const g = c.getContext('2d')
  g.fillStyle = '#3a6ea5'
  g.fillRect(0, 0, width, height)
  return c
}
const png = () => Buffer.from(canvasPicture(20, 10).toBuffer('image/png'))
const jpeg = () => Buffer.from(canvasPicture(20, 10).toBuffer('image/jpeg', 90))
const webp = () => Buffer.from(canvasPicture(20, 10).toBuffer('image/webp'))
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
  return b
}
const TIFF: Buffer = makeTiff({ width: 30, height: 20, pixel: (x: number) => [x * 8, 90, 40], compression: 'lzw' })
const EMF: Buffer = emf()
/** A WMF with the Aldus placeable header, then the metafile header. */
function wmf(): Buffer {
  const b = Buffer.alloc(22 + 18 + 6)
  b.writeUInt32LE(0x9ac6cdd7, 0)
  b.writeInt16LE(0, 6)
  b.writeInt16LE(0, 8)
  b.writeInt16LE(1440, 10)
  b.writeInt16LE(720, 12)
  b.writeUInt16LE(1440, 14)
  b.writeUInt16LE(1, 22)
  b.writeUInt16LE(9, 24)
  b.writeUInt16LE(0x300, 26)
  return b
}

const uri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`
const img = (mime: string, bytes: Buffer, alt = 'picture') => `<img src="${uri(mime, bytes)}" alt="${alt}">`
const OUT_PNG = png().toString('base64')
const OUT_JPEG = jpeg().toString('base64')

function host(): { render: RenderBlocks; calls: RenderRequest[] } {
  const calls: RenderRequest[] = []
  const render: RenderBlocks = async (requests) =>
    requests.map((r): RenderResult => {
      calls.push(r)
      return r.fit?.as === 'jpeg' ? { jpeg: OUT_JPEG, width: 20, height: 10 } : { png: OUT_PNG, width: 20, height: 10 }
    })
  return { render, calls }
}

/** The declared types of the pictures left in the HTML, in order. */
const types = (html: string): string[] => [...html.matchAll(/src="data:(image\/[\w.+-]+);/g)].map((m) => m[1])

describe('targetPictures: what each target holds', () => {
  const every = `<p>${img('image/png', png())}${img('image/jpeg', jpeg())}${img('image/webp', webp())}${img('image/bmp', bmp())}${img('image/tiff', TIFF)}</p>`

  it.each<[TargetFormat, string[], string[]]>([
    // target, kept (by declared type), converted (by source type)
    ['html', ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'], ['image/tiff']],
    ['revealjs', ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'], ['image/tiff']],
    ['pdf', ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'], ['image/tiff']],
    ['azw4', ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'], ['image/tiff']],
    ['epub', ['image/png', 'image/jpeg', 'image/webp'], ['image/bmp', 'image/tiff']],
    ['md', ['image/png', 'image/jpeg', 'image/webp'], ['image/bmp', 'image/tiff']],
    ['azw3', ['image/png', 'image/jpeg'], ['image/webp', 'image/bmp', 'image/tiff']],
    // Word shows TIFF itself: kept as it is (writer-docx-images.test.ts).
    ['docx', ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/tiff'], []],
  ])('%s keeps %j and converts %j, Automatic unless chosen', async (target, kept, converted) => {
    const { render, calls } = host()
    const out = await targetPictures(every, target, { renderBlocks: render })
    expect(calls.map((c) => /^data:(image\/[\w.+-]+);/.exec(c.source)?.[1])).toEqual(converted)
    if (converted.length === 0) expect(out).toBe(every)
    expect(calls.every((c) => c.kind === 'picture' && c.fit?.as === 'auto')).toBe(true)
    // Converted pictures stand where they stood, as the host answered (PNG here).
    const order = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/tiff']
    expect(types(out)).toEqual(order.map((t) => (kept.includes(t) ? t : 'image/png')))
  })

  it('converts to JPEG when that is the picture format chosen', async () => {
    const { render, calls } = host()
    const out = await targetPictures(`<p>${img('image/tiff', TIFF)}</p>`, 'pdf', { renderBlocks: render, pictureFormat: 'jpeg' })
    expect(calls.map((c) => c.fit)).toEqual([{ maxBytes: expect.any(Number), as: 'jpeg' }])
    expect(types(out)).toEqual(['image/jpeg'])
  })

  it('leaves the choice to the render host, by the pixels, when the picture format is Automatic', async () => {
    const { render, calls } = host()
    await targetPictures(`<p>${img('image/tiff', TIFF)}</p>`, 'pdf', { renderBlocks: render, pictureFormat: 'auto' })
    expect(calls.map((c) => c.fit)).toEqual([{ maxBytes: expect.any(Number), as: 'auto' }])
  })

  it('the format is passed from the conversion options', async () => {
    const { render, calls } = host()
    const conv = createConverter(async () => Buffer.from('%PDF-1.4'), { renderBlocks: render })
    await conv.convert({ bytes: Buffer.from(`<p>${img('image/tiff', TIFF)}</p>`), filename: 'a.html' }, 'html', 'html', { pictureFormat: 'jpeg' })
    await conv.convert({ bytes: Buffer.from(`<p>${img('image/tiff', TIFF)}</p>`), filename: 'a.html' }, 'html', 'epub')
    expect(calls.map((c) => c.fit?.as)).toEqual(['jpeg', 'auto'])
  })

  it('tells TIFF, EMF and WMF by their bytes, whatever they claim', async () => {
    expect(pictureType(TIFF)).toBe('image/tiff')
    expect(pictureType(EMF)).toBe('image/x-emf')
    expect(pictureType(wmf())).toBe('image/x-wmf')
    expect(vectorMime(png())).toBeNull()
    const { render, calls } = host()
    await targetPictures(`<p>${img('image/png', TIFF)}</p>`, 'html', { renderBlocks: render })
    expect(calls[0].source.startsWith('data:image/tiff;base64,')).toBe(true)
  })

  it('EMF and WMF are drawn as SVG where SVG images stay SVG; one that draws nothing is its alt text, with a notice', async () => {
    for (const target of ['html', 'pdf', 'epub', 'md', 'azw4', 'revealjs'] as TargetFormat[]) {
      const { render, calls } = host()
      const notices: string[] = []
      // The WMF here is a bare header with no records: it draws nothing.
      const out = await targetPictures(`<p>${img('image/x-emf', EMF, 'Site plan')} and ${img('image/x-wmf', wmf(), 'Logo')}</p>`, target, {
        renderBlocks: render,
        onAdvice: (_k, m) => notices.push(m),
      })
      expect(calls).toHaveLength(0)
      expect(types(out)).toEqual(['image/svg+xml'])
      expect(out).toMatch(/<img src="data:image\/svg\+xml;base64,[^"]+" alt="Site plan" width="64" height="48">/)
      expect(out).toContain('[image: Logo]')
      expect(notices).toEqual([expect.stringMatching(/^Picture 2 could not be stored for .+: the WMF picture could not be drawn: it draws nothing this app can show$/)])
    }
  })

  it('EMF and WMF become PNG where SVG images do (Kindle): the drawing rasterized by the render host, at the size it is shown', async () => {
    const { render, calls } = host()
    const out = await targetPictures(`<p>${img('image/x-emf', EMF, 'Site plan')}</p>`, 'azw3', { renderBlocks: render })
    expect(calls.map((c) => [c.kind, c.format])).toEqual([['svg', 'png']])
    expect(calls[0].source).toMatch(/^<svg[^>]* width="64" height="48"/)
    expect(out).toBe(`<p><img src="data:image/png;base64,${OUT_PNG}" alt="Site plan" width="64" height="48"></p>`)
    // Without a renderer there is nothing to rasterize with.
    const notices: string[] = []
    const alone = await targetPictures(`<p>${img('image/x-emf', EMF, 'Site plan')}</p>`, 'azw3', { onAdvice: (_k, m) => notices.push(m) })
    expect(alone).toContain('[image: Site plan]')
    expect(notices).toEqual(['Picture 1 could not be stored for Kindle: EMF pictures are not converted'])
  })

  it('a metafile that is one bitmap becomes that bitmap, at the size the metafile is shown, for every target but Word', async () => {
    const scan: Buffer = scanEmf()
    for (const target of ['html', 'pdf', 'epub', 'md', 'azw3', 'azw4', 'revealjs'] as TargetFormat[]) {
      const { render, calls } = host()
      const out = await targetPictures(`<p>${img('image/x-emf', scan, 'Pasted photograph')}</p>`, target, { renderBlocks: render })
      expect(calls, target).toHaveLength(0)
      expect(out, target).toMatch(/^<p><img src="data:image\/png;base64,[^"]+" alt="Pasted photograph" width="200" height="150"><\/p>$/)
    }
    const word = await targetPictures(`<p>${img('image/x-emf', scan, 'Pasted photograph')}</p>`, 'docx', {})
    expect(types(word)).toEqual(['image/x-emf'])
  })

  it('without a renderer, a TIFF a target cannot hold becomes its alt text with a notice', async () => {
    const notices: string[] = []
    const out = await targetPictures(`<p>${img('image/tiff', TIFF, 'Survey scan')}</p>`, 'pdf', { onAdvice: (_k, m) => notices.push(m) })
    expect(out).toContain('[image: Survey scan]')
    expect(notices).toEqual(['Picture 1 could not be stored for PDF: TIFF pictures are not converted'])
  })

  it('an unrecognized picture is kept in a web page or Markdown, described in a PDF or EPUB', async () => {
    const odd = `<p>${img('image/heic', Buffer.from('not a picture this app knows'), 'Odd')}</p>`
    const render = vi.fn<RenderBlocks>(async () => [])
    expect(await targetPictures(odd, 'html', { renderBlocks: render })).toBe(odd)
    expect(await targetPictures(odd, 'md', { renderBlocks: render })).toBe(odd)
    expect(await targetPictures(odd, 'pdf', { renderBlocks: render })).toContain('[image: Odd]')
    expect(await targetPictures(odd, 'epub', { renderBlocks: render })).toContain('[image: Odd]')
    expect(render).not.toHaveBeenCalled()
  })

  it('asks nothing for a target with no pictures, or when every picture is held', async () => {
    const render = vi.fn<RenderBlocks>(async () => [])
    const html = `<p>${img('image/tiff', TIFF)}</p>`
    expect(await targetPictures(html, 'txt', { renderBlocks: render })).toBe(html)
    const fine = `<p>${img('image/png', png())}${img('image/webp', webp())}</p>`
    expect(await targetPictures(fine, 'pdf', { renderBlocks: render })).toBe(fine)
    expect(render).not.toHaveBeenCalled()
  })

  it('a multi-page TIFF becomes one picture per page, in order, where it stood, alt text numbered', async () => {
    const pages = [
      { width: 30, height: 20, pixel: (x: number) => [x * 8, 90, 40], compression: 'lzw' },
      { width: 12, height: 9, pixel: (x: number) => [x * 20, 0, 0], kind: 'bilevel', compression: 'packbits' },
      { width: 4, height: 4, pixel: () => [0, 0, 0], thumbnail: true },
      { width: 8, height: 8, pixel: () => [50, 50, 50], kind: 'gray' },
    ]
    const fax: Buffer = makeTiff({ pages })
    // Word keeps each page as a TIFF (writer-docx-images.test.ts); these convert each.
    for (const target of ['pdf', 'epub', 'azw3', 'md'] as TargetFormat[]) {
      const { render, calls } = host()
      const out = await targetPictures(`<p>Before ${img('image/tiff', fax, 'Signed lease')} after</p>`, target, { renderBlocks: render })
      // Three pages (the preview is not one), each a one-page TIFF of its own.
      const sources = calls.map((c) => Buffer.from(c.source.slice(c.source.indexOf(',') + 1), 'base64'))
      expect(sources.map((b) => tiffPages(b)?.map((p) => [p.width, p.height]))).toEqual([[[30, 20]], [[12, 9]], [[8, 8]]])
      expect(calls.every((c) => c.page === undefined)).toBe(true)
      expect([...out.matchAll(/alt="([^"]*)"/g)].map((m) => m[1])).toEqual([
        'Signed lease (page 1 of 3)',
        'Signed lease (page 2 of 3)',
        'Signed lease (page 3 of 3)',
      ])
      expect(out).toMatch(/^<p>Before <img [^>]+><br><img [^>]+><br><img [^>]+> after<\/p>$/)
    }
  })

  it('a converted TIFF is shown at its resolution, as Word shows it, unless the document gives it a size', async () => {
    const at = (dpi: number, width = 30, height = 20) => makeTiff({ width, height, pixel: () => [9, 9, 9], dpi })
    const fax: Buffer = makeTiff({ pages: [{ width: 300, height: 200, pixel: () => [0, 0, 0], dpi: 300 }, { width: 200, height: 100, pixel: () => [9, 9, 9], dpi: 200 }] })
    const { render } = host()
    const html =
      `<p>${img('image/tiff', at(300, 600, 300))}</p><p><img src="${uri('image/tiff', at(300, 600, 300))}" width="50"></p>` +
      `<p>${img('image/tiff', at(96))}</p><p>${img('image/tiff', fax)}</p>`
    for (const target of ['html', 'pdf', 'epub', 'azw3'] as TargetFormat[]) {
      const out = await targetPictures(html, target, { renderBlocks: render })
      const sizes = [...out.matchAll(/<img\b[^>]*>/g)].map((m) => [/ width="(\d+)"/.exec(m[0])?.[1], / height="(\d+)"/.exec(m[0])?.[1]])
      // 600 x 300 px at 300 dpi: 2 x 1 inches, 192 x 96 CSS px. The fax's pages each at their own dpi.
      expect(sizes).toEqual([['192', '96'], ['50', undefined], ['30', '20'], ['96', '64'], ['96', '48']])
    }
  })

  it('a multi-page TIFF alone in its paragraph gets a paragraph a page', async () => {
    const fax: Buffer = makeTiff({ pages: [{ width: 4, height: 4, pixel: () => [0, 0, 0] }, { width: 4, height: 4, pixel: () => [9, 9, 9] }] })
    const { render } = host()
    const out = await targetPictures(`<p>Lease:</p><p class="figure"> ${img('image/tiff', fax, 'Lease')} </p><p>End</p>`, 'epub', { renderBlocks: render })
    expect(out).toMatch(/^<p>Lease:<\/p><p class="figure"> <img [^>]+alt="Lease \(page 1 of 2\)"[^>]*> <\/p><p class="figure"><img [^>]+alt="Lease \(page 2 of 2\)"[^>]*><\/p><p>End<\/p>$/)
  })

  it('a page with no alt text is named by its number; without a renderer each page is its description', async () => {
    const fax: Buffer = makeTiff({ pages: [{ width: 4, height: 4, pixel: () => [0, 0, 0] }, { width: 4, height: 4, pixel: () => [9, 9, 9] }] })
    const notices: string[] = []
    const out = await targetPictures(`<p><img src="${uri('image/tiff', fax)}"></p>`, 'epub', { onAdvice: (_k, m) => notices.push(m) })
    expect(out).toContain('[image: Page 1 of 2]')
    expect(out).toContain('[image: Page 2 of 2]')
    expect(notices).toHaveLength(2)
  })

  it('a page whose data cannot be taken out alone is asked for by its place in the whole file', async () => {
    const fax: Buffer = makeTiff({ pages: [{ width: 4, height: 4, pixel: () => [0, 0, 0] }, { width: 6, height: 4, pixel: () => [9, 9, 9] }] })
    // The second page's strip byte counts (279) said to run past the end of the file.
    const be = (at: number) => fax.readUInt16LE(at)
    let ifd = fax.readUInt32LE(4)
    ifd = fax.readUInt32LE(ifd + 2 + be(ifd) * 12)
    for (let e = 0; e < be(ifd); e++) if (be(ifd + 2 + e * 12) === 279) fax.writeUInt32LE(fax.length * 2, ifd + 2 + e * 12 + 8)
    const { render, calls } = host()
    await targetPictures(`<p>${img('image/tiff', fax)}</p>`, 'pdf', { renderBlocks: render })
    expect(calls.map((c) => c.page)).toEqual([undefined, 1])
    expect(calls[1].source).toBe(uri('image/tiff', fax))
  })

  it('the same picture twice is converted once', async () => {
    const { render, calls } = host()
    const out = await targetPictures(`<p>${img('image/tiff', TIFF)}</p><p>${img('image/tiff', TIFF)}</p>`, 'epub', { renderBlocks: render })
    expect(calls).toHaveLength(1)
    expect(types(out)).toEqual(['image/png', 'image/png'])
  })

  it('converts every picture past the old 200 per document, asking 25 at a time (owner, 2026-10-16)', async () => {
    const batches: number[] = []
    const timeouts = new Set<number | undefined>()
    const { render: inner, calls } = host()
    const render: RenderBlocks = async (requests, opts) => {
      batches.push(requests.length)
      timeouts.add(opts.timeoutMs)
      return inner(requests, opts)
    }
    const n = 230
    // Distinct pictures: the TIFF with a different byte at its end each time.
    const html = Array.from({ length: n }, (_, i) => `<p>${img('image/tiff', Buffer.concat([TIFF, Buffer.from([i & 0xff, i >> 8])]), `p${i}`)}</p>`).join('')
    const onAdvice = vi.fn()
    const out = await targetPictures(html, 'epub', { renderBlocks: render, onAdvice })
    expect(calls).toHaveLength(n)
    expect(Math.max(...batches)).toBe(25)
    expect(timeouts).toEqual(new Set([20_000]))
    expect(types(out)).toEqual(Array(n).fill('image/png'))
    expect(onAdvice).not.toHaveBeenCalled()
  })

  it('keeps the batches already converted when the converter goes down, with one notice', async () => {
    let asked = 0
    const { render: inner } = host()
    const render: RenderBlocks = async (requests, opts) => {
      if (asked++ > 0) throw new Error('the render window closed')
      return inner(requests, opts)
    }
    const html = Array.from({ length: 30 }, (_, i) => `<p>${img('image/tiff', Buffer.concat([TIFF, Buffer.from([i])]), `p${i}`)}</p>`).join('')
    const onAdvice = vi.fn()
    const out = await targetPictures(html, 'epub', { renderBlocks: render, onAdvice })
    expect(types(out)).toEqual(Array(25).fill('image/png'))
    expect(out).toContain('[image: p29]')
    expect(onAdvice).toHaveBeenCalledTimes(1)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Pictures could not be converted for EPUB: the render window closed')
  })

  /** A picture of `mb` MB: the signature of a real one (TIFF, PNG), then zeros. The fake host does not decode it. */
  const sized = (head: Buffer, mb: number): Buffer => Buffer.concat([head, Buffer.alloc(mb * 1024 * 1024 - head.length)])

  it('converts a 40 MB picture, not refusing it for its size (owner, 2026-10-16: the 30 MB cap is gone)', async () => {
    const big = sized(TIFF, 40)
    for (const target of ['epub', 'azw3', 'pdf'] as TargetFormat[]) {
      const { render, calls } = host()
      const onAdvice = vi.fn()
      const out = await targetPictures(`<p>${img('image/tiff', big)}</p>`, target, { renderBlocks: render, onAdvice })
      expect(calls).toHaveLength(1)
      expect(calls[0].source).toBe(uri('image/tiff', big))
      expect(types(out)).toEqual(['image/png'])
      expect(onAdvice).not.toHaveBeenCalled()
    }
  })

  it('a copy may be as large as the largest picture the app fetches; Kindle copies 5 MB', async () => {
    // Word sizes a TIFF from its header; one wider than 20,000 px it cannot, so it is converted.
    const wide: Buffer = makeTiff({ width: 21_000, height: 1, pixel: () => [10, 20, 30] })
    for (const [target, html, max] of [
      ['epub', img('image/bmp', bmp()), MAX_FETCHED_IMAGE_BYTES],
      ['docx', img('image/tiff', wide), MAX_FETCHED_IMAGE_BYTES],
      ['azw3', img('image/bmp', bmp()), KINDLE_IMAGE_MAX_BYTES],
    ] as const) {
      const { render, calls } = host()
      await targetPictures(`<p>${html}</p>`, target, { renderBlocks: render })
      expect(calls.map((c) => c.fit?.maxBytes)).toEqual([max])
    }
  })

  it('a 40 MB PNG for Kindle is made smaller to fit its 5 MB, not refused', async () => {
    const big = sized(png(), 40)
    const { render, calls } = host()
    const onAdvice = vi.fn()
    const out = await targetPictures(`<p>${img('image/png', big)}</p>`, 'azw3', { renderBlocks: render, onAdvice, pictureFormat: 'jpeg' })
    expect(calls.map((c) => c.fit)).toEqual([{ maxBytes: KINDLE_IMAGE_MAX_BYTES, as: 'jpeg' }])
    expect(types(out)).toEqual(['image/jpeg'])
    expect(onAdvice).not.toHaveBeenCalled()
  })

  it('a picture a Kindle holds but not at its size is fitted by its pixels under Automatic, as JPEG under JPG or PNG', async () => {
    const big = sized(png(), 6)
    for (const [pictureFormat, as] of [[undefined, 'auto'], ['auto', 'auto'], ['png', 'jpeg'], ['jpeg', 'jpeg']] as const) {
      const { render, calls } = host()
      await targetPictures(`<p>${img('image/png', big)}</p>`, 'azw3', { renderBlocks: render, pictureFormat })
      expect(calls.map((c) => c.fit), String(pictureFormat)).toEqual([{ maxBytes: KINDLE_IMAGE_MAX_BYTES, as }])
    }
  })

  describe('a drawing over Kindle\'s 5 MB', () => {
    /** A PNG answer of `bytes` bytes (a PNG signature, then zeros). */
    const pngOf = (bytes: number): string => Buffer.concat([png().subarray(0, 16), Buffer.alloc(bytes - 16)]).toString('base64')
    const overSize = KINDLE_IMAGE_MAX_BYTES + 1024 * 1024

    function drawingHost(shrunk: RenderResult): { render: RenderBlocks; calls: RenderRequest[] } {
      const calls: RenderRequest[] = []
      const render: RenderBlocks = async (requests) =>
        requests.map((r): RenderResult => {
          calls.push(r)
          return r.kind === 'svg' ? { png: pngOf(overSize), width: 64, height: 48 } : shrunk
        })
      return { render, calls }
    }

    it('is made smaller to fit, as other pictures are, and keeps the size it is shown at', async () => {
      const { render, calls } = drawingHost({ jpeg: OUT_JPEG, width: 1000, height: 750 })
      const onAdvice = vi.fn()
      const out = await targetPictures(`<p>${img('image/x-emf', EMF, 'Site plan')}</p>`, 'azw3', { renderBlocks: render, onAdvice })
      expect(calls.map((c) => c.kind)).toEqual(['svg', 'picture'])
      expect(calls[1].source).toBe(`data:image/png;base64,${pngOf(overSize)}`)
      expect(calls[1].fit).toEqual({ maxBytes: KINDLE_IMAGE_MAX_BYTES, as: 'jpeg' })
      expect(out).toBe(`<p><img src="data:image/jpeg;base64,${OUT_JPEG}" alt="Site plan" width="64" height="48"></p>`)
      expect(onAdvice).not.toHaveBeenCalled()
    })

    it('is its alt text, with a notice, when it cannot be made small enough', async () => {
      const { render } = drawingHost({ error: 'it cannot be made small enough' })
      const onAdvice = vi.fn()
      const out = await targetPictures(`<p>${img('image/x-emf', EMF, 'Site plan')}</p>`, 'azw3', { renderBlocks: render, onAdvice })
      expect(out).toContain('[image: Site plan]')
      expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Picture 1 could not be stored for Kindle: it cannot be made small enough')
    })
  })
})
