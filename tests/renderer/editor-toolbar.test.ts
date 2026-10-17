// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'
import { EditorToolbar } from '../../src/renderer/src/components/EditorToolbar'
import { configureBlockViews } from '../../src/renderer/src/lib/block-views'

/** The Formula and Diagram menus (spec B13), in the real toolbar. */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let editor: Editor
let root: Root
let bar: HTMLElement

beforeEach(() => {
  configureBlockViews({ watch: () => () => {} })
  editor = new Editor({ element: document.body.appendChild(document.createElement('div')), extensions: EDITOR_EXTENSIONS, content: '<p>Intro.</p>' })
  bar = document.body.appendChild(document.createElement('div'))
  root = createRoot(bar)
})
afterEach(() => {
  act(() => root.unmount())
  editor.destroy()
  document.body.replaceChildren()
  configureBlockViews()
})

const mount = (sourceFormat?: string): void => {
  act(() => root.render(createElement(EditorToolbar, { editor, sourceFormat })))
}
const button = (label: string): HTMLButtonElement | null => bar.querySelector(`button[aria-label="${label}"]`)
const item = (text: string): HTMLButtonElement =>
  [...bar.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.startsWith(text))!

describe('the Formula and Diagram menus', () => {
  it('open on click, list their inserts, and insert what is chosen', () => {
    mount('md')
    const diagram = button('Diagram')!
    expect(diagram.getAttribute('aria-haspopup')).toBe('menu')
    expect(diagram.getAttribute('aria-expanded')).toBe('false')
    act(() => diagram.click())
    expect(diagram.getAttribute('aria-expanded')).toBe('true')
    expect([...bar.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual(['Mermaid diagram', 'Graphviz diagram'])
    act(() => item('Mermaid').click())
    expect(bar.querySelector('[role="menu"]')).toBeNull()
    expect(editor.getHTML()).toContain('<pre><code class="language-mermaid">flowchart LR')

    act(() => button('Formula')!.click())
    expect(item('Inline formula').textContent).toMatch(/Ctrl\+Shift\+M|⌘⇧M/)
    act(() => item('Formula block').click())
    expect(editor.state.doc.toString()).toContain('mathBlock')
  })

  it('closes on Escape and gives focus back to its button', () => {
    mount()
    const formula = button('Formula')!
    act(() => formula.click())
    const list = bar.querySelector('[role="menu"]')!
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(bar.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(formula)
  })

  it('are not offered for a code listing', () => {
    mount('code')
    expect(button('Formula')).toBeNull()
    expect(button('Diagram')).toBeNull()
    expect(button('Insert footnote')).not.toBeNull()
  })
})

describe('the Highlight button and Mod-Shift-H', () => {
  it('highlight the selection, show it pressed, and take it off again', () => {
    mount()
    const highlight = button('Highlight')!
    expect(highlight.title).toMatch(/Ctrl\+Shift\+H|⌘⇧H/)
    expect(highlight.getAttribute('aria-pressed')).toBe('false')
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 })
    })
    act(() => highlight.click())
    expect(editor.getHTML()).toBe('<p><mark>Intro</mark>.</p>')
    expect(highlight.getAttribute('aria-pressed')).toBe('true')
    act(() => highlight.click())
    expect(editor.getHTML()).toBe('<p>Intro.</p>')
  })

  it('answer the shortcut, and keep a highlight of its own color', () => {
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 })
    })
    const shortcut = (): void => {
      editor.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'H', code: 'KeyH', keyCode: 72, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true } as KeyboardEventInit),
      )
    }
    act(shortcut)
    expect(editor.getHTML()).toBe('<p><mark>Intro</mark>.</p>')
    act(shortcut)
    expect(editor.getHTML()).toBe('<p>Intro.</p>')
    editor.commands.setContent('<p><mark style="background-color:#00FF00">Go</mark></p>')
    expect(editor.getJSON().content?.[0].content?.[0].marks).toEqual([{ type: 'highlight', attrs: { color: '00FF00' } }])
  })
})
