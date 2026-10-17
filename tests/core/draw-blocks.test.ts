import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { drawBlocks, FOR_PASTING, RENDER_LIMITS, renderCacheKey, rendersBlocks } from '../../src/core/draw-blocks'
import { createConverter } from '../../src/core/convert'
import { renderedFormatFor, type RenderBlocks, type RenderRequest, type RenderResult } from '../../src/core/rendered-blocks'
import { TARGET_FORMATS, type TargetFormat } from '../../src/core/types'

/** A 1x1 PNG: html-to-docx reads the size of every image it embeds. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const block = (lang: string, source: string): string => `<pre><code class="language-${lang}">${source}</code></pre>`

/** A sanitized SVG, as the host hands it over. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><text x="10" y="50">A</text></svg>'
const SVG64 = Buffer.from(SVG, 'utf8').toString('base64')

/** A renderer that draws everything 200x100 in the format asked, except sources containing BROKEN. */
function fakeRenderer(): { render: RenderBlocks; calls: RenderRequest[][] } {
  const calls: RenderRequest[][] = []
  const render: RenderBlocks = async (requests) => {
    calls.push(requests)
    return requests.map((r): RenderResult =>
      r.source.includes('BROKEN')
        ? { error: 'Parse error on line 1:\nBROKEN\n^' }
        : r.format === 'svg'
          ? { svg: SVG, width: 200, height: 100 }
          : { png: PNG, width: 200, height: 100 },
    )
  }
  return { render, calls }
}

/** Every target with a place for a picture; Word and Kindle get PNG. */
const DRAWING_TARGETS: TargetFormat[] = ['pdf', 'html', 'revealjs', 'epub', 'azw4', 'docx', 'azw3']

