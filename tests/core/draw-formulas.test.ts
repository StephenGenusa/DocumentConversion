import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { DOCX_EX_PX, drawBlocks, RENDER_LIMITS } from '../../src/core/draw-blocks'
import { createConverter } from '../../src/core/convert'
import { DRAWN_KINDS, drawsSomething, type RenderBlocks, type RenderRequest, type RenderResult } from '../../src/core/rendered-blocks'

/*
 * TeX formulas drawn for output (spec B3, B5, B7; plan step 18), with a fake
 * renderer. The real MathJax is tested in tests/main/render-host.test.ts.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
/** Another PNG, so two formulas have different bytes in Word. */
const PNG2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** A third (2x1), for display formulas. */
const PNG3 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGPgEpHTMLIBAAI3ANNbVlHYAAAAAElFTkSuQmCC'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 24 16"><path d="M0 0h1"/></svg>'
const SVG64 = Buffer.from(SVG, 'utf8').toString('base64')

const inline = (tex: string): string => `<code class="language-math">${tex}</code>`
const display = (tex: string): string => `<pre><code class="language-math">${tex}</code></pre>`

/**
 * Inline formulas 24x16 px with the baseline 4 px above the bottom; display
 * ones 80x40. A source containing \foo is an unknown macro, as MathJax says.
 */
function fakeRenderer(): { render: RenderBlocks; calls: RenderRequest[][]; timeouts: number[] } {
  const calls: RenderRequest[][] = []
  const timeouts: number[] = []
  const render: RenderBlocks = async (requests, opts) => {
    calls.push(requests)
    timeouts.push(opts.timeoutMs)
    return requests.map((r): RenderResult => {
      if (r.source.includes('\\foo')) return { error: 'Undefined control sequence \\foo' }
      const size = r.display ? { width: 80, height: 40, baseline: 14 } : { width: 24, height: 16, baseline: 4 }
      return r.format === 'svg' ? { svg: SVG, ...size } : { png: r.display ? PNG3 : r.source.includes('y') ? PNG2 : PNG, ...size }
    })
  }
  return { render, calls, timeouts }
}

