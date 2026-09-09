import { describe, it, expect } from 'vitest'
import { renderDocumentShell } from '../../src/core/shell'

describe('renderDocumentShell', () => {
  it('wraps body html in a full document with title and styles', () => {
    const out = renderDocumentShell({ html: '<h1>Hi</h1>', title: 'My Doc' })
    expect(out).toContain('<!doctype html>')
    expect(out).toContain('<title>My Doc</title>')
    expect(out).toContain('<h1>Hi</h1>')
    expect(out).toContain('<style>')
  })
  it('escapes the title and defaults it', () => {
    const out = renderDocumentShell({ html: '<p>x</p>', title: 'A & B <c>' })
    expect(out).toContain('A &amp; B &lt;c&gt;')
    const noTitle = renderDocumentShell({ html: '<p>x</p>' })
    expect(noTitle).toContain('<title>Document</title>')
  })

  const codeDoc = { html: '<pre><code class="language-typescript">const x: number = 1</code></pre>' }

  it('highlights code fences for pdf and html targets', () => {
    for (const target of ['pdf', 'html'] as const) {
      const out = renderDocumentShell(codeDoc, { target })
      expect(out).toContain('hljs-keyword')
      expect(out).toContain('.hljs-keyword')
    }
  })

  it('does not highlight for docx/md/txt targets', () => {
    const out = renderDocumentShell(codeDoc, { target: 'docx' })
    expect(out).not.toContain('hljs-keyword')
    const plain = renderDocumentShell(codeDoc)
    expect(plain).not.toContain('hljs-keyword')
  })

  /**
   * A notebook shipped as an undifferentiated dump: code and output drawn as
   * identical grey boxes, no execution prompts, nothing marking where input
   * ended. The reader tags each pre; the shell has to draw them.
   */
  describe('notebook styling', () => {
    const nbDoc = {
      html: [
        '<pre class="nb-in nb-c1"><code class="language-python">print(1)</code></pre>',
        '<pre class="nb-output nb-stream">1</pre>',
        '<pre class="nb-in nb-c12"><code class="language-python">x</code></pre>',
        '<pre class="nb-output nb-result nb-c12">42</pre>',
        '<pre class="nb-in"><code class="language-python">y</code></pre>',
        '<pre class="nb-error">ZeroDivisionError</pre>',
      ].join('\n'),
    }

    it('emits an In [n]: prompt for every execution count present', () => {
      const out = renderDocumentShell(nbDoc, { target: 'pdf' })
      expect(out).toContain('.nb-in.nb-c1::before')
      expect(out).toContain('"In [1]:"')
      expect(out).toContain('.nb-in.nb-c12::before')
      expect(out).toContain('"In [12]:"')
    })

    it('emits an Out[n]: prompt for a result carrying its count', () => {
      const out = renderDocumentShell(nbDoc, { target: 'pdf' })
      expect(out).toContain('.nb-result.nb-c12::before')
      expect(out).toContain('"Out[12]:"')
    })

    it('gives an unexecuted cell an empty prompt, never In [undefined]', () => {
      const out = renderDocumentShell(nbDoc, { target: 'pdf' })
      expect(out).toContain('"In [ ]:"')
      expect(out).not.toContain('undefined')
      expect(out).not.toContain('null')
    })

    it('draws input, output, stream and error as four different things', () => {
      const css = renderDocumentShell(nbDoc, { target: 'pdf' }).split('<style>')[1].split('</style>')[0]
      for (const sel of ['pre.nb-in', 'pre.nb-output', 'pre.nb-stream', 'pre.nb-error']) {
        expect(css).toContain(sel)
      }
      // An error must not be another grey box: it reads as an error.
      expect(css).toMatch(/pre\.nb-error\s*\{[^}]*(#b|#c|#d|#f)[0-9a-f]{2}/i)
    })

    it('reserves the prompt gutter inside the block, not off the page', () => {
      const css = renderDocumentShell(nbDoc, { target: 'pdf' }).split('<style>')[1].split('</style>')[0]
      // Long lines still have to wrap: without pre-wrap printToPDF clips them.
      expect(css).toContain('white-space: pre-wrap')
      // Anything that can leave the box, or clip what runs past it, loses
      // content to printToPDF silently.
      expect(css).not.toContain('position: absolute')
      expect(css).not.toContain('position: fixed')
      expect(css).not.toMatch(/pre[^{]*\{[^}]*overflow:\s*hidden/)
    })

    it('keeps highlighting notebook code cells', () => {
      const out = renderDocumentShell(nbDoc, { target: 'pdf' })
      expect(out).toContain('hljs-built_in')
      expect(out).toContain('class="nb-in nb-c1"')
    })

    /**
     * A figure output rendered as a bare full-bleed <img>: no gutter, no
     * coloured rule, nothing tying it to the cell that produced it, while the
     * text outputs beside it got both. An <img> cannot carry a class — the hub
     * allowlist permits `class` on `pre`/`code` only — so the shell selects it
     * by the alt text the notebook reader stamps on every figure it inlines.
     */
    describe('figure outputs', () => {
      const figDoc = {
        html: [
          '<pre class="nb-in nb-c4"><code class="language-python">plt.show()</code></pre>',
          '<img src="data:image/png;base64,AAAA" alt="output image">',
        ].join('\n'),
      }
      const cssOf = (doc: { html: string }): string =>
        renderDocumentShell(doc, { target: 'pdf' }).split('<style>')[1].split('</style>')[0]

      it('gives a figure the same gutter and rule as a text output', () => {
        const css = cssOf(figDoc)
        const rule = /img\[alt="output image"\]\s*\{([^}]*)\}/.exec(css)?.[1]
        expect(rule).toBeDefined()
        expect(rule).toContain('padding-left')
        expect(rule).toContain('border-left')
        // The gutter has to be the SAME width as the pre gutter or the figure
        // will not line up with the block above it.
        const gutter = /pre\.nb-in,[^{]*\{[^}]*padding-left:\s*([0-9.]+em)/.exec(css)?.[1]
        expect(gutter).toBeDefined()
        expect(rule).toContain(`padding-left: ${gutter}`)
        // The padding must be counted inside the width, or the figure runs off
        // the page and printToPDF clips it away.
        expect(rule).toContain('border-box')
      })

      it('styles a notebook that has a figure and no classed block at all', () => {
        const css = cssOf({ html: '<img src="data:image/png;base64,AAAA" alt="output image">' })
        expect(css).toContain('img[alt="output image"]')
      })

      it('leaves an ordinary document image alone', () => {
        const css = cssOf({ html: '<p>text</p>\n<img src="https://example.org/a.png" alt="a chart">' })
        expect(css).not.toContain('nb-in')
        expect(css).not.toContain('alt="output image"')
      })
    })

    it('adds no notebook css to an ordinary document', () => {
      const out = renderDocumentShell({ html: '<p>plain</p>' }, { target: 'pdf' })
      expect(out).not.toContain('nb-in')
      expect(out).not.toContain('In [')
    })

    it('styles notebooks for docx too, harmlessly, without prompts leaking as text', () => {
      const out = renderDocumentShell(nbDoc, { target: 'docx' })
      expect(out).not.toContain('>In [1]:<')
    })
  })

  it('leaves unknown languages untouched', () => {
    const out = renderDocumentShell(
      { html: '<pre><code class="language-imaginarylang">zork &amp; zap</code></pre>' },
      { target: 'pdf' },
    )
    expect(out).toContain('zork &amp; zap')
  })
})

/**
 * Both of these are print-geometry rules that no string assertion elsewhere
 * would catch, and both were found by looking at a rendered PDF.
 */
describe('print geometry', () => {
  const css = (): string => renderDocumentShell({ html: '<p>x</p>' }, { target: 'pdf' })

  it('bounds image height as well as width', () => {
    // An image taller than the page cannot be placed on it, so the renderer
    // pushed it to the next page and left the current one blank: an epub whose
    // 1450x2320 cover scaled to ~1177px tall produced an empty first page and
    // then split the cover across the two after it.
    const style = css()
    expect(style).toMatch(/max-height:\s*\d+vh/)
    expect(style).toContain('max-width: 100%')
  })

  it('sets code below the prose size', () => {
    // Monospace at the body size printed far larger than it read, costing
    // roughly a third more page and wrapping lines that would otherwise fit.
    const style = css()
    const size = /pre\s*\{[^}]*font-size:\s*([0-9.]+)em/.exec(style)?.[1]
    expect(size).toBeDefined()
    expect(Number(size)).toBeLessThan(1)
    expect(Number(size)).toBeGreaterThan(0.6)
  })

  it('keeps pre-wrap, which stops printToPDF clipping long lines', () => {
    expect(css()).toContain('white-space: pre-wrap')
  })
})
