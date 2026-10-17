import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { drawBlocks } from '../../src/core/draw-blocks'
import { createConverter } from '../../src/core/convert'
import { readHtml } from '../../src/core/readers/html'
import type { RenderBlocks } from '../../src/core/rendered-blocks'

/*
 * A display formula that cannot be drawn keeps its TeX and still stands as
 * display math: on a centered line of its own, in the code font, with the
 * "Formula N could not be drawn" notice. Inline math stays in the line.
 */

const failing: RenderBlocks = async (requests) => requests.map(() => ({ error: 'Undefined control sequence \\foo' }))
const crashing: RenderBlocks = async () => {
  throw new Error('render window crashed')
}
const block = '<pre><code class="language-math">\\foo{x}\n+ y</code></pre>'
const inPara = '<p>The sum <code class="language-math math-display">\\foo{a}</code> is big.</p>'
const inline = '<p>Let <code class="language-math">\\foo</code> be.</p>'
const CENTERED = '<span style="display:block;text-align:center;margin:0.5em 0"><code class="language-math math-display">\\foo{a}</code></span>'

describe('a display formula that could not be drawn', () => {
  it.each(['html', 'pdf', 'epub', 'azw3', 'revealjs'] as const)('%s: centered on its own line, the TeX in the code font', async (target) => {
    const onAdvice = vi.fn()
    const out = await drawBlocks(`${block}${inPara}${inline}`, target, { renderBlocks: failing, onAdvice })
    expect(out).toBe(
      '<pre style="text-align:center"><code class="language-math">\\foo{x}\n+ y</code></pre>' + `<p>The sum ${CENTERED} is big.</p>` + inline,
    )
    expect(onAdvice.mock.calls.map((c) => c[1])).toEqual([1, 2, 3].map((n) => `Formula ${n} could not be drawn: Undefined control sequence \\foo`))
  })

  it('leaves out the blank first and last lines of the TeX', async () => {
    const out = await drawBlocks('<pre><code class="language-math">\n\\foo{x}\n</code></pre>', 'pdf', { renderBlocks: failing })
    expect(out).toBe('<pre style="text-align:center"><code class="language-math">\\foo{x}</code></pre>')
  })

  it('docx: between two breaks, for the writer to center in a paragraph of its own', async () => {
    const out = await drawBlocks(`${block}${inPara}`, 'docx', { renderBlocks: failing })
    expect(out).toBe(
      '<pre style="text-align:center"><code class="language-math">\\foo{x}\n+ y</code></pre>' +
        '<p>The sum <br><code data-docx-own-line class="language-math math-display">\\foo{a}</code><br> is big.</p>',
    )
  })

  it('the same when the renderer itself fails, with its one notice', async () => {
    const onAdvice = vi.fn()
    const out = await drawBlocks(`${inPara}${inline}`, 'html', { renderBlocks: crashing, onAdvice })
    expect(out).toBe(`<p>The sum ${CENTERED} is big.</p>${inline}`)
    expect(onAdvice).toHaveBeenCalledTimes(1)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Formulas could not be drawn: render window crashed')
  })

  it('html output read back gives the formulas again', async () => {
    const conv = createConverter(async () => Buffer.from('%PDF-'), { renderBlocks: failing })
    const src = { bytes: Buffer.from(`<html><body>${block}${inPara}</body></html>`), filename: 'a.html' }
    const html = (await conv.convert(src, 'html', 'html')).parts[0].bytes
    const back = (await readHtml({ bytes: html, filename: 'b.html' })).html
    expect(back).toContain('<pre><code class="language-math">\\foo{x}\n+ y</code></pre>')
    expect(back).toContain('<code class="language-math math-display">\\foo{a}</code>')
  })

  it.each([
    ['could not be drawn', { renderBlocks: failing }],
    ['there is no renderer', {}],
  ] as const)('docx (%s): each a centered paragraph of its own in Courier, the text around it in the paragraphs either side', async (_, deps) => {
    const conv = createConverter(async () => Buffer.from('%PDF-'), deps)
    const src = { bytes: Buffer.from(`<html><body>${block}${inPara}</body></html>`), filename: 'a.html' }
    const zip = await JSZip.loadAsync((await conv.convert(src, 'html', 'docx')).parts[0].bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    const paras = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>|<w:p [\s\S]*?<\/w:p>/g)].map((m) => m[0])
    const texts = (p: string): string => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br\b[^>]*\/>/g)].map((m) => m[1] ?? '\n').join('')
    const at = paras.findIndex((p) => texts(p) === '\\foo{x}\n+ y')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(paras[at]).toContain('<w:jc w:val="center"/>')
    expect(paras[at]).toContain('w:ascii="Courier"')
    expect(texts(paras[at + 1])).toBe('The sum')
    expect(texts(paras[at + 2])).toBe('\\foo{a}')
    expect(paras[at + 2]).toContain('<w:jc w:val="center"/>')
    expect(paras[at + 2]).toContain('w:ascii="Courier"')
    expect(texts(paras[at + 3]).trim()).toBe('is big.')
  })
})

