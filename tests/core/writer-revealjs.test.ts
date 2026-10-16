import { describe, it, expect } from 'vitest'
import { writeRevealJs } from '../../src/core/writers/revealjs'
import { HLJS_CSS } from '../../src/core/hljs'

const deck = async (html: string, opts?: Parameters<typeof writeRevealJs>[1]): Promise<string> =>
  (await writeRevealJs({ html, title: 'Deck' }, opts)).toString('utf8')

describe('the reveal.js writer', () => {
  it('produces one section per slide', async () => {
    const html = await deck('<h1>A</h1><p>1</p><hr><h1>B</h1><p>2</p>')
    expect(html.match(/<section>/g)).toHaveLength(2)
    expect(html).toContain('<h1>A</h1>')
    expect(html).toContain('<h1>B</h1>')
  })

  it('is self-contained: no network reference of any kind', async () => {
    const html = await deck('<p>a</p>')
    // Scan the MARKUP only. The inlined engine is minified JS full of its own
    // string literals, and matching those would fail on reveal's source rather
    // than on anything this writer emitted.
    const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '')
    // Any src/href that is not a data: URI is a file this deck cannot open
    // without the network - the one failure that shows up on stage.
    const refs = [...markup.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1])
    expect(refs.filter((r) => !r.startsWith('data:') && !r.startsWith('#'))).toEqual([])
    expect(markup).not.toMatch(/https?:\/\//)
  })

  it('inlines the engine rather than linking it', async () => {
    const html = await deck('<p>a</p>')
    expect(html).toContain('Reveal.initialize')
    expect(html.length).toBeGreaterThan(150_000)
  })

  it('puts speaker notes where reveal expects them', async () => {
    const html = await deck('<p>a</p><aside><p>say this</p></aside>')
    expect(html).toContain('<aside class="notes"><p>say this</p></aside>')
  })

  it('honours an explicit split rule', async () => {
    const html = await deck('<h2>A</h2><p>1</p><h2>B</h2><p>2</p>', { slides: { splitOn: 'h2' } })
    expect(html.match(/<section>/g)).toHaveLength(2)
  })

  it('emits a valid document rather than an empty one for empty input', async () => {
    const html = await deck('')
    expect(html).toContain('<section>')
    expect(html).toContain('no content')
  })

  it('escapes the title rather than trusting it', async () => {
    const out = (await writeRevealJs({ html: '<p>a</p>', title: '<script>x</script>' })).toString('utf8')
    expect(out).not.toContain('<title><script>')
    expect(out).toContain('&lt;script&gt;')
  })
  describe('code', () => {
    const PY = '<pre><code class="language-python">def area(w, h):\n    # width by height\n    return w * h</code></pre>'
    const JS = '<pre><code class="language-javascript">const n = 42; // answer</code></pre>'

    it('colours python and javascript blocks with static spans', async () => {
      const html = await deck(`<h1>A</h1>${PY}<hr><h1>B</h1>${JS}`)
      expect(html).toContain('<code class="language-python hljs"><span class="hljs-keyword">def</span>')
      expect(html).toContain('<span class="hljs-comment"># width by height</span>')
      expect(html).toMatch(/<code class="language-javascript hljs"><span class="hljs-keyword">const<\/span>/)
      expect(html).toContain('<span class="hljs-number">42</span>')
    })

    it('carries the screen palette, since the simple theme is a white slide', async () => {
      const html = await deck(PY)
      expect(html).toContain(HLJS_CSS)
      expect(html).toMatch(/--r-background-color:#fff/)
    })

    it('needs no highlight plugin: nothing is coloured in the browser', async () => {
      const html = await deck(PY)
      expect(html).toContain('plugins: [ RevealNotes ]')
      expect(html).not.toMatch(/RevealHighlight/)
    })

    it('adds no palette to a deck without code', async () => {
      const html = await deck('<h1>A</h1><p>words</p>')
      expect(html).not.toContain('.hljs-keyword')
    })

    it('leaves plaintext, formula and diagram blocks as they came', async () => {
      const blocks = [
        '<pre><code class="language-plaintext">def not code</code></pre>',
        '<pre><code class="language-text">return as words</code></pre>',
        '<pre><code class="language-math">x^2 + y^2</code></pre>',
        '<p>inline <code class="language-math">a+b</code> here</p>',
        '<pre><code class="language-mermaid">graph TD; A --- B</code></pre>',
        '<pre><code class="language-dot">graph { a -- b }</code></pre>',
      ]
      const html = await deck(blocks.join(''))
      for (const b of blocks) expect(html).toContain(b)
      expect(html).not.toContain('.hljs-keyword')
    })

    it('does not colour code in the speaker notes', async () => {
      const html = await deck('<p>a</p><aside><pre><code class="language-python">def f(): pass</code></pre></aside>')
      expect(html).toContain('<aside class="notes"><pre><code class="language-python">def f(): pass</code></pre></aside>')
    })
  })
})

describe('the reveal.js writer keeps text escaped', () => {
  it('keeps &gt;, &lt; and &amp; in code, prose, notes and links as they came', async () => {
    const html = await deck(
      '<h1>A</h1><pre><code>if a &gt; b &amp;&amp; c &lt; d</code></pre>' +
        '<p>Use &lt;script&gt; tags &amp; <a href="https://example.com/?a=1&amp;b=2">more</a></p>' +
        '<aside><p>say a &lt;b&gt; c</p></aside>',
    )
    const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '')
    expect(markup).toContain('<pre><code>if a &gt; b &amp;&amp; c &lt; d</code></pre>')
    expect(markup).toContain('Use &lt;script&gt; tags &amp; ')
    expect(markup).toContain('href="https://example.com/?a=1&amp;b=2"')
    expect(markup).toContain('<aside class="notes"><p>say a &lt;b&gt; c</p></aside>')
    expect(markup).not.toContain('<script> tags')
    expect(markup).not.toContain('<b>')
  })

  it('still colours code with a language, its entities intact', async () => {
    const html = await deck('<pre><code class="language-js">if (a &gt; b &amp;&amp; c &lt; d) {}</code></pre>')
    expect(html).toContain('&gt;')
    expect(html).toContain('&amp;&amp;')
    expect(html).toContain('&lt;')
    expect(html).toContain('hljs-keyword')
  })
})
