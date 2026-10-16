import { describe, it, expect, vi } from 'vitest'
import HTMLtoDOCX from 'html-to-docx'
import { readMarkdown } from '../../src/core/readers/md'
import { readIpynb } from '../../src/core/readers/ipynb'
import { readAsciidoc } from '../../src/core/readers/asciidoc'
import { readRst } from '../../src/core/readers/rst'
import { readDjot } from '../../src/core/readers/djot'
import { readTxt } from '../../src/core/readers/txt'
import { readDocx } from '../../src/core/readers/docx'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeTxt } from '../../src/core/writers/txt'
import { createConverter } from '../../src/core/convert'
import { hubFeatures } from '../../src/core/rendered-blocks'

/*
 * Diagrams and formulas in the hub (spec B1): explicit, tagged source.
 *
 *   <pre><code class="language-mermaid">SOURCE</code></pre>
 *   <pre><code class="language-dot">SOURCE</code></pre>
 *   <pre><code class="language-math">TEX</code></pre>     display math
 *   <code class="language-math">TEX</code>                inline math
 *
 * Writers draw only what a reader positively identified, so a `$5 … $10` in
 * a Word file or a .txt can never become a formula.
 */

const bytes = (s: string): Buffer => Buffer.from(s, 'utf8')
const md = async (text: string): Promise<string> => (await readMarkdown({ bytes: bytes(text) })).html
const B = '\\'

describe('Markdown reads diagrams and formulas as tagged source', () => {
  it('keeps a mermaid fence as a mermaid block', async () => {
    expect(await md('```mermaid\ngraph TD\n  A --> B\n```\n')).toBe(
      '<pre><code class="language-mermaid">graph TD\n  A --&gt; B\n</code></pre>\n',
    )
  })

  it.each(['dot', 'graphviz', 'gv', 'viz', 'Graphviz'])('reads a %s fence as dot', async (lang) => {
    expect(await md(`\`\`\`${lang}\ndigraph { a -> b }\n\`\`\`\n`)).toBe(
      '<pre><code class="language-dot">digraph { a -&gt; b }\n</code></pre>\n',
    )
  })

  it('writes inline math in the hub form, the TeX byte for byte', async () => {
    expect(await md(`Let $${B}alpha_i < 2$ hold.`)).toBe(`<p>Let <code class="language-math">${B}alpha_i &lt; 2</code> hold.</p>\n`)
  })

  it('reads $$…$$ alone in a paragraph as display math', async () => {
    expect(await md(`$$${B}sum_{i=1}^n i$$`)).toBe(`<pre><code class="language-math">${B}sum_{i=1}^n i</code></pre>\n`)
    expect(await md(`$$\na = b ${B}${B}\nc = d\n$$`)).toBe(`<pre><code class="language-math">\na = b ${B}${B}\nc = d\n</code></pre>\n`)
  })

  it('reads $$…$$ inside a sentence as inline math', async () => {
    expect(await md('so $$x+y$$ here')).toBe('<p>so <code class="language-math">x+y</code> here</p>\n')
  })

  it('keeps a math fence as display math', async () => {
    expect(await md('```math\nE = mc^2\n```\n')).toBe('<pre><code class="language-math">E = mc^2\n</code></pre>\n')
  })

  it('leaves dollar amounts and code alone', async () => {
    expect(await md('It costs $5 for the **bold** plan and $10.')).toBe('<p>It costs $5 for the <strong>bold</strong> plan and $10.</p>\n')
    expect(await md('`$a_b$`')).toBe('<p><code>$a_b$</code></p>\n')
  })

  it('reports what it found', () => {
    expect(hubFeatures('<p>x</p>')).toEqual({ diagrams: false, math: false })
    expect(hubFeatures('<pre><code class="language-dot">a</code></pre>')).toEqual({ diagrams: true, math: false })
    expect(hubFeatures('<p><code class="language-math">a</code></p>')).toEqual({ diagrams: false, math: true })
    expect(hubFeatures('<pre><code class="language-python">a</code></pre>')).toEqual({ diagrams: false, math: false })
  })
})

describe('the read boundary reports features on the hub', () => {
  const conv = createConverter(vi.fn(async () => Buffer.from('%PDF')))
  it('sets features from what the reader produced', async () => {
    const hub = await conv.read({ bytes: bytes('```mermaid\ngraph TD\n```\n\n$x^2$\n'), filename: 'a.md' }, 'md')
    expect(hub.features).toEqual({ diagrams: true, math: true })
    const plain = await conv.read({ bytes: bytes('Costs $5 and $10.'), filename: 'a.txt' }, 'txt')
    expect(plain.features).toEqual({ diagrams: false, math: false })
  })
})

