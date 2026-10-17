import { describe, it, expect } from 'vitest'
import { readDjot } from '../../src/core/readers/djot'
import { detect } from '../../src/core/detect'

const read = (text: string, filename = 'notes.dj') => readDjot({ bytes: Buffer.from(text, 'utf8'), filename })

const SAMPLER = `# Release _notes_

## Changes

Some _emphasis_, *strong* text and a [link](https://example.com/).

- one
- two

| Name | Count |
|------|------:|
| a    | 1     |

\`\`\` js
let x = 1 < 2
\`\`\`
`

describe('Djot', () => {
  it('reads headings, emphasis, lists, a table, a link and code', async () => {
    const hub = await read(SAMPLER)
    expect(hub.html).toContain('<h1>Release <em>notes</em></h1>')
    expect(hub.html).toContain('<h2>Changes</h2>')
    expect(hub.html).toContain('<em>emphasis</em>, <strong>strong</strong> text and a <a href="https://example.com/">link</a>.')
    expect(hub.html.replace(/\s+/g, '')).toContain('<ul><li>one</li><li>two</li></ul>')
    // `------:` right-aligns the column, which the hub keeps (src/core/cell-align.ts).
    expect(hub.html.replace(/>\s+</g, '><')).toContain('<table><tr><th>Name</th><th style="text-align:right">Count</th></tr><tr><td>a</td><td style="text-align:right">1</td></tr></table>')
    expect(hub.html).toContain('<pre><code class="language-js">let x = 1 &lt; 2\n</code></pre>')
    expect(hub.html).not.toContain('<section')
  })

  it('takes the title from the first top-level heading, else the file name', async () => {
    expect((await read(SAMPLER)).title).toBe('Release notes')
    expect((await read('## Only a subheading\n', 'plain.djot')).title).toBe('plain.djot')
  })

  it('writes footnotes in the hub model, keeping the labels and a note nothing references', async () => {
    const hub = await read(
      'A claim[^smith2020] and another[^b], again[^smith2020].\n\n[^b]: Second.\n\n[^smith2020]: First note.\n\n[^spare]: Never cited.\n',
    )
    expect(hub.html).toContain(
      'A claim<sup data-fn="smith2020">1</sup> and another<sup data-fn="b">2</sup>, again<sup data-fn="smith2020">1</sup>.',
    )
    expect(hub.html).toMatch(
      /<ol><li data-fn="smith2020"><p>First note.<\/p><\/li><li data-fn="b"><p>Second.<\/p><\/li><li data-fn="spare"><p>Never cited.<\/p><\/li><\/ol>$/,
    )
    expect(hub.html).not.toContain('doc-backlink')
    expect(hub.html).not.toContain('<hr')
  })

  it('makes an unsafe note label safe', async () => {
    const hub = await read('Text[^a note!].\n\n[^a note!]: Body.\n')
    expect(hub.html).toContain('<sup data-fn="a-note">1</sup>')
    expect(hub.html).toContain('<li data-fn="a-note"><p>Body.</p></li>')
  })

  it('keeps superscript and subscript', async () => {
    const hub = await read('H~2~O and x^2^\n')
    expect(hub.html).toContain('<p>H<sub>2</sub>O and x<sup>2</sup></p>')
  })

  it('marks task list items with ballot boxes', async () => {
    const hub = await read('- [ ] todo\n- [x] done\n')
    expect(hub.html.replace(/\n/g, '')).toBe('<ul><li>☐ todo</li><li>☑ done</li></ul>')
    const loose = await read('- [ ] todo\n\n- [X] done\n')
    expect(loose.html.replace(/\n/g, '')).toBe('<ul><li><p>☐ todo</p></li><li><p>☑ done</p></li></ul>')
  })

  it('writes math in the hub forms, the TeX byte for byte', async () => {
    const hub = await read('Inline $`x^2 + y_1 & z` here, and\n$$`\\frac{a}{b} < c`\nafter.\n')
    expect(hub.html).toContain('<p>Inline <code class="language-math">x^2 + y_1 &amp; z</code> here, and</p>')
    expect(hub.html).toContain('<pre><code class="language-math">\\frac{a}{b} &lt; c</code></pre>')
    expect(hub.html).toContain('<p>after.</p>')
    expect(hub.html).not.toMatch(/<p>\s*<pre/)
  })

  it('unwraps divs and keeps their contents', async () => {
    const hub = await read('::: warning\nInside the div.\n:::\n')
    expect(hub.html.trim()).toBe('<p>Inside the div.</p>')
  })

  // @djot/djot 0.3.2 drops the run of text before `![` on the same line.
  it('keeps the text before an image', async () => {
    const img = (alt: string) => `<img alt="${alt}" src="https://example.com/a.png" />`
    const at = (alt: string) => `![${alt}](https://example.com/a.png)`
    const hub = await read(
      [
        `See the café chart ${at('c')} and ${at('d')}, then *bold* tail ${at('e')}.`,
        '',
        `# Head with ${at('h')}`,
        '',
        `| cell with ${at('t')} | b |`,
        '',
        `- [ ] task with ${at('k')}`,
        '',
        `one`,
        `  two ${at('l')}`,
        '',
        `x.${at('m')} _in em ${at('n')}_`,
        '',
      ].join('\n'),
    )
    expect(hub.html).toContain(`<p>See the café chart ${img('c')} and ${img('d')}, then <strong>bold</strong> tail ${img('e')}.</p>`)
    expect(hub.html).toContain(`<h1>Head with ${img('h')}</h1>`)
    expect(hub.html).toContain(`<td>cell with ${img('t')}</td>`)
    expect(hub.html).toContain(`<li>☐ task with ${img('k')}</li>`)
    expect(hub.html).toContain(`<p>one\ntwo ${img('l')}</p>`)
    expect(hub.html).toContain(`<p>x.${img('m')} <em>in em ${img('n')}</em></p>`)
    expect(hub.html).not.toContain('data-')
  })

  it('sanitizes raw HTML', async () => {
    const hub = await read(
      [
        'Raw `<script>alert(1)</script><img src="https://example.com/a.png" onerror="alert(2)">`{=html} inline.',
        '',
        '```=html',
        '<a href="javascript:alert(3)">click</a><script>alert(4)</script>',
        '```',
        '',
        '[bad](javascript:alert(5))',
        '',
      ].join('\n'),
    )
    expect(hub.html).not.toMatch(/<script|alert|onerror|javascript:/i)
    expect(hub.html).toContain('<img src="https://example.com/a.png" />')
    expect(hub.html).toContain('click')
  })

  it('is detected by extension', () => {
    for (const name of ['a.dj', 'b.DJOT']) {
      const d = detect(Buffer.from('# hi\n'), name)
      expect(d.kind === 'ok' && d.format).toBe('djot')
    }
  })
})
