import { describe, it, expect } from 'vitest'
import { writeRevealJs, FIT_SLIDES_JS } from '../../src/core/writers/revealjs'
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

  it('fits a long slide to the slide, and keeps formulas in their line', async () => {
    const html = await deck('<p>Load <img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="x" data-rendered="formula"> here</p>')
    expect(html).toContain("Reveal.on('slidechanged'")
    expect(html).toContain('width: 960, height: 700')
    expect(html).toContain('.reveal section img[data-rendered="formula"] { display: inline; margin: 0; }')
  })

  it('draws a task list without bullets', async () => {
    const html = await deck('<ul><li>☐ Pack</li><li>☑ Label</li></ul>')
    expect(html).toContain('<ul class="task-list">')
    expect(html).toContain('.reveal ul.task-list { list-style: none; }')
  })

  it('puts speaker notes where reveal expects them', async () => {
    const html = await deck('<p>a</p><aside><p>say this</p></aside>')
    expect(html).toContain('<aside class="notes"><p>say this</p></aside>')
  })

  it('honors an explicit split rule', async () => {
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

    it('colors python and javascript blocks with static spans', async () => {
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

    it('needs no highlight plugin: nothing is colored in the browser', async () => {
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

    it('does not color code in the speaker notes', async () => {
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

  it('still colors code with a language, its entities intact', async () => {
    const html = await deck('<pre><code class="language-js">if (a &gt; b &amp;&amp; c &lt; d) {}</code></pre>')
    expect(html).toContain('&gt;')
    expect(html).toContain('&amp;&amp;')
    expect(html).toContain('&lt;')
    expect(html).toContain('hljs-keyword')
  })
})

/**
 * The fit script run against a model of the slide's layout: a heading's
 * lines follow from its font size, its letters (capitals are wider) and the
 * slide's width, and the slide is as tall as what is on it. Coarse, but it
 * answers what the script decides from: how many lines, and whether it fits.
 */
describe('the reveal.js fit script', () => {
  const W = 960
  const H = 700
  interface Box { style: Record<string, string>; text: string; em: number; tag: string }
  function heading(tag: string, text: string, em: number): Box {
    return { style: {}, text, em, tag }
  }
  async function show(heads: Box[], bodyHeight = 0, deckCss = '') {
    const slideFont = (slide: { style: Record<string, string> }): number => (40 * (slide.style.fontSize ? parseFloat(slide.style.fontSize) : 100)) / 100
    const caps = (h: Box): boolean => (h.style.textTransform ?? (/text-transform:\s*none/.test(deckCss) && h.tag !== 'H1' ? 'none' : 'uppercase')) !== 'none'
    const slide = {
      style: {} as Record<string, string>,
      attrs: {} as Record<string, string>,
      getAttribute(n: string) { return this.attrs[n] ?? null },
      setAttribute(n: string, v: string) { this.attrs[n] = v },
      querySelectorAll(sel: string) { return sel === 'img' ? [] : heads.filter((h) => sel.toUpperCase().split(/,\s*/).includes(h.tag)) },
      get scrollHeight() { return heads.reduce((sum, h) => sum + height(h), 0) + (bodyHeight * slideFont(slide)) / 40 },
      get scrollWidth() { return W },
    }
    const fontPx = (h: Box): number => (h.style.fontSize ? parseFloat(h.style.fontSize) : h.em) * slideFont(slide)
    const lines = (h: Box): number => Math.ceil((h.text.length * fontPx(h) * (caps(h) ? 0.68 : 0.52)) / W)
    const height = (h: Box): number => lines(h) * fontPx(h) * 1.2
    for (const h of heads) Object.defineProperty(h, 'offsetHeight', { get: () => height(h) })
    const getComputedStyle = (el: unknown) =>
      el === slide ? { fontSize: `${slideFont(slide)}px` } : { fontSize: `${fontPx(el as Box)}px`, lineHeight: `${fontPx(el as Box) * 1.2}px` }
    const handlers: Record<string, (e: unknown) => void> = {}
    const Reveal = { on: (n: string, f: (e: unknown) => void) => (handlers[n] = f), layout: () => {} }
    new Function('Reveal', 'getComputedStyle', FIT_SLIDES_JS)(Reveal, getComputedStyle)
    handlers.ready({ currentSlide: slide })
    await new Promise((r) => setTimeout(r, 0))
    return { slide, lines, fontPx, caps, H }
  }

  it('keeps a short title large and in the theme capitals', async () => {
    const title = heading('H1', 'Field Notes', 2.5)
    const { slide, caps } = await show([title], 200)
    expect(title.style.fontSize).toBeUndefined()
    expect(caps(title)).toBe(true)
    expect(slide.style.fontSize).toBe('')
  })

  it('sets a long title as written, smaller, on at most two lines', async () => {
    const title = heading('H1', 'Temperature and the Rate of Crystal Violet Fading', 2.5)
    const { slide, caps, lines, fontPx } = await show([title], 120)
    expect(caps(title)).toBe(false)
    expect(lines(title)).toBeLessThanOrEqual(2)
    // Still a title: well above the section headings' 1.6em.
    expect(fontPx(title)).toBeGreaterThan(1.6 * 40)
    expect(slide.style.fontSize).toBe('')
  })

  it('makes the title smaller when that alone makes the slide fit', async () => {
    const title = heading('H1', 'Office Move Planning: Meeting Summary', 2.5)
    const { slide, fontPx, lines, H } = await show([title], 500)
    expect(slide.style.fontSize).toBe('')
    expect(lines(title)).toBe(2)
    // Smaller than two lines alone need (2.4em here), no smaller than a section heading.
    expect(fontPx(title)).toBeLessThan(2.4 * 40)
    expect(fontPx(title)).toBeGreaterThanOrEqual(1.6 * 40)
    expect(slide.scrollHeight).toBeLessThanOrEqual(H)
  })

  it('keeps the title at its two-line size when the whole slide has to be made smaller', async () => {
    const title = heading('H1', 'Office Move Planning: Meeting Summary', 2.5)
    const { slide } = await show([title], 640)
    expect(title.style.fontSize).toBe('2.40em')
    expect(parseFloat(slide.style.fontSize)).toBeLessThan(100)
  })

  it('leaves a short section heading alone', async () => {
    const h2 = heading('H2', 'Timeline', 1.6)
    const { caps } = await show([h2], 300)
    expect(h2.style.fontSize).toBeUndefined()
    expect(caps(h2)).toBe(true)
  })

  it('sets section headings as written, deck-wide, when one of them is long', async () => {
    const long = await deck('<h1>T</h1><h2>Bearings and the L2 gusset repair</h2><p>a</p><h2>Scope</h2><p>b</p>')
    expect(long).toMatch(/\.reveal h2[^{]*\{[^}]*text-transform: none/)
    const short = await deck('<h1>A long title that runs well past one line of capitals</h1><h2>Scope</h2><p>a</p><h2>Loads</h2><p>b</p>')
    expect(short).not.toMatch(/\.reveal h2[^{]*\{[^}]*text-transform: none/)
  })
})
