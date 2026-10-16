import { describe, it, expect } from 'vitest'
import { generateJSON, generateHTML } from '@tiptap/html'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'
import { HUB_TAGS, sanitizeToHub } from '../../src/core/allowlist'
import { SPEAKER_NOTES_TAG } from '../../src/core/speaker-notes'

/**
 * allowlist.ts states the invariant that governs this editor: anything
 * `sanitizeToHub` passes must round-trip it losslessly. ProseMirror silently
 * DROPS nodes its schema does not model, so a tag added to HUB_TAGS without a
 * matching editor node deletes content the moment the user opens the edit
 * pane — with no error and nothing in the output to show it happened.
 *
 * Clipboard and URL input always go through the editor, so this is not a
 * hypothetical path; it is the ordinary one.
 */
const roundTrip = (html: string): string =>
  generateHTML(generateJSON(html, EDITOR_EXTENSIONS), EDITOR_EXTENSIONS)

describe('the editor round-trips what the hub allows', () => {
  it('keeps a speaker note, with its text', () => {
    const html = `<p>Slide body</p><${SPEAKER_NOTES_TAG}><p>say this bit</p></${SPEAKER_NOTES_TAG}>`
    const out = roundTrip(html)
    expect(out).toContain(`<${SPEAKER_NOTES_TAG}>`)
    expect(out).toContain('say this bit')
  })

  it('does not let a note swallow the body around it', () => {
    const out = roundTrip(`<p>before</p><${SPEAKER_NOTES_TAG}><p>n</p></${SPEAKER_NOTES_TAG}><p>after</p>`)
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('keeps superscript and subscript as themselves, not as plain text', () => {
    // The generic check below only asks that SOME tag survives, and <p>
    // would pass it after a <sup> had been dropped.
    expect(roundTrip('<p>x<sup>2</sup> H<sub>2</sub>O</p>')).toBe('<p>x<sup>2</sup> H<sub>2</sub>O</p>')
  })

  it('keeps footnotes exactly: references, labels and the notes list', () => {
    const html =
      '<p>A claim<sup data-fn="smith2020">1</sup> and<sup data-fn="2">2</sup>.</p>' +
      '<ol><li data-fn="smith2020"><p>Smith, 2020.</p></li><li data-fn="2"><p>One.</p><p>Two.</p></li></ol>'
    expect(roundTrip(html)).toBe(html)
  })

  it('leaves an ordinary numbered list and plain superscript as they are', () => {
    expect(roundTrip('<ol><li><p>one</p></li></ol>')).toBe('<ol><li><p>one</p></li></ol>')
    expect(roundTrip('<p>x<sup>2</sup></p>')).toBe('<p>x<sup>2</sup></p>')
  })

  it.each([
    ['a mermaid diagram', '<pre><code class="language-mermaid">graph TD\n  A --&gt; B &amp; C\n</code></pre>'],
    ['a dot diagram', '<pre><code class="language-dot">digraph { a -&gt; b }</code></pre>'],
    ['display math', '<pre><code class="language-math">\\sum_{i=1}^n i &lt; 3 \\\\\nx</code></pre>'],
    ['inline math', '<p>Let <code class="language-math">\\alpha_i &lt; 2</code> hold, and <code>plain</code>.</p>'],
    ['inline math in a list, a heading and a quote', '<ul><li><p><code class="language-math">x^2</code></p></li></ul><h2>On <code class="language-math">y</code></h2><blockquote><p><code class="language-math">z</code></p></blockquote>'],
    ['an ordinary code block beside them', '<pre><code class="language-python">x = 1</code></pre><pre><code class="language-math">a</code></pre>'],
    // A pasted snippet is given its language at intake (core/code-language.ts);
    // the pane must hand it back, or the conversion prints it uncoloured.
    ['a pasted code block with its guessed language', '<pre><code class="language-python">def f():\n    return 1</code></pre>'],
    // Word equations (step 19): math inside footnotes and endnotes, inline and display.
    [
      'math inside notes, as a Word file gives it',
      '<p>Claim<sup data-fn="1">1</sup> and<sup data-fn="e1">2</sup>.</p>' +
        '<ol><li data-fn="1"><p>Since <code class="language-math">x^{2}</code> grows.</p></li>' +
        '<li data-fn="e1"><p>The total:</p><pre><code class="language-math">\\sum_{i=1}^{30}d_{i}</code></pre></li></ol>',
    ],
  ])('keeps %s byte for byte (spec B1)', (_name, html) => {
    expect(roundTrip(html)).toBe(html)
  })

  // Opening a diagram or formula for editing and closing it with no change
  // keeps these bytes too: that needs the node views and a DOM, so it is in
  // block-views.test.ts ("opening and closing with no change ...").

  it('shows an SVG image (an .svg input, spec D10) as an ordinary image, and keeps it byte for byte', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="30"><rect width="48" height="30"/></svg>').toString('base64')
    const html = `<img src="data:image/svg+xml;base64,${svg}" alt="plan.svg" width="48" height="30">`
    const json = generateJSON(html, EDITOR_EXTENSIONS)
    expect(JSON.stringify(json)).toContain('"type":"image"')
    expect(JSON.stringify(json)).toContain(`data:image/svg+xml;base64,${svg}`)
    const out = roundTrip(html)
    expect(out).toContain(`src="data:image/svg+xml;base64,${svg}"`)
    expect(out).toContain('alt="plan.svg"')
  })

  it('shows diagram and formula source as nodes of their own, not as code', () => {
    const json = JSON.stringify(
      generateJSON(
        '<pre><code class="language-mermaid">m</code></pre><pre><code class="language-math">d</code></pre><p><code class="language-math">i</code></p>',
        EDITOR_EXTENSIONS,
      ),
    )
    expect(json).toContain('"type":"diagramBlock"')
    expect(json).toContain('"type":"mathBlock"')
    expect(json).toContain('"type":"mathInline"')
    expect(json).not.toContain('codeBlock')
  })

  it.each(
    HUB_TAGS.filter((t) => !['span', 'div', 'br', 'thead', 'tbody', 'tr', 'td', 'th', 'li'].includes(t)),
  )('models %s, so the editor cannot silently drop it', (tag) => {
    // Structural tags are exercised through their parents; the rest stand alone.
    const sample: Record<string, string> = {
      table: '<table><tbody><tr><td>c</td></tr></tbody></table>',
      ul: '<ul><li>i</li></ul>',
      ol: '<ol><li>i</li></ol>',
      pre: '<pre><code>x</code></pre>',
      img: '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAIBAAA=" alt="a">',
      a: '<p><a href="https://example.com">l</a></p>',
      hr: '<hr>',
      code: '<p><code>x</code></p>',
      aside: `<${SPEAKER_NOTES_TAG}><p>n</p></${SPEAKER_NOTES_TAG}>`,
    }
    const html = sample[tag] ?? `<${tag}>text</${tag}>`
    // Only assert against what the sanitiser would actually pass on.
    const sanitized = sanitizeToHub(html)
    if (!sanitized.includes('<')) return
    const out = roundTrip(sanitized)
    expect(out.replace(/\s+/g, '')).not.toBe('')
    expect(out).toMatch(/<[a-z]/)
  })
})