/*
 * The same layout when nothing is drawn at all: core without a renderer, or
 * formulas not among the kinds drawn. Nothing is said, as before.
 */
describe('a display formula that is not drawn', () => {
  const UNDRAWN = '<pre style="text-align:center"><code class="language-math">\\foo{x}\n+ y</code></pre>' + `<p>The sum ${CENTERED} is big.</p>` + inline

  it.each(['html', 'pdf', 'epub', 'azw3', 'azw4', 'revealjs'] as const)('%s without a renderer: centered on its own line, silently', async (target) => {
    const onAdvice = vi.fn()
    expect(await drawBlocks(`${block}${inPara}${inline}`, target, { onAdvice })).toBe(UNDRAWN)
    expect(onAdvice).not.toHaveBeenCalled()
  })

  it('docx without a renderer: between two breaks, for the writer to center', async () => {
    expect(await drawBlocks(`${block}${inPara}${inline}`, 'docx', {})).toBe(
      '<pre style="text-align:center"><code class="language-math">\\foo{x}\n+ y</code></pre>' +
        '<p>The sum <br><code data-docx-own-line class="language-math math-display">\\foo{a}</code><br> is big.</p>' +
        inline,
    )
  })

  it('leaves out the blank first and last lines of the TeX', async () => {
    const out = await drawBlocks('<pre><code class="language-math">\n\\foo{x}\n</code></pre>', 'epub', {})
    expect(out).toBe('<pre style="text-align:center"><code class="language-math">\\foo{x}</code></pre>')
  })

  it('md, txt and the table targets keep it as it is', async () => {
    for (const t of ['md', 'txt', 'csv', 'json', 'xlsx'] as const) {
      expect(await drawBlocks(`${block}${inPara}${inline}`, t, {})).toBe(`${block}${inPara}${inline}`)
    }
  })

  it('with formulas not drawn, laid out the same and the renderer never asked for them', async () => {
    vi.resetModules()
    vi.doMock('../../src/core/rendered-blocks', async (orig) => ({
      ...(await orig<typeof import('../../src/core/rendered-blocks')>()),
      DRAWN_KINDS: new Set(['mermaid', 'dot']),
    }))
    try {
      const { drawBlocks: draw } = await import('../../src/core/draw-blocks')
      const render = vi.fn(failing)
      const onAdvice = vi.fn()
      expect(await draw(`${block}${inPara}${inline}`, 'pdf', { renderBlocks: render, onAdvice })).toBe(UNDRAWN)
      expect(render).not.toHaveBeenCalled()
      expect(onAdvice).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('../../src/core/rendered-blocks')
      vi.resetModules()
    }
  })

  it('html output read back gives the formulas again', async () => {
    const conv = createConverter(async () => Buffer.from('%PDF-'))
    const src = { bytes: Buffer.from(`<html><body>${block}${inPara}</body></html>`), filename: 'a.html' }
    const html = (await conv.convert(src, 'html', 'html')).parts[0].bytes
    expect(html.toString()).toContain(CENTERED)
    const back = (await readHtml({ bytes: html, filename: 'b.html' })).html
    expect(back).toContain('<pre><code class="language-math">\\foo{x}\n+ y</code></pre>')
    expect(back).toContain('<code class="language-math math-display">\\foo{a}</code>')
  })
})