describe('drawBlocks (spec B3, B7) with a fake renderer', () => {
  it('draws for every picture target, and for no other', () => {
    for (const t of TARGET_FORMATS) expect(rendersBlocks(t), t).toBe(DRAWING_TARGETS.includes(t))
  })

  it('replaces a Mermaid block with a centered PNG <img>, alt "Diagram", sized in CSS px', async () => {
    const { render, calls } = fakeRenderer()
    const html = `<p>Before</p>${block('mermaid', 'flowchart TD\n  A --&gt; B')}<p>After</p>`
    const out = await drawBlocks(html, 'pdf', { renderBlocks: render, format: 'png' })
    expect(calls).toEqual([[{ kind: 'mermaid', source: 'flowchart TD\n  A --> B', display: true, format: 'png' }]])
    expect(out).toBe(
      `<p>Before</p><p style="text-align:center"><img src="data:image/png;base64,${PNG}" alt="Diagram" width="200" height="100" style="width:200px;height:auto;max-width:100%" data-rendered="diagram"></p><p>After</p>`,
    )
  })

  it('embeds SVG by default where the output supports it (spec B3), as a base64 data URI', async () => {
    const { render, calls } = fakeRenderer()
    const out = await drawBlocks(block('mermaid', 'graph LR\nA--&gt;B'), 'html', { renderBlocks: render })
    expect(calls[0][0].format).toBe('svg')
    expect(out).toBe(
      `<p style="text-align:center"><img src="data:image/svg+xml;base64,${SVG64}" alt="Diagram" width="200" height="100" style="width:200px;height:auto;max-width:100%" data-rendered="diagram"></p>`,
    )
  })

  it('draws in the format each target takes: the choice for pdf, html, revealjs, epub and azw4, PNG for Word and Kindle', async () => {
    const matrix: Record<string, Record<string, 'svg' | 'png' | undefined>> = {}
    for (const t of DRAWING_TARGETS) {
      matrix[t] = {}
      for (const chosen of [undefined, 'svg', 'png'] as const) {
        const { render, calls } = fakeRenderer()
        const out = await drawBlocks(block('mermaid', 'graph LR\nA'), t, { renderBlocks: render, format: chosen })
        matrix[t][String(chosen)] = calls[0][0].format
        expect(out, `${t} ${chosen}`).toContain(calls[0][0].format === 'svg' ? 'data:image/svg+xml;base64,' : 'data:image/png;base64,')
        expect(renderedFormatFor(t, chosen)).toBe(calls[0][0].format)
      }
    }
    const svgCapable = { undefined: 'svg', svg: 'svg', png: 'png' }
    expect(matrix).toEqual({
      pdf: svgCapable,
      html: svgCapable,
      revealjs: svgCapable,
      epub: svgCapable,
      azw4: svgCapable,
      docx: { undefined: 'png', svg: 'png', png: 'png' },
      azw3: { undefined: 'png', svg: 'png', png: 'png' },
    })
  })

  it('never embeds SVG in Word, even when SVG is chosen', async () => {
    const { render } = fakeRenderer()
    const out = await drawBlocks(block('mermaid', 'graph LR\nA'), 'docx', { renderBlocks: render, format: 'svg' })
    expect(out).not.toContain('svg')
    expect(out).toContain('data:image/png;base64,')
  })

  it('takes nothing but an SVG document from the host for an SVG picture', async () => {
    const render: RenderBlocks = async (reqs) => reqs.map(() => ({ svg: '<p>not a picture</p>', width: 10, height: 10 }))
    const onAdvice = vi.fn()
    const html = block('mermaid', 'graph LR\nA')
    expect(await drawBlocks(html, 'html', { renderBlocks: render, onAdvice })).toBe(html)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Diagram 1 could not be drawn: the engine gave no picture')
  })

  it('leaves md, txt and the table targets untouched, without asking the renderer', async () => {
    const { render, calls } = fakeRenderer()
    const html = block('mermaid', 'graph LR\nA--&gt;B')
    for (const t of ['md', 'txt', 'csv', 'json', 'xlsx'] as TargetFormat[]) {
      expect(await drawBlocks(html, t, { renderBlocks: render })).toBe(html)
    }
    expect(calls).toHaveLength(0)
  })

  it('draws Graphviz with its own engine (kind dot), and formulas apart (draw-formulas.test.ts)', async () => {
    const { render, calls } = fakeRenderer()
    const math = block('math', 'x^2') + '<p><code class="language-math">y</code></p>'
    const out = await drawBlocks(block('dot', 'digraph { a -&gt; b }') + math, 'html', { renderBlocks: render })
    expect(calls).toEqual([
      [{ kind: 'dot', source: 'digraph { a -> b }', display: true, format: 'svg' }],
      [
        { kind: 'math', source: 'x^2', display: true, format: 'svg' },
        { kind: 'math', source: 'y', display: false, format: 'svg' },
      ],
    ])
    expect(out).toContain(
      `<p style="text-align:center"><img src="data:image/svg+xml;base64,${SVG64}" alt="Diagram" width="200" height="100" style="width:200px;height:auto;max-width:100%" data-rendered="diagram"></p>`,
    )
    expect(out).not.toContain('language-math')
  })

  it('numbers Mermaid and Graphviz diagrams together, and never mixes up the same text in two languages', async () => {
    const { render, calls } = fakeRenderer()
    const onAdvice = vi.fn()
    const html = block('mermaid', 'graph LR\nA') + block('dot', 'BROKEN {') + block('dot', 'graph LR\nA')
    const out = await drawBlocks(html, 'docx', { renderBlocks: render, onAdvice })
    expect(calls[0].map((r) => [r.kind, r.source])).toEqual([
      ['mermaid', 'graph LR\nA'],
      ['dot', 'BROKEN {'],
      ['dot', 'graph LR\nA'],
    ])
    expect(out.match(/<img /g)).toHaveLength(2)
    expect(out).toContain(block('dot', 'BROKEN {'))
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Diagram 2 could not be drawn: Parse error on line 1: BROKEN ^')
  })

  it('keeps source silently when there is no renderer', async () => {
    const onAdvice = vi.fn()
    const html = block('mermaid', 'graph LR\nA--&gt;B')
    expect(await drawBlocks(html, 'pdf', { onAdvice })).toBe(html)
    expect(onAdvice).not.toHaveBeenCalled()
  })

  it('leaves a block that fails as source, with a notice naming it, and draws the rest', async () => {
    const { render } = fakeRenderer()
    const onAdvice = vi.fn()
    const broken = block('mermaid', 'BROKEN --&gt;')
    const html = block('mermaid', 'graph LR\nA--&gt;B') + broken + block('mermaid', 'graph LR\nC--&gt;D')
    const out = await drawBlocks(html, 'docx', { renderBlocks: render, onAdvice })
    expect(out.match(/<img /g)).toHaveLength(2)
    expect(out).toContain(broken)
    expect(onAdvice).toHaveBeenCalledTimes(1)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Diagram 2 could not be drawn: Parse error on line 1: BROKEN ^')
  })

  it('keeps every block as source, with one notice, when the renderer itself fails', async () => {
    const onAdvice = vi.fn()
    const html = block('mermaid', 'graph LR\nA--&gt;B') + block('mermaid', 'graph LR\nC--&gt;D')
    const render: RenderBlocks = async () => {
      throw new Error('render window crashed')
    }
    expect(await drawBlocks(html, 'pdf', { renderBlocks: render, onAdvice })).toBe(html)
    expect(onAdvice).toHaveBeenCalledTimes(1)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Diagrams could not be drawn: render window crashed')
  })

  it('rejects when canceled, rather than writing a half-drawn document', async () => {
    const controller = new AbortController()
    const render: RenderBlocks = async () => {
      controller.abort()
      throw new Error('canceled')
    }
    await expect(
      drawBlocks(block('mermaid', 'graph LR\nA--&gt;B'), 'pdf', { renderBlocks: render, signal: controller.signal }),
    ).rejects.toThrow('canceled')
  })

  it('draws the first 50 diagrams, keeps the rest as source, and says so once', async () => {
    const { render, calls } = fakeRenderer()
    const onAdvice = vi.fn()
    const total = RENDER_LIMITS.diagrams.max + 2
    const html = Array.from({ length: total }, (_, i) => block('mermaid', `graph LR\nN${i}`)).join('')
    const out = await drawBlocks(html, 'html', { renderBlocks: render, onAdvice })
    expect(calls[0]).toHaveLength(50)
    expect(out.match(/<img /g)).toHaveLength(50)
    expect(out).toContain(block('mermaid', 'graph LR\nN50'))
    expect(out).toContain(block('mermaid', 'graph LR\nN51'))
    expect(onAdvice).toHaveBeenCalledTimes(1)
    expect(onAdvice.mock.calls[0][1]).toBe(
      'This document has 52 diagrams; the first 50 were drawn and the other 2 are shown as source',
    )
  })

  it('gives each diagram 10 s, and asks for a repeated diagram once', async () => {
    const seen: number[] = []
    const { render: inner, calls } = fakeRenderer()
    const render: RenderBlocks = (reqs, opts) => {
      seen.push(opts.timeoutMs)
      return inner(reqs, opts)
    }
    const same = block('mermaid', 'graph LR\nA--&gt;B')
    const out = await drawBlocks(same + '<p>x</p>' + same, 'epub', { renderBlocks: render })
    expect(seen).toEqual([10_000])
    expect(calls[0]).toHaveLength(1)
    expect(out.match(/<img /g)).toHaveLength(2)
  })

  it('fits a wide diagram to the Word page, keeping its shape', async () => {
    const render: RenderBlocks = async (reqs) => reqs.map(() => ({ png: PNG, width: 1248, height: 300 }))
    const html = block('mermaid', 'graph LR\nA--&gt;B')
    expect(await drawBlocks(html, 'docx', { renderBlocks: render })).toContain('width="624" height="150" style="width:624px;')
    expect(await drawBlocks(html, 'pdf', { renderBlocks: render, format: 'png' })).toContain('width="1248" height="300"')
  })

  it('never puts anything but base64 in a src', async () => {
    const render: RenderBlocks = async (reqs) => reqs.map(() => ({ png: '"><script>x</script>', width: 1, height: 1 }))
    const onAdvice = vi.fn()
    const html = block('mermaid', 'graph LR\nA')
    expect(await drawBlocks(html, 'html', { renderBlocks: render, onAdvice })).toBe(html)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Diagram 1 could not be drawn: the engine gave no picture')
  })
})

