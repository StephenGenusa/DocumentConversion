// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'
import { configureBlockViews } from '../../src/renderer/src/lib/block-views'
import { COLOR_MARGIN_LINES, codeColorKey, codeLanguages, pickerValue } from '../../src/renderer/src/lib/code-color'
import hljs from '../../src/core/hljs'
import { hljs as editorHljs, loadGrammar } from '../../src/renderer/src/lib/code-grammars'
import { installHighlights, painted as spans } from './highlights'

/*
 * Code colored while it is edited: painted beside the page, never the document.
 * All code here is invented for the test.
 */

let editor: Editor | null = null
let host: HTMLElement

// The grammars load when first needed (code-grammars.ts); these tests start with them in.
beforeAll(async () => {
  for (const name of ['python', 'javascript', 'sql', 'rust', 'bash', 'typescript']) expect(await loadGrammar(name)).toBe(true)
  installHighlights()
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
/** The shapes (italic, bold) drawn in `el` as spans. */
const shapes = (el: Element): string[] => [...el.querySelectorAll('span[class*="hljs-"]')].map((s) => `${s.className}:${s.textContent}`)
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

describe('a long block', () => {
  it('colors a block of 6,500 lines, and keeps coloring it as it grows', () => {
    const e = make(`<pre><code class="language-python">${lines(6500)}</code></pre>`)
    expect(spans(blocks()[0]).length).toBeGreaterThan(0)
    typeInto(e, 0, '\nwhile True: pass')
    expect(spans(blocks()[0]).length).toBeGreaterThan(0)
    expect(e.state.doc.textContent.endsWith('while True: pass')).toBe(true)
  })

  it('round-trips a block of 6,500 lines byte for byte', () => {
    const html = `<pre><code class="language-python">${lines(6500)}</code></pre>`
    expect(make(html).getHTML()).toBe(html)
  })
})

const UNIT = ['def total(items, rate=0.2):', '    """Sum the invented prices."""', '    out = 0', '    for i in items:', '        out += i.price * (1 + rate)  # tax', '    return round(out, 2)', '']
const bigPython = (n: number): string => Array.from({ length: n }, (_, i) => UNIT[i % UNIT.length]).join('\n')
/** Tell the editor which doc positions are on screen, as its view does from the layout. */
const show = (e: Editor, from: number, to: number): void => {
  e.view.dispatch(e.state.tr.setMeta(codeColorKey, { visible: [from, to] }))
}
/** The doc position where line `n` (from 0) of the first code block starts. */
const lineAt = (e: Editor, n: number): number => {
  const text = e.state.doc.child(0).textContent
  let at = 0
  for (let k = 0; k < n; k++) at = text.indexOf('\n', at) + 1
  return 1 + at
}
const mutations = (el: Element, act: () => void): number => {
  const seen = new MutationObserver(() => {})
  seen.observe(el, { subtree: true, childList: true, characterData: true, attributes: true })
  act()
  const n = seen.takeRecords().length
  seen.disconnect()
  return n
}

describe('coloring only what is on screen', () => {
  it('colors the lines on screen and the margin around them, and follows the screen as it moves', () => {
    const e = make(`<pre><code class="language-python">${bigPython(5000)}</code></pre>`)
    const count = (): number => spans(blocks()[0]).length
    // Before the view measures, the top is taken to be on screen.
    const atTop = count()
    expect(atTop).toBeGreaterThan(100)
    expect(atTop).toBeLessThan(2000)
    // Lines 3,000 to 3,040 on screen: painted there, not at the top.
    show(e, lineAt(e, 3000), lineAt(e, 3040))
    const text = (from: number, to: number): string => e.state.doc.textBetween(from, to)
    const there = spans(blocks()[0])
    expect(there.length).toBeGreaterThan(100)
    expect(there.length).toBeLessThan(2000)
    const firstPainted = e.view.posAtDOM(blocks()[0].querySelector('code')!, 0)
    expect(firstPainted).toBeGreaterThan(0)
    // The first painted stretch is within the margin above line 3,000, not near the top.
    const reg = (window as unknown as { CSS: { highlights: Map<string, Set<StaticRange | Range>> } }).CSS.highlights
    const starts = [...reg.values()].flatMap((h) => [...h]).map((r) => e.view.posAtDOM(r.startContainer, r.startOffset))
    expect(Math.min(...starts)).toBeGreaterThanOrEqual(lineAt(e, 3000 - COLOR_MARGIN_LINES - 1))
    expect(Math.max(...starts)).toBeLessThanOrEqual(lineAt(e, 3040 + COLOR_MARGIN_LINES + 1))
    expect(text(lineAt(e, 3000), lineAt(e, 3001))).toMatch(/\S/)
    // Scrolling a few lines keeps the same colors up: nothing is painted again or redrawn.
    const before = [...reg.values()].flatMap((h) => [...h])
    const redrawn = mutations(blocks()[0], () => show(e, lineAt(e, 3010), lineAt(e, 3050)))
    expect(redrawn).toBe(0)
    expect([...reg.values()].flatMap((h) => [...h])).toEqual(before)
  })

  it('colors nothing of a big block far below the screen until it comes near', () => {
    const e = make(`<p>Intro.</p><pre><code class="language-python">${bigPython(20)}</code></pre>` + '<p>Gap.</p>'.repeat(400) + `<pre><code class="language-python">${bigPython(3000)}</code></pre>`)
    const spy = vi.spyOn(editorHljs, 'highlight')
    expect(spans(blocks()[0]).length).toBeGreaterThan(0)
    expect(spans(blocks()[1])).toEqual([])
    typeInto(e, 0, '\nx = 1')
    // Only the first block was colored again, and only a few lines of it.
    expect(spy).toHaveBeenCalledTimes(1)
    const pos = codeBlockPositions(e)[1]
    show(e, pos + 1, pos + 2000)
    expect(spans(blocks()[1]).length).toBeGreaterThan(100)
  })
})

describe('coloring cost', () => {
  it('re-highlights only the block that changed in a document of many small blocks', () => {
    const many = Array.from({ length: 200 }, (_, i) => `<pre><code class="language-python">n${i} = ${i}</code></pre><p>Text ${i}.</p>`).join('')
    const e = make(many)
    const spy = vi.spyOn(editorHljs, 'highlight')
    typeInto(e, 37, ' + 1')
    typeInto(e, 37, ' + 2')
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

  it('keeps a keystroke in a 5,000-line python block cheap, and colors it on the key', () => {
    const e = make(`<pre><code class="language-python">${bigPython(5000)}</code></pre>`)
    expect(spans(blocks()[0])).toContain('hljs-keyword:def')
    const spy = vi.spyOn(editorHljs, 'highlight')
    // The coloring's own share of a keystroke (the plugin's transaction work)
    // and the whole dispatch. The dispatch is mostly happy-dom, which walks
    // every node of the block each time ProseMirror pauses and resumes its
    // DOM observer, and under a loaded suite it varies with whatever else runs.
    const apply: number[] = []
    const dispatch: number[] = []
    const at = lineAt(e, 50)
    for (let k = 0; k < 20; k++) {
      const tr = e.state.tr.insertText(k % 2 ? 'x' : ' ', at + k)
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
    // Each key colors a few lines from the last restart point, not the block.
    expect(spy).toHaveBeenCalled()
    for (const [code] of spy.mock.calls) expect(String(code).length).toBeLessThan(2000)
    expect(median(apply)).toBeLessThan(10)
    // Generous: under load the suite runs every worker at once.
    expect(median(dispatch)).toBeLessThan(60)
    // A keyword typed is colored on the key.
    e.view.dispatch(e.state.tr.insertText('\nwhile x: pass\n', lineAt(e, 60) - 1))
    expect(spans(blocks()[0])).toContain('hljs-keyword:while')
  })

  it('redraws nothing when a new color appears: colors are painted beside the DOM, not in it', () => {
    const e = make(`<pre><code class="language-python">${bigPython(1000)}</code></pre>`)
    const pre = blocks()[0]
    const at = lineAt(e, 40) + '    out'.length
    // Turn " = 0" into " = 0 if 1 else 2": two keywords and a number, new colors in plain text.
    for (const piece of [' if', ' 1', ' else', ' 2']) {
      const n = mutations(pre, () => e.view.dispatch(e.state.tr.insertText(piece, e.state.doc.child(0).textContent.indexOf('\n', at - 1) + 1)))
      expect(n).toBeLessThan(4)
    }
    expect(spans(pre)).toContain('hljs-keyword:else')
    // A comment typed is italic (a shape span): only its own line changes.
    const n = mutations(pre, () => e.view.dispatch(e.state.tr.insertText('  # invented', lineAt(e, 41) - 1)))
    expect(n).toBeLessThan(10)
    expect(shapes(pre)).toContain('hljs-comment:# invented')
  })

  it('colors the rest of what is shown at once when a string opens, and back when it closes', () => {
    const e = make(`<pre><code class="language-python">${bigPython(1000)}</code></pre>`)
    const strings = (): number => spans(blocks()[0]).filter((s) => s.startsWith('hljs-string')).length
    const before = strings()
    const at = lineAt(e, 10)
    e.view.dispatch(e.state.tr.insertText('"""', at))
    // Everything shown after it is now inside strings: far fewer keywords.
    expect(spans(blocks()[0]).filter((s) => s === 'hljs-keyword:def').length).toBeLessThan(3)
    expect(spans(blocks()[0]).some((s) => s.startsWith('hljs-string') && s.split('\n').length > 5)).toBe(true)
    e.view.dispatch(e.state.tr.delete(at, at + 3))
    expect(strings()).toBe(before)
    expect(spans(blocks()[0]).filter((s) => s === 'hljs-keyword:def').length).toBeGreaterThan(20)
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

  const button = (i: number): HTMLButtonElement => blocks()[i].querySelector('button.code-lang__button')!
  const combo = (): HTMLInputElement | null => document.querySelector('.code-lang-pop input[role=combobox]')
  const options = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.code-lang-pop [role=option]')]
  const active = (): string | undefined => options().find((o) => o.getAttribute('aria-selected') === 'true')?.textContent ?? undefined
  const typeFilter = (text: string): void => {
    combo()!.value = text
    combo()!.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const key = (k: string): void => {
    combo()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  }

  it('sits on every code block as a button showing its language, and on no diagram or formula', () => {
    make(PY + '<pre><code class="language-js">let n = 1</code></pre><pre><code>x</code></pre><pre><code class="language-mermaid">flowchart LR</code></pre><pre><code class="language-math">x</code></pre>')
    expect(button(0).textContent).toBe('Python')
    expect(button(0).getAttribute('aria-label')).toBe('Code language: Python')
    expect(button(1).textContent).toBe('JavaScript')
    expect(button(2).textContent).toBe('Plain text')
    expect(host.querySelectorAll('button.code-lang__button').length).toBe(3)
    for (const rb of host.querySelectorAll('.rb')) expect(rb.querySelector('.code-lang')).toBeNull()
    // No list is made until one is opened.
    expect(document.querySelector('.code-lang-pop')).toBeNull()
  })

  it('opens a list to filter, as an ARIA combobox: every language, common ones first, starting at its own', () => {
    make(PY)
    button(0).click()
    const input = combo()!
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(button(0).getAttribute('aria-expanded')).toBe('true')
    const list = document.getElementById(input.getAttribute('aria-controls')!)!
    expect(list.getAttribute('role')).toBe('listbox')
    expect(options().length).toBe(codeLanguages().length)
    expect(options()[0].textContent).toBe('Plain text')
    expect(list.querySelector('[role=group]')!.getAttribute('aria-label')).toBe('More languages')
    expect(list.querySelector('[role=group] [role=option]')!.textContent).toBe(codeLanguages().find((l) => !l.common)!.label)
    // The block's language is marked, and is where the arrows start.
    expect(active()).toBe('Python')
    expect(input.getAttribute('aria-activedescendant')).toBe(options().find((o) => o.textContent === 'Python')!.id)
    expect(options().find((o) => o.textContent === 'Python')!.getAttribute('aria-current')).toBe('true')
  })

  it('filters by name or alias as it is typed; arrows move, Enter chooses: colored at once, saved, one undo step', () => {
    const e = make('<pre><code>SELECT 1 FROM t;</code></pre><p>After.</p>')
    button(0).click()
    typeFilter('js')
    expect(options()[0].textContent).toBe('JavaScript')
    typeFilter('c+')
    expect(options()[0].textContent).toBe('C++')
    typeFilter('zzzz')
    expect(options()).toEqual([])
    expect(document.querySelector<HTMLElement>('.code-lang-pop__empty')!.hidden).toBe(false)
    key('Enter')
    expect(e.getHTML()).toBe('<pre><code>SELECT 1 FROM t;</code></pre><p>After.</p>')
    typeFilter('sq')
    expect(active()).toBe('SQL')
    key('ArrowDown')
    key('ArrowUp')
    expect(active()).toBe('SQL')
    key('Enter')
    expect(document.querySelector('.code-lang-pop')).toBeNull()
    expect(document.activeElement).toBe(e.view.dom)
    expect(e.getHTML()).toBe('<pre><code class="language-sql">SELECT 1 FROM t;</code></pre><p>After.</p>')
    expect(spans(blocks()[0]).some((s) => /hljs-keyword:SELECT/i.test(s))).toBe(true)
    expect(button(0).textContent).toBe('SQL')
    // Back to plain text, through the list from the top.
    button(0).click()
    typeFilter('plain')
    key('Enter')
    expect(e.getHTML()).toBe('<pre><code>SELECT 1 FROM t;</code></pre><p>After.</p>')
    expect(spans(blocks()[0])).toEqual([])
    e.commands.undo()
    expect(e.getHTML()).toBe('<pre><code class="language-sql">SELECT 1 FROM t;</code></pre><p>After.</p>')
    expect(button(0).textContent).toBe('SQL')
  })

  it('chooses with a click; Escape, or a click elsewhere, closes it changing nothing', () => {
    const e = make(PY + '<p>After.</p>')
    const html = e.getHTML()
    button(0).click()
    key('Escape')
    expect(document.querySelector('.code-lang-pop')).toBeNull()
    expect(document.activeElement).toBe(e.view.dom)
    expect(button(0).getAttribute('aria-expanded')).toBe('false')
    // Its button closes it again.
    button(0).click()
    button(0).click()
    expect(document.querySelector('.code-lang-pop')).toBeNull()
    button(0).click()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(document.querySelector('.code-lang-pop')).toBeNull()
    expect(e.getHTML()).toBe(html)
    button(0).click()
    typeFilter('rust')
    options()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(e.getHTML()).toContain('<pre><code class="language-rust">')
  })

  it('shows a language the outputs do not know as itself', () => {
    make('<pre><code class="language-cobolx">x</code></pre>')
    expect(button(0).textContent).toBe('cobolx')
    button(0).click()
    expect(options()[0].textContent).toBe('cobolx')
    expect(active()).toBe('cobolx')
  })

  it('is reached from the code with Mod-Alt-L, its filter focused, and Escape goes back to the code', () => {
    const e = make('<p>Intro.</p>' + PY + JS)
    e.commands.setTextSelection(e.state.doc.child(0).nodeSize + e.state.doc.child(1).nodeSize + 3)
    expect(e.commands.focusCodeLanguage()).toBe(true)
    expect(document.activeElement).toBe(combo())
    expect(active()).toBe('JavaScript')
    key('Escape')
    expect(document.activeElement).toBe(e.view.dom)
    expect(e.state.selection.from).toBe(e.state.doc.child(0).nodeSize + e.state.doc.child(1).nodeSize + 3)
    e.commands.setTextSelection(2)
    expect(e.commands.focusCodeLanguage()).toBe(false)
  })
})
