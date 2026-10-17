import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { detect } from '../../src/core/detect'
import { looksLikeSvg } from '../../src/core/readers/image'
import { readSvg } from '../../src/core/readers/svg'
import {
  inlineSvgElements,
  decodeSvgDataUri,
  prepareSvgForRaster,
  rasterizeSvgImages,
  rasterizesSvgImages,
  sanitizeSvgImages,
  SVG_IMAGE_LIMITS,
  svgIntrinsicSize,
} from '../../src/core/svg-images'
import { createConverter } from '../../src/core/convert'
import { FOR_PASTING } from '../../src/core/draw-blocks'
import { allowedTargets } from '../../src/core/target-validity'
import { TARGET_FORMATS } from '../../src/core/types'
import type { RenderBlocks, RenderRequest, RenderResult } from '../../src/core/rendered-blocks'

const CORPUS = join(__dirname, '..', 'corpus')
const fixture = (name: string): Buffer => readFileSync(join(CORPUS, name))

/** A 1x1 PNG: html-to-docx reads the size of every image it embeds. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#abc"/></svg>'
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const img = (svg: string, attrs = 'alt="Plan"'): string => `<img src="data:image/svg+xml;base64,${b64(svg)}" ${attrs}>`
const decodedSrc = (html: string): string => {
  const m = /src="(data:image\/svg\+xml;base64,[^"]+)"/.exec(html)
  if (!m) throw new Error(`no SVG data URI in ${html}`)
  return decodeSvgDataUri(m[1])!
}

/** A rasterizer that answers every SVG with a PNG at its given size, except sources containing BROKEN. */
function fakeRenderer(): { render: RenderBlocks; calls: RenderRequest[][] } {
  const calls: RenderRequest[][] = []
  const render: RenderBlocks = async (requests) => {
    calls.push(requests)
    return requests.map((r): RenderResult => {
      if (r.source.includes('BROKEN')) return { error: 'the picture could not be decoded' }
      const size = svgIntrinsicSize(r.source)!
      return { png: PNG, width: Math.round(size.width), height: Math.round(size.height) }
    })
  }
  return { render, calls }
}

const pdf = async (): Promise<Buffer> => Buffer.from('%PDF-')

async function docxMedia(bytes: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes)
  return Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !zip.files[n].dir)
}

describe('SVG detection (spec D10)', () => {
  it('takes .svg by its extension', () => {
    expect(detect(fixture('reading-room-plan.svg'), 'reading-room-plan.svg')).toEqual({ kind: 'ok', format: 'svg' })
    expect(detect(Buffer.from(SVG), 'PLAN.SVG')).toEqual({ kind: 'ok', format: 'svg' })
  })

  it('sniffs an SVG with no name: plain, BOM, XML prolog, comments, doctype with an internal subset', () => {
    for (const text of [
      SVG,
      `﻿${SVG}`,
      `<?xml version="1.0"?>\n${SVG}`,
      `  \n<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- drawn by hand -->\n<!-- second -->\n${SVG}`,
      `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${SVG}`,
      `<!DOCTYPE svg [ <!ENTITY a "b"> <!-- ] --> ]>\n${SVG}`,
      '<svg>\n</svg>',
    ]) {
      expect(looksLikeSvg(Buffer.from(text, 'utf8')), text.slice(0, 40)).toBe(true)
      expect(detect(Buffer.from(text, 'utf8'))).toEqual({ kind: 'ok', format: 'svg' })
    }
    expect(detect(fixture('reading-room-hostile.svg'))).toEqual({ kind: 'ok', format: 'svg' })
  })

  it('does not take generic XML, or XML that merely holds an <svg> somewhere, as SVG', () => {
    for (const text of [
      '<?xml version="1.0"?>\n<catalog><item>Fiction</item></catalog>',
      '<?xml version="1.0"?>\n<root><svg xmlns="http://www.w3.org/2000/svg"/></root>',
      '<!-- <svg> --><note/>',
      '<svgfont/>',
      '<!doctype html><html><body><svg></svg></body></html>',
      'The <svg> element draws vector pictures.',
    ]) {
      expect(looksLikeSvg(Buffer.from(text, 'utf8')), text).toBe(false)
      expect(detect(Buffer.from(text, 'utf8')).kind === 'ok' && detect(Buffer.from(text, 'utf8')).format).not.toBe('svg')
    }
  })

  it('lets the bytes decide between SVG and a raster image, and leaves text extensions alone', () => {
    const png = Buffer.from(PNG, 'base64')
    expect(detect(Buffer.from(SVG), 'plan.png')).toEqual({ kind: 'ok', format: 'svg' })
    expect(detect(png, 'plan.svg')).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(Buffer.from(SVG), 'plan.txt')).toEqual({ kind: 'ok', format: 'txt' })
    expect(detect(Buffer.from(SVG), 'plan.xml')).toEqual({ kind: 'ok', format: 'code' })
  })
})

