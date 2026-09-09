import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { readPptx } from '../../src/core/readers/pptx'
import { readDocx, replaceUninlinedImages } from '../../src/core/readers/docx'
import { archiveInlineBudget, DEFAULT_INLINE_BUDGET, OVER_BUDGET } from '../../src/core/inline-images'

/**
 * A PNG the size we ask for. The header is real (imageMime and mammoth's
 * content-type table both have to accept it); the rest is one repeated byte, so
 * deflate crushes it to nothing — which is exactly the shape of the intake this
 * budget exists for: a 40 KB file that expands into tens of megabytes of hub.
 */
function bigPng(bytes: number): Buffer {
  const png = Buffer.alloc(bytes, 0x41)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  return png
}

const MB = 1024 * 1024

/* ---------------------------------------------------------------- pptx ---- */

function slideWithPictures(count: number): string {
  const pics = Array.from(
    { length: count },
    (_, i) => `<p:pic><p:blipFill><a:blip r:embed="rId${i + 1}"/></p:blipFill></p:pic>`,
  ).join('')
  return `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide</a:t></a:r></a:p></p:txBody></p:sp>${pics}</p:spTree></p:cSld></p:sld>`
}

async function pptxWithImages(count: number, each: number): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('ppt/presentation.xml', '<p:presentation/>')
  zip.file('ppt/slides/slide1.xml', slideWithPictures(count))
  const rels = Array.from(
    { length: count },
    (_, i) => `<Relationship Id="rId${i + 1}" Target="../media/image${i + 1}.png"/>`,
  ).join('')
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<Relationships>${rels}</Relationships>`)
  for (let i = 0; i < count; i++) zip.file(`ppt/media/image${i + 1}.png`, bigPng(each))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Promise<Buffer>
}

/* ---------------------------------------------------------------- docx ---- */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const PIC = 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

function drawing(id: number): string {
  return `<w:p><w:r><w:drawing><wp:inline ${WP}><wp:docPr id="${id}" name="Picture ${id}" descr="figure ${id}"/><a:graphic ${A}><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic ${PIC}><pic:blipFill><a:blip r:embed="rId${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

async function docxWithImages(count: number, each: number): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  const body = Array.from({ length: count }, (_, i) => drawing(i + 1)).join('')
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document ${W} ${R}><w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p>${body}</w:body></w:document>`,
  )
  const rels = Array.from(
    { length: count },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`,
  ).join('')
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  )
  for (let i = 0; i < count; i++) zip.file(`word/media/image${i + 1}.png`, bigPng(each))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Promise<Buffer>
}

/* --------------------------------------------------------------------------- */

/** Built once: twelve 3 MB PNGs take a moment to deflate. */
const bombs = new Map<string, Promise<Buffer>>()
function bomb(kind: 'pptx' | 'docx'): Promise<Buffer> {
  const made = bombs.get(kind) ?? (kind === 'pptx' ? pptxWithImages(12, 3 * MB) : docxWithImages(12, 3 * MB))
  bombs.set(kind, made)
  return made
}

describe('archiveInlineBudget', () => {
  it('never allows an archive less than a web page gets', () => {
    const budget = archiveInlineBudget(1024)
    expect(budget.maxTotal).toBe(DEFAULT_INLINE_BUDGET.maxTotal)
  })

  it('scales with the source file, which honest documents never outgrow', () => {
    // Real corpus files carry 0.93–0.99 bytes of image per byte of file; the
    // headroom is what keeps an ordinary document out of the placeholder path.
    expect(archiveInlineBudget(40 * MB).maxTotal).toBeGreaterThan(40 * MB)
  })
})

