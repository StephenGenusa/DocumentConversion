import { describe, it, expect } from 'vitest'
import { looksLikeFormattedHtml, shouldUseHtmlFlavor } from '../../src/core/paste-flavors'

/**
 * Copying text puts two flavors on the clipboard, and which one is right
 * depends on the source. Word, Teams and a rendered web page put real markup in
 * the HTML flavor and it must win. A chat window, an editor or a terminal put
 * the SAME plain characters in both, the HTML one merely wrapped for
 * whitespace — and there the plain flavor is the better copy, because it can
 * still be read as markdown.
 */
describe('looksLikeFormattedHtml', () => {
  it('rejects the whitespace wrapper a browser puts around copied plain text', () => {
    const wrapped = `<meta charset='utf-8'><span style="white-space:pre-wrap">| a | b |<br>|---|---|</span>`
    expect(looksLikeFormattedHtml(wrapped)).toBe(false)
  })

  it('rejects the div-per-line wrapper', () => {
    expect(looksLikeFormattedHtml('<div>line one</div><div>line two</div>')).toBe(false)
  })

  it('accepts a real table', () => {
    expect(looksLikeFormattedHtml('<table><tr><td>a</td></tr></table>')).toBe(true)
  })

  it('accepts paragraphs and headings', () => {
    expect(looksLikeFormattedHtml('<p>hello</p>')).toBe(true)
    expect(looksLikeFormattedHtml('<h2>Title</h2>')).toBe(true)
  })

  it('accepts inline formatting and links', () => {
    expect(looksLikeFormattedHtml('<span><b>bold</b></span>')).toBe(true)
    expect(looksLikeFormattedHtml('<div><a href="https://x.example">link</a></div>')).toBe(true)
  })

  it('accepts a copied code block, so its indentation is not re-read as markdown', () => {
    expect(looksLikeFormattedHtml('<pre><code>const x = 1</code></pre>')).toBe(true)
  })

  it('accepts lists and images', () => {
    expect(looksLikeFormattedHtml('<ul><li>one</li></ul>')).toBe(true)
    expect(looksLikeFormattedHtml('<img src="data:image/png;base64,AAA">')).toBe(true)
  })

  it('is not fooled by a tag name appearing as text', () => {
    expect(looksLikeFormattedHtml('<span>use a &lt;table&gt; element</span>')).toBe(false)
  })
})

describe('shouldUseHtmlFlavor', () => {
  it('uses the HTML flavor for genuinely formatted content', () => {
    expect(shouldUseHtmlFlavor('<p>rich <b>text</b></p>', 'rich text')).toBe(true)
  })

  it('prefers the plain flavor when the HTML is only a wrapper', () => {
    const wrapped = `<span style="white-space:pre-wrap">| a | b |</span>`
    expect(shouldUseHtmlFlavor(wrapped, '| a | b |')).toBe(false)
  })

  it('uses the HTML flavor when there is no plain flavor to fall back to', () => {
    const wrapped = `<span style="white-space:pre-wrap">something</span>`
    expect(shouldUseHtmlFlavor(wrapped, '')).toBe(true)
  })

  it('declines an empty HTML flavor', () => {
    expect(shouldUseHtmlFlavor('', 'plain words')).toBe(false)
    expect(shouldUseHtmlFlavor('   ', 'plain words')).toBe(false)
  })
})
