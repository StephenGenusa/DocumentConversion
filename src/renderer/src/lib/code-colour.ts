import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { AttrStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import hljs, { HLJS_CSS } from '../../../core/hljs'

/**
 * Code blocks coloured while they are edited, by the same highlight.js and the
 * same palette as the pdf and html outputs (core/hljs.ts), so the pane looks
 * like the printed page. The colours are decorations: they are drawn, never
 * part of the document, so what the editor saves is unchanged.
 *
 * Only a block with a language highlight.js knows is coloured; no language or
 * `plaintext` stays plain, as in the outputs (the guess is made at intake).
 *
 * Cost: one keystroke re-highlights only the block it touched, and every other
 * block's colours are mapped through the change. A block too big to
 * highlight inside a keystroke keeps its mapped colours while typing and is
 * re-highlighted once typing pauses. A re-highlight replaces only the colours
 * that changed: the rest stay the same decorations, so the view redraws the
 * edited line, not every span of the block.
 */

/** A code block of this many lines or more is not coloured (plain monospace, as before). */
export const COLOUR_LINE_LIMIT = 6000
/** Blocks up to this many characters are re-coloured on the keystroke; bigger ones after a pause. */
export const SYNC_COLOUR_CHARS = 20_000
/** How long typing must pause before a big block is re-coloured. */
export const COLOUR_PAUSE_MS = 250

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    codeColour: {
      /** The language of the code block at the cursor; '' for plain text. One undo step. */
      setCodeLanguage: (language: string) => ReturnType
      /** Focus the language picker of the code block at the cursor. */
      focusCodeLanguage: () => ReturnType
    }
  }
}

/** The highlight.js language for a block's `language` attr, or null when it is not coloured. */
function grammarOf(language: unknown): string | null {
  if (typeof language !== 'string' || !language) return null
  const lang = hljs.getLanguage(language)
  if (!lang) return null
  const name = canonical.get(lang)
  return name && name !== 'plaintext' ? name : null
}

const canonical = new Map(hljs.listLanguages().map((name) => [hljs.getLanguage(name)!, name] as const))

const ENTITY = /&(?:amp|lt|gt|quot|#x27);/g

/** Each coloured stretch of `code`, as [from, to, classes] offsets into it. */
function tokens(code: string, language: string): [number, number, string][] {
  const { value } = hljs.highlight(code, { language, ignoreIllegals: true })
  const out: [number, number, string][] = []
  const stack: string[] = []
  let at = 0
  for (const m of value.matchAll(/<span class="([^"]*)">|<\/span>|[^<]+/g)) {
    if (m[1] !== undefined) stack.push(m[1])
    else if (m[0] === '</span>') stack.pop()
    else {
      const len = m[0].replace(ENTITY, '.').length
      if (stack.length) {
        const cls = stack.join(' ')
        const last = out[out.length - 1]
        if (last && last[1] === at && last[2] === cls) last[1] = at + len
        else out.push([at, at + len, cls])
      }
      at += len
    }
  }
  return out
}

function lineCountReaches(text: string, limit: number): boolean {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) if (++n >= limit) return true
  return n >= limit
}

/** What colouring a block gets now: none, on the keystroke, or after the pause. */
function plan(node: PMNode): { language: string; now: boolean } | null {
  const language = grammarOf(node.attrs.language)
  if (!language) return null
  const text = node.textContent
  if (lineCountReaches(text, COLOUR_LINE_LIMIT)) return null
  return { language, now: text.length <= SYNC_COLOUR_CHARS }
}

interface ColourState {
  decorations: DecorationSet
  /** Start positions of big blocks waiting for the pause. */
  waiting: number[]
}

const key = new PluginKey<ColourState>('codeColour')

function isCodeBlock(node: PMNode): boolean {
  return node.type.name === 'codeBlock'
}

/**
 * Above this many stale colours a block's decorations are rebuilt with the
 * rest of the set rather than removed one by one: DecorationSet.remove looks
 * each one up in the block's list, which is quadratic in a big block.
 */
