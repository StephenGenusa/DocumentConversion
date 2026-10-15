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
