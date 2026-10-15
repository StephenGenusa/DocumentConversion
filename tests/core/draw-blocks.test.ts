import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { drawBlocks, RENDER_LIMITS, renderCacheKey, rendersBlocks } from '../../src/core/draw-blocks'
import { createConverter } from '../../src/core/convert'
import type { RenderBlocks, RenderRequest, RenderResult } from '../../src/core/rendered-blocks'
import { TARGET_FORMATS, type TargetFormat } from '../../src/core/types'

/** A 1x1 PNG: html-to-docx reads the size of every image it embeds. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const block = (lang: string, source: string): string => `<pre><code class="language-${lang}">${source}</code></pre>`

/** A renderer that draws everything 200x100, except sources containing BROKEN. */
function fakeRenderer(): { render: RenderBlocks; calls: RenderRequest[][] } {
  const calls: RenderRequest[][] = []
  const render: RenderBlocks = async (requests) => {
    calls.push(requests)
    return requests.map((r): RenderResult =>
      r.source.includes('BROKEN') ? { error: 'Parse error on line 1:\nBROKEN\n^' } : { png: PNG, width: 200, height: 100 },
    )
  }
  return { render, calls }
}

/** azw3 is not one yet: its writer embeds no images (see RENDER_TARGETS). */
const DRAWING_TARGETS: TargetFormat[] = ['pdf', 'html', 'revealjs', 'epub', 'azw4', 'docx']

describe('drawBlocks (spec B3, B7) with a fake renderer', () => {
  it('draws for every picture target, and for no other', () => {
    for (const t of TARGET_FORMATS) expect(rendersBlocks(t), t).toBe(DRAWING_TARGETS.includes(t))
  })

  it('replaces a Mermaid block with a centred PNG <img>, alt "Diagram", sized in CSS px', async () => {
    const { render, calls } = fakeRenderer()
    const html = `<p>Before</p>${block('mermaid', 'flowchart TD\n  A --&gt; B')}<p>After</p>`
    const out = await drawBlocks(html, 'pdf', { renderBlocks: render })
    expect(calls).toEqual([[{ kind: 'mermaid', source: 'flowchart TD\n  A --> B', display: true, format: 'png' }]])
    expect(out).toBe(
      `<p>Before</p><p style="text-align:center"><img src="data:image/png;base64,${PNG}" alt="Diagram" width="200" height="100" style="width:200px;height:auto;max-width:100%"></p><p>After</p>`,
    )
  })

  it('leaves md, txt, azw3 and the table targets untouched, without asking the renderer', async () => {
    const { render, calls } = fakeRenderer()
    const html = block('mermaid', 'graph LR\nA--&gt;B')
    for (const t of ['md', 'txt', 'azw3', 'csv', 'json', 'xlsx'] as TargetFormat[]) {
      expect(await drawBlocks(html, t, { renderBlocks: render })).toBe(html)
    }
    expect(calls).toHaveLength(0)
  })

  it('keeps Graphviz and math as source in this step', async () => {
    const { render, calls } = fakeRenderer()
    const html = block('dot', 'digraph { a -&gt; b }') + block('math', 'x^2') + '<p><code class="language-math">y</code></p>'
    expect(await drawBlocks(html, 'html', { renderBlocks: render })).toBe(html)
    expect(calls).toHaveLength(0)
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

  it('rejects when cancelled, rather than writing a half-drawn document', async () => {
    const controller = new AbortController()
    const render: RenderBlocks = async () => {
      controller.abort()
      throw new Error('cancelled')
    }
    await expect(
      drawBlocks(block('mermaid', 'graph LR\nA--&gt;B'), 'pdf', { renderBlocks: render, signal: controller.signal }),
    ).rejects.toThrow('cancelled')
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
    expect(await drawBlocks(html, 'pdf', { renderBlocks: render })).toContain('width="1248" height="300"')
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
    expect(html).toContain(`src="data:image/png;base64,${PNG}"`)
    expect(calls).toHaveLength(1)
    const back = (await conv.convert({ bytes: md, filename: 'd.md' }, 'md', 'md')).parts[0].bytes.toString('utf8')
    expect(back).toContain('```mermaid\nflowchart TD\n  A --> B\n```')
    const txt = (await conv.convert({ bytes: md, filename: 'd.md' }, 'md', 'txt')).parts[0].bytes.toString('utf8')
    expect(txt).toContain('A --> B')
    expect(calls).toHaveLength(1)
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
    // The two flavours clipboardFlavors writes.
    const rich = (await conv.write(hub, 'html')).parts[0].bytes.toString('utf8')
    const plain = (await conv.write(hub, 'txt')).parts[0].bytes.toString('utf8')
    expect(rich).toContain(`src="data:image/png;base64,${PNG}"`)
    expect(rich).not.toContain('A --&gt; B')
    expect(plain).toContain('flowchart LR\n  A --> B')
  })
})
