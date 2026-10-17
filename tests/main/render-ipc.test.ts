import { describe, it, expect } from 'vitest'
import { checkRenderRequest, previewForEditor, renderForEditor } from '../../src/main/render-ipc'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { tiff, emf, wmf } from '../../scripts/fixtures/lib-tiff.mjs'
import type { RenderRequest } from '../../src/core/rendered-blocks'

/** The editor's `render:block` (spec B11): what main accepts, and what it hands back. */
describe('render:block', () => {
  const seen: Array<{ req: RenderRequest; priority: string }> = []
  const render = async (req: RenderRequest, opts: { priority: string }) => {
    seen.push({ req, priority: opts.priority })
    if (req.source.includes('BROKEN')) return { error: 'Parse error on line 1' }
    return { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5"/>', width: 10, height: 5 }
  }

  it.each([
    ['nothing', undefined],
    ['a string', 'flowchart LR'],
    ['an unknown kind', { kind: 'plantuml', source: 'x' }],
    // SVG images are rasterized for conversions only (spec D10); the editor shows them as images.
    ['an SVG image to rasterize', { kind: 'svg', source: '<svg xmlns="http://www.w3.org/2000/svg"/>' }],
    ['a kind that is not a string', { kind: ['mermaid'], source: 'x' }],
    ['no source', { kind: 'mermaid' }],
    ['a source that is not a string', { kind: 'mermaid', source: 42 }],
    ['a display that is not a boolean', { kind: 'mermaid', source: 'x', display: 'yes' }],
    ['a priority the editor does not use', { kind: 'mermaid', source: 'x', priority: 'convert' }],
  ])('refuses %s', async (_name, value) => {
    expect('refused' in checkRenderRequest(value)).toBe(true)
    const before = seen.length
    expect(await renderForEditor(value, render)).toHaveProperty('error')
    expect(seen.length).toBe(before)
  })

  it('refuses a source over 100 KB, counted in UTF-8 bytes', async () => {
    const atCap = 'é'.repeat(50 * 1024) // 100 KB exactly
    expect('refused' in checkRenderRequest({ kind: 'mermaid', source: atCap })).toBe(false)
    const over = atCap + 'x'
    expect(await renderForEditor({ kind: 'mermaid', source: over, display: true, priority: 'visible' }, render)).toEqual({
      error: 'the source is over 100 KB',
    })
  })

  it('draws SVG at the priority asked, and answers an <img>-ready data URI', async () => {
    const out = await renderForEditor({ kind: 'mermaid', source: 'flowchart LR', display: true, priority: 'prefetch' }, render)
    expect(seen.at(-1)).toEqual({ req: { kind: 'mermaid', source: 'flowchart LR', display: true, format: 'svg' }, priority: 'prefetch' })
    expect(out).toMatchObject({ width: 10, height: 5 })
    const uri = (out as { uri: string }).uri
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(Buffer.from(uri.split(',')[1], 'base64').toString('utf8')).toContain('<svg')
  })

  it('defaults to visible priority and display', async () => {
    await renderForEditor({ kind: 'mermaid', source: 'a' }, render)
    expect(seen.at(-1)).toMatchObject({ req: { display: true }, priority: 'visible' })
  })

  it("passes the engine's message through", async () => {
    expect(await renderForEditor({ kind: 'mermaid', source: 'BROKEN' }, render)).toEqual({ error: 'Parse error on line 1' })
  })

  it('draws TeX (step 18), inline or display as asked, and hands back its baseline', async () => {
    const withBaseline = async (req: RenderRequest) => {
      seen.push({ req, priority: 'visible' })
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="19" height="16"/>', width: 19, height: 16, baseline: 0.903 }
    }
    const out = await renderForEditor({ kind: 'math', source: 'x^2', display: false }, withBaseline)
    expect(out).toMatchObject({ width: 19, height: 16, baseline: 0.903 })
    expect(seen.at(-1)).toMatchObject({ req: { kind: 'math', source: 'x^2', display: false, format: 'svg' } })
  })

  it('draws Graphviz (step 17)', async () => {
    const before = seen.length
    expect(await renderForEditor({ kind: 'dot', source: 'digraph {}' }, render)).not.toHaveProperty('unavailable')
    expect(seen.length).toBe(before + 1)
    expect(seen.at(-1)).toMatchObject({ req: { kind: 'dot', format: 'svg' } })
  })

  it('never throws: a host failure is a message', async () => {
    const out = await renderForEditor({ kind: 'mermaid', source: 'x' }, async () => {
      throw new Error('the render window stopped')
    })
    expect(out).toEqual({ error: 'the render window stopped' })
  })
})

/** The editor's `picture:preview`: a copy it can show of a TIFF, EMF or WMF, made as an HTML conversion makes it. */
describe('picture:preview', () => {
  const asked: RenderRequest[] = []
  const renderBlocks = async (reqs: RenderRequest[]) => {
    asked.push(...reqs)
    return reqs.map(() => ({ png: 'iVBORw0KGgo=', width: 8, height: 8 }))
  }
  const dataUri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`
  const page = { width: 8, height: 8, pixel: () => [0, 0, 0], kind: 'gray' }

  it('makes a TIFF a PNG in the render host, the first page of one of several', async () => {
    asked.length = 0
    const fax = tiff({ pages: [page, { ...page, width: 9 }] })
    expect(await previewForEditor({ src: dataUri('image/tiff', fax) }, { renderBlocks })).toEqual({ uri: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(asked.map((r) => r.kind)).toEqual(['picture', 'picture'])
  })

  it('draws an EMF or WMF as SVG, with no render host needed', async () => {
    for (const [mime, bytes] of [['image/x-emf', emf()], ['image/x-wmf', wmf()]] as const) {
      const answer = await previewForEditor({ src: dataUri(mime, bytes) }, {})
      expect('uri' in answer && answer.uri.startsWith('data:image/svg+xml;base64,')).toBe(true)
    }
  })

  it.each([
    ['nothing', undefined],
    ['a bare string', 'data:image/tiff;base64,AAAA'],
    ['a picture the page shows', { src: 'data:image/png;base64,iVBORw0KGgo=' }],
    ['an address', { src: 'https://example.com/a.tif' }],
    ['markup in the source', { src: 'data:image/tiff;base64,AAAA" onerror="x' }],
  ])('refuses %s', async (_name, value) => {
    expect(await previewForEditor(value, { renderBlocks })).toHaveProperty('error')
  })
})