describe('readSvg (spec D10, B6)', () => {
  it('embeds the file as an SVG data URI, sized from the file, with the file name as alt', async () => {
    const hub = await readSvg({ bytes: fixture('reading-room-plan.svg'), filename: 'reading-room-plan.svg' })
    expect(hub.html).toMatch(/^<img src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+" alt="reading-room-plan\.svg" width="480" height="300">$/)
    expect(hub.title).toBe('reading-room-plan.svg')
    expect(decodedSrc(hub.html)).toContain('Periodicals')
  })

  it('strips the script, handlers, external hrefs, @import, foreignObject and the prolog from a hostile file', async () => {
    const hub = await readSvg({ bytes: fixture('reading-room-hostile.svg'), filename: 'reading-room-hostile.svg' })
    const svg = decodedSrc(hub.html)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.toLowerCase()).not.toContain('script')
    expect(svg).not.toMatch(/\son\w+=/i)
    // The picture it names by address is kept for the read step to fetch, and only that.
    expect(svg).toContain('<image href="http://127.0.0.1:9/picture.png" x="0" y="0" width="10" height="10" />')
    expect(svg.replace('<image href="http://127.0.0.1:9/picture.png"', '')).not.toContain('127.0.0.1')
    expect(svg).not.toContain('javascript:')
    expect(svg).not.toContain('@import')
    expect(svg.toLowerCase()).not.toContain('foreignobject')
    expect(svg).not.toContain('<iframe')
    expect(svg).not.toContain('xml-stylesheet')
    expect(svg).not.toContain('ENTITY')
    expect(svg).not.toContain('/etc/')
    // The drawing itself is kept.
    expect(svg).toContain('Fiction')
    expect(svg).toContain('<rect')
    // Read whole, with no network: the picture is its description, and no address is left.
    const read = decodedSrc((await createConverter(vi.fn()).read({ bytes: fixture('reading-room-hostile.svg') }, 'svg')).html)
    expect(read).not.toContain('127.0.0.1')
    expect(read).not.toContain('<image')
    expect(read).toContain('>[image: not included]</text>')
  })

  it('keeps the SVG images nested in a file, each cleaned, in every output that shows SVG', async () => {
    const bytes = fixture('reading-room-marked-plan.svg')
    const nested = (svg: string): string[] =>
      [...svg.matchAll(/<image [^>]*href="(data:image\/svg\+xml;base64,[^"]+)"/g)].map((m) => decodeSvgDataUri(m[1])!)
    const hub = await readSvg({ bytes, filename: 'reading-room-marked-plan.svg' })
    const markers = nested(decodedSrc(hub.html))
    expect(markers).toHaveLength(3)
    for (const m of markers) {
      expect(m).toContain('<circle')
      expect(m).not.toContain('script')
      expect(m).not.toContain('127.0.0.1')
    }
    const conv = createConverter(pdf)
    const html = (await conv.convert({ bytes, filename: 'reading-room-marked-plan.svg' }, 'svg', 'html')).parts[0].bytes.toString('utf8')
    expect(nested(decodedSrc(html))).toEqual(markers)
    const epub = await JSZip.loadAsync((await conv.convert({ bytes, filename: 'reading-room-marked-plan.svg' }, 'svg', 'epub')).parts[0].bytes)
    const item = Object.keys(epub.files).find((n) => n.endsWith('.svg'))!
    expect(nested(await epub.file(item)!.async('string'))).toEqual(markers)
  })

  it('refuses a file that is not an SVG', async () => {
    await expect(readSvg({ bytes: Buffer.from('<?xml version="1.0"?><note/>'), filename: 'x.svg' })).rejects.toMatchObject({
      code: 'image-unsupported',
    })
  })

  it('reads a raster image named .svg as the image it is', async () => {
    const hub = await readSvg({ bytes: Buffer.from(PNG, 'base64'), filename: 'x.svg' })
    expect(hub.html).toContain('data:image/png;base64,')
  })

  it('escapes a file name in the alt', async () => {
    const hub = await readSvg({ bytes: Buffer.from(SVG), filename: 'a"b<c>.svg' })
    expect(hub.html).toContain('alt="a&quot;b&lt;c&gt;.svg"')
  })
})