const REMOVE_ONE_BY_ONE = 64

/*
 * A colour takes in what is typed at its end (and, first in its block, at its
 * start). Typed text then always lands inside a coloured or a plain stretch
 * that is already drawn, never in a new stretch of its own between two
 * colours: ProseMirror matches a block's stretches in order, so one new
 * stretch had it rewrite every span after it, the whole rest of the block.
 */
function colour(from: number, to: number, cls: string, first: boolean): Decoration {
  return Decoration.inline(from, to, { class: cls }, { colour: cls, inclusiveStart: first, inclusiveEnd: true })
}

/** Re-colour the code block at `pos`, or queue it, replacing what it had. */
function recolour(state: ColourState, doc: PMNode, pos: number, node: PMNode, force: boolean): ColourState {
  const p = plan(node)
  let { decorations, waiting } = state
  waiting = waiting.filter((w) => w !== pos)
  const end = pos + node.nodeSize
  // The picker always shows the language as it is now; kept while it does.
  const pickerKey = `lang:${pickerValue(node.attrs.language)}`
  const picker = decorations.find(pos, end, (spec) => spec.picker === true)
  if (picker.length !== 1 || picker[0].from !== pos + 1 || picker[0].spec.key !== pickerKey) {
    if (picker.length) decorations = decorations.remove(picker)
    decorations = decorations.add(doc, [pickerWidget(pos, node.attrs.language)])
  }
  if (p && !p.now && !force) {
    // Keep the mapped colours up until the pause.
    return { decorations, waiting: [...waiting, pos] }
  }
  // Only the colours that changed are replaced. The rest, mapped through the
  // edit, are kept as they are: the same objects, so the view leaves their
  // spans alone and a re-colour after the pause redraws a line, not the block.
  const old = decorations.find(pos, end, (spec) => spec.picker !== true).sort((x, y) => x.from - y.from || x.to - y.to)
  const fresh = p ? tokens(node.textContent, p.language) : []
  const stale: Decoration[] = []
  const added: Decoration[] = []
  let i = 0
  for (const [from, to, cls] of fresh) {
    const a = pos + 1 + from
    const b = pos + 1 + to
    while (i < old.length && (old[i].from < a || (old[i].from === a && old[i].to < b))) stale.push(old[i++])
    const d = old[i]
    if (d && d.from === a && d.to === b && d.spec.colour === cls && (d.spec.inclusiveStart === true) === (from === 0)) i++
    else added.push(colour(a, b, cls, from === 0))
  }
  while (i < old.length) stale.push(old[i++])
  if (stale.length > REMOVE_ONE_BY_ONE) {
    // The block's colours afresh, beside everything else as it was.
    const others = decorations.find().filter((d) => d.spec.picker === true || d.to <= pos || d.from >= end)
    const all = fresh.map(([from, to, cls]) => colour(pos + 1 + from, pos + 1 + to, cls, from === 0))
    decorations = DecorationSet.create(doc, [...others, ...all])
  } else {
    if (stale.length) decorations = decorations.remove(stale)
    if (added.length) decorations = decorations.add(doc, added)
  }
  return { decorations, waiting }
}

/** Set the language of the code block at `pos` ('' for plain text), as one undo step. */
function setLanguageAt(tr: Transaction, pos: number, language: string): Transaction {
  closeHistory(tr)
  tr.setNodeAttribute(pos, 'language', language || null)
  return closeHistory(tr)
}

/*
 * The language picker: a small select in the block's top corner, for every
 * code block (diagrams and formulas are blocks of their own), so the toolbar
 * is no wider. Its list is filled when it is first used: a document of many
 * blocks does not carry a list of every language for each one.
 */
function pickerWidget(pos: number, language: unknown): Decoration {
  const value = pickerValue(language)
  return Decoration.widget(pos + 1, (view, getPos) => pickerDom(view, getPos, value), {
    side: -1,
    picker: true,
    key: `lang:${value}`,
    ignoreSelection: true,
    stopEvent: () => true,
  })
}

