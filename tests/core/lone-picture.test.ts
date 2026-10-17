import { describe, it, expect } from 'vitest'
import { lonePicture, isWideLonePicture } from '../../src/core/lone-picture'
import { rasterSize } from '../../src/core/picture-headers'
import { svgDataUri } from '../../src/core/svg-images'
import { encodePng } from '../../src/core/metafile/png'
import { createPdfWriter } from '../../src/core/writers/pdf'
import type { PdfRenderOptions } from '../../src/core/types'

/*
 * A document that is one picture and nothing else (lone-picture.ts): an .svg
 * or a photo opened on its own, or a Markdown or HTML page whose only block
 * is a picture. Such a page prints the picture filling the page, and the
 * Kindle page turns landscape for a wide one.
 */

const svg = (w: number, h: number, viewBox = true) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"${viewBox ? ` viewBox="0 0 ${w} ${h}"` : ''}><rect width="${w}" height="${h}"/></svg>`

function png(width: number, height: number): Buffer {
  return encodePng(width, height, new Uint8Array(width * height * 4).fill(200), false)
}

/** A JPEG holding only the markers its size is read from: SOI, an APP0, SOF0, EOI. */
function jpeg(width: number, height: number, orientation?: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]
  parts.push(Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]))
  if (orientation !== undefined) {
    // APP1 Exif, big-endian TIFF, IFD0 with one entry: Orientation (0x0112), SHORT.
    const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0])
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
    const len = Buffer.alloc(2)
    len.writeUInt16BE(body.length + 2)
    parts.push(Buffer.from([0xff, 0xe1]), len, body)
  }
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  parts.push(sof, Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13)
  b.write('GIF89a', 0, 'latin1')
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

function webpLossy(width: number, height: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.writeUInt32LE(22, 4)
  b.write('WEBPVP8 ', 8, 'latin1')
  b.set([0x9d, 0x01, 0x2a], 23)
  b.writeUInt16LE(width, 26)
  b.writeUInt16LE(height, 28)
  return b
}

function webpLossless(width: number, height: number): Buffer {
  const b = Buffer.alloc(25)
  b.write('RIFF', 0, 'latin1')
  b.write('WEBPVP8L', 8, 'latin1')
  b[20] = 0x2f
  b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21)
  return b
}

function webpExtended(width: number, height: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.write('WEBPVP8X', 8, 'latin1')
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return b
}

