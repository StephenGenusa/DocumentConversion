// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'
import { configureBlockViews } from '../../src/renderer/src/lib/block-views'
import { COLOUR_LINE_LIMIT, SYNC_COLOUR_CHARS, COLOUR_PAUSE_MS, codeLanguages, pickerValue } from '../../src/renderer/src/lib/code-colour'
import hljs from '../../src/core/hljs'

/*
 * Code coloured while it is edited: decorations only, never the document.
 * All code here is invented for the test.
 */

let editor: Editor | null = null
let host: HTMLElement

beforeEach(() => {
  configureBlockViews({ watch: () => () => {} })
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(() => {
  editor?.destroy()
  editor = null
  host.remove()
  configureBlockViews()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const make = (content: string): Editor => (editor = new Editor({ element: host, extensions: EDITOR_EXTENSIONS, content }))
const blocks = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('pre')]
const spans = (el: Element): string[] => [...el.querySelectorAll('span[class*="hljs-"]')].map((s) => `${s.className}:${s.textContent}`)
const codeBlockPositions = (e: Editor): number[] => {
  const at: number[] = []
  e.state.doc.descendants((n, pos) => {
    if (n.type.name === 'codeBlock') at.push(pos)
  })
  return at
}
/** Type `text` at the end of the code block at index `i`, as one transaction. */
const typeInto = (e: Editor, i: number, text: string): void => {
  const pos = codeBlockPositions(e)[i]
  const end = pos + 1 + e.state.doc.nodeAt(pos)!.content.size
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, end)).insertText(text))
}
const lines = (n: number, line = 'total = price * 2  # invented'): string => Array.from({ length: n }, () => line).join('\n')

const PY = '<pre><code class="language-python">def area(w, h):\n    return w * h  # square units</code></pre>'
const JS = '<pre><code class="language-javascript">const n = 42\nfunction twice(x) { return x * 2 }</code></pre>'
const SQL = '<pre><code class="language-sql">SELECT name FROM parts WHERE weight &gt; 3;</code></pre>'

describe('code coloured in the editor', () => {
  it('colours python, javascript and sql blocks with the classes the outputs use', () => {
    make(PY + JS + SQL)
    const [py, js, sql] = blocks()
    expect(spans(py)).toContain('hljs-keyword:def')
    expect(spans(py)).toContain('hljs-comment:# square units')
    expect(spans(js)).toContain('hljs-keyword:const')
    expect(spans(js)).toContain('hljs-number:42')
    expect(spans(sql).some((s) => /hljs-keyword:SELECT/i.test(s))).toBe(true)
    // The text itself is untouched.
    expect(sql.querySelector('code')!.textContent!.endsWith('SELECT name FROM parts WHERE weight > 3;')).toBe(true)
    expect(editor!.state.doc.child(2).textContent).toBe('SELECT name FROM parts WHERE weight > 3;')
  })

  it('leaves a block with no language, plaintext or an unknown language uncoloured', () => {
    make('<pre><code>def f(): pass</code></pre><pre><code class="language-plaintext">def f(): pass</code></pre><pre><code class="language-nosuchlang">def f(): pass</code></pre>')
    for (const b of blocks()) expect(spans(b)).toEqual([])
  })

  it('never puts the colouring in the document: what is saved is byte for byte what came in', () => {
    const html = PY + JS + SQL + '<pre><code>plain</code></pre>'
    const e = make(html)
    expect(blocks().some((b) => spans(b).length > 0)).toBe(true)
    expect(e.getHTML()).toBe(html)
    expect(e.getHTML()).not.toContain('hljs')
  })

  it('re-colours a block as it is typed in', () => {
    const e = make('<pre><code class="language-python">x = 1</code></pre>')
    expect(spans(blocks()[0]).some((s) => s.startsWith('hljs-keyword'))).toBe(false)
    typeInto(e, 0, '\nwhile x: pass')
    expect(spans(blocks()[0])).toContain('hljs-keyword:while')
  })

  it('leaves diagrams and formulas to their own views', () => {
    make('<pre><code class="language-mermaid">flowchart LR\n  A --&gt; B</code></pre><pre><code class="language-math">x^2</code></pre>' + PY)
    expect(host.querySelectorAll('.rb').length).toBe(2)
    for (const rb of host.querySelectorAll('.rb')) expect(spans(rb)).toEqual([])
    expect(spans(blocks().at(-1)!)).toContain('hljs-keyword:def')
  })
})