function pickerDom(view: EditorView, getPos: () => number | undefined, value: string): HTMLElement {
  const doc = view.dom.ownerDocument
  const wrap = doc.createElement('span')
  wrap.className = 'code-lang'
  wrap.contentEditable = 'false'
  const select = doc.createElement('select')
  select.className = 'code-lang__select'
  select.setAttribute('aria-label', 'Code language')
  select.title = 'Code language'
  const option = (v: string, label: string): HTMLOptionElement => {
    const o = doc.createElement('option')
    o.value = v
    o.textContent = label
    return o
  }
  const all = codeLanguages()
  select.append(option(value, all.find((l) => l.value === value)?.label ?? value))
  select.value = value
  let filled = false
  const fill = (): void => {
    if (filled) return
    filled = true
    select.replaceChildren()
    for (const l of all.filter((l) => l.common)) select.append(option(l.value, l.label))
    if (!all.some((l) => l.value === value)) select.append(option(value, value))
    const more = doc.createElement('optgroup')
    more.label = 'More languages'
    for (const l of all.filter((l) => !l.common)) more.append(option(l.value, l.label))
    select.append(more)
    select.value = value
  }
  select.addEventListener('mousedown', fill)
  select.addEventListener('focus', fill)
  select.addEventListener('change', () => {
    const at = getPos()
    if (at === undefined) return
    const blockPos = at - 1
    const node = view.state.doc.nodeAt(blockPos)
    if (!node || !isCodeBlock(node)) return
    view.dispatch(setLanguageAt(view.state.tr, blockPos, select.value))
  })
  select.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    // Back to the code, where the caret was.
    e.preventDefault()
    view.focus()
  })
  wrap.append(select)
  return wrap
}

/** Start positions of the code blocks a transaction touched, in the new document. */
function touched(tr: Transaction): number[] {
  const doc = tr.doc
  const ranges: [number, number][] = []
  tr.mapping.maps.forEach((map, i) => {
    const after = tr.mapping.slice(i + 1)
    map.forEach((_a, _b, from, to) => ranges.push([after.map(from, -1), after.map(to, 1)]))
    const step = tr.steps[i]
    if (step instanceof AttrStep) {
      const at = after.map(step.pos)
      ranges.push([at, at + 1])
    }
  })
  const found = new Set<number>()
  for (const [from, to] of ranges) {
    const a = Math.max(0, Math.min(from, to) - 1)
    const b = Math.min(doc.content.size, Math.max(from, to) + 1)
    doc.nodesBetween(a, b, (node, pos) => {
      if (isCodeBlock(node)) found.add(pos)
      return !node.isTextblock
    })
  }
  return [...found]
}

function initial(doc: PMNode): ColourState {
  let state: ColourState = { decorations: DecorationSet.empty, waiting: [] }
  doc.descendants((node, pos) => {
    if (isCodeBlock(node)) state = recolour(state, doc, pos, node, false)
    return !node.isTextblock
  })
  return state
}

function apply(tr: Transaction, value: ColourState): ColourState {
  const flush = tr.getMeta(key) === 'flush'
  if (!tr.docChanged && !flush) return value
  let state: ColourState = value
  if (tr.docChanged) {
    const waiting: number[] = []
    for (const w of value.waiting) {
      const r = tr.mapping.mapResult(w, 1)
      if (!r.deleted) waiting.push(r.pos)
    }
    state = { decorations: value.decorations.map(tr.mapping, tr.doc), waiting }
    for (const pos of touched(tr)) state = recolour(state, tr.doc, pos, tr.doc.nodeAt(pos)!, false)
  }
  if (flush) {
    for (const pos of state.waiting) {
      const node = tr.doc.nodeAt(pos)
      if (node && isCodeBlock(node)) state = recolour(state, tr.doc, pos, node, true)
    }
    state = { ...state, waiting: [] }
  }
  return state
}

