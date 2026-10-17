import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readHtml } from '../../src/core/readers/html'
import { createConverter } from '../../src/core/convert'
import { pastedHtmlToHub } from '../../src/core/remote-images'
import { guessCodeLanguages } from '../../src/core/code-language'
import type { GuardedFetchDeps } from '../../src/core/net/guarded-fetch'

/*
 * A page's <pre> can carry the author's own markup: the command to type in
 * bold, a name linked to its docs. Reading a file keeps the inline markup the
 * hub allows; a highlighter's spans still go (their color is redrawn at write
 * time), and a paste into the editor is still flattened on purpose.
 */

const read = async (html: string): Promise<string> => (await readHtml({ bytes: Buffer.from(html, 'utf8'), filename: 'a.html' })).html

const PAGE =
  '<html><body><pre>$ <b>npm</b> install <a href="https://example.com/pkg">the package</a>\n' +
  '<span class="pl-c">done</span> <em>quickly</em> &amp; <strong>well</strong></pre></body></html>'

describe('html: markup inside a <pre>', () => {
  it('keeps bold, italic and links, and drops a highlighter span', async () => {
    expect(await read(PAGE)).toBe(
      '<pre><code>$ <b>npm</b> install <a href="https://example.com/pkg">the package</a>\n' +
        'done <em>quickly</em> &amp; <strong>well</strong></code></pre>',
    )
  })

  it('keeps it inside a <code> too, with the language the page named', async () => {
    const html = await read('<div class="highlight-source-python"><pre><code>def <b>total</b>(items):<br>    return 0</code></pre></div>')
    expect(html).toContain('<pre><code class="language-python">def <b>total</b>(items):\n    return 0</code></pre>')
  })

  it('leaves a diagram block untouched', async () => {
    expect(await read('<pre><code class="language-mermaid">graph TD\n  A --&gt; B</code></pre>')).toBe(
      '<pre><code class="language-mermaid">graph TD\n  A --&gt; B</code></pre>',
    )
  })

  it('still flattens a paste into the editor', async () => {
    const hub = await pastedHtmlToHub('<pre>$ <b>npm</b> install <a href="https://example.com/pkg">it</a></pre>', {} as GuardedFetchDeps)
    // Flat text, so the one-line guess may name it: a `$` prompt is Bash.
    expect(hub).toBe('<pre><code class="language-bash">$ npm install it</code></pre>')
  })

  it('does not guess a language over a block the author formatted', () => {
    const block = '<pre><code>def <b>total</b>(items):\n    result = 0\n    for item in items:\n        result += item\n    return result</code></pre>'
    expect(guessCodeLanguages(block)).toBe(block)
  })
})

describe('html: every writer takes a <pre> with markup in it', () => {
  const rendered: string[] = []
  const conv = createConverter(async (html: string) => {
    rendered.push(html)
    return Buffer.from('%PDF fake')
  })
  const convert = (target: string) => conv.convert({ bytes: Buffer.from(PAGE, 'utf8'), filename: 'a.html' }, 'html', target as 'html', target === 'pdf' ? { pdf: {} } : undefined)
  const text = (res: { parts: { bytes: Buffer }[] }): string => res.parts[0].bytes.toString('utf8')

  it('html and pdf show the markup', async () => {
    expect(text(await convert('html'))).toContain('$ <b>npm</b> install <a href="https://example.com/pkg">the package</a>')
    await convert('pdf')
    expect(rendered[rendered.length - 1]).toContain('<strong>well</strong></code></pre>')
  })

  it('md and txt write the plain text', async () => {
    const md = text(await convert('md'))
    expect(md).toContain('```\n$ npm install the package\ndone quickly & well\n```')
    const txt = text(await convert('txt'))
    expect(txt).toContain('$ npm install the package\ndone quickly & well')
  })

  it('docx keeps every word and the line break', async () => {
    const zip = await JSZip.loadAsync((await convert('docx')).parts[0].bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    const para = xml.split('</w:p>').find((p) => p.includes('npm'))!
    const words = [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br\b[^>]*\/>/g)].map((m) => (m[0].startsWith('<w:br') ? '\n' : m[1])).join('')
    expect(words).toBe('$ npm install the package\ndone quickly &amp; well')
    expect(para).toContain('w:ascii="Courier"')
  })

  it('epub writes well-formed XHTML with the markup', async () => {
    const zip = await JSZip.loadAsync((await convert('epub')).parts[0].bytes)
    const names = Object.keys(zip.files).filter((n) => n.endsWith('.xhtml'))
    const pages = await Promise.all(names.map((n) => zip.file(n)!.async('string')))
    const page = pages.find((p) => p.includes('npm'))!
    expect(page).toContain('<b>npm</b>')
    expect(page).toContain('<a href="https://example.com/pkg">the package</a>')
  })

  it.each(['revealjs', 'azw3'])('%s writes it with the text in place', async (target) => {
    const out = (await convert(target)).parts[0].bytes.toString('latin1')
    expect(out).toContain('npm')
    expect(out).toContain('the package')
  })
})
