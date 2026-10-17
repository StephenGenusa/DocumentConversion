import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { writeDocx } from '../../src/core/writers/docx'
import { createConverter } from '../../src/core/convert'
import type { RenderBlocks, RenderRequest, RenderResult } from '../../src/core/rendered-blocks'
// @ts-expect-error: a plain .mjs fixture library, no types.
import { emf, tiff as makeTiff, wmf } from '../../scripts/fixtures/lib-tiff.mjs'
import { tiffPages } from '../../src/core/picture-headers'

// Two distinct 1x1 PNGs: enough for html-to-docx's image-size probe, and
// different byte-for-byte so a de-duplicating pass must keep both.
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC'
const red = `data:image/png;base64,${RED}`
const blue = `data:image/png;base64,${BLUE}`

interface Media {
  /** Distinct `word/media/*` parts left in the package. */
  parts: string[]
  /** Targets of the image relationships that document.xml actually references. */
  used: string[]
  /** Image relationships nothing in document.xml points at. */
  dangling: string[]
  bytes: number
}

async function inspect(docx: Buffer): Promise<Media> {
  const zip = await JSZip.loadAsync(docx)
  const parts = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !zip.files[n].dir)
  const doc = await zip.files['word/document.xml'].async('string')
  const rels = await zip.files['word/_rels/document.xml.rels'].async('string')
  const referenced = new Set((doc.match(/r:(?:embed|link|id)="([^"]+)"/g) ?? []).map((m) => /"([^"]+)"/.exec(m)![1]))
  const used: string[] = []
  const dangling: string[] = []
  for (const rel of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    if (!/relationships\/image/.test(rel)) continue
    const id = /Id="([^"]+)"/.exec(rel)![1]
    const target = /Target="([^"]+)"/.exec(rel)![1]
    ;(referenced.has(id) ? used : dangling).push(target)
  }
  return { parts, used, dangling, bytes: docx.length }
}

describe('writeDocx image parts', () => {
  // html-to-docx builds an <img> that is not a direct child of <p>/<li> twice:
  // buildImage writes the media part and its relationship, then hands the same
  // node to buildParagraph -> buildRun, which writes a second copy under a new
  // random name and embeds that one. The first is left orphaned.
  for (const [shape, html] of Object.entries({
    'a bare top-level image': `<p>before</p><img src="${red}" alt="a">`,
    'an image in a figure': `<figure><img src="${red}" alt="a"></figure>`,
    'an image in a div': `<div><img src="${red}" alt="a"></div>`,
    'an image in a table cell': `<table><tr><td><img src="${red}" alt="a"></td></tr></table>`,
    'an image in a paragraph': `<p><img src="${red}" alt="a"></p>`,
  })) {
    it(`writes ${shape} exactly once`, async () => {
      const media = await inspect(await writeDocx({ html, title: 'T' }))
      expect(media.dangling).toEqual([])
      expect(media.parts).toHaveLength(1)
      expect(media.used).toHaveLength(1)
    })
  }

  it('keeps both of two different images', async () => {
    const html = `<div><img src="${red}" alt="a"></div><div><img src="${blue}" alt="b"></div>`
    const media = await inspect(await writeDocx({ html, title: 'T' }))
    expect(media.dangling).toEqual([])
    expect(media.parts).toHaveLength(2)
    expect(new Set(media.used).size).toBe(2)
  })

  it('stores one copy of an image used twice, still embedded twice', async () => {
    const html = `<p><img src="${red}" alt="a"></p><p>mid</p><p><img src="${red}" alt="a again"></p>`
    const media = await inspect(await writeDocx({ html, title: 'T' }))
    expect(media.dangling).toEqual([])
    expect(media.parts).toHaveLength(1)
    // Both drawings survive; they simply share the single stored blob.
    expect(media.used).toHaveLength(2)
    expect(new Set(media.used).size).toBe(1)
  })

  it('leaves an image-free document untouched', async () => {
    const media = await inspect(await writeDocx({ html: '<h1>T</h1><p>No pictures.</p>', title: 'T' }))
    expect(media.parts).toEqual([])
    expect(media.used).toEqual([])
    expect(media.dangling).toEqual([])
  })

  it('shrinks a multi-image document', async () => {
    const imgs = Array.from({ length: 6 }, (_, i) => `<div><img src="${i % 2 ? blue : red}" alt="i${i}"></div>`)
    const media = await inspect(await writeDocx({ html: imgs.join(''), title: 'T' }))
    expect(media.dangling).toEqual([])
    // Six drawings, two distinct blobs.
    expect(media.parts).toHaveLength(2)
    expect(media.used).toHaveLength(6)
  })
})

