import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { writeDocx } from '../../src/core/writers/docx'
import { readDocx } from '../../src/core/readers/docx'

describe('writeDocx', () => {
  it('produces a docx that reads back to equivalent content', async () => {
    const buf = await writeDocx({ html: '<h1>Rt</h1><p>Hello <strong>world</strong></p>', title: 'Rt' })
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(1000)
    const back = await readDocx({ bytes: buf })
    expect(back.html).toContain('Rt')
    expect(back.html.toLowerCase()).toContain('world')
  })
})

/**
 * The lines of each paragraph holding `marker`, as Word shows them: the runs'
 * text, with a <w:br/> starting a new line.
 */
async function linesOf(html: string, marker: string): Promise<string[]> {
  const xml = await (await JSZip.loadAsync(await writeDocx({ html }))).file('word/document.xml')!.async('string')
  const para = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map((m) => m[0]).find((p) => p.includes(marker))
  expect(para, `a paragraph holding ${marker}`).toBeDefined()
  const pieces = [...para!.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br\b[^>]*\/>/g)]
  return pieces
    .map((m) => (m[0].startsWith('<w:br') ? '\n' : m[1]))
    .join('')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split('\n')
}

describe('writeDocx keeps the lines of a code block apart', () => {
  it('writes each line of a plain block on its own line', async () => {
    const lines = await linesOf('<pre><code>const alpha = 1\nconst beta = 2\n</code></pre>', 'alpha')
    expect(lines).toEqual(['const alpha = 1', 'const beta = 2'])
  })

  it('breaks a line whose newline falls inside a highlighting span', async () => {
    const html =
      '<pre><code class="language-js"><span class="hljs-keyword">const</span> alpha = <span class="hljs-string">"one\ntwo"</span>\n<span class="hljs-title">run</span>()\n</code></pre>'
    expect(await linesOf(html, 'alpha')).toEqual(['const alpha = "one', 'two"', 'run()'])
  })

  it('keeps leading indentation and tabs', async () => {
    const lines = await linesOf('<pre><code>if (alpha) {\n    beta()\n\tgamma()\n}\n</code></pre>', 'alpha')
    expect(lines).toEqual(['if (alpha) {', '    beta()', '\tgamma()', '}'])
  })

  it('keeps a blank line inside the block', async () => {
    const lines = await linesOf('<pre><code>alpha()\n\nbeta()\n</code></pre>', 'alpha')
    expect(lines).toEqual(['alpha()', '', 'beta()'])
  })

  it('breaks the lines of a code block in a list item', async () => {
    const lines = await linesOf('<ul><li><p>Step</p><pre><code>alpha()\n  beta()\n</code></pre></li></ul>', 'alpha')
    expect(lines).toEqual(['Step', 'alpha()', '  beta()'])
  })

  it('breaks the lines of a code block in a table cell', async () => {
    const lines = await linesOf('<table><tr><td><pre><code>alpha()\nbeta()</code></pre></td></tr></table>', 'alpha')
    expect(lines).toEqual(['alpha()', 'beta()'])
  })

  it('keeps a <br> already inside a block as a line break', async () => {
    expect(await linesOf('<pre><code>alpha()<br>beta()</code></pre>', 'alpha')).toEqual(['alpha()', 'beta()'])
  })

  it('breaks the lines of a diagram source block', async () => {
    const lines = await linesOf('<pre><code class="language-mermaid">graph TD\n  Alpha --&gt; Beta\n</code></pre>', 'Alpha')
    expect(lines).toEqual(['graph TD', '  Alpha --> Beta'])
  })
})

/**
 * The font of every run whose text holds `marker`: the w:rFonts ascii font,
 * or '' for the body font. Word takes a run without rFonts in the body font.
 */
async function fontsOf(html: string, marker: string): Promise<string[]> {
  const xml = await (await JSZip.loadAsync(await writeDocx({ html }))).file('word/document.xml')!.async('string')
  const runs = [...xml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => m[1])
  const hits = runs.filter((r) => [...r.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].some((t) => t[1].includes(marker)))
  expect(hits.length, `a run holding ${marker}`).toBeGreaterThan(0)
  return hits.map((r) => /<w:rFonts\b[^>]*\bw:ascii="([^"]*)"/.exec(r)?.[1] ?? '')
}

describe('writeDocx sets code in a monospace font wherever it is', () => {
  it('sets a top-level code block in Courier (as html-to-docx already does)', async () => {
    expect(await fontsOf('<pre><code>alpha()\nbeta()</code></pre>', 'alpha')).toEqual(['Courier'])
  })

  it('sets a code block in a list item in Courier, lines still apart', async () => {
    const html = '<ul><li><p>Step</p><pre><code>alpha()\n  beta()\n</code></pre></li></ul>'
    expect(await fontsOf(html, 'alpha')).toEqual(['Courier'])
    expect(await fontsOf(html, 'beta')).toEqual(['Courier'])
    expect(await fontsOf(html, 'Step')).toEqual([''])
    expect(await linesOf(html, 'alpha')).toEqual(['Step', 'alpha()', '  beta()'])
  })

  it('sets a code block in a nested list item in Courier', async () => {
    const html = '<ol><li>Outer<ul><li>Inner<pre><code>alpha()\nbeta()</code></pre></li></ul></li></ol>'
    expect(await fontsOf(html, 'alpha')).toEqual(['Courier'])
    expect(await fontsOf(html, 'beta')).toEqual(['Courier'])
    expect(await fontsOf(html, 'Inner')).toEqual([''])
  })

  it('sets inline code in a list item, a paragraph and a table cell in Courier', async () => {
    expect(await fontsOf('<ul><li>use <code>alpha</code> now</li></ul>', 'alpha')).toEqual(['Courier'])
    expect(await fontsOf('<ul><li>use <code>alpha</code> now</li></ul>', 'now')).toEqual([''])
    expect(await fontsOf('<p>use <code>beta</code> now</p>', 'beta')).toEqual(['Courier'])
    expect(await fontsOf('<table><tr><td>use <code>gamma</code></td></tr></table>', 'gamma')).toEqual(['Courier'])
  })

  it('sets a highlighted code block in a list item in Courier', async () => {
    const html =
      '<ol><li>Item<pre><code class="hljs language-js"><span class="hljs-keyword">const</span> alpha = <span class="hljs-number">1</span>\nbeta()</code></pre></li></ol>'
    expect(await fontsOf(html, 'const')).toEqual(['Courier'])
    expect(await fontsOf(html, 'beta')).toEqual(['Courier'])
    expect(await linesOf(html, 'alpha')).toEqual(['Item', 'const alpha = 1', 'beta()'])
  })

  it('keeps the paragraph after a code block in a list item', async () => {
    // A loose Markdown list: html-to-docx wrote nothing for "Then this."
    const html = '<ol><li><p>Step one:</p><pre><code>alpha()</code></pre><p>Then this.</p></li></ol>'
    expect(await linesOf(html, 'alpha')).toEqual(['Step one:', 'alpha()', 'Then this.'])
    expect(await fontsOf(html, 'Then')).toEqual([''])
  })
})