const dataUri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`

describe('rasterSize', () => {
  it('reads PNG, JPEG, GIF and the three WebP kinds from their headers', () => {
    expect(rasterSize(png(40, 30))).toEqual({ width: 40, height: 30 })
    expect(rasterSize(jpeg(1200, 800))).toEqual({ width: 1200, height: 800 })
    expect(rasterSize(gif(16, 9))).toEqual({ width: 16, height: 9 })
    expect(rasterSize(webpLossy(320, 200))).toEqual({ width: 320, height: 200 })
    expect(rasterSize(webpLossless(321, 201))).toEqual({ width: 321, height: 201 })
    expect(rasterSize(webpExtended(4000, 3000))).toEqual({ width: 4000, height: 3000 })
  })

  it('turns a JPEG the camera stored on its side as it is shown (EXIF orientation 5 to 8)', () => {
    expect(rasterSize(jpeg(1200, 800, 6))).toEqual({ width: 800, height: 1200 })
    expect(rasterSize(jpeg(1200, 800, 8))).toEqual({ width: 800, height: 1200 })
    expect(rasterSize(jpeg(1200, 800, 1))).toEqual({ width: 1200, height: 800 })
  })

  it('says nothing of a file it cannot read, or one cut short', () => {
    expect(rasterSize(Buffer.from('not a picture'))).toBeNull()
    expect(rasterSize(png(40, 30).subarray(0, 12))).toBeNull()
    expect(rasterSize(jpeg(1200, 800).subarray(0, 24))).toBeNull()
  })
})

describe('lonePicture', () => {
  it('finds an .svg opened on its own, by the size written on it', () => {
    const html = `<img src="${svgDataUri(svg(1200, 800))}" alt="architecture-diagram.svg" width="1200" height="800">`
    expect(lonePicture(html)).toEqual({ size: { width: 1200, height: 800 } })
    expect(isWideLonePicture(html)).toBe(true)
  })

  it("reads an SVG's own size when the <img> gives none (width/height, else viewBox)", () => {
    expect(lonePicture(`<p><img src="${svgDataUri(svg(900, 300))}" alt=""></p>`)?.size).toEqual({ width: 900, height: 300 })
    const boxOnly = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="1" height="1"/></svg>`
    expect(isWideLonePicture(`<p><img src="${svgDataUri(boxOnly)}" alt=""></p>`)).toBe(true)
  })

  it('reads a photo opened on its own from its header', () => {
    expect(isWideLonePicture(`<img src="${dataUri('image/jpeg', jpeg(1200, 800))}" alt="photo.jpg">`)).toBe(true)
    expect(isWideLonePicture(`<img src="${dataUri('image/png', png(30, 40))}" alt="tall.png">`)).toBe(false)
    expect(isWideLonePicture(`<img src="${dataUri('image/jpeg', jpeg(1200, 800, 6))}" alt="sideways.jpg">`)).toBe(false)
  })

  it('finds the only block of a Markdown or HTML page, wrapped in a paragraph, a link or a figure', () => {
    const img = `<img src="${svgDataUri(svg(1200, 800))}" alt="Diagram">`
    for (const html of [`<p>${img}</p>`, `<figure>${img}</figure>`, `<p><a href="https://example.com">${img}</a></p>`, `\n<div>\n  ${img}\n</div>\n<!-- end -->\n`]) {
      expect(isWideLonePicture(html)).toBe(true)
    }
  })

  it('keeps a portrait or square picture portrait', () => {
    expect(isWideLonePicture(`<img src="${svgDataUri(svg(600, 800))}" alt="" width="600" height="800">`)).toBe(false)
    expect(isWideLonePicture(`<img src="${svgDataUri(svg(500, 500))}" alt="" width="500" height="500">`)).toBe(false)
    // Still a lone picture: it fills its page all the same.
    expect(lonePicture(`<img src="${svgDataUri(svg(600, 800))}" alt="" width="600" height="800">`)).not.toBeNull()
  })

  it('is not a lone picture when the document has text, a caption, a heading or another picture', () => {
    const img = `<img src="${svgDataUri(svg(1200, 800))}" alt="Diagram">`
    for (const html of [
      `<h1>Architecture</h1><p>${img}</p>`,
      `<p>${img}</p><p>The service, drawn above.</p>`,
      `<p>See: ${img}</p>`,
      `<figure>${img}<figcaption>Figure 1</figcaption></figure>`,
      `<p>${img}</p><p>${img}</p>`,
      `<table><tr><td>${img}</td></tr></table>`,
      '<p>No picture at all.</p>',
      '',
    ]) {
      expect(lonePicture(html)).toBeNull()
    }
  })

  it('is a lone picture of unknown shape when its size cannot be told (never landscape then)', () => {
    const html = '<p><img src="https://example.com/a.png" alt=""></p>'
    expect(lonePicture(html)).toEqual({ size: null })
    expect(isWideLonePicture(html)).toBe(false)
  })
})

/*
 * Printed at its own size, a 1200 px diagram took the top half of a portrait
 * page and a small one a corner. On paper the lone picture fills the page,
 * scaled up or down and kept whole.
 */
describe('the PDF writer prints a lone picture filling the page', () => {
  const wide = `<p><img src="${svgDataUri(svg(1200, 800))}" alt="d" width="1200" height="800"></p>`
  async function printed(html: string, opts?: PdfRenderOptions): Promise<{ css: string; opts?: PdfRenderOptions }> {
    let page = ''
    let seen: PdfRenderOptions | undefined
    await createPdfWriter(async (h, o) => {
      page = h
      seen = o
      return Buffer.from('%PDF-1.7\n%%EOF', 'latin1')
    })({ html, title: 'T' }, opts ? { pdf: opts } : undefined)
    return { css: page.split('<style>')[1].split('</style>')[0], opts: seen }
  }

  it('sizes the picture to the whole page box, whole (contain) and centered', async () => {
    const { css } = await printed(wide)
    expect(css).toMatch(/img \{[^}]*width: 100%;[^}]*height: 100vh;[^}]*object-fit: contain;/)
    expect(css).toMatch(/body \{[^}]*margin: 0;[^}]*max-width: none;/)
  })

  it('leaves a picture beside text at its own size', async () => {
    expect((await printed('<h1>Plan</h1>' + wide)).css).not.toContain('object-fit: contain')
  })

  it("keeps the page the user chose: orientation is the toolbar's, never changed behind their back", async () => {
    const chosen: PdfRenderOptions = { scale: 0.9, pageSize: 'Letter', landscape: false, headerFooter: false }
    expect((await printed(wide, chosen)).opts?.landscape).toBe(false)
  })
})
