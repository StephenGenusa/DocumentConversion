import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { readMarkdown } from '../../src/core/readers/md'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeTxt } from '../../src/core/writers/txt'
import { writeDocx } from '../../src/core/writers/docx'
import { drawBlocks } from '../../src/core/draw-blocks'
import { createConverter } from '../../src/core/convert'
import { sanitizeToHub } from '../../src/core/allowlist'
import { hubFeatures, type RenderBlocks, type RenderRequest } from '../../src/core/rendered-blocks'

/*
 * `$$…$$` in the middle of a sentence is display math inside the paragraph,
 * as pandoc reads it: `<p>The sum <br /><span class="math display">…</span><br /> is big.</p>`.
 * The hub holds it as the inline code element with a display marker:
 *
 *   <code class="language-math math-display">TEX</code>
 */

const B = '\\'
const md = async (text: string): Promise<string> => (await readMarkdown({ bytes: Buffer.from(text, 'utf8') })).html
const toMd = async (html: string): Promise<string> => (await writeMarkdown({ html })).toString('utf8')
const shown = (tex: string): string => `<code class="language-math math-display">${tex}</code>`
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 24 16"><path d="M0 0h1"/></svg>'
const SVG64 = Buffer.from(SVG, 'utf8').toString('base64')

function fakeRenderer(): { render: RenderBlocks; calls: RenderRequest[] } {
  const calls: RenderRequest[] = []
  const render: RenderBlocks = async (requests) => {
    calls.push(...requests)
    return requests.map((r) => {
      const size = r.display ? { width: 80, height: 40, baseline: 14 } : { width: 24, height: 16, baseline: 4 }
      return r.format === 'svg' ? { svg: SVG, ...size } : { png: PNG, ...size }
    })
  }
  return { render, calls }
}

describe('Markdown reads $$…$$ in a sentence as display math in the paragraph', () => {
  it('gives the hub form', async () => {
    expect(await md('The sum $$x+y$$ is big.')).toBe(`<p>The sum ${shown('x+y')} is big.</p>\n`)
    expect(await md(`So $$${B}sum_i i < 2$$`)).toBe(`<p>So ${shown(`${B}sum_i i &lt; 2`)}</p>\n`)
  })

  it('still reads a paragraph that is only $$…$$ as a display block', async () => {
    expect(await md(`$$${B}sum_i i$$`)).toBe(`<pre><code class="language-math">${B}sum_i i</code></pre>\n`)
  })

  it('reports it as math', async () => {
    expect(hubFeatures(await md('The sum $$x+y$$ is big.')).math).toBe(true)
  })
})

describe('the sanitizer keeps the display marker, and only beside language-math', () => {
  it('keeps it, in one order', () => {
    expect(sanitizeToHub(`<p>a ${shown('x')} b</p>`)).toBe(`<p>a ${shown('x')} b</p>`)
    expect(sanitizeToHub('<p>a <code class="math-display language-math">x</code> b</p>')).toBe(`<p>a ${shown('x')} b</p>`)
  })

  it('drops it elsewhere', () => {
    expect(sanitizeToHub('<p><code class="math-display">x</code></p>')).toBe('<p><code>x</code></p>')
    expect(sanitizeToHub('<p><code class="language-ts math-display">x</code></p>')).toBe('<p><code class="language-ts">x</code></p>')
  })
})