describe(`the ${COLOUR_LINE_LIMIT}-line limit`, () => {
  it('shows a block of the limit or more as plain monospace, editable, and colours it again once shorter', () => {
    vi.useFakeTimers()
    const e = make(`<pre><code class="language-python">${lines(COLOUR_LINE_LIMIT - 1)}</code></pre>`)
    vi.advanceTimersByTime(COLOUR_PAUSE_MS + 1)
    expect(spans(blocks()[0]).length).toBeGreaterThan(0)

    // The limit reached: plain at once, not after the pause.
    typeInto(e, 0, '\nwhile True: pass')
    expect(spans(blocks()[0])).toEqual([])
    vi.advanceTimersByTime(COLOUR_PAUSE_MS + 1)
    expect(spans(blocks()[0])).toEqual([])
    expect(e.state.doc.textContent.endsWith('while True: pass')).toBe(true)

    // One line removed: coloured again.
    const pos = codeBlockPositions(e)[0]
    const end = pos + 1 + e.state.doc.nodeAt(pos)!.content.size
    e.view.dispatch(e.state.tr.delete(end - '\nwhile True: pass'.length, end))
    vi.advanceTimersByTime(COLOUR_PAUSE_MS + 1)
    expect(spans(blocks()[0]).length).toBeGreaterThan(0)
  })

  it('round-trips a block over the limit byte for byte', () => {
    const html = `<pre><code class="language-python">${lines(COLOUR_LINE_LIMIT + 10)}</code></pre>`
    expect(make(html).getHTML()).toBe(html)
  })
})

