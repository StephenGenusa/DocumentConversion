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

  it('docx: each a centered paragraph of its own in Courier, the text around it in the paragraphs either side', async () => {
    const conv = createConverter(async () => Buffer.from('%PDF-'), { renderBlocks: failing })
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