describe('notebooks inherit Markdown', () => {
  it('reads math and diagrams in markdown cells', async () => {
    const nb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'markdown', metadata: {}, source: [`Inline $${B}beta_1$.\n`, '\n', '$$a^2$$\n', '\n', '```mermaid\ngraph LR\n```\n'] }],
    }
    const html = (await readIpynb({ bytes: bytes(JSON.stringify(nb)), filename: 'n.ipynb' })).html
    expect(html).toContain(`<code class="language-math">${B}beta_1</code>`)
    expect(html).toContain('<pre><code class="language-math">a^2</code></pre>')
    expect(html).toContain('<pre><code class="language-mermaid">graph LR\n</code></pre>')
  })
})

describe('AsciiDoc reads diagrams and formulas as tagged source', () => {
  const adoc = async (text: string): Promise<string> => (await readAsciidoc({ bytes: bytes(text), filename: 'a.adoc' })).html

  it('reads [mermaid] and [graphviz] blocks', async () => {
    const html = await adoc('[mermaid]\n----\ngraph TD\n  A --> B & C\n----\n\n[graphviz]\n....\ndigraph { a -> b }\n....\n')
    expect(html).toContain('<pre><code class="language-mermaid">graph TD\n  A --&gt; B &amp; C</code></pre>')
    expect(html).toContain('<pre><code class="language-dot">digraph { a -&gt; b }</code></pre>')
  })

  it('reads [source,graphviz] as dot and [source,mermaid] as mermaid', async () => {
    const html = await adoc('[source,graphviz]\n----\ngraph { a -- b }\n----\n\n[source,mermaid]\n----\npie\n----\n')
    expect(html).toContain('<pre><code class="language-dot">graph { a -- b }</code></pre>')
    expect(html).toContain('<pre><code class="language-mermaid">pie</code></pre>')
  })

  it('reads latexmath inline and as a block', async () => {
    const html = await adoc(`Inline latexmath:[x^2 < y] here.\n\n[latexmath]\n++++\n${B}sum_{i=1}^n i < 3\n++++\n`)
    expect(html).toContain('Inline <code class="language-math">x^2 &lt; y</code> here.')
    expect(html).toContain(`<pre><code class="language-math">${B}sum_{i=1}^n i &lt; 3</code></pre>`)
  })

  it('reads stem as math only under :stem: latexmath', async () => {
    const latex = await adoc(':stem: latexmath\n\nInline stem:[a_b].\n\n[stem]\n++++\nE=mc^2\n++++\n')
    expect(latex).toContain('<code class="language-math">a_b</code>')
    expect(latex).toContain('<pre><code class="language-math">E=mc^2</code></pre>')
    const ascii = await adoc(':stem:\n\nInline stem:[a_b].\n')
    expect(ascii).not.toContain('language-math')
  })
})

describe('reStructuredText reads diagrams and formulas as tagged source', () => {
  const rst = async (text: string): Promise<string> => (await readRst({ bytes: bytes(text), filename: 'a.rst' })).html

  it('reads the mermaid and graphviz directives, joined and de-indented', async () => {
    const html = await rst('.. mermaid::\n\n   graph TD\n     A --> B\n\n.. graphviz::\n\n   digraph { a -> b }\n')
    expect(html).toContain('<pre><code class="language-mermaid">graph TD\n  A --&gt; B</code></pre>')
    expect(html).toContain('<pre><code class="language-dot">digraph { a -&gt; b }</code></pre>')
  })

  it('reads digraph and graph directives as a whole graph', async () => {
    const html = await rst('.. digraph:: deps\n\n   a -> b\n\n.. graph:: links\n\n   a -- b\n')
    expect(html).toContain('<pre><code class="language-dot">digraph deps {\na -&gt; b\n}</code></pre>')
    expect(html).toContain('<pre><code class="language-dot">graph links {\na -- b\n}</code></pre>')
  })

  it('reads the math directive, leaving out its options', async () => {
    const html = await rst(`.. math::\n   :label: eq1\n\n   a < b ${B}${B}\n   c\n`)
    expect(html).toContain(`<pre><code class="language-math">a &lt; b ${B}${B}\nc</code></pre>`)
  })

  it('keeps blank lines inside a math or diagram body', async () => {
    const math = await rst(`.. math::\n   :label: eq1\n\n   a = b\n\n\n   c = d\n\nAfter.\n`)
    expect(math).toContain('<pre><code class="language-math">a = b\n\n\nc = d</code></pre>')
    expect(math).toContain('<p>After.</p>')
    const mermaid = await rst('.. mermaid::\n\n   graph TD\n\n     A --> B\n\n.. graphviz::\n\n   digraph {\n\n     a -> b\n   }\n\n')
    expect(mermaid).toContain('<pre><code class="language-mermaid">graph TD\n\n  A --&gt; B</code></pre>')
    expect(mermaid).toContain('<pre><code class="language-dot">digraph {\n\n  a -&gt; b\n}</code></pre>')
    const digraph = await rst('.. digraph:: deps\n\n   a -> b\n\n   b -> c\n')
    expect(digraph).toContain('<pre><code class="language-dot">digraph deps {\na -&gt; b\n\nb -&gt; c\n}</code></pre>')
  })

  it('reads the math role as inline math', async () => {
    expect(await rst(`Then :math:\`${B}alpha_1 < 2\` holds.\n`)).toContain(`<code class="language-math">${B}alpha_1 &lt; 2</code>`)
  })
})

