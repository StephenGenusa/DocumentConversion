import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { featuresHint, FEATURES_HINT_MAX_BYTES, FEATURES_SCAN_BUDGET_MS } from '../../src/core/features-hint'

const b = (s: string): Buffer => Buffer.from(s, 'utf8')

describe('featuresHint (spec 2a: the Diagrams choice knows about a file never opened)', () => {
  it('finds the diagrams and formulas in the corpus fixture', async () => {
    const bytes = readFileSync(join(__dirname, '..', 'corpus', 'diagram-notes.md'))
    expect(await featuresHint(bytes, 'md', 'diagram-notes.md')).toEqual({ diagrams: true, math: true })
  })

  it('reads each text format with its own reader', async () => {
    expect(await featuresHint(b('[mermaid]\n----\ngraph LR\nA-->B\n----\n'), 'asciidoc')).toEqual({ diagrams: true, math: false })
    expect(await featuresHint(b('.. mermaid::\n\n   graph LR\n   A-->B\n'), 'rst')).toEqual({ diagrams: true, math: false })
    expect(await featuresHint(b('<pre><code class="language-mermaid">graph LR</code></pre>'), 'html')).toEqual({ diagrams: true, math: false })
    // Graphviz alone counts: it is drawn too (step 17), so the Diagrams choice applies.
    expect(await featuresHint(b('.. digraph:: deps\n\n   a -> b\n'), 'rst')).toEqual({ diagrams: true, math: false })
    expect(await featuresHint(b('# Plain\n\nNothing to draw, and $5 is not math.\n'), 'md')).toEqual({ diagrams: false, math: false })
  })

  it('a Word file: formulas when it holds equations (spec B12), found without converting it', async () => {
    const equations = readFileSync(join(__dirname, '..', 'corpus', 'treasurer-equations.docx'))
    expect(await featuresHint(equations, 'docx')).toEqual({ diagrams: false, math: true })
    const plain = readFileSync(join(__dirname, '..', 'corpus', 'supply-request-header.docx'))
    expect(await featuresHint(plain, 'docx')).toEqual({ diagrams: false, math: false })
  })

  it('says nothing for formats with no such blocks, or for an input it cannot read', async () => {
    expect(await featuresHint(b('```mermaid\nA\n```'), 'txt')).toBeUndefined()
    expect(await featuresHint(b('anything'), 'docx')).toBeUndefined()
    expect(await featuresHint(b('{ not json'), 'ipynb')).toBeUndefined()
  })
})

/** Ordinary paragraphs, past the size the hint reads whole. */
function filler(bytes = FEATURES_HINT_MAX_BYTES + 1024): string {
  const para = 'The reading room opens at nine, and the second floor keeps the quiet tables by the windows.\n\n'
  return para.repeat(Math.ceil(bytes / para.length))
}

describe('featuresHint on a large input: scanned, not read whole', () => {
  const big = (s: string): Buffer => Buffer.from(s, 'utf8')

  it('Markdown: a diagram near the end, a formula in the middle', async () => {
    const half = filler(FEATURES_HINT_MAX_BYTES)
    const md = `${half}Area is $\\pi r^2$ here.\n\n${half}\`\`\`mermaid\ngraph LR\n\n  A --> B\n\`\`\`\n`
    expect(await featuresHint(big(md), 'md')).toEqual({ diagrams: true, math: true })
    expect(await featuresHint(big(`${filler()}A \`\`\`dot\` fence:\n\n~~~dot\ndigraph { a -> b }\n~~~\n`), 'md')).toEqual({ diagrams: true, math: false })
  })

  it('Markdown: nothing to draw, a price, and TeX inside a code fence', async () => {
    expect(await featuresHint(Buffer.alloc(FEATURES_HINT_MAX_BYTES + 1, 0x61), 'md')).toEqual({ diagrams: false, math: false })
    const md = `${filler()}It costs $5 or $10.\n\n\`\`\`latex\nThe formula $x^2$ is code here.\n\nStill code: $y_1$.\n\`\`\`\n`
    expect(await featuresHint(big(md), 'md')).toEqual({ diagrams: false, math: false })
  })

  it('AsciiDoc: a [mermaid] listing with a blank line in it, and stem under the header', async () => {
    const adoc = `= Notes\n:stem: latexmath\n\n${filler()}[mermaid]\n----\ngraph LR\n\nA --> B\n----\n\nThe area is stem:[\\pi r^2].\n`
    expect(await featuresHint(big(adoc), 'asciidoc')).toEqual({ diagrams: true, math: true })
    // Without the header's latexmath, stem is AsciiMath, which is not drawn.
    expect(await featuresHint(big(adoc.replace(':stem: latexmath\n', '')), 'asciidoc')).toEqual({ diagrams: true, math: false })
  })

  it('reStructuredText: a directive whose body follows a blank line', async () => {
    const rst = `${filler()}.. mermaid::\n\n   graph LR\n   A --> B\n\nAfter it, :math:\`x^2\`.\n`
    expect(await featuresHint(big(rst), 'rst')).toEqual({ diagrams: true, math: true })
  })

  it('HTML: tagged blocks in a large page', async () => {
    const page = `<html><body>${'<p>The reading room opens at nine.</p>'.repeat(60_000)}<pre><code class="language-mermaid">graph LR\nA --&gt; B</code></pre><p>Inline <code class="language-math">x^2</code>.</p></body></html>`
    expect(page.length).toBeGreaterThan(FEATURES_HINT_MAX_BYTES)
    expect(await featuresHint(big(page), 'html')).toEqual({ diagrams: true, math: true })
  })

  it('Djot and a notebook large for its outputs', async () => {
    expect(await featuresHint(big(`${filler()}The area is $\`\\pi r^2\`.\n`), 'djot')).toEqual({ diagrams: false, math: true })
    const picture = 'A'.repeat(FEATURES_HINT_MAX_BYTES * 2)
    const nb = {
      nbformat: 4,
      metadata: {},
      cells: [
        { cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': picture } }] },
        { cell_type: 'markdown', source: ['Energy: $$E = mc^2$$\n'] },
      ],
    }
    expect(await featuresHint(big(JSON.stringify(nb)), 'ipynb')).toEqual({ diagrams: false, math: true })
  })

  it('a large Word file is answered from its document part, within the budget', async () => {
    const zip = await JSZip.loadAsync(readFileSync(join(__dirname, '..', 'corpus', 'treasurer-equations.docx')))
    zip.file('word/media/large.bin', Buffer.alloc(40 * 1024 * 1024, 7), { compression: 'STORE' })
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const started = performance.now()
    expect(await featuresHint(bytes, 'docx')).toEqual({ diagrams: false, math: true })
    expect(performance.now() - started).toBeLessThan(FEATURES_SCAN_BUDGET_MS)
  })

  it('a 40 MB Markdown file is scanned within the budget', async () => {
    const md = `${filler(40 * 1024 * 1024)}\`\`\`mermaid\ngraph LR\n\`\`\`\n`
    const started = performance.now()
    expect(await featuresHint(big(md), 'md')).toEqual({ diagrams: true, math: false })
    expect(performance.now() - started).toBeLessThan(FEATURES_SCAN_BUDGET_MS)
  })
})
