import { describe, expect, it } from 'vitest'
import { sanitizeSvg, svgImageRefs, svgImageUrls, withSvgImagePictures } from '../../src/core/svg-sanitize'

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">'
const wrap = (inner: string): string => `${SVG_OPEN}${inner}</svg>`
const clean = (inner: string): string => sanitizeSvg(wrap(inner)) ?? 'NOT SVG'

/** The opening bytes of each picture type: enough for the sniff, which is all the sanitizer reads. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0])
const GIF = Buffer.from('GIF89a\x01\0\x01\0\x80\0\0', 'latin1')
const WEBP = Buffer.from('RIFF\x1a\0\0\0WEBPVP8L', 'latin1')

describe('sanitizeSvg (spec B6): hostile SVG corpus', () => {
  it('keeps an ordinary drawing as it is', () => {
    const out = clean('<defs><marker id="m"><path d="M0 0L1 1"/></marker></defs><g class="node"><rect width="4" height="4" style="fill:#eee"/><text x="1" y="2">Start &amp; end</text><path d="M0 0" marker-end="url(#m)"/><use href="#m"/></g><style>.node rect{fill:url(#g);font-family:Arial}</style>')
    expect(out).toContain('<rect')
    expect(out).toContain('Start &amp; end')
    expect(out).toContain('marker-end="url(#m)"')
    expect(out).toContain('<use href="#m"')
    expect(out).toContain('.node rect{fill:url(#g)')
    expect(out).toContain('viewBox="0 0 10 10"')
  })

  it('removes script, with any prefix or case', () => {
    for (const inner of [
      '<script>alert(1)</script>',
      '<SCRIPT>alert(1)</SCRIPT>',
      '<html:script xmlns:html="http://www.w3.org/1999/xhtml">alert(1)</html:script>',
      '<g><g><script href="http://evil.invalid/a.js"/></g></g>',
    ]) {
      const out = clean(inner)
      expect(out.toLowerCase()).not.toContain('script')
      expect(out).not.toContain('alert')
    }
  })

  it('removes foreignObject, iframe, image and other embedding elements', () => {
    const out = clean(
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject>' +
        '<iframe src="http://evil.invalid/"/><image href="http://evil.invalid/a.png"/><feImage href="#ok"/><embed src="x"/><object data="x"/>' +
        '<xhtml:link xmlns:xhtml="http://www.w3.org/1999/xhtml" rel="stylesheet" href="http://evil.invalid/a.css"/>',
    )
    expect(out).not.toMatch(/<(\w+:)?(foreignobject|iframe|image|feimage|embed|object|link)\b/i)
    expect(out).not.toContain('alert')
  })

  it('removes every on* handler, including on the root', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect onclick="a()" ONMOUSEOVER="b()" width="1"/><text onfocusin="c()">t</text></svg>',
    )!
    expect(out).not.toMatch(/\bon\w+=/i)
    expect(out).toContain('width="1"')
  })

  it('removes href and xlink:href unless they are a #fragment', () => {
    const out = clean(
      '<a href="javascript:alert(1)"><text>x</text></a><a xlink:href="http://example.invalid/"><text>y</text></a>' +
        '<use xlink:href="other.svg#a"/><use href=" data:image/svg+xml,&lt;svg/&gt;"/><a href="#local"><text>z</text></a>',
    )
    expect(out).not.toContain('javascript')
    expect(out).not.toContain('example.invalid')
    expect(out).not.toContain('other.svg')
    expect(out).not.toContain('data:')
    expect(out).toContain('href="#local"')
    expect(out).toContain('<text>x</text>')
  })

  it('removes xml:base, which would point fragments at another file', () => {
    expect(clean('<g xml:base="http://evil.invalid/"><use href="#a"/></g>')).not.toContain('evil')
  })

  it('removes a style element with @import or a remote url(), however it is spelled', () => {
    for (const css of [
      '@import url(http://evil.invalid/a.css);',
      '@IMPORT "http://evil.invalid/a.css";',
      '@im/**/port "x.css";',
      '.a{background:url(http://evil.invalid/a.png)}',
      ".a{background:url( 'https://evil.invalid/a.png' )}",
      '.a{background:URL(//evil.invalid/a.png)}',
      '.a{background:u\\72 l(http://evil.invalid/a.png)}',
      '.a{background:\\75\\72\\6c(http://evil.invalid/a.png)}',
      '.a{background-image:image-set("http://evil.invalid/a.png" 1x)}',
      '@font-face{font-family:f;src:url(data:font/woff2;base64,AAAA)}',
    ]) {
      const out = clean(`<style>${css}</style><rect width="1"/>`)
      expect(out, css).not.toContain('<style')
      expect(out, css).toContain('<rect')
    }
  })

  it('removes a style attribute or presentation attribute with a remote url()', () => {
    const out = clean(
      '<rect style="fill:url(http://evil.invalid/p.svg#g)" width="1"/><rect fill="url(http://evil.invalid/p.svg#g)" width="2"/>' +
        '<rect filter="url(https://evil.invalid/f.svg#f)" width="3"/><rect style="fill:url(#ok)" fill="url(#ok)" width="4"/>',
    )
    expect(out).not.toContain('evil')
    expect(out).toContain('style="fill:url(#ok)"')
    expect(out).toContain('fill="url(#ok)"')
    expect(out.match(/<rect/g)).toHaveLength(4)
  })

  it('removes animation that would set a reference or a handler', () => {
    const out = clean(
      '<a href="#x"><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="xlink:href" values="http://evil.invalid/"/><text>t</text></a>' +
        '<rect width="1"><set attributeName="onclick" to="alert(1)"/><animate attributeName="fill" values="url(http://evil.invalid/a)"/>' +
        '<animate attributeName="opacity" values="0;1" dur="1s"/></rect>',
    )
    expect(out).not.toContain('javascript')
    expect(out).not.toContain('evil')
    expect(out).not.toContain('<set')
    expect(out).toContain('attributeName="opacity"')
  })

  it('writes only the root: no doctype, entities, processing instructions or comments', () => {
    const out = sanitizeSvg(
      '<?xml-stylesheet href="http://evil.invalid/a.css"?><!DOCTYPE svg [<!ENTITY e "boom">]>' +
        `${SVG_OPEN}<!-- note --><text>&e;</text></svg>`,
    )!
    expect(out.startsWith('<svg')).toBe(true)
    expect(out).not.toContain('xml-stylesheet')
    expect(out).not.toContain('DOCTYPE')
    expect(out).not.toContain('boom')
    expect(out).not.toContain('note')
  })

  it('keeps an SVG nested as an <svg> element, cleaned like the rest', () => {
    const out = clean('<svg x="2" y="2" width="6" height="6" viewBox="0 0 6 6" onload="alert(1)"><script>alert(2)</script><rect width="6" height="6"/></svg>')
    expect(out).toMatch(/<svg x="2" y="2" width="6" height="6" viewBox="0 0 6 6"><rect width="6" height="6" \/><\/svg><\/svg>$/)
  })

  it('keeps an SVG image nested in an SVG, sanitized as the outer one is', () => {
    const inner =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" onload="alert(1)"><script>alert(2)</script>' +
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject>' +
      '<image href="http://evil.invalid/a.png"/><style>@import url(http://evil.invalid/a.css);</style>' +
      '<circle r="2" fill="url(http://evil.invalid/p.svg#g)"/><rect width="4" height="4" fill="#0a0"/></svg>'
    const forms = [
      `data:image/svg+xml;base64,${Buffer.from(inner).toString('base64')}`,
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(inner)}`,
      `data:image/svg+xml,${inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}`,
    ]
    for (const [i, src] of forms.entries()) {
      const attr = i === 1 ? 'xlink:href' : 'href'
      const out = clean(`<image x="1" y="1" width="4" height="4" ${attr}="${src}"/>`)
      const m = new RegExp(`<image x="1" y="1" width="4" height="4" ${attr}="data:image/svg\\+xml;base64,([A-Za-z0-9+/=]+)" />`).exec(out)
      expect(m, out).not.toBeNull()
      const kept = Buffer.from(m![1], 'base64').toString('utf8')
      expect(kept).toContain('<rect width="4" height="4" fill="#0a0" />')
      expect(kept).toContain('<circle r="2" />')
      for (const bad of ['alert', 'script', 'foreignObject', 'html', 'evil', '@import', '<image', 'onload']) expect(kept, bad).not.toContain(bad)
    }
  })

  it('sanitizes an SVG image nested several deep, and drops one nested too deep or not an SVG', () => {
    const svgUri = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    const level = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="1"/><image href="${inner}"/><script>x()</script></svg>`
    let src = svgUri('<svg xmlns="http://www.w3.org/2000/svg"><script>deep()</script><circle r="1"/></svg>')
    for (let i = 0; i < 2; i++) src = svgUri(level(src))
    // Three levels below the outer one: kept, every level clean.
    let out = clean(`<image href="${src}"/>`)
    let depth = 0
    for (let m = /href="data:image\/svg\+xml;base64,([^"]+)"/.exec(out); m; m = /href="data:image\/svg\+xml;base64,([^"]+)"/.exec(out)) {
      out = Buffer.from(m[1], 'base64').toString('utf8')
      expect(out).not.toContain('script')
      depth++
    }
    expect(depth).toBe(3)
    expect(out).toContain('<circle r="1" />')
    // Deeper than that: the innermost picture is dropped, the rest kept.
    for (let i = 0; i < 4; i++) src = svgUri(level(src))
    expect(clean(`<image href="${src}"/>`)).toContain('<image href="data:image/svg+xml;base64,')
    // Not an SVG, a remote SVG, or a raster that is not what it claims: dropped, as before.
    for (const href of [svgUri('<html><body>x</body></html>'), 'http://evil.invalid/a.svg', `data:image/png;base64,${JPEG.toString('base64')}`]) {
      expect(clean(`<image href="${href}"/><rect width="1"/>`), href).not.toContain('<image')
    }
  })

  it('keeps a PNG, JPEG, GIF or WebP picture placed in an SVG as a data URI, written as base64 of its own type', () => {
    for (const [claimed, bytes, mime] of [
      ['png', PNG, 'image/png'],
      ['jpeg', JPEG, 'image/jpeg'],
      ['jpg', JPEG, 'image/jpeg'],
      ['JPEG', JPEG, 'image/jpeg'],
      ['gif', GIF, 'image/gif'],
      ['webp', WEBP, 'image/webp'],
    ] as const) {
      const b64 = bytes.toString('base64')
      for (const [attr, src] of [
        ['href', `data:image/${claimed};base64,${b64}`],
        ['xlink:href', `data:image/${claimed};name=a.bin;base64,${b64}`],
        ['href', `data:image/${claimed},${[...bytes].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('')}`],
      ]) {
        const out = clean(`<image x="1" y="1" width="4" height="4" onload="alert(1)" ${attr}="${src}"><script>alert(2)</script></image>`)
        expect(out, `${claimed} ${src.slice(0, 30)}`).toContain(`<image x="1" y="1" width="4" height="4" ${attr}="data:${mime};base64,${b64}" />`)
        expect(out).not.toContain('alert')
      }
    }
  })

  it('drops a picture in an SVG whose bytes are not the type it claims, or not a picture it keeps', () => {
    for (const href of [
      `data:image/png;base64,${JPEG.toString('base64')}`,
      `data:image/gif;base64,${PNG.toString('base64')}`,
      `data:image/webp;base64,${Buffer.from('RIFF\0\0\0\0WAVEfmt ').toString('base64')}`,
      `data:image/jpeg;base64,${Buffer.from('<html><script>alert(1)</script></html>').toString('base64')}`,
      `data:image/bmp;base64,${Buffer.from('BM\0\0\0\0\0\0').toString('base64')}`,
      `data:text/html;base64,${PNG.toString('base64')}`,
      'data:image/png;base64,',
    ]) {
      expect(clean(`<image href="${href}"/><rect width="1"/>`), href).not.toContain('<image')
    }
    // Two references could disagree on what is shown.
    const png = `data:image/png;base64,${PNG.toString('base64')}`
    expect(clean(`<image href="${png}" xlink:href="${png}"/>`)).not.toContain('<image')
  })

  it('shows a picture named by a web address as its description in text, as a failed <img> is shown', () => {
    const out = clean('<g transform="translate(2 0)"><image x="1" y="2" width="6" height="4" transform="rotate(5)" href="https://example.invalid/desk.png"><title>Desk photo</title></image></g>')
    expect(out).not.toContain('<image')
    expect(out).not.toContain('example.invalid')
    const text = /<text ([^>]*)>\[image: Desk photo\]<\/text>/.exec(out)
    expect(text, out).not.toBeNull()
    // At the picture's corner, the line no taller than the picture, turned with it.
    for (const a of ['x="1"', 'y="6"', 'font-size="4"', 'transform="rotate(5)"']) expect(text![1]).toContain(a)
    // A relative or protocol-relative address too; with no description, "not included".
    for (const href of ['photos/desk.png', '//cdn.example.invalid/desk.png', 'http://example.invalid/desk.png']) {
      expect(clean(`<image xlink:href="${href}"/>`), href).toContain('>[image: not included]</text>')
    }
    expect(clean('<image aria-label="Shelf &amp; desk" href="https://example.invalid/a.png"/>')).toContain('>[image: Shelf &amp; desk]</text>')
    // What is not a web address is dropped as before, with nothing in its place.
    for (const href of ['javascript:alert(1)', 'file:///etc/passwd', '#local', 'data:image/bmp;base64,Qk0=']) {
      const dropped = clean(`<image href="${href}"/><rect width="1"/>`)
      expect(dropped, href).not.toContain('<image')
      expect(dropped, href).not.toContain('<text')
    }
  })

  it('keeps a picture named by a web address for the read step to fetch, when asked, and nothing else', () => {
    const svg = wrap(
      '<image x="1" width="4" height="4" onload="alert(1)" href="https://example.invalid/a.png"><title>Desk photo</title><script>alert(2)</script></image>' +
        '<image xlink:href="photos/b.png"/><image href="javascript:alert(3)"/><script>alert(4)</script>',
    )
    const out = sanitizeSvg(svg, { keepImageUrls: true })!
    expect(out).toContain('<image aria-label="Desk photo" x="1" width="4" height="4" href="https://example.invalid/a.png" />')
    expect(out).toContain('<image xlink:href="photos/b.png" />')
    expect(out).not.toContain('alert')
    expect(out).not.toContain('javascript')
    // Sanitized again without asking (as every SVG is once its pictures are fetched), they become text.
    expect(sanitizeSvg(out)).toContain('>[image: Desk photo]</text>')
  })

  it('keeps a web address in an SVG nested as a data URI too, when asked', () => {
    const inner = wrap('<image width="4" height="4" href="https://example.invalid/a.png"><title>Desk photo</title></image>')
    const svg = wrap(`<image width="8" height="8" href="data:image/svg+xml;base64,${Buffer.from(inner).toString('base64')}"/>`)
    const nestedOf = (out: string): string =>
      Buffer.from(/href="data:image\/svg\+xml;base64,([^"]+)"/.exec(out)![1], 'base64').toString('utf8')
    const kept = sanitizeSvg(svg, { keepImageUrls: true })!
    expect(nestedOf(kept)).toContain('href="https://example.invalid/a.png"')
    expect(nestedOf(sanitizeSvg(kept)!)).toContain('>[image: Desk photo]</text>')
    expect(nestedOf(sanitizeSvg(kept)!)).not.toContain('example.invalid')
  })

  it('lists every picture reference, data URIs and repeats included', () => {
    const png = `data:image/png;base64,${PNG.toString('base64')}`
    const svg = wrap(`<image href="a.png"/><g><image href="${png}"/></g><image href="a.png"/>`)
    expect(svgImageRefs(svg)).toEqual(['a.png', png, 'a.png'])
    expect(svgImageRefs('not an svg')).toEqual([])
  })

  it('lists the web addresses an SVG\'s pictures name, and puts fetched pictures in their place', () => {
    const png = `data:image/png;base64,${PNG.toString('base64')}`
    const svg = wrap(`<image href="https://example.invalid/a.png"/><g><image xlink:href="//example.invalid/b.png"/></g><image href="${png}"/><image href="#x"/>`)
    expect(svgImageUrls(svg)).toEqual(['https://example.invalid/a.png', '//example.invalid/b.png'])
    const out = withSvgImagePictures(svg, new Map([['https://example.invalid/a.png', png]]))
    expect(out).toContain(`<image href="${png}" />`)
    expect(out).toContain('<image xlink:href="//example.invalid/b.png" />')
    expect(svgImageUrls('not an svg')).toEqual([])
    // An address is read as text: `&amp;` in the markup is `&` in the address.
    const query = wrap('<image href="https://example.invalid/p?w=4&amp;h=4"/>')
    expect(svgImageUrls(query)).toEqual(['https://example.invalid/p?w=4&h=4'])
    expect(withSvgImagePictures(query, new Map([['https://example.invalid/p?w=4&h=4', png]]))).toContain(`<image href="${png}" />`)
  })

  it('refuses what is not an SVG', () => {
    expect(sanitizeSvg('<html><body>x</body></html>')).toBeNull()
    expect(sanitizeSvg('')).toBeNull()
  })
})