describe('where an SVG input can go', () => {
  it('to the targets a picture can, like an embedded image: no text, no tables', () => {
    expect(allowedTargets([{ format: 'svg' }])).toEqual(allowedTargets([{ format: 'image', imageMode: 'embed' }]))
    // OCR is never offered for it, so an OCR choice left on the item changes nothing.
    expect(allowedTargets([{ format: 'svg', imageMode: 'ocr' }])).toEqual(allowedTargets([{ format: 'svg' }]))
    expect(allowedTargets([{ format: 'svg' }])).not.toContain('txt')
  })
})

describe('svgIntrinsicSize', () => {
  it.each([
    ['width and height in px', '<svg width="200" height="100"/>', 200, 100],
    ['units', '<svg width="2in" height="72pt"/>', 192, 96],
    ['cm and mm', '<svg width="2.54cm" height="25.4mm"/>', 96, 96],
    ['viewBox only', '<svg viewBox="0 0 400 300"/>', 400, 300],
    ['viewBox with commas', '<svg viewBox="0,0,40,30"/>', 40, 30],
    ['width and viewBox', '<svg width="100" viewBox="0 0 400 300"/>', 100, 75],
    ['height and viewBox', '<svg height="60" viewBox="0 0 400 300"/>', 80, 60],
    ['percentages and viewBox', '<svg width="100%" height="100%" viewBox="0 0 50 20"/>', 50, 20],
    ['nothing at all (the CSS default)', '<svg/>', 300, 150],
    ['a bad viewBox', '<svg viewBox="0 0 -5 0"/>', 300, 150],
  ])('%s', (_name, svg, w, h) => {
    const size = svgIntrinsicSize(svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'))
    expect(size!.width).toBeCloseTo(w, 3)
    expect(size!.height).toBeCloseTo(h, 3)
  })

  it('answers null for something that is not an SVG', () => {
    expect(svgIntrinsicSize('<note/>')).toBeNull()
    expect(svgIntrinsicSize('not markup')).toBeNull()
  })
})

describe('prepareSvgForRaster', () => {
  it('sanitizes, and sizes the root in px at the size the picture will be shown', () => {
    const out = prepareSvgForRaster(SVG.replace('<rect', '<script>alert(1)</script><rect'), {})!
    expect(out).toMatchObject({ width: 200, height: 100 })
    expect(out.svg).not.toContain('script')
    expect(svgIntrinsicSize(out.svg)).toEqual({ width: 200, height: 100 })
  })

  it("takes the <img>'s own width, keeping the picture's aspect", () => {
    expect(prepareSvgForRaster(SVG, { width: 50 })).toMatchObject({ width: 50, height: 25 })
    expect(prepareSvgForRaster(SVG, { height: 50 })).toMatchObject({ width: 100, height: 50 })
    expect(prepareSvgForRaster(SVG, { width: 50, height: 50 })).toMatchObject({ width: 50, height: 50 })
  })

  it('caps the size, keeping the aspect', () => {
    const wide = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 500"/>'
    expect(prepareSvgForRaster(wide, { maxWidth: 624, maxHeight: 864 })).toMatchObject({ width: 624, height: 156 })
    const tall = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 4000"/>'
    expect(prepareSvgForRaster(tall, { maxWidth: 624, maxHeight: 864 })).toMatchObject({ width: 108, height: 864 })
  })

  it('gives a picture with no viewBox one, so its drawing scales with it', () => {
    const out = prepareSvgForRaster('<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1in"><rect width="192" height="96"/></svg>', { width: 96 })!
    expect(out).toMatchObject({ width: 96, height: 48 })
    expect(out.svg).toMatch(/viewBox="0 0 192 96"/)
    expect(out.svg).toMatch(/width="96"/)
  })

  it('drops a size the root style would set over the attributes', () => {
    const out = prepareSvgForRaster('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" style="width:50%;height: 3em;background:#fff"/>', {})!
    expect(out.svg).toContain('background:#fff')
    expect(out.svg).not.toMatch(/width:\s*50%/)
    expect(out.svg).not.toMatch(/height:\s*3em/)
  })

  it('answers null for something that is not an SVG', () => {
    expect(prepareSvgForRaster('<note/>', {})).toBeNull()
  })
})

describe('decodeSvgDataUri', () => {
  it('reads base64, percent-encoded and raw forms, with or without a charset', () => {
    expect(decodeSvgDataUri(`data:image/svg+xml;base64,${b64(SVG)}`)).toBe(SVG)
    expect(decodeSvgDataUri(`data:image/svg+xml;charset=utf-8;base64,${b64(SVG)}`)).toBe(SVG)
    expect(decodeSvgDataUri(`data:image/svg+xml,${encodeURIComponent(SVG)}`)).toBe(SVG)
    expect(decodeSvgDataUri(`DATA:IMAGE/SVG+XML;utf8,${SVG}`)).toBe(SVG)
    expect(decodeSvgDataUri(`data:image/png;base64,${PNG}`)).toBeNull()
  })
})

describe('sanitizeSvgImages (spec B6 for every SVG image a document carries)', () => {
  it('cleans an SVG <img> from any reader, and leaves other images alone', () => {
    const hostile = SVG.replace('<rect', '<script>alert(1)</script><a href="http://127.0.0.1:9/"><rect onclick="alert(1)"')
      .replace('</svg>', '</a></svg>')
    const png = `<img src="data:image/png;base64,${PNG}" alt="p">`
    const out = sanitizeSvgImages(`<p>${img(hostile)}</p><p>${png}</p>`)
    const svg = decodedSrc(out)
    expect(svg).not.toContain('script')
    expect(svg).not.toContain('onclick')
    expect(svg).not.toContain('127.0.0.1')
    expect(out).toContain(png)
    expect(out).toContain('alt="Plan"')
  })

  it('re-encodes a percent-encoded SVG as base64', () => {
    const out = sanitizeSvgImages(`<p><img src="data:image/svg+xml,${encodeURIComponent(SVG)}" alt="m"></p>`)
    expect(out).toMatch(/src="data:image\/svg\+xml;base64,/)
  })

  it('turns an SVG <img> that is not an SVG into its alt text', () => {
    const out = sanitizeSvgImages(`<p>See ${img('<note/>', 'alt="Shelf map"')} here</p>`)
    expect(out).not.toContain('<img')
    expect(out).toContain('Shelf map')
  })

  it('returns a document with no SVG image untouched', () => {
    const html = `<p>x</p><img src="data:image/png;base64,${PNG}">`
    expect(sanitizeSvgImages(html)).toBe(html)
  })
})

describe('rasterizeSvgImages (spec D10): PNG copies of SVG images for Word and Kindle', () => {
  it('rasterizes for Word and Kindle (AZW3) only', () => {
    for (const t of TARGET_FORMATS) expect(rasterizesSvgImages(t), t).toBe(t === 'docx' || t === 'azw3')
  })

  it('replaces each SVG <img> with a PNG of it, sized as shown, keeping the alt', async () => {
    const { render, calls } = fakeRenderer()
    const out = await rasterizeSvgImages(`<p>${img(SVG)}</p>`, 'docx', { renderBlocks: render })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(1)
    expect(calls[0][0]).toMatchObject({ kind: 'svg', display: true, format: 'png' })
    expect(svgIntrinsicSize(calls[0][0].source)).toEqual({ width: 200, height: 100 })
    expect(out).toBe(
      `<p><img src="data:image/png;base64,${PNG}" alt="Plan" width="200" height="100" style="width:200px;height:auto;max-width:100%"></p>`,
    )
  })

  it("draws at the <img>'s own size, and caps it at Word's text width", async () => {
    const { render, calls } = fakeRenderer()
    const wide = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1248 300"/>'
    const out = await rasterizeSvgImages(`<p>${img(SVG, 'width="24" alt="a"')}</p><p>${img(wide)}</p>`, 'docx', { renderBlocks: render })
    expect(svgIntrinsicSize(calls[0][0].source)).toEqual({ width: 24, height: 12 })
    expect(svgIntrinsicSize(calls[0][1].source)).toEqual({ width: 624, height: 150 })
    expect(out).toMatch(/width="24" alt="a" height="12" style="width:24px;/)
    expect(out).toContain('width="624" height="150"')
  })

  it('asks once for a picture repeated', async () => {
    const { render, calls } = fakeRenderer()
    const out = await rasterizeSvgImages(`<p>${img(SVG)}</p><p>${img(SVG)}</p>`, 'docx', { renderBlocks: render })
    expect(calls[0]).toHaveLength(1)
    expect(out.match(/data:image\/png/g)).toHaveLength(2)
  })

  it('keeps the alt text and says so when a picture cannot be made', async () => {
    const { render } = fakeRenderer()
    const onAdvice = vi.fn()
    const broken = SVG.replace('<rect', '<desc>BROKEN</desc><rect')
    const html = `<p>Before ${img(broken, 'alt="Shelf map"')} after</p><p>${img('<note/>', 'alt="Not one"')}</p><p>${img(SVG)}</p>`
    const out = await rasterizeSvgImages(html, 'docx', { renderBlocks: render, onAdvice })
    expect(out).not.toContain('image/svg+xml')
    expect(out).toContain('Before <em>[image: Shelf map]</em> after')
    expect(out).toContain('<p><em>[image: Not one]</em></p>')
    expect(out).toContain('data:image/png')
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'SVG image 1 could not be converted for Word: the picture could not be decoded')
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'SVG image 2 could not be converted for Word: it is not a readable SVG')
    expect(onAdvice).toHaveBeenCalledTimes(2)
  })

  it('asks for an SVG of any size: a 12 MB one is converted, not refused (owner, 2026-10-16: the 5 MB cap is gone)', async () => {
    const { render, calls } = fakeRenderer()
    const onAdvice = vi.fn()
    const big = SVG.replace('</svg>', `<desc>${'x'.repeat(12 * 1024 * 1024)}</desc></svg>`)
    const out = await rasterizeSvgImages(`<p>${img(big)}</p>`, 'docx', { renderBlocks: render, onAdvice })
    expect(calls).toHaveLength(1)
    expect(calls[0][0].source.length).toBeGreaterThan(12 * 1024 * 1024)
    expect(out).toContain('data:image/png')
    expect(out).not.toContain('[image:')
    expect(onAdvice).not.toHaveBeenCalled()
    expect(SVG_IMAGE_LIMITS).not.toHaveProperty('maxBytes')
  })

  /** `n` distinct SVG images, one per paragraph. */
  const manyImages = (n: number): string =>
    Array.from({ length: n }, (_, i) => `<p>${img(SVG.replace('#abc', `#${i.toString(16).padStart(6, '0')}`), `alt="Icon ${i}"`)}</p>`).join('')

  it('converts every one of 300 images, asking for them a batch at a time', async () => {
    const { render, calls } = fakeRenderer()
    const onAdvice = vi.fn()
    const out = await rasterizeSvgImages(manyImages(300), 'docx', { renderBlocks: render, onAdvice })
    expect(out.match(/data:image\/png/g)).toHaveLength(300)
    expect(out).not.toContain('image/svg+xml')
    expect(out).not.toContain('[image:')
    expect(calls.map((c) => c.length)).toEqual(Array(Math.ceil(300 / SVG_IMAGE_LIMITS.batch)).fill(SVG_IMAGE_LIMITS.batch).map((n, i, a) => (i === a.length - 1 ? 300 - n * i : n)))
    expect(onAdvice).not.toHaveBeenCalled()
  })

  it('converts every image past the old 2,000, with no notice (owner, 2026-10-16)', async () => {
    const { render, calls } = fakeRenderer()
    const onAdvice = vi.fn()
    const n = 2_050
    const out = await rasterizeSvgImages(manyImages(n), 'docx', { renderBlocks: render, onAdvice })
    expect(calls.flat()).toHaveLength(n)
    expect(Math.max(...calls.map((c) => c.length))).toBe(SVG_IMAGE_LIMITS.batch)
    expect(out.match(/data:image\/png/g)).toHaveLength(n)
    expect(onAdvice).not.toHaveBeenCalled()
  })

  it('gives each picture its own time: one too slow is its alt text, the rest convert', async () => {
    const { render: inner } = fakeRenderer()
    const seen: (number | undefined)[] = []
    const render: RenderBlocks = async (reqs, opts) => {
      seen.push(opts.timeoutMs)
      const results = await inner(reqs, opts)
      return results.map((r, i) => (reqs[i].source.includes(`#${'1'.padStart(6, '0')}`) ? { error: 'took longer than 10 s' } : r))
    }
    const onAdvice = vi.fn()
    const n = SVG_IMAGE_LIMITS.batch * 3 + 5
    const out = await rasterizeSvgImages(manyImages(n), 'docx', { renderBlocks: render, onAdvice })
    expect(new Set(seen)).toEqual(new Set([SVG_IMAGE_LIMITS.eachMs]))
    expect(out.match(/data:image\/png/g)).toHaveLength(n - 1)
    expect(out).toContain('<p><em>[image: Icon 1]</em></p>')
    expect(onAdvice).toHaveBeenCalledTimes(1)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'SVG image 2 could not be converted for Word: took longer than 10 s')
  })

  it('keeps PNG copies past the old 100 MB', async () => {
    // Five answers of 26 MB each.
    const big = Buffer.alloc(26 * 1024 * 1024).toString('base64')
    const render: RenderBlocks = async (reqs) => reqs.map(() => ({ png: big, width: 200, height: 100 }))
    const onAdvice = vi.fn()
    const out = await rasterizeSvgImages(manyImages(5), 'docx', { renderBlocks: render, onAdvice })
    expect(out.match(/data:image\/png/g)).toHaveLength(5)
    expect(onAdvice).not.toHaveBeenCalled()
  })

  it('one notice when the rasterizer is down, every picture its alt text', async () => {
    const onAdvice = vi.fn()
    const render: RenderBlocks = async () => {
      throw new Error('the render window could not start')
    }
    const out = await rasterizeSvgImages(`<p>${img(SVG)}</p><p>${img(SVG, 'alt="Two"')}</p>`, 'docx', { renderBlocks: render, onAdvice })
    expect(out).not.toContain('<img')
    expect(onAdvice).toHaveBeenCalledTimes(1)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'SVG images could not be converted for Word: the render window could not start')
  })

  it('leaves every other target, and a document with no renderer, untouched', async () => {
    const { render, calls } = fakeRenderer()
    const html = `<p>${img(SVG)}</p>`
    for (const t of TARGET_FORMATS.filter((t) => t !== 'docx' && t !== 'azw3')) {
      expect(await rasterizeSvgImages(html, t, { renderBlocks: render })).toBe(html)
    }
    expect(await rasterizeSvgImages(html, 'docx', {})).toBe(html)
    expect(calls).toHaveLength(0)
  })
})

