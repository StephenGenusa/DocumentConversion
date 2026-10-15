import { describe, expect, it } from 'vitest'
import { sanitizeSvg } from '../../src/core/svg-sanitize'

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">'
const wrap = (inner: string): string => `${SVG_OPEN}${inner}</svg>`
const clean = (inner: string): string => sanitizeSvg(wrap(inner)) ?? 'NOT SVG'

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

  it('refuses what is not an SVG', () => {
    expect(sanitizeSvg('<html><body>x</body></html>')).toBeNull()
    expect(sanitizeSvg('')).toBeNull()
  })
})
