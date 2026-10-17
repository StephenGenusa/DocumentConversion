import { describe, it, expect } from 'vitest'
import { readTextile } from '../../src/core/readers/textile'
import { detect } from '../../src/core/detect'

const read = (text: string, filename = 'notes.textile') => readTextile({ bytes: Buffer.from(text, 'utf8'), filename })

const SAMPLER = `h1. Release _notes_

h2. Changes

Some _emphasis_, *strong* text and a "link":https://example.com/.

* one
* two

|_. Name |_. Count |
| a | 1 |

bc. let x = 1 < 2
`

describe('Textile', () => {
  it('reads headings, emphasis, lists, a table, a link and code', async () => {
    const hub = await read(SAMPLER)
    expect(hub.html).toContain('<h1>Release <em>notes</em></h1>')
    expect(hub.html).toContain('<h2>Changes</h2>')
    expect(hub.html).toContain('<em>emphasis</em>, <strong>strong</strong> text and a <a href="https://example.com/">link</a>.')
    expect(hub.html.replace(/\s+/g, '')).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(hub.html.replace(/\s+/g, '')).toContain('<table><tr><th>Name</th><th>Count</th></tr><tr><td>a</td><td>1</td></tr></table>')
    expect(hub.html).toContain('<pre><code>let x = 1 &lt; 2</code></pre>')
  })

  it('takes the title from the first top-level heading, else the file name', async () => {
    expect((await read(SAMPLER)).title).toBe('Release notes')
    expect((await read('h2. Only a subheading\n', 'plain.textile')).title).toBe('plain.textile')
  })

  it('writes footnotes in the hub model, as one list at the end', async () => {
    const hub = await read('A claim[1] and another[2!].\n\nfn1. First _note_.\n\nfn2. Second.\n\nMore text.\n')
    expect(hub.html).toContain('A claim<sup data-fn="1">1</sup> and another<sup data-fn="2">2</sup>.')
    expect(hub.html).toContain('<p>More text.</p>')
    expect(hub.html).toMatch(/<ol><li data-fn="1"><p>First <em>note<\/em>.<\/p><\/li><li data-fn="2"><p>Second.<\/p><\/li><\/ol>$/)
    expect(hub.html).not.toContain('href="#')
    expect(hub.html).not.toContain('class=')
  })

  it('reads a footnote with a backlink (`fn1^.`) as it reads `fn1.`', async () => {
    const plain = await read('A claim[1] and another[2].\n\nfn1. First _note_.\n\nfn2. Second.\n')
    const linked = await read('A claim[1] and another[2].\n\nfn1^. First _note_.\n\nfn2(note)^. Second.\n')
    expect(linked.html).toBe(plain.html)
    expect(linked.html).toMatch(/<ol><li data-fn="1"><p>First <em>note<\/em>.<\/p><\/li><li data-fn="2"><p>Second.<\/p><\/li><\/ol>$/)
    // Only at the start of a block: in a sentence it is text.
    expect((await read('See fn1^. in the manual.\n')).html).toBe('<p>See fn1^. in the manual.</p>')
  })

  it('keeps superscript and subscript', async () => {
    const hub = await read('H[~2~]O and x[^2^]\n')
    expect(hub.html).toContain('<p>H<sub>2</sub>O and x<sup>2</sup></p>')
  })

  it('sanitizes raw HTML', async () => {
    const hub = await read(
      [
        '<script>alert(1)</script><img src="https://example.com/a.png" onerror="alert(2)">',
        '',
        '"bad":javascript:alert(3)',
        '',
        'notextile. <b onclick="alert(4)">raw</b>',
        '',
      ].join('\n'),
    )
    expect(hub.html).not.toMatch(/<script|alert|onerror|onclick|javascript:/i)
    expect(hub.html).toContain('<img src="https://example.com/a.png" />')
    expect(hub.html).toContain('<b>raw</b>')
  })

  it('is detected by extension', () => {
    const d = detect(Buffer.from('h1. hi\n'), 'a.TEXTILE')
    expect(d.kind === 'ok' && d.format).toBe('textile')
  })
})
