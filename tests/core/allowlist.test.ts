import { describe, it, expect } from 'vitest'
import { HUB_TAGS, sanitizeToHub } from '../../src/core/allowlist'

/** Everything XML 1.0 forbids that HTML happily carries. */
const XML_ILLEGAL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('shared hub allowlist', () => {
  it('includes the structures the editor schema must model', () => {
    for (const t of ['table', 'tr', 'td', 'th', 'img', 'a', 'pre', 'code', 'blockquote', 'hr', 'h1']) {
      expect(HUB_TAGS).toContain(t)
    }
  })

  it('keeps data: URIs on img (inlined images must survive)', () => {
    const out = sanitizeToHub('<img src="data:image/png;base64,AAAA" alt="x">')
    expect(out).toContain('data:image/png;base64,AAAA')
  })

  it('keeps http(s) img sources', () => {
    expect(sanitizeToHub('<img src="https://example.com/a.png">')).toContain('https://example.com/a.png')
  })

  it('keeps colspan/rowspan on table cells', () => {
    const out = sanitizeToHub('<table><tr><td colspan="2" rowspan="3">x</td></tr></table>')
    expect(out).toContain('colspan="2"')
    expect(out).toContain('rowspan="3"')
  })

  it('strips Office cruft but keeps its text', () => {
    const out = sanitizeToHub('<p>Hello<o:p></o:p> <span style="mso-bidi-font-weight:bold">world</span></p>')
    expect(out).not.toContain('o:p')
    expect(out).not.toContain('mso-')
    expect(out).toContain('Hello')
    expect(out).toContain('world')
  })

  it('removes scripts entirely and event handlers', () => {
    const out = sanitizeToHub('<p onclick="x()">hi</p><script>alert(1)</script><img src="x" onerror="p()">')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('onerror')
  })

  // D3. These characters are legal in HTML text but forbidden by XML, and both
  // the docx and the epub writer emit XML: one stray U+0008 is enough for Word
  // or a reader to refuse the whole file. The hub is the last place to catch it.
  it('strips XML-illegal control characters', () => {
    const ctl = [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1a, 0x1f].map((c) => String.fromCharCode(c)).join('')
    const out = sanitizeToHub(`<p>before${ctl}after</p>`)
    expect(out).toContain('beforeafter')
    expect(out).not.toMatch(XML_ILLEGAL)
  })

  it('strips control characters written as numeric character references', () => {
    const out = sanitizeToHub('<p>a&#x8;b&#11;c&#31;d</p>')
    expect(out).not.toMatch(XML_ILLEGAL)
    expect(out).toContain('a')
    expect(out).toContain('d')
  })

  it('strips control characters out of attribute values too', () => {
    const out = sanitizeToHub('<img src="https://example.com/a.png" alt="a&#x8;b">')
    expect(out).not.toMatch(XML_ILLEGAL)
  })

  it('keeps tab, newline and carriage return', () => {
    const out = sanitizeToHub('<pre><code>a\tb\nc\r\nd</code></pre>')
    expect(out).toContain('a\tb')
    expect(out).toContain('\n')
  })

  it('drops unpaired surrogates and non-characters, which XML also forbids', () => {
    const out = sanitizeToHub(`<p>x${String.fromCharCode(0xd800)}y${String.fromCharCode(0xfffe)}z</p>`)
    expect(out).toContain('xyz')
    expect(out).not.toMatch(XML_ILLEGAL)
  })

  it('leaves ordinary text alone, astral characters included', () => {
    const text = 'Café — “quoted” 你好 \u{1f600}'
    expect(sanitizeToHub(`<p>${text}</p>`)).toContain(text)
  })

  it('keeps code language classes', () => {
    const out = sanitizeToHub('<pre><code class="language-ts">let x</code></pre>')
    expect(out).toContain('language-ts')
  })
})
