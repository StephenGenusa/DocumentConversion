// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})
const make = (content: string): Editor => (editor = new Editor({ extensions: EDITOR_EXTENSIONS, content }))
const endOf = (e: Editor, text: string): number => {
  let at = -1
  e.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text?.includes(text)) at = pos + n.text.indexOf(text) + text.length
  })
  return at
}

describe('footnotes in the editor', () => {
  it('Insert footnote adds a reference, a notes list and puts the cursor in the note', () => {
    const e = make('<p>A claim here.</p>')
    e.commands.setTextSelection(endOf(e, 'A claim'))
    expect(e.commands.insertFootnote()).toBe(true)
    e.commands.insertContent('The source.')
    expect(e.getHTML()).toBe('<p>A claim<sup data-fn="1">1</sup> here.</p><ol><li data-fn="1"><p>The source.</p></li></ol>')
  })

  it('adds a second note to the same list, with the next free label', () => {
    const e = make('<p>One two.</p>')
    e.commands.setTextSelection(endOf(e, 'One'))
    e.commands.insertFootnote()
    e.commands.insertContent('first')
    e.commands.setTextSelection(endOf(e, ' two'))
    e.commands.insertFootnote()
    e.commands.insertContent('second')
    expect(e.getHTML()).toBe(
      '<p>One<sup data-fn="1">1</sup> two<sup data-fn="2">2</sup>.</p><ol><li data-fn="1"><p>first</p></li><li data-fn="2"><p>second</p></li></ol>',
    )
  })

  it('renumbers references to follow the notes after an edit', () => {
    const e = make('<p>a<sup data-fn="x">9</sup> b<sup data-fn="y">9</sup></p><ol><li data-fn="y"><p>Y</p></li><li data-fn="x"><p>X</p></li></ol>')
    e.commands.setTextSelection(endOf(e, ' b'))
    e.commands.insertContent('!')
    expect(e.getHTML()).toContain('a<sup data-fn="x">2</sup> b!<sup data-fn="y">1</sup>')
  })

  it('keeps a note whose reference was deleted', () => {
    const e = make('<p>a<sup data-fn="x">1</sup></p><ol><li data-fn="x"><p>X</p></li></ol>')
    e.commands.setTextSelection({ from: endOf(e, 'a'), to: endOf(e, 'a') + 1 })
    e.commands.deleteSelection()
    expect(e.getHTML()).toBe('<p>a</p><ol><li data-fn="x"><p>X</p></li></ol>')
  })
})
