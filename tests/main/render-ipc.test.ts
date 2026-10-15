import { describe, it, expect } from 'vitest'
import { checkRenderRequest, renderForEditor } from '../../src/main/render-ipc'
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

  it('answers "unavailable" for a kind with no engine yet, without asking the host', async () => {
    const before = seen.length
    expect(await renderForEditor({ kind: 'math', source: 'x^2', display: false }, render)).toEqual({ unavailable: true })
    expect(await renderForEditor({ kind: 'dot', source: 'digraph {}' }, render)).toEqual({ unavailable: true })
    expect(seen.length).toBe(before)
  })

  it('never throws: a host failure is a message', async () => {
    const out = await renderForEditor({ kind: 'mermaid', source: 'x' }, async () => {
      throw new Error('the render window stopped')
    })
    expect(out).toEqual({ error: 'the render window stopped' })
  })
})