/** The palette, once per page: the same rules the pdf and html shell print. */
function addStyles(doc: Document): void {
  if (doc.getElementById('code-colour-css')) return
  const style = doc.createElement('style')
  style.id = 'code-colour-css'
  style.textContent = HLJS_CSS
  doc.head.append(style)
}

export const CodeColour = Extension.create({
  name: 'codeColour',
  addCommands() {
    return {
      setCodeLanguage:
        (language) =>
        ({ state, tr, dispatch }) => {
          const { $from } = state.selection
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d)
            if (!isCodeBlock(node)) continue
            // Its own undo step, whatever was typed just before or after.
            if (dispatch) setLanguageAt(tr, $from.before(d), language)
            return true
          }
          return false
        },
      focusCodeLanguage:
        () =>
        ({ state, view }) => {
          const { $from } = state.selection
          for (let d = $from.depth; d > 0; d--) {
            if (!isCodeBlock($from.node(d))) continue
            const dom = view.nodeDOM($from.before(d)) as HTMLElement | null
            const select = dom?.querySelector<HTMLSelectElement>('.code-lang__select')
            if (!select) return false
            select.focus()
            return true
          }
          return false
        },
    }
  },
  addKeyboardShortcuts() {
    return { 'Mod-Alt-l': () => this.editor.commands.focusCodeLanguage() }
  },
  addProseMirrorPlugins: () => [
    new Plugin<ColourState>({
      key,
      state: {
        init: (_config, state: EditorState) => initial(state.doc),
        apply,
      },
      props: {
        decorations: (state) => key.getState(state)?.decorations,
      },
      view(view) {
        addStyles(view.dom.ownerDocument)
        let timer: ReturnType<typeof setTimeout> | undefined
        let seen: number[] | undefined
        const schedule = (state: EditorState): void => {
          const waiting = key.getState(state)?.waiting ?? []
          if (waiting === seen) return
          seen = waiting
          clearTimeout(timer)
          timer = undefined
          if (waiting.length === 0) return
          timer = setTimeout(() => {
            timer = undefined
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, 'flush').setMeta('addToHistory', false))
          }, COLOUR_PAUSE_MS)
        }
        schedule(view.state)
        return {
          update: (v) => schedule(v.state),
          destroy: () => clearTimeout(timer),
        }
      },
    }),
  ],
})

/** Shown first in the picker: the languages most pasted. */
const COMMON = ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp', 'c', 'go', 'rust', 'sql', 'bash', 'shell', 'powershell', 'json', 'yaml', 'xml', 'css', 'markdown', 'php', 'ruby']

export interface CodeLanguage {
  /** The `language` attr; '' for plain text. */
  value: string
  label: string
  common: boolean
}

let languages: CodeLanguage[] | undefined

/** The picker's list: Plain text, the common languages, then the rest by name. */
export function codeLanguages(): CodeLanguage[] {
  if (languages) return languages
  const label = (name: string): string => {
    const friendly = hljs.getLanguage(name)!.name ?? name
    // hljs names HTML/XML "HTML, XML"; one name reads better in a list.
    return friendly.split(',')[0].trim()
  }
  const all = hljs.listLanguages().filter((n) => n !== 'plaintext')
  const common = COMMON.filter((n) => all.includes(n))
  const rest = all.filter((n) => !common.includes(n)).sort((a, b) => label(a).localeCompare(label(b)))
  languages = [
    { value: '', label: 'Plain text', common: true },
    ...common.map((n) => ({ value: n, label: label(n), common: true })),
    ...rest.map((n) => ({ value: n, label: label(n), common: false })),
  ]
  return languages
}

/** The picker entry for a block's `language` attr: an alias as its language, an unknown name as itself. */
export function pickerValue(language: unknown): string {
  if (typeof language !== 'string' || !language) return ''
  const lang = hljs.getLanguage(language)
  if (!lang) return language
  const name = canonical.get(lang) ?? language
  return name === 'plaintext' ? '' : name
}