describe('Word keeps TIFF, EMF and WMF pictures as they are (html-to-docx cannot size them)', () => {
  // html-to-docx sizes every picture with image-size, which reads no TIFF
  // from memory and no EMF or WMF at all, and then gave up on the whole
  // document. Word shows all three itself, so each is embedded as it came,
  // sized from its own header (picture-headers.ts).
  const scan = (bigEndian = false): Buffer =>
    makeTiff({ width: 12, height: 8, pixel: (x: number) => [x * 20, 90, 160], compression: 'lzw', bigEndian })
  const tag = (mime: string, bytes: Buffer, alt: string): string => `<img src="data:${mime};base64,${bytes.toString('base64')}" alt="${alt}">`
  const EMU = 9525

  async function parts(out: Buffer) {
    const zip = await JSZip.loadAsync(out)
    const media = await inspect(out)
    const types = await zip.file('[Content_Types].xml')!.async('string')
    const doc = await zip.file('word/document.xml')!.async('string')
    const bytes = async (name: string) => zip.file(name)!.async('nodebuffer')
    return { zip, media, types, doc, bytes }
  }

  it('embeds each as it is, with its own content type, at the size its header gives', async () => {
    const tiff = scan()
    const mislabeled = scan(true)
    const drawing: Buffer = emf({ width: 160, height: 120 })
    const old: Buffer = wmf({ width: 200, height: 80 })
    const html =
      `<p>Before</p><p>${tag('image/tiff', tiff, 'Scan')}</p><p>${tag('image/png', mislabeled, 'Mislabeled')}</p>` +
      `<p>${tag('image/x-emf', drawing, 'Drawing')}</p><p>${tag('image/x-wmf', old, 'Old drawing')}</p><p><img src="${red}" alt="Red"></p><p>After</p>`
    const { media, types, doc, bytes } = await parts(await writeDocx({ html }))
    for (const text of ['Before', 'After']) expect(doc).toContain(text)
    expect(doc).not.toMatch(/\[(Scan|Mislabeled|Drawing|Old drawing)\]/)
    expect(media.dangling).toEqual([])
    expect(media.used.map((t) => t.replace(/^.*\./, ''))).toEqual(['tif', 'tif', 'emf', 'wmf', 'png'])
    const used = media.used.map((t) => `word/${t}`)
    expect((await bytes(used[0])).equals(tiff)).toBe(true)
    expect((await bytes(used[1])).equals(mislabeled)).toBe(true)
    expect((await bytes(used[2])).equals(drawing)).toBe(true)
    expect((await bytes(used[3])).equals(old)).toBe(true)
    expect(types).toContain('<Default Extension="tif" ContentType="image/tiff"/>')
    expect(types).toContain('<Default Extension="emf" ContentType="image/x-emf"/>')
    expect(types).toContain('<Default Extension="wmf" ContentType="image/x-wmf"/>')
    // Extents from the headers: the TIFF at 72 dpi (12 x 8 px is 16 x 10.67 CSS px), the EMF's frame, the WMF's box.
    const extents = [...doc.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2])])
    expect(extents.slice(0, 4)).toEqual([
      [16 * EMU, 11 * EMU],
      [16 * EMU, 11 * EMU],
      [160 * EMU, 120 * EMU],
      [200 * EMU, 80 * EMU],
    ])
  })

  it('declares a content type for every picture part (GIF and BMP were left undeclared)', async () => {
    const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    const { media, types } = await parts(await writeDocx({ html: `<p><img src="data:image/gif;base64,${gif}" alt="g"></p>` }))
    expect(media.used[0]).toMatch(/\.gif$/)
    expect(types).toContain('<Default Extension="gif" ContentType="image/gif"/>')
  })

  it('a picture whose header gives no size becomes its alt text', async () => {
    const bare: Buffer = wmf({ placeable: false })
    const WMF_EMPTY = Buffer.from('d7cdc69a000000000000000000000000000000000000', 'hex')
    const html = `<p>${tag('image/x-wmf', bare, 'Bare')}</p><p>${tag('image/x-wmf', WMF_EMPTY, 'Empty')}</p><p>${tag('image/tiff', makeTiff({ pages: [{ width: 4, height: 4, pixel: () => [0, 0, 0] }, { width: 4, height: 4, pixel: () => [0, 0, 0] }] }), 'Fax')}</p>`
    const { media, doc } = await parts(await writeDocx({ html }))
    for (const text of ['[Bare]', '[Empty]', '[Fax]']) expect(doc).toContain(text)
    expect(media.parts).toHaveLength(0)
  })

  it('through the converter: TIFF, EMF and WMF kept, a multi-page TIFF one TIFF a page, nothing asked of the render host', async () => {
    const calls: RenderRequest[] = []
    const render: RenderBlocks = async (reqs) =>
      reqs.map((r): RenderResult => {
        calls.push(r)
        return { png: BLUE, width: 12, height: 8 }
      })
    const notices: string[] = []
    const conv = createConverter(async () => Buffer.from('%PDF-'), { renderBlocks: render })
    const fax: Buffer = makeTiff({
      pages: [
        { width: 10, height: 6, pixel: () => [0, 0, 0], kind: 'bilevel', compression: 'packbits' },
        { width: 7, height: 5, pixel: () => [200, 200, 200], kind: 'gray' },
      ],
    })
    const page = Buffer.from(
      `<p>${tag('image/tiff', scan(), 'Scan')}</p><p>${tag('image/tiff', fax, 'Fax')}</p><p>${tag('image/x-emf', emf(), 'Drawing')}</p>` +
        `<p>${tag('image/x-wmf', wmf(), 'Old drawing')}</p><p><img src="${red}" alt="Red"></p>`,
    )
    const out = (await conv.convert({ bytes: page, filename: 'p.html' }, 'html', 'docx', undefined, { onAdvice: (_k, m) => notices.push(m) })).parts[0].bytes
    expect(calls).toEqual([])
    expect(notices).toEqual([])
    const { media, doc, bytes } = await parts(out)
    expect(media.used.map((t) => t.replace(/^.*\./, ''))).toEqual(['tif', 'tif', 'tif', 'emf', 'wmf', 'png'])
    const pages = await Promise.all(media.used.slice(1, 3).map((t) => bytes(`word/${t}`)))
    expect(pages.map((p) => tiffPages(p)?.map((x) => [x.width, x.height]))).toEqual([[[10, 6]], [[7, 5]]])
    expect(doc).toContain('descr="Fax (page 2 of 2)"')
  })

  it('a TIFF whose header cannot be read gets a PNG copy (render host) instead', async () => {
    const calls: RenderRequest[] = []
    const render: RenderBlocks = async (reqs) => reqs.map((r): RenderResult => (calls.push(r), { png: BLUE, width: 12, height: 8 }))
    const conv = createConverter(async () => Buffer.from('%PDF-'), { renderBlocks: render })
    const looped = scan()
    const ifd = looped.readUInt32LE(4)
    looped.writeUInt32LE(ifd, ifd + 2 + looped.readUInt16LE(ifd) * 12)
    const out = (await conv.convert({ bytes: Buffer.from(`<p>${tag('image/tiff', looped, 'Scan')}</p>`), filename: 'p.html' }, 'html', 'docx')).parts[0].bytes
    expect(calls.map((c) => [c.kind, c.fit?.as])).toEqual([['picture', 'auto']])
    expect((await inspect(out)).parts.every((p) => p.endsWith('.png'))).toBe(true)
  })
})