describe('colouring cost', () => {
  it('re-highlights only the block that changed in a document of many small blocks', () => {
    const many = Array.from({ length: 200 }, (_, i) => `<pre><code class="language-python">n${i} = ${i}</code></pre><p>Text ${i}.</p>`).join('')
    const e = make(many)
    const spy = vi.spyOn(hljs, 'highlight')
    typeInto(e, 57, ' + 1')
    typeInto(e, 57, ' + 2')
    expect(spy).toHaveBeenCalledTimes(2)
    // Typing in a paragraph highlights nothing.
    let para = -1
    e.state.doc.descendants((n, pos) => {
      if (para < 0 && n.type.name === 'paragraph') para = pos
    })
    e.view.dispatch(e.state.tr.insertText('more', para + 1))
    expect(spy).toHaveBeenCalledTimes(2)
    // The other blocks keep their colours.
    expect(spans(blocks()[3])).toContain('hljs-number:3')
  })

  it('keeps a keystroke in a 5,000-line python block cheap: the block is re-coloured after a pause, not on the key', () => {
    // performance.now stays real: it is what is measured.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const unit = ['def total(items, rate=0.2):', '    """Sum the invented prices."""', '    out = 0', '    for i in items:', '        out += i.price * (1 + rate)  # tax', '    return round(out, 2)', '']
    const code = Array.from({ length: 5000 }, (_, i) => unit[i % unit.length]).join('\n')
    expect(code.length).toBeGreaterThan(SYNC_COLOUR_CHARS)
    const e = make(`<pre><code class="language-python">${code}</code></pre>`)
    vi.advanceTimersByTime(COLOUR_PAUSE_MS + 1)
    expect(spans(blocks()[0])).toContain('hljs-keyword:def')

    const spy = vi.spyOn(hljs, 'highlight')
    const times: number[] = []
    for (let k = 0; k < 20; k++) {
      const t = performance.now()
      typeInto(e, 0, k % 2 ? 'x' : ' ')
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    const median = times[times.length >> 1]
    process.stdout.write(`5,000-line python block: keystroke dispatch median ${median.toFixed(2)} ms, max ${times.at(-1)!.toFixed(2)} ms\n`)
    expect(spy).not.toHaveBeenCalled()
    // Generous: under load the suite runs every worker at once.
    expect(median).toBeLessThan(30)
    // Colours stay up (mapped) while typing, and the block is re-coloured once, after the pause.
    expect(spans(blocks()[0])).toContain('hljs-keyword:def')
    vi.advanceTimersByTime(COLOUR_PAUSE_MS + 1)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('the language picker', () => {
  it('lists the languages the outputs colour, with friendly names and the common ones first', () => {
    const langs = codeLanguages()
    const names = langs.map((l) => l.value)
    expect(names[0]).toBe('')
    expect(langs[0].label).toBe('Plain text')
    expect(names.slice(0, 6)).toContain('python')
    expect(langs.find((l) => l.value === 'javascript')!.label).toBe('JavaScript')
    expect(langs.find((l) => l.value === 'cpp')!.label).toBe('C++')
    // Every language hljs.ts registers, once each; no plaintext entry (that is "Plain text").
    for (const l of hljs.listLanguages().filter((l) => l !== 'plaintext')) expect(names.filter((n) => n === l)).toHaveLength(1)
    expect(names).not.toContain('plaintext')
    expect(names).not.toContain('mermaid')
  })

  it('shows an alias as its language, and an unknown name as itself', () => {
    expect(pickerValue('js')).toBe('javascript')
    expect(pickerValue('py')).toBe('python')
    expect(pickerValue('plaintext')).toBe('')
    expect(pickerValue(null)).toBe('')
    expect(pickerValue('nosuchlang')).toBe('nosuchlang')
  })

  it('sets the language: re-coloured at once, saved as its class, undone in one step', () => {
    const e = make('<pre><code>SELECT 1 FROM t;</code></pre><p>After.</p>')
    expect(spans(blocks()[0])).toEqual([])
    e.chain().setTextSelection(3).setCodeLanguage('sql').run()
    expect(spans(blocks()[0]).some((s) => /hljs-keyword:SELECT/i.test(s))).toBe(true)
    expect(e.getHTML()).toBe('<pre><code class="language-sql">SELECT 1 FROM t;</code></pre><p>After.</p>')
    e.chain().setCodeLanguage('').run()
    expect(e.getHTML()).toBe('<pre><code>SELECT 1 FROM t;</code></pre><p>After.</p>')
    expect(spans(blocks()[0])).toEqual([])
    e.commands.undo()
    expect(e.getHTML()).toBe('<pre><code class="language-sql">SELECT 1 FROM t;</code></pre><p>After.</p>')
    e.commands.undo()
    expect(e.getHTML()).toBe('<pre><code>SELECT 1 FROM t;</code></pre><p>After.</p>')
  })

  const picker = (i: number): HTMLSelectElement => blocks()[i].querySelector('select[aria-label="Code language"]')!
  const choose = (sel: HTMLSelectElement, value: string): void => {
    sel.dispatchEvent(new Event('focus'))
    sel.value = value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }

  it('sits on every code block, showing its language, and on no diagram or formula', () => {
    make(PY + '<pre><code class="language-js">let n = 1</code></pre><pre><code>x</code></pre><pre><code class="language-mermaid">flowchart LR</code></pre><pre><code class="language-math">x</code></pre>')
    expect(picker(0).value).toBe('python')
    expect(picker(0).selectedOptions[0].textContent).toBe('Python')
    expect(picker(1).value).toBe('javascript')
    expect(picker(2).value).toBe('')
    expect(picker(2).selectedOptions[0].textContent).toBe('Plain text')
    expect(host.querySelectorAll('select[aria-label="Code language"]').length).toBe(3)
    for (const rb of host.querySelectorAll('.rb')) expect(rb.querySelector('select')).toBeNull()
  })

  it('lists every language once it is used, and changing it re-colours at once and saves the class, one undo step', () => {
    const e = make('<pre><code>SELECT 1 FROM t;</code></pre><p>After.</p>')
    expect(picker(0).options.length).toBe(1)
    picker(0).dispatchEvent(new Event('focus'))
    expect(picker(0).options.length).toBe(codeLanguages().length)
    choose(picker(0), 'sql')
    expect(e.getHTML()).toBe('<pre><code class="language-sql">SELECT 1 FROM t;</code></pre><p>After.</p>')
    expect(spans(blocks()[0]).some((s) => /hljs-keyword:SELECT/i.test(s))).toBe(true)
    expect(picker(0).value).toBe('sql')
    choose(picker(0), '')
    expect(e.getHTML()).toBe('<pre><code>SELECT 1 FROM t;</code></pre><p>After.</p>')
    expect(spans(blocks()[0])).toEqual([])
    e.commands.undo()
    expect(e.getHTML()).toBe('<pre><code class="language-sql">SELECT 1 FROM t;</code></pre><p>After.</p>')
    expect(picker(0).value).toBe('sql')
  })

  it('shows a language the outputs do not know as itself', () => {
    make('<pre><code class="language-cobolx">x</code></pre>')
    expect(picker(0).value).toBe('cobolx')
    picker(0).dispatchEvent(new Event('focus'))
    expect(picker(0).value).toBe('cobolx')
  })

  it('is reached from the code with Mod-Alt-L, and Escape goes back to the code', () => {
    const e = make('<p>Intro.</p>' + PY + JS)
    e.commands.setTextSelection(e.state.doc.child(0).nodeSize + e.state.doc.child(1).nodeSize + 3)
    expect(e.commands.focusCodeLanguage()).toBe(true)
    expect(document.activeElement).toBe(picker(1))
    picker(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.activeElement).toBe(e.view.dom)
    e.commands.setTextSelection(2)
    expect(e.commands.focusCodeLanguage()).toBe(false)
  })
})