describe('writers', () => {
  it('md: writes $$…$$ back in place, and it reads back the same', async () => {
    const hub = `<p>The sum ${shown('x+y')} is big, and ${shown(`${B}$5`)}.</p>\n`
    expect(await toMd(hub)).toBe(`The sum $$x+y$$ is big, and $$${B}$5$$.`)
    expect(await md(await toMd(hub))).toBe(hub)
  })

  it('md: TeX whose lines would break the paragraph is put on one line', async () => {
    expect(await toMd(`<p>So ${shown('a\n- b')} c</p>`)).toBe('So $$a - b$$ c')
  })

  it('md → md round trip is exact', async () => {
    const source = `The sum $$x+y$$ is big, ${'$'}{n = 5}$ inline.\n\n$$${B}sum_i i$$`
    expect(await toMd(await md(source))).toBe(source)
  })

  it('txt: $$…$$ in place', async () => {
    expect((await writeTxt({ html: `<p>The sum ${shown('x+y')} is big.</p>` })).toString('utf8')).toContain('The sum $$x+y$$ is big.')
  })

  it('html, pdf, epub, azw3, revealjs: drawn as display, on a centered line of its own inside the paragraph', async () => {
    for (const target of ['html', 'pdf', 'epub', 'revealjs'] as const) {
      const { render, calls } = fakeRenderer()
      const out = await drawBlocks(`<p>The sum ${shown('x+y')} is big.</p>`, target, { renderBlocks: render })
      expect(calls).toEqual([{ kind: 'math', source: 'x+y', display: true, format: 'svg' }])
      expect(out).toBe(
        `<p>The sum <span style="display:block;text-align:center;margin:0.5em 0"><img src="data:image/svg+xml;base64,${SVG64}" alt="x+y" ` +
          `width="80" height="40" style="width:10ex;height:auto;max-width:100%" data-rendered="formula"></span> is big.</p>`,
      )
    }
    const { render } = fakeRenderer()
    const kindle = await drawBlocks(`<p>The sum ${shown('x+y')} is big.</p>`, 'azw3', { renderBlocks: render })
    expect(kindle).toContain('<p>The sum <span style="display:block;text-align:center;margin:0.5em 0"><img src="data:image/png;base64,')
  })

  it('docx: drawn as display between two line breaks, for the writer', async () => {
    const { render } = fakeRenderer()
    const out = await drawBlocks(`<li>The sum ${shown('x+y')} is big.</li>`, 'docx', { renderBlocks: render })
    expect(out).toMatch(/^<li>The sum <br><img [^>]*data-docx-own-line[^>]*><br> is big\.<\/li>$/)
    expect(out).not.toContain('data-docx-lower')
  })

  it('docx: a paragraph is split around it, the formula centered in a paragraph of its own', async () => {
    const { render } = fakeRenderer()
    const html = await drawBlocks(`<p>The sum ${shown('x+y')} is big.</p><p>Next.</p>`, 'docx', { renderBlocks: render })
    const zip = await JSZip.loadAsync(await writeDocx({ html }))
    const xml = await zip.file('word/document.xml')!.async('string')
    const paras = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>|<w:p [\s\S]*?<\/w:p>/g)].map((m) => m[0])
    const at = paras.findIndex((p) => p.includes('<w:drawing>'))
    expect(at).toBeGreaterThan(0)
    expect(paras[at - 1]).toContain('The sum')
    expect(paras[at]).toContain('<w:jc w:val="center"/>')
    expect(paras[at]).not.toContain('<w:t')
    expect(paras[at + 1]).toContain('is big.')
    expect(xml).not.toContain('<w:br/>')
  })

  it('a conversion: md → html draws it as display; md → md keeps it', async () => {
    const { render, calls } = fakeRenderer()
    const conv = createConverter(async () => Buffer.from('%PDF-'), { renderBlocks: render })
    const src = Buffer.from('The sum $$x+y$$ is big.\n')
    const html = (await conv.convert({ bytes: src, filename: 'm.md' }, 'md', 'html')).parts[0].bytes.toString('utf8')
    expect(calls.map((c) => c.display)).toEqual([true])
    expect(html).toContain('The sum <span style="display:block;text-align:center;margin:0.5em 0"><img ')
    const back = (await conv.convert({ bytes: src, filename: 'm.md' }, 'md', 'md')).parts[0].bytes.toString('utf8')
    expect(back.trim()).toBe('The sum $$x+y$$ is big.')
  })
})
