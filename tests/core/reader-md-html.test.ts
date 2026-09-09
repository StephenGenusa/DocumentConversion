import { describe, it, expect } from 'vitest'
import { readMarkdown } from '../../src/core/readers/md'

const src = (s: string) => ({ bytes: Buffer.from(s, 'utf8') })

/**
 * Inline HTML is part of the markdown spec and real documents lean on it.
 * With `html: false` the notebook corpus rendered `<img src='...' width=70%>`
 * as VISIBLE TEXT and the image never appeared — confirmed by eye in a PDF.
 * Turning html on means the reader must sanitize, since markdown is untrusted.
 */
describe('readMarkdown inline html', () => {
  it('renders an inline <img> instead of printing its tag as text', async () => {
    const doc = await readMarkdown(src("<img src='https://example.org/a.jpg' width=70%>\n"))
    expect(doc.html).toContain('<img')
    expect(doc.html).toContain('https://example.org/a.jpg')
    expect(doc.html).not.toContain('&lt;img')
  })

  it('keeps a remote image as a remote reference with its dimensions', async () => {
    const doc = await readMarkdown(src('<img src="https://example.org/b.png" width="300" height="200" alt="fig">\n'))
    expect(doc.html).toMatch(/<img[^>]*src="https:\/\/example\.org\/b\.png"/)
    expect(doc.html).toContain('width="300"')
    expect(doc.html).toContain('height="200"')
    expect(doc.html).toContain('alt="fig"')
  })

  it('renders a block-level html image on its own line', async () => {
    // Absolute src: a relative one is unresolvable and is dropped (below).
    const doc = await readMarkdown(src('<center>\n<img src="https://example.org/stickers.jpg" />\n</center>\n'))
    expect(doc.html).toContain('<img')
    expect(doc.html).not.toContain('&lt;center&gt;')
    expect(doc.html).not.toContain('<center>')
  })

  it('drops unknown tags but keeps their text', async () => {
    const doc = await readMarkdown(src('<spoiler title="List of articles">\n\nsee below\n\n</spoiler>\n'))
    expect(doc.html).not.toContain('spoiler')
    expect(doc.html).toContain('see below')
  })

  it('strips scripts and their contents', async () => {
    const doc = await readMarkdown(src('before\n\n<script>alert(1)</script>\n\nafter\n'))
    expect(doc.html).not.toContain('script')
    expect(doc.html).not.toContain('alert(1)')
    expect(doc.html).toContain('before')
    expect(doc.html).toContain('after')
  })

  it('strips style blocks and event handlers', async () => {
    const doc = await readMarkdown(src('<style>.a{color:red}</style>\n\n<div onclick="steal()">text</div>\n'))
    expect(doc.html).not.toContain('color:red')
    expect(doc.html).not.toContain('onclick')
    expect(doc.html).toContain('text')
  })

  it('refuses a javascript: link', async () => {
    const doc = await readMarkdown(src('<a href="javascript:alert(1)">click</a>\n'))
    expect(doc.html).not.toContain('javascript:')
    expect(doc.html).toContain('click')
  })

  it('still renders ordinary markdown, fences and links', async () => {
    const doc = await readMarkdown(src('# Title\n\n**bold** and [a](https://example.org)\n\n```python\nx = 1\n```\n'))
    expect(doc.html).toContain('<h1>Title</h1>')
    expect(doc.html).toContain('<strong>bold</strong>')
    expect(doc.html).toContain('<a href="https://example.org">a</a>')
    // The shell's highlighter matches this exact shape; it must survive sanitizing.
    expect(doc.html).toContain('<pre><code class="language-python">')
    expect(doc.html).toContain('x = 1')
  })

  it('leaves straight quotes and dashes alone (typographer stays off)', async () => {
    const doc = await readMarkdown(src('He said "no" -- it\'s a converter...\n'))
    expect(doc.html).toMatch(/(&quot;|")no(&quot;|")/)
    expect(doc.html).toContain('--')
    expect(doc.html).not.toMatch(/[“”—…]/)
  })

  /**
   * sanitize-html decodes `&quot;` in text back to a bare `"`. That is valid
   * html, but markdown-it escapes it and the whole pipeline was built on
   * markdown-it's escaping — so turning html on must not change the output of
   * a document that contains no raw html at all.
   */
  it('keeps markdown-it quote escaping, in prose and inside inline code', async () => {
    const doc = await readMarkdown(src('Call `f("a", "b")` and pass "literal" strings.\n'))
    expect(doc.html).toContain('<code>f(&quot;a&quot;, &quot;b&quot;)</code>')
    expect(doc.html).toContain('pass &quot;literal&quot; strings')
  })

  it('escapes quotes in text without touching attribute values', async () => {
    // The src is absolute deliberately: a relative one cannot resolve away from
    // its source directory and is stripped (see the broken-image tests below),
    // which would take the attribute this test is about with it.
    const doc = await readMarkdown(src('<img src="https://example.org/a.png" alt="a > b" title="t"> then "quoted"\n'))
    expect(doc.html).toContain('src="https://example.org/a.png"')
    expect(doc.html).toContain('alt="a &gt; b"')
    expect(doc.html).toContain('&quot;quoted&quot;')
    expect(doc.html).not.toContain('src=&quot;')
  })

  it('escapes html written inside a fenced code block', async () => {
    const doc = await readMarkdown(src('```html\n<img src="x.png">\n```\n'))
    expect(doc.html).toContain('&lt;img')
    expect(doc.html).not.toMatch(/<code[^>]*><img/)
  })
})

