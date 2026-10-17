import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { highlightMarkup } from '../../src/core/code-markup'
import { highlightedRuns } from '../../src/core/hljs'
import { createConverter } from '../../src/core/convert'

/*
 * A code block with a language and the author's markup (rustdoc and javadoc
 * link every type to its page): the writers color it and keep the markup,
 * the token spans laid inside the author's tags (mergeStreams-style).
 */

describe('highlightMarkup', () => {
  it('lays the token spans inside the author tags', () => {
    expect(highlightMarkup('fn <a href="https://example.com/p">parse</a>(s: &amp;<b>str</b>)', 'rust')).toBe(
      '<span class="hljs-keyword">fn</span> <a href="https://example.com/p"><span class="hljs-title function_">parse</span></a>' +
        '(s: &amp;<b><span class="hljs-type">str</span></b>)',
    )
  })

  it('closes a token around an author tag that starts inside it, and opens it again', () => {
    expect(highlightMarkup('x = "a <i>b</i> c"', 'python')).toBe(
      'x = <span class="hljs-string">"a </span><i><span class="hljs-string">b</span></i><span class="hljs-string"> c"</span>',
    )
  })

  it('keeps a tag across lines, and reads a <br> as the newline', () => {
    expect(highlightMarkup('<em># one<br># two</em>', 'python')).toBe(
      '<em><span class="hljs-comment"># one</span>\n<span class="hljs-comment"># two</span></em>',
    )
  })

  it('drops tags the hub does not keep in code, as before', () => {
    expect(highlightMarkup('<span>x</span> = 1', 'python')).toBe('x = <span class="hljs-number">1</span>')
  })

  it('docx runs keep the author tags between the colored runs', () => {
    expect(highlightedRuns(highlightMarkup('def <b>total</b>():\n    <a href="https://example.com">pass</a>', 'python'))).toBe(
      '<span style="color: #cf222e">def</span> <b><span style="color: #8250df">total</span></b>():\n' +
        '    <a href="https://example.com"><span style="color: #cf222e">pass</span></a>',
    )
  })
})

const PAGE =
  '<html><body><pre><code class="language-rust">pub fn <a href="https://docs.rs/p/fn.parse.html">parse</a>(s: &amp;<b>str</b>) -&gt; ' +
  '<a href="https://docs.rs/p/enum.Option.html">Option</a>&lt;u32&gt; {\n    <em>// the note</em>\n}</code></pre></body></html>'

describe('every writer that colors code keeps the markup', () => {
  const rendered: string[] = []
  const conv = createConverter(async (html: string) => {
    rendered.push(html)
    return Buffer.from('%PDF fake')
  })
  const convert = (target: string) => conv.convert({ bytes: Buffer.from(PAGE, 'utf8'), filename: 'a.html' }, 'html', target as 'html', target === 'pdf' ? { pdf: {} } : undefined)
  const text = (res: { parts: { bytes: Buffer }[] }): string => res.parts[0].bytes.toString('utf8')
  const LINKED = '<a href="https://docs.rs/p/fn.parse.html"><span class="hljs-title function_">parse</span></a>'

  it('html and pdf', async () => {
    const html = text(await convert('html'))
    expect(html).toContain(LINKED)
    expect(html).toContain('<b><span class="hljs-type">str</span></b>')
    expect(html).toContain('<em><span class="hljs-comment">// the note</span></em>')
    await convert('pdf')
    expect(rendered[rendered.length - 1]).toContain(LINKED)
  })

  it('epub', async () => {
    const zip = await JSZip.loadAsync((await convert('epub')).parts[0].bytes)
    const pages = await Promise.all(Object.keys(zip.files).filter((n) => n.endsWith('.xhtml')).map((n) => zip.file(n)!.async('string')))
    const page = pages.find((p) => p.includes('parse'))!
    expect(page).toContain(LINKED)
    expect(page).toContain('<b><span class="hljs-type">str</span></b>')
  })

  it('azw3', async () => {
    const out = (await convert('azw3')).parts[0].bytes.toString('latin1')
    expect(out).toContain('hljs-title')
    expect(out).toContain('docs.rs/p/fn.parse.html')
  })

  it('revealjs', async () => {
    const out = text(await convert('revealjs'))
    expect(out).toContain(LINKED)
    expect(out).toContain('<em><span class="hljs-comment">// the note</span></em>')
  })

  it('docx: links, bold and italic, each run still colored', async () => {
    const zip = await JSZip.loadAsync((await convert('docx')).parts[0].bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    expect(rels).toContain('https://docs.rs/p/fn.parse.html')
    expect(xml).toMatch(/<w:hyperlink [^>]*>(?:(?!<\/w:hyperlink>)[\s\S])*<w:color w:val="8250DF"\/>(?:(?!<\/w:hyperlink>)[\s\S])*parse<\/w:t>/i)
    const run = (word: string): string => xml.split('</w:r>').find((r) => r.trimEnd().endsWith(`>${word}</w:t>`))!.toUpperCase()
    expect(run('str')).toContain('<W:B/>')
    expect(run('str')).toContain('<W:COLOR W:VAL="953800"/>')
    expect(run('    // the note')).toContain('<W:I/>')
    expect(run('    // the note')).toContain('<W:COLOR W:VAL="59636E"/>')
    expect(run('str')).toContain('W:ASCII="COURIER"')
  })

  it('md and txt write the plain text', async () => {
    expect(text(await convert('md'))).toContain('```rust\npub fn parse(s: &str) -> Option<u32> {\n    // the note\n}\n```')
    expect(text(await convert('txt'))).toContain('pub fn parse(s: &str) -> Option<u32> {')
  })
})