describe('Djot reads formulas as tagged source', () => {
  it('maps its native math', async () => {
    const html = (await readDjot({ bytes: bytes('Inline $`x_1` and\n\n$$`a^2`\n'), filename: 'a.dj' })).html
    expect(html).toContain('<code class="language-math">x_1</code>')
    expect(html).toContain('<pre><code class="language-math">a^2</code></pre>')
  })
})

describe('dollar signs in plain text and Word never become math', () => {
  it('txt', async () => {
    const html = (await readTxt({ bytes: bytes('It costs $5 for a_b and $10.\n\n$$x^2$$\n'), filename: 'a.txt' })).html
    expect(html).not.toContain('language-math')
    expect(html).toContain('$5')
  })

  it('docx', async () => {
    const docx = Buffer.from(await HTMLtoDOCX('<p>It costs $5 for a_b and $10, or $x^2$.</p>'))
    const html = (await readDocx({ bytes: docx, filename: 'a.docx' })).html
    expect(html).not.toContain('language-math')
    expect(html).toContain('$5')
  })
})

describe('Markdown and text writers put the delimiters back', () => {
  const toMd = async (html: string): Promise<string> => (await writeMarkdown({ html })).toString('utf8')
  const toTxt = async (html: string): Promise<string> => (await writeTxt({ html })).toString('utf8')

  it('writes inline math as $…$ and display math as $$…$$', async () => {
    expect(await toMd(`<p>Let <code class="language-math">${B}alpha_i &lt; 2</code> hold.</p>`)).toBe(`Let $${B}alpha_i < 2$ hold.`)
    expect(await toMd(`<pre><code class="language-math">${B}sum_i i</code></pre>`)).toBe(`$$${B}sum_i i$$`)
  })

  it('writes inline math that would not read back with a single $ in $$', async () => {
    expect(await toMd('<p>so <code class="language-math">x+y</code> here</p>')).toBe('so $$x+y$$ here')
  })

  it('writes display math that a paragraph cannot hold as a math fence', async () => {
    expect(await toMd('<pre><code class="language-math">a\n\nb</code></pre>')).toBe('```math\na\n\nb\n```')
    expect(await toMd('<pre><code class="language-math">a\n- b</code></pre>')).toBe('```math\na\n- b\n```')
  })

  it('writes diagrams as fences', async () => {
    expect(await toMd('<pre><code class="language-mermaid">graph TD\n  A --&gt; B\n</code></pre>')).toBe('```mermaid\ngraph TD\n  A --> B\n```')
    expect(await toMd('<pre><code class="language-dot">digraph { a -&gt; b }\n</code></pre>')).toBe('```dot\ndigraph { a -> b }\n```')
  })

  it('escapes a dollar pair in prose that would read back as math', async () => {
    const out = await toMd('<p>It costs $5 for a_b and $10.</p>')
    expect(out).toBe('It costs \\$5 for a\\_b and $10.')
    expect(await md(out)).not.toContain('language-math')
    expect(await toMd('<p>It costs $5 and $10.</p>')).toBe('It costs $5 and $10.')
  })

  it('round-trips Markdown math and diagrams exactly', async () => {
    const source = [
      `Let $${B}alpha_i < 2$ and $$x+y$$ hold, costing $5 and $10.`,
      `$$${B}sum_{i=1}^n i$$`,
      '```mermaid\ngraph TD\n  A --> B\n```',
      '```dot\ndigraph { a -> b }\n```',
    ].join('\n\n')
    expect(await toMd(await md(source))).toBe(source)
  })

  it('writes the same delimiters to plain text', async () => {
    const out = await toTxt(
      `<p>Let <code class="language-math">${B}alpha &lt; 2</code> hold.</p><pre><code class="language-math">${B}sum_i i</code></pre><pre><code class="language-mermaid">graph TD\n  A --&gt; B</code></pre>`,
    )
    expect(out).toContain(`Let $${B}alpha < 2$ hold.`)
    expect(out).toContain(`$$${B}sum_i i$$`)
    expect(out).toContain('graph TD\n  A --> B')
  })
})