describe('image budget: pptx', () => {
  it('bounds the hub a tiny deck full of heavily deflated images can produce', async () => {
    const bytes = await bomb('pptx')
    expect(bytes.byteLength).toBeLessThan(200 * 1024) // the 40 KB-class intake
    const hub = await readPptx({ bytes, filename: 'bomb.pptx' })
    const budget = archiveInlineBudget(bytes.byteLength)
    // Base64 costs 4/3, plus the tags themselves; well under 2x the byte budget.
    expect(hub.html.length).toBeLessThan(budget.maxTotal * 2)
    expect(hub.html.length).toBeLessThan(20 * MB)
  }, 60_000)

  it('says so in the document rather than dropping a refused image silently', async () => {
    const bytes = await bomb('pptx')
    const hub = await readPptx({ bytes })
    expect(hub.html).toContain('[image:')
    const inlined = (hub.html.match(/<img\b/g) ?? []).length
    const refused = (hub.html.match(/\[image:/g) ?? []).length
    expect(inlined + refused).toBe(12)
    expect(inlined).toBeGreaterThan(0)
  }, 60_000)

  it('leaves an ordinary deck alone', async () => {
    const bytes = await pptxWithImages(6, 64 * 1024)
    const hub = await readPptx({ bytes })
    expect((hub.html.match(/<img\b/g) ?? []).length).toBe(6)
    expect(hub.html).not.toContain('[image:')
  }, 60_000)
})

describe('replaceUninlinedImages', () => {
  it('leaves an inlined image alone', () => {
    const img = '<img src="data:image/png;base64,AAA" alt="figure 1" />'
    expect(replaceUninlinedImages(img)).toBe(img)
  })

  it('is not fooled by data-src, and survives a ">" inside the alt', () => {
    expect(replaceUninlinedImages('<img alt="a > b" />')).toBe(
      `<em>[image: a > b — ${OVER_BUDGET}]</em>`,
    )
    // data-src is not a src: the image still has nowhere to load from.
    expect(replaceUninlinedImages('<img data-src="x.png" alt="a" />')).toContain('[image: a —')
  })

  it('says something even when the picture had no alt text', () => {
    expect(replaceUninlinedImages('<img />')).toBe(`<em>[image: ${OVER_BUDGET}]</em>`)
  })
})

describe('image budget: docx', () => {
  it('bounds the hub a tiny document full of heavily deflated images can produce', async () => {
    const bytes = await bomb('docx')
    expect(bytes.byteLength).toBeLessThan(200 * 1024)
    const hub = await readDocx({ bytes, filename: 'bomb.docx' })
    expect(hub.html.length).toBeLessThan(archiveInlineBudget(bytes.byteLength).maxTotal * 2)
    expect(hub.html.length).toBeLessThan(20 * MB)
  }, 60_000)

  it('leaves the refused image as its alt text, in place', async () => {
    const bytes = await bomb('docx')
    const hub = await readDocx({ bytes })
    // mammoth takes the alt from <wp:docPr descr>; the placeholder keeps it.
    expect(hub.html).toContain('[image: figure 12')
    expect(hub.html).not.toMatch(/<img(?![^>]*src=)/)
    const inlined = (hub.html.match(/<img\b/g) ?? []).length
    const refused = (hub.html.match(/\[image:/g) ?? []).length
    expect(inlined + refused).toBe(12)
    expect(inlined).toBeGreaterThan(0)
  }, 60_000)

  it('leaves an ordinary document alone', async () => {
    const bytes = await docxWithImages(6, 64 * 1024)
    const hub = await readDocx({ bytes })
    expect((hub.html.match(/<img\b/g) ?? []).length).toBe(6)
    expect(hub.html).not.toContain('[image:')
  }, 60_000)
})

/**
 * The guard is only worth having if it never fires on ordinary work: not one
 * picture in any corpus document may be refused. The fixtures deliberately
 * include the image-heavy cases (a training packet, a numbered how-to whose
 * list is interrupted by images), because those are what a budget would trip
 * on first.
 */
describe('image budget: the whole corpus', () => {
  const dir = join(__dirname, '../corpus')
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => /\.(docx|pptx)$/i.test(f))
    : []

  it.each(files)('%s keeps every image it had', async (name) => {
    const bytes = await readFile(join(dir, name))
    const read = /\.pptx$/i.test(name) ? readPptx : readDocx
    const hub = await read({ bytes, filename: name })
    expect(hub.html).not.toContain('[image:')
  }, 60_000)
})
