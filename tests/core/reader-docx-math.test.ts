import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { equationMarker, readDocx, restoreEquations, takeEquations, type WordEquation } from '../../src/core/readers/docx'
import { createConverter } from '../../src/core/convert'
import type { RenderBlocks } from '../../src/core/rendered-blocks'
import type { AdviceKind } from '../../src/core/types'
// The fixture generators' own docx builder, so these documents are put
// together exactly as tests/corpus/treasurer-equations.docx is.
import { buildDocx, noteRef } from '../../scripts/fixtures/lib-docx.mjs'

/*
 * Word equations in the docx reader (spec B12, plan step 19): taken out of the
 * XML before mammoth (which drops them), turned into TeX, and put back as the
 * hub's math (B1). Inline unless a math paragraph stands alone in its
 * paragraph. The conversion itself is tests/core/omml-tex.test.ts.
 */

const r = (t: string): string => `<m:r><m:t xml:space="preserve">${t}</m:t></m:r>`
const t = (s: string): string => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`
const xSquared = `<m:oMath><m:sSup><m:e>${r('x')}</m:e><m:sup>${r('2')}</m:sup></m:sSup></m:oMath>`
const mathPara = (...maths: string[]): string => `<m:oMathPara>${maths.join('')}</m:oMathPara>`
const unknown = `<m:oMath>${r('a')}<m:mystery><m:e>${r('b')}</m:e></m:mystery></m:oMath>`

async function read(opts: { body: string; footnotes?: string[]; endnotes?: string[] }): Promise<{ html: string; notes: Array<[AdviceKind, string]> }> {
  const notes: Array<[AdviceKind, string]> = []
  const bytes = await buildDocx(opts)
  const { html } = await readDocx({ bytes, filename: 'e.docx' }, { onAdvice: (kind, message) => notes.push([kind, message]) })
  return { html, notes }
}

const inline = (tex: string): string => `<code class="language-math">${tex}</code>`
const display = (tex: string): string => `<pre><code class="language-math">${tex}</code></pre>`

describe('Word equations in the docx reader', () => {
  it('inline math in running text (the spec’s "Inline x² end.", which used to lose the x²)', async () => {
    const { html, notes } = await read({ body: `<w:p>${t('Inline ')}${xSquared}${t(' end.')}</w:p>` })
    expect(html).toBe(`<p>Inline ${inline('x^{2}')} end.</p>`)
    expect(notes).toEqual([])
  })

  it('a math paragraph alone in its paragraph is display math', async () => {
    const { html } = await read({ body: `<w:p>${t('Before.')}</w:p><w:p>${mathPara(xSquared)}</w:p><w:p>${t('After.')}</w:p>` })
    expect(html).toBe(`<p>Before.</p>${display('x^{2}')}<p>After.</p>`)
  })

  it('a math paragraph sharing its paragraph with text is inline', async () => {
    const { html } = await read({ body: `<w:p>${t('So ')}${mathPara(xSquared)}</w:p>` })
    expect(html).toBe(`<p>So ${inline('x^{2}')}</p>`)
  })

  it('an m:oMath alone in its paragraph, not in a math paragraph, stays inline (B12)', async () => {
    const { html } = await read({ body: `<w:p>${xSquared}</w:p>` })
    expect(html).toBe(`<p>${inline('x^{2}')}</p>`)
  })

  it('a bookmark beside a math paragraph still leaves it on its own line', async () => {
    const { html } = await read({ body: `<w:p><w:bookmarkStart w:id="0" w:name="eq1"/>${mathPara(xSquared)}<w:bookmarkEnd w:id="0"/></w:p>` })
    expect(html).toBe(display('x^{2}'))
  })

  it('math in a footnote (inline) and an endnote (display) survives the footnote model', async () => {
    const { html } = await read({
      body: `<w:p>${t('Claim')}${noteRef('footnote', 1)}${t(' and more')}${noteRef('endnote', 1)}</w:p>`,
      footnotes: [`<w:p>${t('Since ')}${xSquared}${t(' grows.')}</w:p>`],
      endnotes: [`<w:p>${t('The total:')}</w:p><w:p>${mathPara(xSquared)}</w:p>`],
    })
    expect(html).toContain(`<li data-fn="1"><p>Since ${inline('x^{2}')} grows.</p></li>`)
    expect(html).toContain(`<li data-fn="e1"><p>The total:</p>${display('x^{2}')}</li>`)
    expect(html).not.toContain('↑')
  })

  it('escapes TeX for the hub: < and & are entities in the code', async () => {
    const { html } = await read({ body: `<w:p><m:oMath>${r('a&lt;b')}</m:oMath></w:p>` })
    expect(html).toBe(`<p>${inline('a&lt;b')}</p>`)
  })

  it('an empty equation leaves nothing behind', async () => {
    const { html } = await read({ body: `<w:p>${t('Empty')}<m:oMath></m:oMath></w:p><w:p><m:oMathPara><m:oMath/></m:oMathPara></w:p>` })
    expect(html).toBe('<p>Empty</p>')
  })

  it('an unknown element: its linear text, and one notice per document with the count', async () => {
    const one = await read({ body: `<w:p>${unknown}</w:p>` })
    expect(one.html).toBe(`<p>${inline('ab')}</p>`)
    expect(one.notes).toEqual([['equation-partial', 'One equation has a part that could not be read as a formula; that part is shown as plain characters.']])
    const two = await read({ body: `<w:p>${unknown}</w:p><w:p>${mathPara(unknown)}</w:p>`, footnotes: [`<w:p>${xSquared}</w:p>`] })
    expect(two.notes).toEqual([['equation-partial', '2 equations have parts that could not be read as formulas; those parts are shown as plain characters.']])
  })

  it('a paragraph holding only an equation counts as visible in a numbered list', async () => {
    const numbering = `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
    const item = (x: string): string => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${x}</w:p>`
    const bytes = await buildDocx({ body: item(t('One')) + `<w:p>${t('Between')}</w:p>` + item(xSquared), numberingXml: numbering })
    const { html } = await readDocx({ bytes, filename: 'l.docx' })
    // The two items are one list, split by the paragraph between: merged.
    expect(html).toBe(`<ol><li>One<p>Between</p></li><li>${inline('x^{2}')}</li></ol>`)
  })
})

describe('equation markers', () => {
  it('never collide with the document’s own text', () => {
    expect(equationMarker(['plain'])).toBe('eq')
    const taken = equationMarker(['has eq in it'])
    expect(taken).not.toBe('eq')
    expect(equationMarker(['has &#xE000;eq as a reference'])).not.toBe('eq')
  })

  it('document text that looks like a marker is left alone', async () => {
    const { html } = await read({ body: `<w:p>${t('odd eq0 text ')}${xSquared}</w:p>` })
    expect(html).toBe(`<p>odd eq0 text ${inline('x^{2}')}</p>`)
  })

  it('none leaks when one cannot be restored', () => {
    const equations: WordEquation[] = []
    const xml = takeEquations(`<w:p>${xSquared}</w:p>`, 'eq', equations)
    expect(xml).toBe('<w:p><w:r><w:t>eq0</w:t></w:r></w:p>')
    // A marker torn in two, and one with no equation behind it.
    expect(restoreEquations('<p>eq</p><p>eq7</p>', 'eq', equations)).toBe('<p></p><p></p>')
  })
})

describe('Word equations through a conversion', () => {
  const doc = (): Promise<Buffer> =>
    buildDocx({ body: `<w:p>${t('Inline ')}${xSquared}${t(' end.')}</w:p><w:p>${mathPara(`<m:oMath><m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f></m:oMath>`)}</w:p>` })

  it('docx → md: $…$ inline, $$…$$ on its own line', async () => {
    const conv = createConverter(async () => Buffer.from(''))
    const out = await conv.convert({ bytes: await doc(), filename: 'e.docx' }, 'docx', 'md')
    const md = out.parts[0].bytes.toString('utf8')
    expect(md).toContain('Inline $x^{2}$ end.')
    expect(md).toContain('$$\\frac{a}{b}$$')
  })

  it('docx → md → docx: an equation that is not TeX-shaped stays inline, its TeX unchanged', async () => {
    const bytes = await buildDocx({ body: `<w:p>${t('So ')}<m:oMath>${r('x+y')}</m:oMath>${t(' here.')}</w:p>` })
    const asked: Array<{ source: string; display: boolean }> = []
    const render: RenderBlocks = async (reqs) => {
      asked.push(...reqs.map(({ source, display }) => ({ source, display })))
      return reqs.map(() => ({ png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', width: 20, height: 16 }))
    }
    const conv = createConverter(async () => Buffer.from(''), { renderBlocks: render })
    const md = (await conv.convert({ bytes, filename: 'e.docx' }, 'docx', 'md')).parts[0].bytes
    expect(md.toString('utf8')).toContain('So ${x+y}$ here.')
    await conv.convert({ bytes: md, filename: 'e.md' }, 'md', 'docx')
    expect(asked).toEqual([{ source: 'x+y', display: false }])
  })

  it('docx → docx: equations come back as pictures, not as Word equations', async () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const PNG2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const render: RenderBlocks = async (reqs) =>
      reqs.map((q) => ({ png: q.display ? PNG2 : PNG, width: 20, height: 16, baseline: 4 }))
    const conv = createConverter(async () => Buffer.from(''), { renderBlocks: render })
    const out = await conv.convert({ bytes: await doc(), filename: 'e.docx' }, 'docx', 'docx')
    const zip = await JSZip.loadAsync(out.parts[0].bytes)
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'))
    expect(media.filter((n) => n.endsWith('.png'))).toHaveLength(2)
    const xml = await zip.files['word/document.xml'].async('string')
    expect(xml).not.toContain('m:oMath')
    expect(xml).toContain('Inline')
  })
})
