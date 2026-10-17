import { describe, it, expect } from 'vitest'
import { readHtml } from '../../src/core/readers/html'
import { readTextile } from '../../src/core/readers/textile'
import { pastedHtmlToHub } from '../../src/core/remote-images'
import { hubFeatures } from '../../src/core/rendered-blocks'
import type { GuardedFetchDeps } from '../../src/core/net/guarded-fetch'

/*
 * Diagrams and formulas as pages and Textile write them, read into the hub's
 * form (rendered-blocks.ts), which is what hubFeatures and draw-blocks take.
 */

const html = async (page: string): Promise<string> => (await readHtml({ bytes: Buffer.from(page, 'utf8'), filename: 'a.html' })).html
const textile = async (text: string): Promise<string> => (await readTextile({ bytes: Buffer.from(text, 'utf8'), filename: 'a.textile' })).html
const paste = (fragment: string): Promise<string> => pastedHtmlToHub(fragment, {} as GuardedFetchDeps)

const MATHJAX = '<head><script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script></head>'

describe('Textile: a diagram or formula block named by its class', () => {
  it('reads bc(language-mermaid). as a diagram, without the class on the <pre>', async () => {
    const hub = await textile('bc(language-mermaid). graph LR\n  A --> B\n')
    expect(hub).toContain('<pre><code class="language-mermaid">graph LR\n  A --&gt; B</code></pre>')
    expect(hubFeatures(hub)).toEqual({ diagrams: true, math: false })
  })

  it('names Graphviz dot whatever the author called it, and reads a math block', async () => {
    expect(await textile('bc(language-graphviz). digraph { a -> b }\n')).toContain('<pre><code class="language-dot">digraph { a -&gt; b }</code></pre>')
    expect(await textile('bc(language-math). E = mc^2\n')).toContain('<pre><code class="language-math">E = mc^2</code></pre>')
  })

  it('leaves an ordinary code block with its language alone', async () => {
    expect(await textile('bc(language-python). x = 1\n')).toContain('<code class="language-python">x = 1</code>')
  })
})

describe("HTML: mermaid.js's and Graphviz's own conventions", () => {
  it('reads <pre class="mermaid"> and <div class="mermaid"> as diagrams, the source dedented', async () => {
    expect(await html('<pre class="mermaid">graph LR\n  A --&gt; B</pre>')).toBe('<pre><code class="language-mermaid">graph LR\n  A --&gt; B</code></pre>')
    expect(await html('<div class="mermaid">\n    graph LR\n      A --&gt; B\n  </div>')).toBe(
      '<pre><code class="language-mermaid">graph LR\n  A --&gt; B</code></pre>',
    )
  })

  it('reads a language class on a bare <pre>, and Graphviz by any of its names', async () => {
    expect(await html('<pre class="language-mermaid">graph TD\nA</pre>')).toBe('<pre><code class="language-mermaid">graph TD\nA</code></pre>')
    expect(await html('<pre class="graphviz">digraph { a -&gt; b }</pre>')).toBe('<pre><code class="language-dot">digraph { a -&gt; b }</code></pre>')
    expect(await html('<pre class="language-dot">graph { a -- b }</pre>')).toBe('<pre><code class="language-dot">graph { a -- b }</code></pre>')
    expect(await html('<pre><code class="language-graphviz">digraph {}</code></pre>')).toBe('<pre><code class="language-dot">digraph {}</code></pre>')
    expect(await html('<pre class="language-graphviz"><code class="language-graphviz">digraph {}</code></pre>')).toBe(
      '<pre><code class="language-dot">digraph {}</code></pre>',
    )
  })

  it('leaves a diagram mermaid.js already drew, a div merely named dot, and a frame round a block', async () => {
    const drawn = await html('<div class="mermaid" data-processed="true"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>A</text></svg></div>')
    expect(hubFeatures(drawn).diagrams).toBe(false)
    expect(await html('<div class="dot">A</div>')).toBe('<div>A</div>')
    // A highlighter's frame: its <pre> is read, not the frame's button.
    expect(await html('<div class="language-mermaid"><button>Copy</button><pre><code class="language-mermaid">graph LR</code></pre></div>')).toBe(
      '<div>Copy<pre><code class="language-mermaid">graph LR</code></pre></div>',
    )
  })
})

