import { describe, it, expect, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { targetPictures, pictureType, vectorMime } from '../../src/core/pictures'
import { tiffPages } from '../../src/core/picture-headers'
import { createConverter } from '../../src/core/convert'
import type { RenderBlocks, RenderRequest, RenderResult } from '../../src/core/rendered-blocks'
import type { TargetFormat } from '../../src/core/types'
// @ts-expect-error: a plain .mjs fixture library, no types.
import { emf, tiff as makeTiff } from '../../scripts/fixtures/lib-tiff.mjs'

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
    ['docx', ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'], ['image/tiff']],
  ])('%s keeps %j and converts %j to PNG', async (target, kept, converted) => {
    const { render, calls } = host()
    const out = await targetPictures(every, target, { renderBlocks: render })
    expect(calls.map((c) => /^data:(image\/[\w.+-]+);/.exec(c.source)?.[1])).toEqual(converted)
    expect(calls.every((c) => c.kind === 'picture' && c.fit?.as === 'png')).toBe(true)
    // Converted pictures stand where they stood, as PNG.
    const order = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/tiff']
    expect(types(out)).toEqual(order.map((t) => (kept.includes(t) ? t : 'image/png')))
  })

  it('converts to JPEG when that is the picture format chosen', async () => {
    const { render, calls } = host()
    const out = await targetPictures(`<p>${img('image/tiff', TIFF)}</p>`, 'pdf', { renderBlocks: render, pictureFormat: 'jpeg' })
    expect(calls.map((c) => c.fit)).toEqual([{ maxBytes: expect.any(Number), as: 'jpeg' }])
    expect(types(out)).toEqual(['image/jpeg'])
  })

  it('the format is passed from the conversion options', async () => {
    const { render, calls } = host()
    const conv = createConverter(async () => Buffer.from('%PDF-1.4'), { renderBlocks: render })
    await conv.convert({ bytes: Buffer.from(`<p>${img('image/tiff', TIFF)}</p>`), filename: 'a.html' }, 'html', 'html', { pictureFormat: 'jpeg' })
    await conv.convert({ bytes: Buffer.from(`<p>${img('image/tiff', TIFF)}</p>`), filename: 'a.html' }, 'html', 'epub')
    expect(calls.map((c) => c.fit?.as)).toEqual(['jpeg', 'png'])
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

  it('EMF and WMF become their alt text, with a notice, where the target cannot hold them', async () => {
    for (const target of ['html', 'pdf', 'epub', 'md', 'azw3', 'azw4', 'revealjs'] as TargetFormat[]) {
      const { render, calls } = host()
      const notices: string[] = []
      const out = await targetPictures(`<p>${img('image/x-emf', EMF, 'Site plan')} and ${img('image/x-wmf', wmf(), 'Logo')}</p>`, target, {
        renderBlocks: render,
        onAdvice: (_k, m) => notices.push(m),
      })
      expect(calls).toHaveLength(0)
      expect(out).toContain('[image: Site plan]')
      expect(out).toContain('[image: Logo]')
      expect(out).not.toContain('<img')
      expect(notices).toEqual([expect.stringMatching(/^Picture 1 could not be stored for .+: EMF pictures are not converted$/), expect.stringMatching(/WMF pictures are not converted$/)])
    }
  })

  it('without a renderer, a TIFF a target cannot hold becomes its alt text with a notice', async () => {
    const notices: string[] = []
    const out = await targetPictures(`<p>${img('image/tiff', TIFF, 'Survey scan')}</p>`, 'pdf', { onAdvice: (_k, m) => notices.push(m) })
    expect(out).toContain('[image: Survey scan]')
    expect(notices).toEqual(['Picture 1 could not be stored for PDF: TIFF pictures are not converted'])
  })

  it('an unrecognised picture is kept in a web page or Markdown, described in a PDF or EPUB', async () => {
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
    for (const target of ['pdf', 'epub', 'azw3', 'md', 'docx'] as TargetFormat[]) {
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
})