describe('Convert to clipboard: SVG images go as PNG, which Word and Outlook show when pasted', () => {
  it('HTML with FOR_PASTING has PNG copies and no SVG; the HTML file itself keeps its SVG', async () => {
    const { render, calls } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const hub = await conv.read({ bytes: fixture('reading-room-page.html'), filename: 'reading-room-page.html' }, 'html')
    // What clipboardFlavors writes: the rich flavor and the plain one.
    const rich = (await conv.write(hub, 'html', { ...FOR_PASTING })).parts[0].bytes.toString('utf8')
    const plain = (await conv.write(hub, 'txt', { ...FOR_PASTING })).parts[0].bytes.toString('utf8')
    expect((rich.match(/<img[^>]+src="data:image\/png;base64,/g) ?? []).length).toBe(2)
    expect(rich).not.toContain('svg+xml')
    expect(plain).not.toContain('<img')
    // Two pictures, asked for once each; the txt flavor asked for nothing.
    expect(calls.flat().map((r) => `${r.kind}:${r.format}`)).toEqual(['svg:png', 'svg:png'])
    const file = (await conv.write(hub, 'html')).parts[0].bytes.toString('utf8')
    expect(file).toContain('src="data:image/svg+xml;base64,')
    expect(calls).toHaveLength(1)
  })

  it('names the clipboard in a notice when a picture cannot be converted', async () => {
    const render: RenderBlocks = async (reqs) => reqs.map(() => ({ error: 'it is not a readable SVG' }))
    const onAdvice = vi.fn()
    await rasterizeSvgImages(`<p>${img(SVG)}</p>`, 'html', { renderBlocks: render, onAdvice, svgImagesAsPng: true })
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'SVG image 1 could not be converted for pasting: it is not a readable SVG')
  })

  it('asks nothing for a target with no place for a picture, even when asked', async () => {
    const { render, calls } = fakeRenderer()
    const html = `<p>${img(SVG)}</p>`
    for (const t of ['txt', 'md', 'csv'] as const) {
      expect(await rasterizeSvgImages(html, t, { renderBlocks: render, svgImagesAsPng: true })).toBe(html)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('Word output of SVG images (the verified bug: image/svg+xml media Word cannot show)', () => {
  it('HTML with SVG images → docx holds PNG media, never SVG', async () => {
    const { render } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const page = fixture('reading-room-page.html')
    const out = await conv.convert({ bytes: page, filename: 'reading-room-page.html' }, 'html', 'docx')
    const media = await docxMedia(out.parts[0].bytes)
    expect(media.length).toBeGreaterThan(0)
    expect(media.every((n) => n.endsWith('.png'))).toBe(true)
    const doc = await (await JSZip.loadAsync(out.parts[0].bytes)).file('[Content_Types].xml')!.async('string')
    expect(doc).not.toContain('svg')
  })

  it('an .svg input → docx holds PNG media, never SVG', async () => {
    const { render, calls } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const bytes = fixture('reading-room-plan.svg')
    const out = await conv.convert({ bytes, filename: 'reading-room-plan.svg' }, 'svg', 'docx')
    const media = await docxMedia(out.parts[0].bytes)
    expect(media).toHaveLength(1)
    expect(media[0]).toMatch(/\.png$/)
    expect(svgIntrinsicSize(calls[0][0].source)).toEqual({ width: 480, height: 300 })
  })

  it('without a renderer, Word gets the alt text rather than media it cannot show', async () => {
    const conv = createConverter(pdf)
    const out = await conv.convert({ bytes: Buffer.from(`<p>${img(SVG, 'alt="Shelf map"')}</p>`), filename: 'a.html' }, 'html', 'docx')
    expect(await docxMedia(out.parts[0].bytes)).toEqual([])
    const doc = await (await JSZip.loadAsync(out.parts[0].bytes)).file('word/document.xml')!.async('string')
    expect(doc).toContain('Shelf map')
  })

  it('the other picture targets keep the SVG (sanitized), and never ask for a PNG', async () => {
    const { render, calls } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const hostile = fixture('reading-room-hostile.svg')
    const html = (await conv.convert({ bytes: hostile, filename: 'h.svg' }, 'svg', 'html')).parts[0].bytes.toString('utf8')
    expect(calls).toHaveLength(0)
    const svg = decodedSrc(html)
    expect(svg).toContain('Fiction')
    expect(svg).not.toContain('127.0.0.1')
  })

  it("read() cleans an SVG image another reader brought in, so the editor and every writer get B6's SVG", async () => {
    const conv = createConverter(pdf)
    const hostile = SVG.replace('<rect', '<script>alert(1)</script><rect onload="alert(1)"')
    const hub = await conv.read({ bytes: Buffer.from(`<p>${img(hostile)}</p>`), filename: 'a.html' }, 'html')
    const svg = decodedSrc(hub.html)
    expect(svg).not.toContain('script')
    expect(svg).not.toContain('onload')
  })
})

describe('inlineSvgElements: an SVG drawn inline in a page', () => {
  const decoded = (html: string): string[] =>
    [...html.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'))

  it('becomes an SVG image at its own size, its names as written, cleaned', () => {
    const html =
      '<p>Before</p><svg viewBox="0 0 80 40" width=80 preserveAspectRatio="xMidYMid meet" onload="alert(1)" class="figure" style="max-width:100%">' +
      '<title>Reading &amp; room</title><linearGradient id="g" gradientUnits="userSpaceOnUse"/><use xlink:href="#g"/>' +
      '<path d="M0 0L1 1"/><script>alert(2)</script><text>Desk</text></svg><p>After</p>'
    const out = inlineSvgElements(html)
    expect(out).toMatch(/^<p>Before<\/p><img src="data:image\/svg\+xml;base64,[^"]+" alt="Reading &amp; room" width="80" height="40" class="figure" style="max-width:100%"><p>After<\/p>$/)
    const [svg] = decoded(out)
    for (const kept of ['xmlns="http://www.w3.org/2000/svg"', 'xmlns:xlink="http://www.w3.org/1999/xlink"', 'viewBox="0 0 80 40"', 'preserveAspectRatio="xMidYMid meet"', 'gradientUnits="userSpaceOnUse"', '<text>Desk</text>']) {
      expect(svg).toContain(kept)
    }
    expect(svg).not.toContain('alert')
  })

  it("reads HTML's named entities as the characters they stand for", () => {
    const [svg] = decoded(inlineSvgElements('<svg width="4" height="4"><text>a&nbsp;b &copy; &lt;c&gt; &nosuch;</text></svg>'))
    expect(svg).toContain('<text>a&#160;b \u00a9 &lt;c&gt; &amp;nosuch;</text>')
  })

  it('leaves alone an SVG marked as decoration, one that runs on to the end, and a page without one', () => {
    for (const html of ['<svg aria-hidden="true" viewBox="0 0 4 4"><path d="M0 0"/></svg><p>x</p>', '<p>a</p><svg viewBox="0 0 4 4"><path d="M0 0"/><p>rest of page</p>', '<p>no svg</p>']) {
      expect(inlineSvgElements(html)).toBe(html)
    }
  })

  it('keeps a picture it names by address for the read step to fetch', () => {
    const [svg] = decoded(inlineSvgElements('<svg width="4" height="4"><image href="https://example.invalid/a.png" width="4" height="4"/></svg>'))
    expect(svg).toContain('href="https://example.invalid/a.png"')
  })
})