/**
 * A markdown document is bytes plus a bare filename: there is no base URL to
 * resolve `../../img/ods_stickers.jpg` against, and the converted document is
 * read somewhere else entirely, so such an image can only ever paint a
 * broken-image icon. Every notebook in the corpus opens with one.
 *
 * The remedy is the one `src/core/readers/html.ts` already applies for exactly
 * this reason: strip the src and let `sanitizeToHub` decide what a contentless
 * image becomes — its alt text in a span, or nothing.
 */
describe('readMarkdown unresolvable images', () => {
  it('drops a relative inline-html image that has no alt', async () => {
    const doc = await readMarkdown(src('<img src="../../img/ods_stickers.jpg" />\n'))
    expect(doc.html).not.toContain('<img')
    expect(doc.html).not.toContain('ods_stickers')
  })

  it('keeps the alt text of a relative image as a span', async () => {
    const doc = await readMarkdown(src('<img src="../../img/fig.png" alt="Benchmarking chart">\n'))
    expect(doc.html).not.toContain('<img')
    expect(doc.html).toContain('<span>[Benchmarking chart]</span>')
  })

  it('drops a relative markdown-syntax image the same way', async () => {
    const doc = await readMarkdown(src('![Prophet](../../img/benchmarking-chart.png)\n'))
    expect(doc.html).not.toContain('<img')
    expect(doc.html).toContain('[Prophet]')
  })

  it('drops a root-relative image', async () => {
    const doc = await readMarkdown(src('<img src="/_layouts/15/images/spcommon.png?rev=43">\n'))
    expect(doc.html).not.toContain('<img')
    expect(doc.html).not.toContain('spcommon')
  })

  it('keeps http, https and data images untouched', async () => {
    const doc = await readMarkdown(
      src(
        [
          '<img src="https://example.org/a.png" width=70%>',
          '',
          '<img src="http://example.org/b.png" alt="b">',
          '',
          '<img src="data:image/png;base64,AAAA" alt="inline">',
          '',
        ].join('\n'),
      ),
    )
    expect(doc.html).toContain('src="https://example.org/a.png"')
    expect(doc.html).toContain('src="http://example.org/b.png"')
    expect(doc.html).toContain('src="data:image/png;base64,AAAA"')
    expect((doc.html.match(/<img/g) ?? []).length).toBe(3)
  })

  it('leaves relative links alone — only images cannot degrade to text', async () => {
    const doc = await readMarkdown(src('See [the notes](../notes.md).\n'))
    expect(doc.html).toContain('href="../notes.md"')
  })

  it('changes nothing about a document with no images in it', async () => {
    const source = '# Title\n\nCall `f("a", "b")` and pass "literal" strings.\n\n```python\nx = 1\n```\n'
    const doc = await readMarkdown(src(source))
    expect(doc.html).toContain('<code>f(&quot;a&quot;, &quot;b&quot;)</code>')
    expect(doc.html).toContain('<pre><code class="language-python">')
  })
})
