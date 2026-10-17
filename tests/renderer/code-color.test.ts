// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { DecorationSet, type Decoration } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'
import { configureBlockViews } from '../../src/renderer/src/lib/block-views'
import { COLOR_LINE_LIMIT, SYNC_COLOR_CHARS, COLOR_PAUSE_MS, codeLanguages, pickerValue } from '../../src/renderer/src/lib/code-color'
import hljs from '../../src/core/hljs'
import { hljs as editorHljs, loadGrammar } from '../../src/renderer/src/lib/code-grammars'

/*
 * Code colored while it is edited: decorations only, never the document.
 * All code here is invented for the test.
 */

let editor: Editor | null = null
let host: HTMLElement

// The grammars load when first needed (code-grammars.ts); these tests start with them in.
beforeAll(async () => {
  for (const name of ['python', 'javascript', 'sql', 'rust', 'bash', 'typescript']) expect(await loadGrammar(name)).toBe(true)
})

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

describe('code colored in the editor', () => {
  it('colors python, javascript and sql blocks with the classes the outputs use', () => {
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

  it('leaves a block with no language, plaintext or an unknown language uncolored', () => {
    make('<pre><code>def f(): pass</code></pre><pre><code class="language-plaintext">def f(): pass</code></pre><pre><code class="language-nosuchlang">def f(): pass</code></pre>')
    for (const b of blocks()) expect(spans(b)).toEqual([])
  })

  it('never puts the coloring in the document: what is saved is byte for byte what came in', () => {
    const html = PY + JS + SQL + '<pre><code>plain</code></pre>'
    const e = make(html)
    expect(blocks().some((b) => spans(b).length > 0)).toBe(true)
    expect(e.getHTML()).toBe(html)
    expect(e.getHTML()).not.toContain('hljs')
  })

  it('re-colors a block as it is typed in', () => {
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

describe("the author's markup in code", () => {
  const RUST =
    '<pre><code class="language-rust">pub fn <strong>parse</strong>(s: &amp;str) -&gt; ' +
    '<a href="https://example.com/std/vec/struct.Vec.html">Vec</a>&lt;<em>Token</em>&gt; { 42 }</code></pre>'

  it('colors a block holding bold, italic and links by its text, and keeps the markup', () => {
    const e = make(RUST)
    const [b] = blocks()
    expect(spans(b)).toContain('hljs-keyword:pub')
    expect(spans(b)).toContain('hljs-keyword:fn')
    expect(spans(b)).toContain('hljs-number:42')
    expect(b.querySelector('strong')!.textContent).toBe('parse')
    expect(b.querySelector('em')!.textContent).toBe('Token')
    expect(b.querySelector('a')!.getAttribute('href')).toBe('https://example.com/std/vec/struct.Vec.html')
    expect(e.getHTML()).toContain('<strong>parse</strong>')
    expect(e.getHTML()).not.toContain('hljs')
  })

  it('flattens code pasted into the pane, as the app flattens pasted code (core tagPastedCodeBlocks)', () => {
    const e = make('<p>start</p>')
    e.commands.setTextSelection(e.state.doc.content.size - 1)
    e.view.pasteHTML('<p>From the docs:</p><pre><code class="language-rust">fn <b>main</b>() { <a href="https://example.com/x">x</a>(<i>1</i>) }</code></pre><p>That is all.</p>')
    let code: PMNode | undefined
    e.state.doc.descendants((n) => {
      if (n.type.name === 'codeBlock') code = n
    })
    expect(code).toBeDefined()
    expect(code!.textContent).toBe('fn main() { x(1) }')
    code!.descendants((n) => {
      expect(n.marks).toEqual([])
    })
    expect(e.getHTML()).not.toMatch(/<pre>[\s\S]*<(?:strong|em|a)\b/)
  })

  it('does not link a web address typed in code, nor turn a pasted address over a selection into a link', () => {
    const e = make('<pre><code class="language-bash">curl https://old.example.com</code></pre>')
    typeInto(e, 0, ' ')
    typeInto(e, 0, 'https://example.com/a ')
    expect(e.getHTML()).not.toContain('<a ')
    // Select the old address and paste a new one over it: the text is replaced.
    const start = 1 + 'curl '.length
    e.commands.setTextSelection({ from: start, to: start + 'https://old.example.com'.length })
    e.view.pasteText('https://new.example.com')
    expect(e.state.doc.textContent).toBe('curl https://new.example.com https://example.com/a ')
    expect(e.getHTML()).not.toContain('<a ')
  })

  it('still links a web address typed in a paragraph', () => {
    const e = make('<p>see</p>')
    e.commands.setTextSelection(e.state.doc.content.size - 1)
    e.view.dispatch(e.state.tr.insertText(' https://example.com/a '))
    expect(e.getHTML()).toContain('href="https://example.com/a"')
  })

  it('makes code bold with Mod-B, now that code may hold it', () => {
    const e = make('<pre><code class="language-python">x = 1</code></pre>')
    e.commands.setTextSelection({ from: 1, to: 2 })
    e.commands.toggleBold()
    expect(e.getHTML()).toContain('<pre><code class="language-python"><strong>x</strong> = 1</code></pre>')
  })
})

describe(`the ${COLOR_LINE_LIMIT}-line limit`, () => {
  it('shows a block of the limit or more as plain monospace, editable, and colors it again once shorter', () => {
    vi.useFakeTimers()
    const e = make(`<pre><code class="language-python">${lines(COLOR_LINE_LIMIT - 1)}</code></pre>`)
    vi.advanceTimersByTime(COLOR_PAUSE_MS + 1)
    expect(spans(blocks()[0]).length).toBeGreaterThan(0)

    // The limit reached: plain at once, not after the pause.
    typeInto(e, 0, '\nwhile True: pass')
    expect(spans(blocks()[0])).toEqual([])
    vi.advanceTimersByTime(COLOR_PAUSE_MS + 1)
    expect(spans(blocks()[0])).toEqual([])
    expect(e.state.doc.textContent.endsWith('while True: pass')).toBe(true)

    // One line removed: colored again.
    const pos = codeBlockPositions(e)[0]
    const end = pos + 1 + e.state.doc.nodeAt(pos)!.content.size
    e.view.dispatch(e.state.tr.delete(end - '\nwhile True: pass'.length, end))
    vi.advanceTimersByTime(COLOR_PAUSE_MS + 1)
    expect(spans(blocks()[0]).length).toBeGreaterThan(0)
  })

  it('round-trips a block over the limit byte for byte', () => {
    const html = `<pre><code class="language-python">${lines(COLOR_LINE_LIMIT + 10)}</code></pre>`
    expect(make(html).getHTML()).toBe(html)
  })
})

describe('coloring cost', () => {
  it('re-highlights only the block that changed in a document of many small blocks', () => {
    const many = Array.from({ length: 200 }, (_, i) => `<pre><code class="language-python">n${i} = ${i}</code></pre><p>Text ${i}.</p>`).join('')
    const e = make(many)
    const spy = vi.spyOn(editorHljs, 'highlight')
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
    // The other blocks keep their colors.
    expect(spans(blocks()[3])).toContain('hljs-number:3')
  })

  it('keeps a keystroke in a 5,000-line python block cheap: the block is re-colored after a pause, not on the key', () => {
    // performance.now stays real: it is what is measured.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const unit = ['def total(items, rate=0.2):', '    """Sum the invented prices."""', '    out = 0', '    for i in items:', '        out += i.price * (1 + rate)  # tax', '    return round(out, 2)', '']
    const code = Array.from({ length: 5000 }, (_, i) => unit[i % unit.length]).join('\n')
    expect(code.length).toBeGreaterThan(SYNC_COLOR_CHARS)
    const e = make(`<pre><code class="language-python">${code}</code></pre>`)
    vi.advanceTimersByTime(COLOR_PAUSE_MS + 1)
    expect(spans(blocks()[0])).toContain('hljs-keyword:def')

    const spy = vi.spyOn(editorHljs, 'highlight')
    // The coloring's own share of a keystroke (the plugin's transaction work)
    // and the whole dispatch. The dispatch is mostly happy-dom, which walks
    // every node of the block each time ProseMirror pauses and resumes its
    // DOM observer, and under a loaded suite it varies with whatever else runs.
    const apply: number[] = []
    const dispatch: number[] = []
    for (let k = 0; k < 20; k++) {
      const pos = codeBlockPositions(e)[0]
      const end = pos + 1 + e.state.doc.nodeAt(pos)!.content.size
      const tr = e.state.tr.setSelection(TextSelection.create(e.state.doc, end)).insertText(k % 2 ? 'x' : ' ')
      const t0 = performance.now()
      e.state.apply(tr)
      const t1 = performance.now()
      e.view.dispatch(tr)
      const t2 = performance.now()
      apply.push(t1 - t0)
      dispatch.push(t2 - t1)
    }
    const median = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1]
    process.stdout.write(`5,000-line python block: keystroke coloring median ${median(apply).toFixed(2)} ms, dispatch median ${median(dispatch).toFixed(2)} ms, max ${Math.max(...dispatch).toFixed(2)} ms\n`)
    expect(spy).not.toHaveBeenCalled()
    // Re-highlighting or rebuilding the block's 9,000 colors costs tens of ms.
    expect(median(apply)).toBeLessThan(10)
    // Generous: under load the suite runs every worker at once.
    expect(median(dispatch)).toBeLessThan(60)
    // Colors stay up (mapped) while typing, and the block is re-colored once, after the pause.
    expect(spans(blocks()[0])).toContain('hljs-keyword:def')
    vi.advanceTimersByTime(COLOR_PAUSE_MS + 1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('redraws only what changed when typing between two colors in a big block, before and after its re-color', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const unit = ['def total(items, rate=0.2):', '    """Sum the invented prices."""', '    out = 0', '    for i in items:', '        out += i.price * (1 + rate)  # tax', '    return round(out, 2)', '']
    const code = Array.from({ length: 1000 }, (_, i) => unit[i % unit.length]).join('\n')
    expect(code.length).toBeGreaterThan(SYNC_COLOR_CHARS)
    const e = make(`<pre><code class="language-python">${code}</code></pre>`)
    vi.advanceTimersByTime(COLOR_PAUSE_MS + 1)
    const pre = blocks()[0]
    const mutations = (act: () => void): number => {
      const seen = new MutationObserver(() => {})
      seen.observe(pre, { subtree: true, childList: true, characterData: true, attributes: true })
      act()
      const n = seen.takeRecords().length
      seen.disconnect()
      return n
    }
    // Two colors side by side, well inside the block: "rate=" then "0.2".
    const colored = [...pre.querySelectorAll('span[class*="hljs-"]')]
    const number = colored.find((s, i) => i > 200 && s.className.includes('hljs-number') && s.previousSibling === colored[i - 1])!
    expect(number).toBeTruthy()
    const at = e.view.posAtDOM(number.firstChild!, 0)
    const spansBefore = spans(pre).length
    for (let k = 0; k < 4; k++) {
      // Each key, then the re-color after the pause: a handful of DOM changes,
      // not a rewrite of the thousands of spans after the caret.
      const key = mutations(() => e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, at + k)).insertText('x')))
      const pause = mutations(() => vi.advanceTimersByTime(COLOR_PAUSE_MS + 1))
      expect(key).toBeLessThan(10)
      expect(pause).toBeLessThan(10)
    }
    expect(spans(pre).length).toBeGreaterThan(spansBefore - 5)
    expect(spans(pre)).toContain('hljs-keyword:def')
  })

  it('re-colors a big block after the pause by replacing only the colors that changed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const code = Array.from({ length: 1000 }, (_, i) => `value_${i} = ${i}  # invented`).join('\n')
    expect(code.length).toBeGreaterThan(SYNC_COLOR_CHARS)
    const e = make(`<pre><code class="language-python">${code}</code></pre>`)
    vi.advanceTimersByTime(COLOR_PAUSE_MS + 1)
    // ProseMirror empties the arrays it is given, so each is copied as it is passed.
    const added: Decoration[] = []
    const removed: Decoration[] = []
    const { add, remove } = DecorationSet.prototype
    vi.spyOn(DecorationSet.prototype, 'add').mockImplementation(function (this: DecorationSet, doc, d) {
      added.push(...d.filter((x) => x.spec.color))
      return add.call(this, doc, d)
    })
    vi.spyOn(DecorationSet.prototype, 'remove').mockImplementation(function (this: DecorationSet, d) {
      removed.push(...d.filter((x) => x.spec.color))
      return remove.call(this, d)
    })
    const create = vi.spyOn(DecorationSet, 'create')
    typeInto(e, 0, '\nmore = 1')
    vi.advanceTimersByTime(COLOR_PAUSE_MS + 1)
    // The new line's colors, not the block's thousands.
    expect(added.length).toBeGreaterThan(0)
    expect(added.length).toBeLessThan(5)
    expect(removed.length).toBeLessThan(5)
    expect(create).not.toHaveBeenCalled()
    expect(spans(blocks()[0])).toContain('hljs-number:1')
  })
})

describe('the language picker', () => {
  it('lists the languages the outputs color, with friendly names and the common ones first', () => {
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

  it('sets the language: re-colored at once, saved as its class, undone in one step', () => {
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

  it('lists every language once it is used, and changing it re-colors at once and saves the class, one undo step', () => {
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
