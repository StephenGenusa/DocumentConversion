import { describe, it, expect } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readRtf } from '../../src/core/readers/rtf'
import { createConverter } from '../../src/core/convert'
import { targetPictures, pictureType } from '../../src/core/pictures'
import { wmfSize } from '../../src/core/picture-headers'
import type { RenderBlocks, RenderResult } from '../../src/core/rendered-blocks'
// @ts-expect-error: a plain .mjs fixture library, no types.
import { emf, wmf } from '../../scripts/fixtures/lib-tiff.mjs'
// @ts-expect-error: a plain .mjs fixture library, no types.
import { pictPackBits, pictDirect, pictBits, pictQuickTime, pictDrawing, ddb } from '../../scripts/fixtures/lib-pict.mjs'

/*
 * Pictures in RTF (\pict): PNG, JPEG, EMF, WMF and DIB, as hex or \bin
 * bytes, sized by \picwgoal/\pichgoal, with Word's \shppict/\nonshppict
 * pair kept as a picture and its alternate for the picture step to choose
 * from per target (pictures.ts).
 */

const png = (): Buffer => {
  const c = createCanvas(8, 6)
  const g = c.getContext('2d')
  g.fillStyle = '#3a6ea5'
  g.fillRect(0, 0, 8, 6)
  return Buffer.from(c.toBuffer('image/png'))
}
const jpeg = (): Buffer => Buffer.from(createCanvas(8, 6).toBuffer('image/jpeg', 90))

/** A 2x2 24-bit DIB: a BITMAPINFOHEADER and its rows, no file header (as \dibitmap holds it). */
function dib(): Buffer {
  const b = Buffer.alloc(40 + 16)
  b.writeUInt32LE(40, 0)
  b.writeInt32LE(2, 4)
  b.writeInt32LE(2, 8)
  b.writeUInt16LE(1, 12)
  b.writeUInt16LE(24, 14)
  b.writeUInt32LE(16, 20)
  b.fill(0x80, 40)
  return b
}