describe('renderCacheKey (spec B5)', () => {
  const req: RenderRequest = { kind: 'mermaid', source: 'graph LR\nA', display: true, format: 'png' }
  it('differs by every part of the request and by engine version', () => {
    const base = renderCacheKey(req, '11.12.0')
    expect(renderCacheKey({ ...req }, '11.12.0')).toBe(base)
    expect(renderCacheKey({ ...req, format: 'svg' }, '11.12.0')).not.toBe(base)
    expect(renderCacheKey({ ...req, display: false }, '11.12.0')).not.toBe(base)
    expect(renderCacheKey({ ...req, kind: 'dot' }, '11.12.0')).not.toBe(base)
    expect(renderCacheKey({ ...req, source: 'graph LR\nB' }, '11.12.0')).not.toBe(base)
    expect(renderCacheKey(req, '11.12.1')).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('Converter.write draws diagrams through ConverterDeps.renderBlocks', () => {
  const pdf = async (): Promise<Buffer> => Buffer.from('%PDF-')
  const md = Buffer.from('# Title\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n```mermaid\nBROKEN\n```\n')

  it('docx holds the PNG as media, and the broken diagram as text, with a notice', async () => {
    const { render } = fakeRenderer()
    const onAdvice = vi.fn()
    const conv = createConverter(pdf, { renderBlocks: render })
    const out = await conv.convert({ bytes: md, filename: 'd.md' }, 'md', 'docx', undefined, { onAdvice })
    const zip = await JSZip.loadAsync(out.parts[0].bytes)
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'))
    expect(media.some((n) => n.endsWith('.png'))).toBe(true)
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('BROKEN')
    expect(doc).not.toContain('A --&gt; B')
    expect(onAdvice).toHaveBeenCalledWith('render-failed', expect.stringMatching(/^Diagram 2 could not be drawn: /))
  })

  it('html has the picture; md and txt keep the fences and never ask', async () => {
    const { render, calls } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const html = (await conv.convert({ bytes: md, filename: 'd.md' }, 'md', 'html')).parts[0].bytes.toString('utf8')
    expect(html).toContain(`src="data:image/svg+xml;base64,${SVG64}"`)
    expect(calls).toHaveLength(1)
    const back = (await conv.convert({ bytes: md, filename: 'd.md' }, 'md', 'md')).parts[0].bytes.toString('utf8')
    expect(back).toContain('```mermaid\nflowchart TD\n  A --> B\n```')
    const txt = (await conv.convert({ bytes: md, filename: 'd.md' }, 'md', 'txt')).parts[0].bytes.toString('utf8')
    expect(txt).toContain('A --> B')
    expect(calls).toHaveLength(1)
  })

  it("draws Graphviz from every reader's form: md fences (graphviz alias), and rst digraph:: / graph:: directives", async () => {
    const { render, calls } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const fromMd = Buffer.from('```graphviz\ndigraph { a -> b }\n```\n')
    const html = (await conv.convert({ bytes: fromMd, filename: 'g.md' }, 'md', 'html')).parts[0].bytes.toString('utf8')
    expect(html).toContain(`src="data:image/svg+xml;base64,${SVG64}"`)
    expect(calls[0]).toEqual([{ kind: 'dot', source: 'digraph { a -> b }\n', display: true, format: 'svg' }])
    const fromRst = Buffer.from('Title\n=====\n\n.. digraph:: deps\n\n   a -> b\n\n.. graph:: links\n\n   a -- b\n')
    await conv.convert({ bytes: fromRst, filename: 'g.rst' }, 'rst', 'pdf')
    expect(calls[1]).toEqual([
      { kind: 'dot', source: 'digraph deps {\na -> b\n}', display: true, format: 'svg' },
      { kind: 'dot', source: 'graph links {\na -- b\n}', display: true, format: 'svg' },
    ])
  })

  it('passes the chosen format from ConvertOptions.renderedFormat', async () => {
    const { render, calls } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const html = (await conv.convert({ bytes: md, filename: 'd.md' }, 'md', 'html', { renderedFormat: 'png' })).parts[0].bytes.toString('utf8')
    expect(calls[0][0].format).toBe('png')
    expect(html).toContain(`src="data:image/png;base64,${PNG}"`)
  })

  it('epub stores an SVG diagram as an image/svg+xml item, never as the cover', async () => {
    const { render } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const out = await conv.convert({ bytes: md, filename: 'd.md' }, 'md', 'epub', { renderedFormat: 'svg' })
    const zip = await JSZip.loadAsync(out.parts[0].bytes)
    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    expect(opf).toMatch(/<item id="img1" href="images\/img001\.svg" media-type="image\/svg\+xml"\/>/)
    expect(opf).not.toContain('cover-image')
    expect(await zip.file('OEBPS/images/img001.svg')!.async('string')).toBe(SVG)
  })

  it('docx never holds SVG media, whatever is chosen', async () => {
    const { render } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const out = await conv.convert({ bytes: md, filename: 'd.md' }, 'md', 'docx', { renderedFormat: 'svg' })
    const zip = await JSZip.loadAsync(out.parts[0].bytes)
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !zip.files[n].dir)
    expect(media.length).toBeGreaterThan(0)
    expect(media.every((n) => n.endsWith('.png'))).toBe(true)
  })

  it('draws on a copy: the hub passed to write() keeps its source', async () => {
    const { render } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const hub = await conv.read({ bytes: md, filename: 'd.md' }, 'md')
    const before = hub.html
    await conv.write(hub, 'html')
    expect(hub.html).toBe(before)
    expect(hub.html).not.toContain('<img')
  })

  it("an editor's copy converts to the clipboard as the html target does: drawn, with the source as plain text (spec B11)", async () => {
    // What the pane sends for an edited input: its HTML, read as html (items.ts toRequest).
    const edited = Buffer.from('<p>Flow:</p><pre><code class="language-mermaid">flowchart LR\n  A --&gt; B</code></pre>')
    const { render } = fakeRenderer()
    const conv = createConverter(pdf, { renderBlocks: render })
    const hub = await conv.read({ bytes: edited, filename: 'Clipboard' }, 'html')
    // The two flavors clipboardFlavors writes. The rich one is always PNG:
    // Word and Outlook do not take an SVG data URI from pasted HTML.
    const rich = (await conv.write(hub, 'html', { ...FOR_PASTING })).parts[0].bytes.toString('utf8')
    const plain = (await conv.write(hub, 'txt')).parts[0].bytes.toString('utf8')
    expect(rich).toContain(`src="data:image/png;base64,${PNG}"`)
    expect(rich).not.toContain('A --&gt; B')
    expect(plain).toContain('flowchart LR\n  A --> B')
  })
})
