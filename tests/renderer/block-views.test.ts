// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'
import { configureBlockViews, type Watch } from '../../src/renderer/src/lib/block-views'
import { createRenderClient, setRenderClient, type BlockAnswer, type DrawFn } from '../../src/renderer/src/lib/render-client'

/*
 * Diagrams and formulas drawn in the editor (spec B11, B13), against a fake
 * render host. Nothing scrolls in happy-dom, so visibility is driven by hand:
 * `show(el)` is a block scrolling into view.
 */

type Asked = { kind: string; source: string; display: boolean; priority: string }
let asked: Asked[] = []
let watchers: Map<HTMLElement, (v: boolean) => void>
let editor: Editor | null = null
let host: HTMLElement

const svgOf = (s: string): string => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(s)))}`
const fakeDraw: DrawFn = async (req) => {
  asked.push({ ...req })
  if (req.source.includes('BROKEN')) return { error: "Parse error on line 2: unexpected 'TAGEND'" } as BlockAnswer
  return { uri: svgOf(req.source), width: 120 + req.source.length, height: 60 }
}

/** Let the fake host's promises settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const watch: Watch = (el, onChange) => {
  watchers.set(el, onChange)
  return () => watchers.delete(el)
}
const show = (el: Element): void => watchers.get(el as HTMLElement)?.(true)
const showAll = (): void => [...watchers.values()].forEach((f) => f(true))

beforeEach(() => {
  asked = []
  watchers = new Map()
  setRenderClient(createRenderClient(fakeDraw))
  configureBlockViews({ watch })
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(() => {
  editor?.destroy()
  editor = null
  host.remove()
  setRenderClient(null)
  configureBlockViews()
  vi.useRealTimers()
})

const make = (content: string): Editor => (editor = new Editor({ element: host, extensions: EDITOR_EXTENSIONS, content }))
const $ = (sel: string): HTMLElement => host.querySelector(sel) as HTMLElement
const posOf = (e: Editor, type: string): number => {
  let at = -1
  e.state.doc.descendants((n, pos) => {
    if (at < 0 && n.type.name === type) at = pos
  })
  return at
}
/** Put the cursor at the end of the first block of `type` (edit mode), or after everything. */
const cursorInto = (e: Editor, type: string): void => {
  const pos = posOf(e, type)
  const node = e.state.doc.nodeAt(pos)!
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, pos + 1 + node.content.size)))
}
const cursorToStart = (e: Editor): void => {
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 1)))
}
const key = (e: Editor, k: string, mods: Partial<KeyboardEventInit> = {}): void => {
  e.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }))
}

const MERMAID = '<pre><code class="language-mermaid">flowchart LR\n  A --&gt; B</code></pre>'

describe('a diagram in the editor', () => {
  it('is drawn as an <img> of the SVG once it is on screen, with its source hidden', async () => {
    make(`<p>Before.</p>${MERMAID}`)
    const block = $('.rb')
    expect(block.dataset.state).toBe('waiting')
    expect(asked).toEqual([])
    show(block)
    await settle()
    expect(asked).toEqual([{ kind: 'mermaid', source: 'flowchart LR\n  A --> B', display: true, priority: 'visible' }])
    expect(block.dataset.state).toBe('picture')
    const img = block.querySelector('.rb__picture img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(svgOf('flowchart LR\n  A --> B'))
    expect(img.getAttribute('width')).toBe(String(120 + 'flowchart LR\n  A --> B'.length))
    expect(img.getAttribute('height')).toBe('60')
    expect(img.alt).toBe('Diagram')
    // Engine output is only ever a data URI, never markup in this page.
    expect(host.querySelector('svg')).toBeNull()
  })

  it('opens on a click on the picture, with a live preview 400 ms after typing stops', async () => {
    const e = make(`<p>Before.</p>${MERMAID}`)
    show($('.rb'))
    await settle()
    $('.rb__picture').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
    expect($('.rb').dataset.state).toBe('editing')
    expect($('.rb__bar').textContent).toContain('Mermaid diagram')
    expect($('.rb__preview img')).not.toBeNull()

    vi.useFakeTimers()
    e.commands.insertContent(' --> C')
    await vi.advanceTimersByTimeAsync(399)
    expect(asked).toHaveLength(1)
    // The old picture stays up, faded, while the new one is drawn.
    expect($('.rb__preview img').classList.contains('rb__img--stale')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(asked.at(-1)).toMatchObject({ source: 'flowchart LR\n  A --> B --> C', priority: 'visible' })
    expect($('.rb__preview img').getAttribute('src')).toBe(svgOf('flowchart LR\n  A --> B --> C'))
    expect($('.rb__preview img').classList.contains('rb__img--stale')).toBe(false)

    cursorToStart(e)
    expect($('.rb').dataset.state).toBe('picture')
    expect($('.rb__picture img').getAttribute('src')).toBe(svgOf('flowchart LR\n  A --> B --> C'))
    // (The trailing paragraph is StarterKit's, after any last block but a paragraph.)
    expect(e.getHTML()).toBe('<p>Before.</p><pre><code class="language-mermaid">flowchart LR\n  A --&gt; B --&gt; C</code></pre><p></p>')
  })

  it("shows the source with the engine's message when it cannot be drawn", async () => {
    make('<p>x</p><pre><code class="language-mermaid">flowchart TD\n  BROKEN --&gt;</code></pre>')
    show($('.rb'))
    await settle()
    expect($('.rb').dataset.state).toBe('error')
    expect($('.rb__message').textContent).toBe("Parse error on line 2: unexpected 'TAGEND'")
    expect($('.rb__source').textContent).toBe('flowchart TD\n  BROKEN -->')
  })

  it('draws a Graphviz diagram the same way, and opens it as "Graphviz diagram"', async () => {
    make('<p>x</p><pre><code class="language-dot">digraph { a -&gt; b }</code></pre>')
    show($('.rb'))
    await settle()
    expect(asked).toEqual([{ kind: 'dot', source: 'digraph { a -> b }', display: true, priority: 'visible' }])
    expect($('.rb').dataset.state).toBe('picture')
    expect($('.rb__picture img').getAttribute('src')).toBe(svgOf('digraph { a -> b }'))
    $('.rb__picture').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
    expect($('.rb').dataset.state).toBe('editing')
    expect($('.rb__bar').textContent).toContain('Graphviz diagram')
  })

  it('shows a kind with no engine as its source, without asking the host', async () => {
    configureBlockViews({ watch, drawable: (kind) => kind !== 'math' })
    make('<pre><code class="language-math">x^2</code></pre>')
    showAll()
    // First in the document, where the cursor starts: shown, not opened.
    await settle()
    expect($('.rb').dataset.state).toBe('source')
    expect(asked).toEqual([])
  })

  it('Enter in the source is a new line, not a second block; Escape selects the block and Enter reopens it', () => {
    const e = make(`<p>x</p>${MERMAID}`)
    cursorInto(e, 'diagramBlock')
    key(e, 'Enter')
    e.commands.insertContent('  B --> C')
    expect(e.getHTML()).toBe('<p>x</p><pre><code class="language-mermaid">flowchart LR\n  A --&gt; B\n  B --&gt; C</code></pre><p></p>')
    key(e, 'Escape')
    expect(e.state.selection).toBeInstanceOf(NodeSelection)
    expect($('.rb').dataset.state).not.toBe('editing')
    expect($('.rb').classList.contains('ProseMirror-selectednode')).toBe(true)
    key(e, 'Enter')
    expect($('.rb').dataset.state).toBe('editing')
  })

  it('is selected, not entered, when the arrow keys reach it', () => {
    const e = make(`<p>x</p>${MERMAID}<p>y</p>`)
    // happy-dom has no layout: every position is the end of its textblock.
    e.view.endOfTextblock = () => true
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 2)))
    key(e, 'ArrowDown')
    expect(e.state.selection).toBeInstanceOf(NodeSelection)
    expect((e.state.selection as NodeSelection).node.type.name).toBe('diagramBlock')
  })
})

describe('opening and closing with no change keeps the document byte for byte', () => {
  it.each([
    ['a mermaid diagram', `<p>a</p>${MERMAID}<p>b</p>`, 'diagramBlock'],
    ['display math', '<p>a</p><pre><code class="language-math">\\sum_{i=1}^n i &lt; 3 \\\\\nx</code></pre><p>b</p>', 'mathBlock'],
    ['a dot diagram', '<p>a</p><pre><code class="language-dot">digraph { a -&gt; b }</code></pre><p>b</p>', 'diagramBlock'],
  ])('%s', async (_n, html, type) => {
    const e = make(html)
    showAll()
    await settle()
    expect(e.getHTML()).toBe(html)
    cursorInto(e, type)
    expect($('.rb').dataset.state).toBe('editing')
    cursorToStart(e)
    expect($('.rb').dataset.state).not.toBe('editing')
    cursorInto(e, type)
    key(e, 'Escape')
    expect(e.getHTML()).toBe(html)
  })

  it('an inline formula, opened and cancelled, and opened and applied unchanged', async () => {
    const html = '<p>Let <code class="language-math">\\alpha_i &lt; 2</code> hold.</p>'
    const e = make(html)
    $('.rm__face').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
    const input = $('.rm-pop input') as HTMLInputElement
    expect(input.value).toBe('\\alpha_i < 2')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect($('.rm-pop')).toBeNull()
    expect(e.getHTML()).toBe(html)
    $('.rm__face').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
    ;($('.rm-pop input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(e.getHTML()).toBe(html)
  })
})

describe('Insert Diagram and Formula (spec B13)', () => {
  it('a diagram goes after the current block, open with a starter that previews at once, and saves as source', async () => {
    const e = make('<p>Intro.</p><p>Next.</p>')
    e.commands.setTextSelection(3)
    e.commands.insertDiagram('mermaid')
    expect($('.rb').dataset.state).toBe('editing')
    show($('.rb'))
    await settle()
    expect(asked).toEqual([{ kind: 'mermaid', source: 'flowchart LR\n  A --> B', display: true, priority: 'visible' }])
    expect($('.rb__preview img')).not.toBeNull()
    cursorToStart(e)
    expect(e.getHTML()).toBe(`<p>Intro.</p>${MERMAID}<p>Next.</p>`)
  })

  it('a Graphviz diagram gets its own starter', () => {
    const e = make('<p>Intro.</p>')
    e.commands.insertDiagram('dot')
    expect(e.getHTML()).toBe('<p>Intro.</p><pre><code class="language-dot">digraph { a -&gt; b }</code></pre><p></p>')
  })

  it('replaces the empty paragraph the cursor is in, rather than leaving it behind', () => {
    const e = make('<p>Intro.</p><p></p>')
    e.commands.setTextSelection(posOf(e, 'paragraph') + 9)
    e.commands.insertDiagram('mermaid')
    expect(e.getHTML()).toBe(`<p>Intro.</p>${MERMAID}<p></p>`)
  })

  it('one undo removes an inserted diagram', () => {
    const html = '<p>Intro.</p><p>Next.</p>'
    const e = make(html)
    e.commands.setTextSelection(3)
    e.commands.insertDiagram('mermaid')
    e.commands.undo()
    expect(e.getHTML()).toBe(html)
  })

  it('a formula block left empty is removed when it closes', () => {
    const html = '<p>Intro.</p><p>Next.</p>'
    const e = make(html)
    e.commands.setTextSelection(3)
    e.commands.insertMathBlock()
    expect($('.rb--math').dataset.state).toBe('editing')
    cursorToStart(e)
    expect(e.getHTML()).toBe(html)
    // And by Escape, too.
    e.commands.setTextSelection(3)
    e.commands.insertMathBlock()
    key(e, 'Escape')
    expect(e.getHTML()).toBe(html)
  })

  it('a formula block typed into saves as display math', () => {
    const e = make('<p>Intro.</p>')
    e.commands.insertMathBlock()
    e.commands.insertContent('E = mc^2')
    cursorToStart(e)
    expect(e.getHTML()).toBe('<p>Intro.</p><pre><code class="language-math">E = mc^2</code></pre><p></p>')
  })

  it('an inline formula opens its popover, empty; Enter applies; one undo removes it', async () => {
    const html = '<p>Area is .</p>'
    const e = make(html)
    e.commands.setTextSelection(9)
    e.commands.insertMathInline()
    await new Promise((r) => requestAnimationFrame(r))
    const input = $('.rm-pop input') as HTMLInputElement
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    input.value = '\\pi r^2'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect($('.rm-pop')).toBeNull()
    expect(e.getHTML()).toBe('<p>Area is <code class="language-math">\\pi r^2</code>.</p>')
    e.commands.undo()
    expect(e.getHTML()).toBe(html)
  })

  it('cancelling an empty inline formula leaves nothing', () => {
    const html = '<p>Area is .</p>'
    const e = make(html)
    e.commands.setTextSelection(9)
    e.commands.insertMathInline()
    ;($('.rm-pop input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(e.getHTML()).toBe(html)
    // Applying it empty is the same as cancelling.
    e.commands.insertMathInline()
    ;($('.rm-pop input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(e.getHTML()).toBe(html)
  })

  it('the selected text becomes the TeX', () => {
    const e = make('<p>Area is x^2 here.</p>')
    e.commands.setTextSelection({ from: 9, to: 12 })
    e.commands.insertMathInline()
    expect(($('.rm-pop input') as HTMLInputElement).value).toBe('x^2')
    ;($('.rm-pop input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(e.getHTML()).toBe('<p>Area is <code class="language-math">x^2</code> here.</p>')
  })

  it('Mod-Shift-M inserts an inline formula and Mod-Alt-F a footnote', () => {
    const e = make('<p>Area.</p>')
    e.commands.setTextSelection(5)
    key(e, 'M', { ctrlKey: true, shiftKey: true, code: 'KeyM', keyCode: 77 } as KeyboardEventInit)
    expect($('.rm-pop')).not.toBeNull()
    ;($('.rm-pop input') as HTMLInputElement).value = 'a'
    ;($('.rm-pop input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    key(e, 'f', { ctrlKey: true, altKey: true, code: 'KeyF', keyCode: 70 } as KeyboardEventInit)
    expect(e.getHTML()).toBe('<p>Area<code class="language-math">a</code><sup data-fn="1">1</sup>.</p><ol><li data-fn="1"><p></p></li></ol>')
  })
})

describe('math drawn by its engine (step 18)', () => {
  /** A formula 30x20 px, its baseline 5 px above the bottom; \\foo is unknown, as MathJax says. */
  const mathDraw: DrawFn = async (req) => {
    asked.push({ ...req })
    if (req.source.includes('\\foo')) return { error: 'Undefined control sequence \\foo' }
    return { uri: svgOf(req.source), width: 30, height: 20, baseline: 5 }
  }

  it('draws inline and display TeX, asking for each as what it is', async () => {
    setRenderClient(createRenderClient(mathDraw))
    make('<p>Let <code class="language-math">x^2</code>.</p><pre><code class="language-math">y</code></pre>')
    showAll()
    await settle()
    expect(asked).toContainEqual({ kind: 'math', source: 'x^2', display: false, priority: 'visible' })
    expect(asked).toContainEqual({ kind: 'math', source: 'y', display: true, priority: 'visible' })
    expect($('.rm').dataset.state).toBe('picture')
    expect($('.rb--math').dataset.state).toBe('picture')
    // A display formula is sized in ex like the output, never wider than the pane.
    const block = $('.rb--math .rb__picture img') as HTMLImageElement
    expect(block.style.width).toBe('3.75ex')
    expect(block.style.height).toBe('auto')
  })

  it('draws display math inside a paragraph as display, on a line of its own, still in the paragraph', async () => {
    setRenderClient(createRenderClient(mathDraw))
    const html = '<p>The sum <code class="language-math math-display">x+y</code> is big.</p>'
    const e = make(html)
    show($('.rm'))
    await settle()
    expect(asked).toEqual([{ kind: 'math', source: 'x+y', display: true, priority: 'visible' }])
    expect($('.rm').classList.contains('rm--display')).toBe(true)
    expect($('p .rm')).not.toBeNull()
    const img = $('.rm img') as HTMLImageElement
    expect(img.style.width).toBe('3.75ex')
    expect(img.style.height).toBe('auto')
    expect(img.style.verticalAlign).toBe('')
    // Edited as an inline formula is, previewed as display, and saved as it was.
    vi.useFakeTimers()
    $('.rm__face').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
    await settle()
    const input = $('.rm-pop input') as HTMLInputElement
    input.value = 'x+z'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(400)
    await settle()
    expect(asked).toContainEqual({ kind: 'math', source: 'x+z', display: true, priority: 'visible' })
    expect(($('.rm-pop__preview img') as HTMLImageElement).style.height).toBe('auto')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(e.getHTML()).toBe(html.replace('x+y', 'x+z'))
  })

  it("carries a formula's \\newcommand into the later ones, as a conversion does; alt and the document keep each one's own TeX", async () => {
    setRenderClient(createRenderClient(mathDraw))
    const html =
      '<p>Let <code class="language-math">\\newcommand{\\vv}{x}\\vv</code> and <code class="language-math">\\vv^2</code>.</p>' +
      '<pre><code class="language-math">\\vv + 1</code></pre><p><code class="language-math">y</code></p>'
    const e = make(html)
    showAll()
    await settle()
    const sources = (): string[] => asked.map((a) => a.source)
    expect(sources()).toEqual(expect.arrayContaining(['\\newcommand{\\vv}{x}\\vv', '\\newcommand{\\vv}{x}\\vv^2', '\\newcommand{\\vv}{x}\\vv + 1', 'y']))
    expect(new Set(sources()).size).toBe(4)
    expect(([...host.querySelectorAll('.rm img')] as HTMLImageElement[]).map((i) => i.alt)).toEqual(['\\newcommand{\\vv}{x}\\vv', '\\vv^2', 'y'])
    expect(($('.rb--math .rb__picture img') as HTMLImageElement).alt).toBe('\\vv + 1')
    expect(e.getHTML()).toBe(html)
    // Changing the definition redraws the formulas that use it, and only those.
    asked = []
    const first = posOf(e, 'mathInline')
    e.view.dispatch(e.state.tr.setNodeMarkup(first, undefined, { ...e.state.doc.nodeAt(first)!.attrs, tex: '\\newcommand{\\vv}{z}\\vv' }))
    await settle()
    expect([...new Set(sources())].sort()).toEqual(['\\newcommand{\\vv}{z}\\vv', '\\newcommand{\\vv}{z}\\vv + 1', '\\newcommand{\\vv}{z}\\vv^2'])
  })

  it('the inline popover previews typed TeX with the definitions before it', async () => {
    setRenderClient(createRenderClient(mathDraw))
    make('<p><code class="language-math">\\newcommand{\\vv}{x}\\vv</code> and <code class="language-math">y</code>.</p>')
    showAll()
    await settle()
    vi.useFakeTimers()
    ;(host.querySelectorAll('.rm__face')[1] as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
    await settle()
    const input = $('.rm-pop input') as HTMLInputElement
    input.value = '\\vv^3'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(400)
    await settle()
    expect(asked).toContainEqual({ kind: 'math', source: '\\newcommand{\\vv}{x}\\vv^3', display: false, priority: 'visible' })
    expect(($('.rm-pop__preview img') as HTMLImageElement).alt).toBe('\\vv^3')
  })

  it('puts inline math on the baseline: sized in ex and lowered by its depth', async () => {
    setRenderClient(createRenderClient(mathDraw))
    make('<p>Let <code class="language-math">x^2</code>.</p>')
    show($('.rm'))
    await settle()
    const img = $('.rm img') as HTMLImageElement
    expect(img.alt).toBe('x^2')
    expect(img.style.width).toBe('3.75ex')
    expect(img.style.height).toBe('2.5ex')
    expect(img.style.verticalAlign).toBe('-0.625ex')
  })

  it('an unknown macro shows the TeX, with the message on hover', async () => {
    setRenderClient(createRenderClient(mathDraw))
    make('<p>Let <code class="language-math">\\foo{x}</code>.</p>')
    show($('.rm'))
    await settle()
    expect($('.rm').dataset.state).toBe('error')
    expect($('.rm__src').textContent).toBe('\\foo{x}')
    expect($('.rm__src').title).toBe('Undefined control sequence \\foo')
  })

  it('the inline popover previews the TeX as it is typed, 400 ms after typing stops, and shows an error there', async () => {
    setRenderClient(createRenderClient(mathDraw))
    const e = make('<p>Let <code class="language-math">x^2</code> hold.</p>')
    show($('.rm'))
    await settle()
    vi.useFakeTimers()
    $('.rm__face').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
    await settle()
    // Opened: the current formula is previewed at once (already drawn: no new request).
    let preview = $('.rm-pop__preview')
    expect(preview.hidden).toBe(false)
    expect((preview.querySelector('img') as HTMLImageElement).alt).toBe('x^2')
    const input = $('.rm-pop input') as HTMLInputElement
    input.value = 'x^3'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(399)
    expect(asked.some((a) => a.source === 'x^3')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(asked).toContainEqual({ kind: 'math', source: 'x^3', display: false, priority: 'visible' })
    preview = $('.rm-pop__preview')
    const img = preview.querySelector('img') as HTMLImageElement
    expect(img.alt).toBe('x^3')
    expect(img.getAttribute('src')).toBe(svgOf('x^3'))
    expect(img.style.verticalAlign).toBe('-0.625ex')
    input.value = '\\foo'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(400)
    await settle()
    expect($('.rm-pop__preview').textContent).toBe('Undefined control sequence \\foo')
    // Applying keeps the typed TeX; the formula in the line is drawn afresh.
    input.value = 'x^3'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(e.getHTML()).toBe('<p>Let <code class="language-math">x^3</code> hold.</p>')
    await settle()
    expect(($('.rm .rm__face img') as HTMLImageElement).alt).toBe('x^3')
  })
})

describe('a 500-formula notebook', () => {
  const notebook =
    '<h1>Exercises</h1>' +
    Array.from({ length: 500 }, (_, i) => `<p>Step ${i}: <code class="language-math">x_{${i}}^2 + ${i}</code> holds.</p>` + (i % 5 === 0 ? `<pre><code class="language-math">\\sum_{k=0}^{${i}} k</code></pre>` : '')).join('')

  it('opens without drawing anything, then draws what scrolls into view and prefetches its neighbours', async () => {
    configureBlockViews({ watch, drawable: () => true })
    const t0 = performance.now()
    make(notebook)
    const opened = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`note  500-formula notebook: editor built in ${opened.toFixed(0)} ms (happy-dom)`)
    expect(opened).toBeLessThan(5000)
    expect(host.querySelectorAll('.rm')).toHaveLength(500)
    await settle()
    expect(asked).toEqual([])

    // Scroll: the 10th to 12th inline formulas come into view.
    const inline = [...host.querySelectorAll('.rm')]
    inline.slice(10, 13).forEach(show)
    await settle()
    const visible = asked.filter((a) => a.priority === 'visible').map((a) => a.source)
    expect(visible).toEqual(['x_{10}^2 + 10', 'x_{11}^2 + 11', 'x_{12}^2 + 12'])
    const prefetched = asked.filter((a) => a.priority === 'prefetch')
    expect(prefetched.length).toBeGreaterThan(0)
    expect(prefetched.length).toBeLessThan(20)
    expect(inline[11].getAttribute('data-state')).toBe('picture')
  })
})