const hex = (b: Buffer): string => b.toString('hex').replace(/(.{64})/g, '$1\n')
const doc = (body: string): Buffer => Buffer.from(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}\\pard ${body}\\par}`, 'latin1')
const read = async (body: string): Promise<string> => (await readRtf({ bytes: doc(body), filename: 'a.rtf' })).html

/** Each <img>: its src's type and bytes, its alt and size attributes, and any alternate. */
function pictures(html: string) {
  return [...html.matchAll(/<img\b[^>]*>/g)].map((m) => {
    const tag = m[0]
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
    const bytes = (src?: string) => (src ? Buffer.from(src.slice(src.indexOf(',') + 1), 'base64') : undefined)
    const src = attr('src')
    return {
      type: /^data:([^;]+);/.exec(src ?? '')?.[1],
      bytes: bytes(src),
      alt: attr('alt'),
      width: attr('width'),
      height: attr('height'),
      alternate: bytes(attr('data-alt-src')),
    }
  })
}

describe('RTF pictures', () => {
  it('reads a PNG as hex, where it stood, sized by \\picwgoal/\\pichgoal (twips)', async () => {
    const html = await read(`Before {\\pict\\pngblip\\picw8\\pich6\\picwgoal1500\\pichgoal900 ${hex(png())}} after`)
    expect(html).toMatch(/Before <img [^>]+> after/)
    const [p] = pictures(html)
    expect(p.type).toBe('image/png')
    expect(p.bytes!.equals(png())).toBe(true)
    expect([p.width, p.height]).toEqual(['100', '60'])
  })

  it('reads a JPEG given as \\bin bytes, and applies \\picscalex/\\picscaley', async () => {
    const bytes = jpeg()
    const html = await read(`{\\pict\\jpegblip\\picwgoal1500\\pichgoal900\\picscalex50\\picscaley200\\bin${bytes.length} ${bytes.toString('latin1')}} after`)
    const [p] = pictures(html)
    expect(p.type).toBe('image/jpeg')
    expect(p.bytes!.equals(bytes)).toBe(true)
    expect([p.width, p.height]).toEqual(['50', '120'])
    expect(html).toContain('after')
  })

  it('reads an EMF, and a bare WMF given the placeable header its size says', async () => {
    const drawing: Buffer = emf({ width: 160, height: 120 })
    const bare: Buffer = wmf({ width: 64, height: 48, placeable: false })
    const html = await read(`{\\pict\\emfblip\\picwgoal2400\\pichgoal1800 ${hex(drawing)}}{\\pict\\wmetafile8\\picw1693\\pich1270\\picwgoal960\\pichgoal720 ${hex(bare)}}`)
    const [e, w] = pictures(html)
    expect(e.type).toBe('image/x-emf')
    expect(e.bytes!.equals(drawing)).toBe(true)
    expect(w.type).toBe('image/x-wmf')
    expect(pictureType(w.bytes!)).toBe('image/x-wmf')
    // The metafile kept byte for byte after its new 22-byte header; sized 960 x 720 twips = 64 x 48 px.
    expect(w.bytes!.subarray(22).equals(bare)).toBe(true)
    expect(wmfSize(w.bytes!)).toEqual({ width: 64, height: 48 })
  })

  it('reads a DIB as a BMP (a file header put in front)', async () => {
    const html = await read(`{\\pict\\dibitmap0\\picw2\\pich2 ${hex(dib())}}`)
    const [p] = pictures(html)
    expect(p.type).toBe('image/bmp')
    expect(p.bytes!.toString('latin1', 0, 2)).toBe('BM')
    expect(p.bytes!.readUInt32LE(2)).toBe(14 + 56)
    expect(p.bytes!.readUInt32LE(10)).toBe(14 + 40)
    expect(p.bytes!.subarray(14).equals(dib())).toBe(true)
  })

  it("keeps Word's \\shppict picture, with its \\nonshppict fallback as the alternate", async () => {
    const fallback: Buffer = wmf({ width: 8, height: 6, placeable: false })
    const html = await read(
      `{\\*\\shppict{\\pict{\\*\\picprop\\shplid1025{\\sp{\\sn shapeType}{\\sv 75}}{\\sp{\\sn wzDescription}{\\sv Reading room sign}}}\\picscalex100\\picscaley100\\picwgoal120\\pichgoal90\\pngblip\\bliptag-1{\\*\\blipuid 0123456789abcdef0123456789abcdef}${hex(png())}}}` +
        `{\\nonshppict{\\pict\\picscalex100\\picscaley100\\picw212\\pich159\\picwgoal120\\pichgoal90\\wmetafile8 ${hex(fallback)}}} after`,
    )
    const all = pictures(html)
    expect(all).toHaveLength(1)
    expect(all[0].type).toBe('image/png')
    expect(all[0].alt).toBe('Reading room sign')
    expect(pictureType(all[0].alternate!)).toBe('image/x-wmf')
    expect(html).toContain('after')
    expect(html).not.toMatch(/[0-9a-f]{40}/)
  })

  it('a \\nonshppict on its own is the picture', async () => {
    const html = await read(`{\\nonshppict{\\pict\\pngblip\\picwgoal120\\pichgoal90 ${hex(png())}}}`)
    expect(pictures(html).map((p) => p.type)).toEqual(['image/png'])
  })

  it('a picture in a table cell stays in its cell', async () => {
    const html = await read(`\\trowd\\cellx2000\\cellx4000\\intbl Sign\\cell\\intbl {\\pict\\pngblip\\picwgoal120\\pichgoal90 ${hex(png())}}\\cell\\row`)
    expect(html).toMatch(/<td>[^<]*Sign[^<]*<\/td>\s*<td>\s*<img [^>]*src="data:image\/png;base64,/)
  })

  it('a WMF that is not one is left out, the text kept', async () => {
    const html = await read(`One {\\pict\\wmetafile8 ${'ab'.repeat(300)}} two`)
    expect(pictures(html)).toEqual([])
    expect(html).toMatch(/One\s+two/)
  })

  /** A floating picture frame as Word writes it: the picture in the shape's `pib`, a copy in `\\shprslt` for readers that know no shapes. */
  const floating = (pib: string, result: string, extra = ''): string =>
    `{\\shp{\\*\\shpinst\\shpleft0\\shptop0\\shpright1800\\shpbottom1200\\shpwr3{\\sp{\\sn shapeType}{\\sv 75}}${extra}{\\sp{\\sn pib}{\\sv ${pib}}}}{\\shprslt\\par\\pard\\ql ${result}\\par}}`

  it('a floating picture: the pib picture where the shape stands, the \\shprslt copy as its alternate, never both', async () => {
    const fallback: Buffer = wmf({ width: 8, height: 6, placeable: false })
    const html = await read(
      `Before ${floating(`{\\pict\\pngblip\\picwgoal120\\pichgoal90 ${hex(png())}}`, `{\\pict\\wmetafile8\\picwgoal120\\pichgoal90 ${hex(fallback)}}`, '{\\sp{\\sn wzDescription}{\\sv Quiet seating sign}}')} after`,
    )
    const all = pictures(html)
    expect(all).toHaveLength(1)
    expect(all[0].type).toBe('image/png')
    expect(all[0].bytes!.equals(png())).toBe(true)
    expect(pictureType(all[0].alternate!)).toBe('image/x-wmf')
    // The frame's own size (1800 x 1200 twips) and description.
    expect([all[0].width, all[0].height, all[0].alt]).toEqual(['120', '80', 'Quiet seating sign'])
    // Where it stood, in its paragraph: the \\shprslt paragraph breaks went with it.
    expect(html).toMatch(/Before <img [^>]+> after/)
    expect(html).not.toMatch(/[0-9a-f]{40}/)
  })

  it('a floating picture whose pib is not read here: the \\shprslt picture, once', async () => {
    const html = await read(`Before ${floating('{\\pict\\pmmetafile8 00aa11bb22}', `{\\pict\\pngblip\\picwgoal120\\pichgoal90 ${hex(png())}}`)} after`)
    const all = pictures(html)
    expect(all.map((p) => [p.type, p.alternate])).toEqual([['image/png', undefined]])
    expect(html).toMatch(/Before <img [^>]+> after/)
  })

  it('a floating picture with no \\shprslt, and a text box (no pib) read as before', async () => {
    const lone = await read(`{\\shp{\\*\\shpinst{\\sp{\\sn pib}{\\sv {\\pict\\pngblip ${hex(png())}}}}}} kept`)
    expect(pictures(lone).map((p) => p.type)).toEqual(['image/png'])
    expect(lone).toContain('kept')
    const box = await read(`{\\shp{\\*\\shpinst{\\sp{\\sn shapeType}{\\sv 202}}{\\shptxt Shelf note\\par}}{\\shprslt Shelf note {\\pict\\pngblip ${hex(png())}}\\par}} kept`)
    expect(pictures(box).map((p) => p.type)).toEqual(['image/png'])
    expect(box).toContain('Shelf note')
  })

  it('the floating-pictures fixture: each picture once, where it stands', async () => {
    const bytes = readFileSync(join(__dirname, '../corpus/reading-room-floating.rtf'))
    const html = (await readRtf({ bytes, filename: 'reading-room-floating.rtf' })).html
    const all = pictures(html)
    expect(all.map((p) => [p.type, p.width, p.height])).toEqual([
      ['image/png', '64', '64'],
      ['image/jpeg', '160', '120'],
    ])
    expect(all[0].alt).toBe('Quiet seating sign beside the windows')
    expect(pictureType(all[0].alternate!)).toBe('image/x-wmf')
    expect(all[1].alternate).toBeUndefined()
    expect(html).toMatch(/<img [^>]+>The quiet seating sign floats/)
    expect(html).toMatch(/<img [^>]+>The photograph of the periodicals floats/)
  })

  it('hex with an odd digit or stray characters does not break the document', async () => {
    const html = await read(`{\\pict\\pngblip 89504e470}{\\pict\\pngblip zz}{\\pict} kept`)
    expect(html).toContain('kept')
  })
})

describe('RTF pictures of the rarer kinds: QuickDraw, OS/2 metafiles, device-dependent bitmaps', () => {
  /** Blue on the left half, pale on the right, a dark bar across the middle rows. */
  const rgb = (x: number, y: number): [number, number, number] => (y >= 4 && y < 6 ? [20, 20, 20] : x < 6 ? [58, 110, 165] : [242, 230, 200])
  const W = 12
  const H = 10
  const expectPixels = async (png: Buffer, w = W, h = H, at = rgb) => {
    const image = await loadImage(png)
    expect([image.width, image.height]).toEqual([w, h])
    const g = createCanvas(w, h).getContext('2d')
    g.drawImage(image, 0, 0)
    const { data } = g.getImageData(0, 0, w, h)
    for (const [x, y] of [[0, 0], [11, 0], [3, 5], [8, 9]]) {
      const o = (y * w + x) * 4
      expect([data[o], data[o + 1], data[o + 2]]).toEqual(at(x, y))
    }
  }

  it('a QuickDraw picture of an 8-bit PackBitsRect becomes a PNG of it, sized by its frame (points)', async () => {
    const html = await read(`Before {\\pict\\macpict\\picw${W}\\pich${H} ${hex(pictPackBits({ width: W, height: H, rgb }))}} after`)
    const [p] = pictures(html)
    expect(p.type).toBe('image/png')
    await expectPixels(p.bytes!)
    // 12 x 10 points = 16 x 13 CSS px.
    expect([p.width, p.height]).toEqual(['16', '13'])
    expect(html).toMatch(/Before <img [^>]+> after/)
  })

  it('a QuickDraw picture of 32-bit DirectBitsRect bands becomes one PNG of the bands together', async () => {
    const html = await read(`{\\pict\\macpict\\picwgoal${W * 15}\\pichgoal${H * 15} ${hex(pictDirect({ width: W, height: H, rgb, bands: 3 }))}}`)
    const [p] = pictures(html)
    expect(p.type).toBe('image/png')
    await expectPixels(p.bytes!)
    expect([p.width, p.height]).toEqual([String(W), String(H)])
  })

  it('a version 1 QuickDraw picture of a one-bit BitsRect: black where a bit is set', async () => {
    const html = await read(`{\\pict\\macpict ${hex(pictBits({ width: W, height: H, rgb }))}}`)
    const [p] = pictures(html)
    const mono = (x: number, y: number): [number, number, number] => {
      const [r, g, b] = rgb(x, y)
      return r + g + b < 384 ? [0, 0, 0] : [255, 255, 255]
    }
    await expectPixels(p.bytes!, W, H, mono)
  })

  it('a QuickDraw picture holding a QuickTime JPEG becomes that JPEG, byte for byte', async () => {
    const photo = jpeg()
    const html = await read(`{\\pict\\macpict ${hex(pictQuickTime({ width: 8, height: 6, image: photo }))}}`)
    const [p] = pictures(html)
    expect(p.type).toBe('image/jpeg')
    expect(p.bytes!.equals(photo)).toBe(true)
  })

  it('a QuickDraw drawing with no picture in it, or not a QuickDraw picture at all: a placeholder that says so', async () => {
    const html = await read(
      `One {\\pict\\macpict ${hex(pictDrawing({ width: W, height: H }))}} two {\\pict{\\*\\picprop{\\sp{\\sn wzDescription}{\\sv Shelf plan}}}\\macpict 00aa11bb22} three`,
    )
    expect(pictures(html)).toEqual([])
    expect(html).toContain('One <em>[image: a QuickDraw (Mac) drawing, which this app cannot draw]</em> two')
    expect(html).toContain('<em>[image: Shelf plan — a QuickDraw (Mac) drawing, which this app cannot draw]</em> three')
  })

  it('an OS/2 metafile: a placeholder that says so', async () => {
    const html = await read(`One {\\pict\\pmmetafile8\\picw100\\pich100 0012d3a8a800000000} two`)
    expect(html).toContain('One <em>[image: an OS/2 metafile, which this app cannot draw]</em> two')
  })

  it('a picture not drawn here gives way to the other of a pair', async () => {
    const html = await read(`{\\*\\shppict{\\pict\\macpict ${hex(pictDrawing({ width: W, height: H }))}}}{\\nonshppict{\\pict\\pngblip ${hex(png())}}}`)
    expect(pictures(html).map((p) => [p.type, p.alternate])).toEqual([['image/png', undefined]])
    expect(html).not.toContain('[image:')
  })

  it('a device-dependent bitmap (\\wbitmap) becomes a PNG: 1 bit black and white, 24 bits BGR', async () => {
    const mono = ddb({ width: W, height: H, depth: 1, rgb })
    const color = ddb({ width: W, height: H, depth: 24, rgb })
    const html = await read(
      `{\\pict\\wbitmap0\\wbmbitspixel1\\wbmplanes1\\wbmwidthbytes${mono.widthBytes}\\picw${W}\\pich${H} ${hex(mono.bits)}}` +
        `{\\pict\\wbitmap0\\wbmbitspixel24\\wbmplanes1\\wbmwidthbytes${color.widthBytes}\\picw${W}\\pich${H}\\picwgoal360\\pichgoal300 ${hex(color.bits)}}`,
    )
    const [a, b] = pictures(html)
    expect([a.type, a.width, a.height]).toEqual(['image/png', String(W), String(H)])
    await expectPixels(a.bytes!, W, H, (x, y) => {
      const [r, g, bl] = rgb(x, y)
      return r + g + bl >= 384 ? [255, 255, 255] : [0, 0, 0]
    })
    expect([b.type, b.width, b.height]).toEqual(['image/png', '24', '20'])
    await expectPixels(b.bytes!)
  })

  it('the old-pictures fixture: three pictures, two placeholders that say why', async () => {
    const bytes = readFileSync(join(__dirname, '../corpus/reading-room-old-pictures.rtf'))
    const html = (await readRtf({ bytes, filename: 'reading-room-old-pictures.rtf' })).html
    expect(pictures(html).map((p) => [p.type, p.width, p.height])).toEqual([
      ['image/png', '48', '48'],
      ['image/jpeg', '160', '107'],
      ['image/png', '16', '16'],
    ])
    expect(html).toContain('[image: Shelf plan from the old handbook — a QuickDraw (Mac) drawing, which this app cannot draw]')
    expect(html).toContain('[image: an OS/2 metafile, which this app cannot draw]')
  })

  it('a device-dependent bitmap with too few bits, or of several planes, is left out', async () => {
    const html = await read(`One {\\pict\\wbitmap0\\wbmbitspixel24\\wbmplanes1\\wbmwidthbytes36\\picw12\\pich10 00ff00} two {\\pict\\wbitmap0\\wbmbitspixel1\\wbmplanes4\\wbmwidthbytes2\\picw12\\pich1 ${'00'.repeat(8)}} three`)
    expect(pictures(html)).toEqual([])
    expect(html).toMatch(/One\s+two\s+three/)
  })
})

describe('RTF pictures through the picture step: the best of the pair each target can use', () => {
  const OUT_PNG = png().toString('base64')
  const render: RenderBlocks = async (reqs) => reqs.map((): RenderResult => ({ png: OUT_PNG, width: 8, height: 6 }))

  it('an EMF with a DIB fallback: Word keeps the EMF, every other target the EMF drawn (the DIB is a copy for old readers)', async () => {
    const drawing: Buffer = emf({ width: 160, height: 120 })
    const rtf = doc(`{\\*\\shppict{\\pict\\emfblip\\picwgoal2400\\pichgoal1800 ${hex(drawing)}}}{\\nonshppict{\\pict\\dibitmap0\\picwgoal2400\\pichgoal1800 ${hex(dib())}}}`)
    const html = (await readRtf({ bytes: rtf })).html
    const word = await targetPictures(html, 'docx', { renderBlocks: render })
    expect(pictures(word).map((p) => [p.type, p.alternate])).toEqual([['image/x-emf', undefined]])
    for (const target of ['html', 'epub', 'pdf'] as const) {
      const page = await targetPictures(html, target, { renderBlocks: render })
      expect(pictures(page).map((p) => [p.type, p.alternate])).toEqual([['image/svg+xml', undefined]])
    }
    // Kindle takes no SVG: the drawing as PNG.
    const book = await targetPictures(html, 'azw3', { renderBlocks: render })
    expect(pictures(book).map((p) => p.type)).toEqual(['image/png'])
  })

  it('an EMF that cannot be drawn, with a DIB fallback: the DIB', async () => {
    const empty = Buffer.from(emf({ width: 160, height: 120 }))
    // Its one drawing record (the rectangle, type 0x2b) made one nothing reads.
    for (let at = 0; at + 8 <= empty.length; at += empty.readUInt32LE(at + 4)) if (empty.readUInt32LE(at) === 0x2b) empty.writeUInt32LE(0x7a, at)
    const rtf = doc(`{\\*\\shppict{\\pict\\emfblip\\picwgoal2400\\pichgoal1800 ${hex(empty)}}}{\\nonshppict{\\pict\\dibitmap0\\picwgoal2400\\pichgoal1800 ${hex(dib())}}}`)
    const html = (await readRtf({ bytes: rtf })).html
    const page = await targetPictures(html, 'html', { renderBlocks: render })
    expect(pictures(page).map((p) => [p.type, p.alternate])).toEqual([['image/bmp', undefined]])
  })

  it('a PNG with a WMF fallback: the PNG everywhere', async () => {
    const rtf = doc(`{\\*\\shppict{\\pict\\pngblip\\picwgoal120\\pichgoal90 ${hex(png())}}}{\\nonshppict{\\pict\\wmetafile8\\picwgoal120\\pichgoal90 ${hex(wmf({ placeable: false }))}}}`)
    const conv = createConverter(async () => Buffer.from('%PDF-'), { renderBlocks: render })
    for (const target of ['html', 'md', 'docx'] as const) {
      const out = (await conv.convert({ bytes: rtf, filename: 'a.rtf' }, 'rtf', target)).parts[0].bytes
      expect(out.toString('latin1')).not.toContain('data-alt-src')
    }
    const page = (await conv.convert({ bytes: rtf, filename: 'a.rtf' }, 'rtf', 'html')).parts[0].bytes.toString('utf8')
    expect(page).toContain(`data:image/png;base64,${png().toString('base64')}`)
  })
})
