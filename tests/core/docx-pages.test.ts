import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import JSZip from 'jszip'
import { createConverter } from '../../src/core/convert'
import { writeDocx, wordPages } from '../../src/core/writers/docx'
import { encodePng } from '../../src/core/metafile/png'
import type { ConvertOptions, PdfLandscape, PdfPageSize } from '../../src/core/types'

// Word's pages: Word's own 1-inch margins, and the PDF's Automatic orientation
// (orientation.ts), a section a picture for a document of pictures a page.

const corpus = (name: string): Buffer => readFileSync(join(__dirname, '../corpus', name))
const conv = createConverter(async () => Buffer.from('%PDF'))

async function documentXml(docx: Buffer): Promise<string> {
  return (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')
}

/** Letter in twips, portrait: 8.5 by 11 inches. */
const W = 8.5 * 1440
const H = 11 * 1440

const opts = (landscape: PdfLandscape, pageSize: PdfPageSize = 'Letter'): ConvertOptions => ({ pdf: { scale: 1, pageSize, landscape, headerFooter: false } })

/** Each section's page, in order: 'P' or 'L' by its w:pgSz, with its size. */
function sections(xml: string): Array<{ shape: 'P' | 'L'; w: number; h: number; orient?: string }> {
  return [...xml.matchAll(/<w:pgSz w:w="(\d+)" w:h="(\d+)"(?: w:orient="(\w+)")?\/>/g)].map((m) => ({
    shape: Number(m[1]) > Number(m[2]) ? 'L' : 'P',
    w: Number(m[1]),
    h: Number(m[2]),
    orient: m[3],
  }))
}

const png = (width: number, height: number): string =>
  `data:image/png;base64,${encodePng(width, height, new Uint8Array(width * height * 4).fill(255), false).toString('base64')}`

describe('Word page margins', () => {
  it("are Word's own: 1 inch all round, header and footer half an inch", async () => {
    const xml = await documentXml(await writeDocx({ html: '<p>Hello</p>' }))
    expect(xml).toMatch(/<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"\/>/)
    expect(sections(xml)).toEqual([{ shape: 'P', w: W, h: H, orient: 'portrait' }])
  })

  it('keep the section properties last in the body (schema order)', async () => {
    const xml = await documentXml(await writeDocx({ html: '<p>Hello</p>' }))
    expect(xml).toMatch(/<\/w:p>\s*<w:sectPr>[\s\S]*<\/w:sectPr>\s*<\/w:body>/)
  })
})

describe('Word page orientation', () => {
  it('Portrait and Landscape are exact', async () => {
    const html = '<p>Hello</p>'
    expect(sections(await documentXml(await writeDocx({ html }, opts(false))))).toEqual([{ shape: 'P', w: W, h: H, orient: 'portrait' }])
    expect(sections(await documentXml(await writeDocx({ html }, opts(true))))).toEqual([{ shape: 'L', w: H, h: W, orient: 'landscape' }])
  })

  it('Automatic (and no options) is portrait for prose', async () => {
    expect(sections(await documentXml(await writeDocx({ html: '<p>Hello</p>' }, opts('auto'))))[0].shape).toBe('P')
  })

  it('Automatic turns the page for a wide picture on its own', async () => {
    const xml = await documentXml(await writeDocx({ html: `<img src="${png(400, 200)}" alt="wide" width="400" height="200">` }, opts('auto')))
    expect(sections(xml).map((s) => s.shape)).toEqual(['L'])
  })

  it('Automatic turns the page for a document mostly of wide tables', async () => {
    const row = (cell: string): string => `<tr>${Array.from({ length: 14 }, (_, i) => `<td>${cell} ${i} value</td>`).join('')}</tr>`
    const html = `<table><thead>${row('Heading')}</thead><tbody>${Array.from({ length: 12 }, () => row('Some')).join('')}</tbody></table>`
    expect(wordPages(html, 'auto').landscape).toBe(true)
    expect(sections(await documentXml(await writeDocx({ html }, opts('auto')))).map((s) => s.shape)).toEqual(['L'])
  })

  it('a fax of portrait, landscape and portrait pages is three sections, each its own page and orientation', async () => {
    const r = await conv.convert({ bytes: corpus('reading-room-lease.tiff'), filename: 'lease.tiff' }, 'image', 'docx', opts('auto'))
    const xml = await documentXml(r.parts[0].bytes)
    expect(sections(xml).map((s) => s.shape)).toEqual(['P', 'L', 'P'])
    // The first two end in the paragraph that holds their picture (its section properties last in its w:pPr).
    const breaks = [...xml.matchAll(/<w:p>(?:(?!<w:p>)[\s\S])*?<\/w:p>/g)].map((m) => m[0]).filter((p) => p.includes('<w:sectPr>'))
    expect(breaks).toHaveLength(2)
    for (const p of breaks) {
      expect(p).toContain('<w:drawing>')
      expect(p).toMatch(/<w:sectPr>[\s\S]*<\/w:sectPr><\/w:pPr>/)
    }
  })

  it('the fax in Portrait is three portrait pages, a picture each', async () => {
    const r = await conv.convert({ bytes: corpus('reading-room-lease.tiff'), filename: 'lease.tiff' }, 'image', 'docx', opts(false))
    expect(sections(await documentXml(r.parts[0].bytes)).map((s) => s.shape)).toEqual(['P', 'P', 'P'])
  })

  it('a wide drawing (the EMF floor plan) is a landscape page', async () => {
    const r = await conv.convert({ bytes: corpus('reading-room-floor-plan.emf'), filename: 'plan.emf' }, 'metafile', 'docx', opts('auto'))
    expect(sections(await documentXml(r.parts[0].bytes)).map((s) => s.shape)).toEqual(['L'])
  })
})

describe('Word page size', () => {
  // The Page setting (Settings → Pages, the toolbar) is Word's too: twips, portrait.
  const inch = (n: number): number => n * 1440
  const mm = (n: number): number => Math.round((n / 25.4) * 1440)
  const sizes: Array<[PdfPageSize, number, number]> = [
    ['Letter', inch(8.5), inch(11)],
    ['A4', mm(210), mm(297)],
    ['Legal', inch(8.5), inch(14)],
    ['A3', mm(297), mm(420)],
    ['Tabloid', inch(11), inch(17)],
  ]

  it('is the page asked for, portrait or turned', async () => {
    for (const [size, w, h] of sizes) {
      expect(sections(await documentXml(await writeDocx({ html: '<p>Hello</p>' }, opts(false, size)))), size).toEqual([{ shape: 'P', w, h, orient: 'portrait' }])
      expect(sections(await documentXml(await writeDocx({ html: '<p>Hello</p>' }, opts(true, size)))), size).toEqual([{ shape: 'L', w: h, h: w, orient: 'landscape' }])
    }
  })

  it('is Letter when none is given, or when the page is in inches (the Kindle\'s)', async () => {
    expect(sections(await documentXml(await writeDocx({ html: '<p>Hello</p>' })))[0]).toMatchObject({ w: W, h: H })
    const inches: ConvertOptions = { pdf: { scale: 1, pageSize: { width: 3.6, height: 4.8 }, landscape: false, headerFooter: false } }
    expect(sections(await documentXml(await writeDocx({ html: '<p>Hello</p>' }, inches)))[0]).toMatchObject({ w: W, h: H })
  })

  it('is every section\'s, for a fax of pictures a page', async () => {
    const r = await conv.convert({ bytes: corpus('reading-room-lease.tiff'), filename: 'lease.tiff' }, 'image', 'docx', opts('auto', 'A4'))
    // A4 in twips: 210 by 297 millimeters.
    const [w, h] = [Math.round((210 / 25.4) * 1440), Math.round((297 / 25.4) * 1440)]
    expect(sections(await documentXml(r.parts[0].bytes))).toEqual([
      { shape: 'P', w, h, orient: 'portrait' },
      { shape: 'L', w: h, h: w, orient: 'landscape' },
      { shape: 'P', w, h, orient: 'portrait' },
    ])
  })

  it('decides Automatic on the page asked for: wide tables that need Letter turned fit A3 upright', async () => {
    const row = (cell: string): string => `<tr>${Array.from({ length: 11 }, (_, i) => `<td>${cell} ${i} value</td>`).join('')}</tr>`
    const html = `<table><thead>${row('Heading')}</thead><tbody>${Array.from({ length: 12 }, () => row('Some')).join('')}</tbody></table>`
    expect(wordPages(html, 'auto', 'Letter').landscape).toBe(true)
    expect(wordPages(html, 'auto', 'A3').landscape).toBe(false)
  })

  it('narrows a table sized by content to the page\'s text width (A4: 8.27 inches less 2)', async () => {
    const html = '<table><tr><td>' + 'word '.repeat(200) + '</td><td>short</td></tr></table>'
    const xml = await documentXml(await writeDocx({ html }, opts(false, 'A4')))
    const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]))
    expect(widths.length).toBeGreaterThan(0)
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(Math.round((210 / 25.4) * 1440) - 2 * 1440)
  })
})

describe('Word pictures fit their page', () => {
  it('a picture taller than a turned page is made to fit its height, its shape kept', async () => {
    const xml = await documentXml(await writeDocx({ html: `<p>Before</p><img src="${png(500, 1000)}" alt="tall" width="500" height="1000">` }, opts(true)))
    const [cx, cy] = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!.slice(1).map(Number)
    // Landscape Letter with 1-inch margins: 9 x 6.5 inches of text (EMU: 914,400 an inch).
    expect(cy).toBeLessThanOrEqual(6.5 * 914400)
    expect(cx / cy).toBeCloseTo(0.5, 2)
    const [ax, ay] = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!.slice(1).map(Number)
    expect([ax, ay]).toEqual([cx, cy])
  })

  it('a picture that fits is left as it is', async () => {
    const xml = await documentXml(await writeDocx({ html: `<p><img src="${png(96, 48)}" alt="small" width="96" height="48"></p>` }))
    expect(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!.slice(1).map(Number)).toEqual([914400, 914400 / 2])
  })
})