describe('drawing formulas (step 18)', () => {
  it('math is a drawn kind, so the Diagrams and formulas choice counts formulas', () => {
    expect(DRAWN_KINDS.has('math')).toBe(true)
    expect(drawsSomething({ diagrams: false, math: true })).toBe(true)
  })

  it('draws an inline formula in the line: sized and lowered in ex, so it follows the text size; alt is the TeX', async () => {
    const { render, calls } = fakeRenderer()
    const out = await drawBlocks(`<p>Let ${inline('x^2 &lt; 1')} hold.</p>`, 'html', { renderBlocks: render })
    expect(calls).toEqual([[{ kind: 'math', source: 'x^2 < 1', display: false, format: 'svg' }]])
    expect(out).toBe(
      `<p>Let <img src="data:image/svg+xml;base64,${SVG64}" alt="x^2 &lt; 1" width="24" height="16" ` +
        `style="width:3ex;height:2ex;vertical-align:-0.5ex" data-rendered="formula"> hold.</p>`,
    )
  })

  it('computes vertical-align from the baseline: px above the bottom edge, at 8 px to the ex, lowered', async () => {
    const render: RenderBlocks = async (reqs) => reqs.map(() => ({ svg: SVG, width: 19, height: 16, baseline: 0.903 }))
    const out = await drawBlocks(`<p>${inline('x^2')}</p>`, 'pdf', { renderBlocks: render })
    expect(out).toContain('style="width:2.375ex;height:2ex;vertical-align:-0.113ex"')
  })

  it('without a baseline, an inline formula sits on the line as an image does', async () => {
    const render: RenderBlocks = async (reqs) => reqs.map(() => ({ svg: SVG, width: 16, height: 16 }))
    const out = await drawBlocks(`<p>${inline('x')}</p>`, 'pdf', { renderBlocks: render })
    expect(out).toContain('style="width:2ex;height:2ex"')
  })

  it('centres a display formula on a line of its own, never wider than the page', async () => {
    const { render, calls } = fakeRenderer()
    const out = await drawBlocks(display('\\sum_i i'), 'epub', { renderBlocks: render })
    expect(calls[0]).toEqual([{ kind: 'math', source: '\\sum_i i', display: true, format: 'svg' }])
    expect(out).toBe(
      `<p style="text-align:center"><img src="data:image/svg+xml;base64,${SVG64}" alt="\\sum_i i" width="80" height="40" ` +
        `style="width:10ex;height:auto;max-width:100%" data-rendered="formula"></p>`,
    )
  })

  it('draws PNG where the target takes no SVG, and for the PNG choice, sized the same way', async () => {
    const { render, calls } = fakeRenderer()
    const out = await drawBlocks(`<p>${inline('x')}</p>`, 'azw3', { renderBlocks: render })
    expect(calls[0][0].format).toBe('png')
    expect(out).toContain(`src="data:image/png;base64,${PNG}" alt="x" width="24" height="16" style="width:3ex;height:2ex;vertical-align:-0.5ex"`)
    const chosen = await drawBlocks(`<p>${inline('x')}</p>`, 'pdf', { renderBlocks: render, format: 'png' })
    expect(chosen).toContain('data:image/png;base64,')
  })

  it("sizes Word's formulas in px at its text's x-height, and gives the lowering in half-points for the writer", async () => {
    const { render } = fakeRenderer()
    const out = await drawBlocks(`<p>${inline('x')}</p>${display('\\int')}`, 'docx', { renderBlocks: render })
    const f = DOCX_EX_PX / 8
    const w = Math.round(24 * f)
    const h = Math.round(16 * f)
    const lower = Math.round(4 * f * 1.5)
    expect(out).toContain(`alt="x" width="${w}" height="${h}" style="width:${w}px;height:${h}px" data-rendered="formula" data-docx-lower="${lower}"`)
    expect(out).toContain(
      `<p style="text-align:center"><img src="data:image/png;base64,${PNG3}" alt="\\int" width="${Math.round(80 * f)}" height="${Math.round(40 * f)}"`,
    )
  })

  it('an unknown macro keeps its source, with a notice naming the formula and the message; the rest are drawn', async () => {
    const { render } = fakeRenderer()
    const onAdvice = vi.fn()
    const html = `<p>${inline('a')} and ${inline('\\foo{b}')}</p>${display('c')}`
    const out = await drawBlocks(html, 'pdf', { renderBlocks: render, onAdvice })
    expect(out.match(/<img /g)).toHaveLength(2)
    expect(out).toContain(inline('\\foo{b}'))
    expect(onAdvice).toHaveBeenCalledTimes(1)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Formula 2 could not be drawn: Undefined control sequence \\foo')
  })

  it('numbers formulas apart from diagrams, and draws both', async () => {
    const calls: RenderRequest[][] = []
    const render: RenderBlocks = async (reqs) => {
      calls.push(reqs)
      return reqs.map((r) => (r.source.includes('\\foo') ? { error: 'Undefined control sequence \\foo' } : { svg: SVG, width: 24, height: 16, baseline: 4 }))
    }
    const onAdvice = vi.fn()
    const html = `<pre><code class="language-mermaid">graph LR\nA</code></pre><p>${inline('\\foo')}</p>`
    const out = await drawBlocks(html, 'html', { renderBlocks: render, onAdvice })
    expect(out).toContain('data-rendered="diagram"')
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Formula 1 could not be drawn: Undefined control sequence \\foo')
  })

  it("carries a formula's \\newcommand into the later ones that use it; alt and notices stay each formula's own", async () => {
    const { render, calls } = fakeRenderer()
    const onAdvice = vi.fn()
    const def = '\\newcommand{\\vv}[1]{\\mathbf{#1}}'
    const html = `<p>${inline('\\vv{a}')}</p>${display(`${def} \\vv{b}`)}<p>${inline('\\vv{c}')} ${inline('\\foo')}</p>`
    const out = await drawBlocks(html, 'html', { renderBlocks: render, onAdvice })
    expect(calls.flat().map((r) => r.source)).toEqual(['\\vv{a}', `${def} \\vv{b}`, `${def}\\vv{c}`, '\\foo'])
    expect(out).toContain('alt="\\vv{c}"')
    expect(onAdvice).toHaveBeenCalledTimes(1)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Formula 4 could not be drawn: Undefined control sequence \\foo')
  })

  it('carries nothing from one conversion into the next', async () => {
    const { render, calls } = fakeRenderer()
    await drawBlocks(`<p>${inline('\\def\\vv{v}\\vv')}</p>`, 'html', { renderBlocks: render })
    await drawBlocks(`<p>${inline('\\vv')}</p>`, 'html', { renderBlocks: render })
    expect(calls.flat().map((r) => r.source)).toEqual(['\\def\\vv{v}\\vv', '\\vv'])
  })

  it('asks once for a repeated formula, keyed by display too, and gives each 2 s', async () => {
    const { render, calls, timeouts } = fakeRenderer()
    const out = await drawBlocks(`<p>${inline('x')} ${inline('x')}</p>${display('x')}`, 'html', { renderBlocks: render })
    expect(calls.flat().map((r) => [r.source, r.display])).toEqual([
      ['x', false],
      ['x', true],
    ])
    expect(timeouts.every((t) => t === RENDER_LIMITS.formulas.eachMs)).toBe(true)
    expect(RENDER_LIMITS.formulas.eachMs).toBe(2000)
    expect(out.match(/<img /g)).toHaveLength(3)
  })

  it('leaves an empty formula alone, saying nothing', async () => {
    const { render, calls } = fakeRenderer()
    const onAdvice = vi.fn()
    const html = `<p>${inline('')}</p>`
    expect(await drawBlocks(html, 'html', { renderBlocks: render, onAdvice })).toBe(html)
    expect(calls).toHaveLength(0)
    expect(onAdvice).not.toHaveBeenCalled()
  })

  /** `count` distinct inline formulas in one paragraph. */
  const many = (count: number, name = 'a'): string => '<p>' + Array.from({ length: count }, (_, i) => inline(`${name}_{${i}}`)).join(' ') + '</p>'

  it('draws every one of 2,500 formulas, a batch at a time, with no notice (owner, 2026-10-16: the 2,000 limit is gone)', async () => {
    const { render, calls } = fakeRenderer()
    const onAdvice = vi.fn()
    const out = await drawBlocks(many(2500), 'pdf', { renderBlocks: render, onAdvice })
    expect(calls.flat()).toHaveLength(2500)
    expect(Math.max(...calls.map((c) => c.length))).toBe(RENDER_LIMITS.formulas.batch)
    expect(out.match(/<img /g)).toHaveLength(2500)
    expect(out).not.toContain('language-math')
    expect(onAdvice).not.toHaveBeenCalled()
    expect(RENDER_LIMITS.formulas).toEqual({ eachMs: 2000, batch: 100 })
  })

  it('has no deadline for them all: batches that take 25 s each are all drawn', async () => {
    let now = 0
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const calls: RenderRequest[][] = []
      const render: RenderBlocks = async (reqs) => {
        calls.push(reqs)
        now += 25_000
        return reqs.map(() => ({ svg: SVG, width: 24, height: 16, baseline: 4 }))
      }
      const onAdvice = vi.fn()
      const count = RENDER_LIMITS.formulas.batch * 5
      const out = await drawBlocks(many(count, 'b'), 'pdf', { renderBlocks: render, onAdvice })
      expect(calls).toHaveLength(5)
      expect(out.match(/<img /g)).toHaveLength(count)
      expect(onAdvice).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('a formula that takes too long keeps its source, alone; the rest are drawn', async () => {
    const { render: inner } = fakeRenderer()
    const timeouts = new Set<number>()
    // The host answers a formula over its time with an error, and goes on with the next (render-host.ts).
    const render: RenderBlocks = async (reqs, opts) => {
      timeouts.add(opts.timeoutMs)
      const results = await inner(reqs, opts)
      return results.map((r, k) => (reqs[k].source === 'a_{150}' ? { error: 'drawing took longer than 2 s' } : r))
    }
    const onAdvice = vi.fn()
    const out = await drawBlocks(many(300), 'pdf', { renderBlocks: render, onAdvice })
    expect(timeouts).toEqual(new Set([RENDER_LIMITS.formulas.eachMs]))
    expect(out.match(/<img /g)).toHaveLength(299)
    expect(out).toContain(inline('a_{150}'))
    expect(onAdvice).toHaveBeenCalledTimes(1)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Formula 151 could not be drawn: drawing took longer than 2 s')
  })

  it('a cancel stops a long run: no batch is asked for after it, and the conversion ends cancelled', async () => {
    const controller = new AbortController()
    const calls: RenderRequest[][] = []
    // As the render host does: a request made, or waiting, when the signal fires is rejected.
    const render: RenderBlocks = async (reqs, opts) => {
      if (opts.signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' })
      calls.push(reqs)
      if (calls.length === 3) controller.abort()
      return reqs.map(() => ({ svg: SVG, width: 24, height: 16, baseline: 4 }))
    }
    const onAdvice = vi.fn()
    await expect(drawBlocks(many(2500), 'pdf', { renderBlocks: render, onAdvice, signal: controller.signal })).rejects.toThrow('Cancelled')
    expect(calls).toHaveLength(3)
    expect(onAdvice).not.toHaveBeenCalled()
  })

  it('tells its progress a batch at a time, through the conversion', async () => {
    const { render } = fakeRenderer()
    const progress: Array<[string, number | undefined]> = []
    const conv = createConverter(async () => Buffer.from('%PDF-'), { renderBlocks: render })
    await conv.write({ html: many(250) }, 'html', {}, { onProgress: (stage, percent) => progress.push([stage, percent]) })
    expect(progress).toEqual([
      ['Drawing formulas (0 of 250)', 0],
      ['Drawing formulas (100 of 250)', 40],
      ['Drawing formulas (200 of 250)', 80],
    ])
  })

  it('keeps every formula as source, with one notice, when the renderer itself fails', async () => {
    const onAdvice = vi.fn()
    const render: RenderBlocks = async () => {
      throw new Error('render window crashed')
    }
    const html = `<p>${inline('x')}</p>`
    expect(await drawBlocks(html, 'pdf', { renderBlocks: render, onAdvice })).toBe(html)
    expect(onAdvice).toHaveBeenCalledWith('render-failed', 'Formulas could not be drawn: render window crashed')
  })

  it('leaves md and txt with their delimiters, without asking', async () => {
    const { render, calls } = fakeRenderer()
    const conv = createConverter(async () => Buffer.from('%PDF-'), { renderBlocks: render })
    const md = Buffer.from('Let $x^2$ be.\n\n$$\\sum_i i$$\n')
    const back = (await conv.convert({ bytes: md, filename: 'm.md' }, 'md', 'md')).parts[0].bytes.toString('utf8')
    expect(back.trimEnd()).toBe('Let $x^2$ be.\n\n$$\\sum_i i$$')
    const txt = (await conv.convert({ bytes: md, filename: 'm.md' }, 'md', 'txt')).parts[0].bytes.toString('utf8')
    expect(txt).toContain('$x^2$')
    expect(txt).toContain('$$\\sum_i i$$')
    expect(calls).toHaveLength(0)
  })

  it('Word: formulas are PNG media, each inline one lowered onto the baseline (w:position), display ones centred', async () => {
    const { render } = fakeRenderer()
    const conv = createConverter(async () => Buffer.from('%PDF-'), { renderBlocks: render })
    const md = Buffer.from('Let $x^2$ and $y_1$ be.\n\n$$\\sum_i i$$\n')
    const out = await conv.convert({ bytes: md, filename: 'm.md' }, 'md', 'docx')
    const zip = await JSZip.loadAsync(out.parts[0].bytes)
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !zip.files[n].dir)
    expect(media.length).toBeGreaterThan(0)
    expect(media.every((n) => n.endsWith('.png'))).toBe(true)
    const doc = await zip.file('word/document.xml')!.async('string')
    const lower = Math.round(4 * (DOCX_EX_PX / 8) * 1.5)
    const runs = [...doc.matchAll(/<w:r>(?:(?!<\/w:r>)[\s\S])*?<w:drawing>[\s\S]*?<\/w:r>/g)].map((m) => m[0])
    expect(runs).toHaveLength(3)
    // Inline formulas (x^2 and y_1) are lowered; the display one is not.
    const lowered = runs.filter((r) => r.includes(`<w:position w:val="-${lower}"/>`))
    expect(lowered.length).toBe(2)
    expect(doc).toContain('descr="x^2"')
    expect(doc).not.toContain('language-math')
  })

  it('html: inline SVG pictures in the text, the source kept as alt', async () => {
    const { render } = fakeRenderer()
    const conv = createConverter(async () => Buffer.from('%PDF-'), { renderBlocks: render })
    const md = Buffer.from('Let $x^2$ be.\n')
    const html = (await conv.convert({ bytes: md, filename: 'm.md' }, 'md', 'html')).parts[0].bytes.toString('utf8')
    expect(html).toContain(`<img src="data:image/svg+xml;base64,${SVG64}" alt="x^2"`)
    expect(html).toContain('vertical-align:-0.5ex')
  })
})