describe('HTML: formulas as pandoc, MathJax and KaTeX pages write them', () => {
  it("reads pandoc's math spans, delimiters or not", async () => {
    expect(await html('<p>Area <span class="math inline">\\(\\pi r^2\\)</span> here.</p>')).toBe('<p>Area <code class="language-math">\\pi r^2</code> here.</p>')
    expect(await html('<p>Sum <span class="math inline">x_1</span>.</p>')).toBe('<p>Sum <code class="language-math">x_1</code>.</p>')
    expect(await html('<p><span class="math display">\\[E = mc^2\\]</span></p>')).toBe('<pre><code class="language-math">E = mc^2</code></pre>')
    expect(await html('<p>So <span class="math display">\\[x^2\\]</span> holds.</p>')).toBe('<p>So <code class="language-math math-display">x^2</code> holds.</p>')
    expect(await html('<div class="math display">a^2 + b^2</div>')).toBe('<pre><code class="language-math">a^2 + b^2</code></pre>')
  })

  it("leaves pandoc's plain rendering, which is not TeX, and a page's own math class", async () => {
    expect(await html('<p><span class="math inline"><em>x</em><sup>2</sup></span></p>')).toBe('<p><span><em>x</em><sup>2</sup></span></p>')
    expect(await html('<p>Subject: <span class="math">Algebra</span>.</p>')).toBe('<p>Subject: <span>Algebra</span>.</p>')
    expect(await html('<p><span class="math">\\(x^2\\)</span></p>')).toBe('<p><code class="language-math">x^2</code></p>')
  })

  it("reads the TeX KaTeX keeps in a drawn formula, and not its drawing", async () => {
    const katex = (tex: string): string =>
      `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">x2</span></span></span>`
    expect(await html(`<p>Inline ${katex('x^2')} here.</p>`)).toBe('<p>Inline <code class="language-math">x^2</code> here.</p>')
    expect(await html(`<p><span class="katex-display">${katex('a &lt; b')}</span></p>`)).toBe('<pre><code class="language-math">a &lt; b</code></pre>')
  })

  it('reads MathJax script tags, and drops the rendering MathJax put before them', async () => {
    expect(await html('<p>Inline <script type="math/tex">x^2</script>.</p>')).toBe('<p>Inline <code class="language-math">x^2</code>.</p>')
    expect(
      await html('<p>A</p><div class="MathJax_Display"><span class="MathJax">x2</span></div><script type="math/tex; mode=display">x^2</script>'),
    ).toBe('<p>A</p><pre><code class="language-math">x^2</code></pre>')
  })

  it('reads \\( \\), \\[ \\] and $$ in the text of a page that loads MathJax or KaTeX', async () => {
    const page = `<html>${MATHJAX}<body><p>Area \\(\\pi r^2\\) here.</p><p>\\[E = mc^2\\]</p><p>Then $$a+b$$ inside.</p></body></html>`
    expect(await html(page)).toBe(
      '<p>Area <code class="language-math">\\pi r^2</code> here.</p><pre><code class="language-math">E = mc^2</code></pre>' +
        '<p>Then <code class="language-math math-display">a+b</code> inside.</p>',
    )
  })

  it('never reads them in code, nor in a page with no math library', async () => {
    const code = `<html>${MATHJAX}<body><pre>re.sub(r"\\(\\d+\\)", "", s)</pre><p>Run <code>\\(x\\)</code>.</p></body></html>`
    const read = await html(code)
    expect(read).toContain('<pre><code>re.sub(r"\\(\\d+\\)", "", s)</code></pre>')
    expect(read).toContain('<p>Run <code>\\(x\\)</code>.</p>')
    expect(await html('<p>The folder C:\\Program Files \\(x86\\) and \\[sic\\].</p>')).toBe('<p>The folder C:\\Program Files \\(x86\\) and \\[sic\\].</p>')
  })
})

describe('Pasted HTML: the same blocks', () => {
  it('reads a copied mermaid block and a math span', async () => {
    expect(await paste('<pre class="mermaid">graph LR\nA --&gt; B</pre>')).toBe('<pre><code class="language-mermaid">graph LR\nA --&gt; B</code></pre>')
    expect(await paste('<p><span class="math inline">\\(x^2\\)</span></p>')).toBe('<p><code class="language-math">x^2</code></p>')
  })
})
