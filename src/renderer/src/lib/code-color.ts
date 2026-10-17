import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { AttrStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import { HLJS_CSS, TOKEN_COLORS } from '../../../core/hljs-palette'
import { GRAMMARS, grammarName, grammarReady, loadGrammar } from './code-grammars'
import { colorTo, recolorText, tokensIn, uncolored, type Colors, type Token } from './code-tokens'
import { closePicker, openPickerIn, pickerDom, pickerValue } from './code-language-picker'

export { pickerValue }

/**
 * Code blocks colored while they are edited, by the same highlight.js and the
 * same palette as the pdf and html outputs (core/hljs.ts), so the pane looks
 * like the printed page. The colors are never part of the document, so what
 * the editor saves is unchanged.
 *
 * Only a block with a language highlight.js knows is colored; no language or
 * `plaintext` stays plain, as in the outputs (the guess is made at intake).
 * A grammar is loaded the first time a block needs it (code-grammars.ts), and
 * the blocks in that language are colored once it is in.
 *
 * Only what is on screen is colored, with a margin of lines above and below
 * (COLOR_MARGIN_LINES), so a big block costs what its visible part does. The
 * colors are painted with the CSS Custom Highlight API: ranges over the
 * block's text, kept beside the page rather than in it, so ProseMirror's DOM
 * is the plain block's. A new color never makes it redraw anything. Only
 * what a color cannot do (italic comments, bold headings, a diff line's
 * background) is a decoration, and only in the colored lines.
 *
 * Cost of a key: the block is colored again from the last restart point
 * before it until the old colors hold (code-tokens.ts), usually the next
 * line, and its visible lines are painted again.
 */

/** Lines colored past what is on screen, above and below. */
export const COLOR_MARGIN_LINES = 150

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    codeColor: {
      /** The language of the code block at the cursor; '' for plain text. One undo step. */
      setCodeLanguage: (language: string) => ReturnType
      /** Open the language picker of the code block at the cursor, its filter focused. */
      focusCodeLanguage: () => ReturnType
    }
  }
}

/** The highlight.js language for a block's `language` attr, or null when it is not colored. */
function grammarOf(language: unknown): string | null {
  const name = grammarName(language)
  return name && name !== 'plaintext' ? name : null
}

/** The language a block is colored in now, or null (none, unknown, or not loaded). */
function colorLanguage(node: PMNode): string | null {
  const language = grammarOf(node.attrs.language)
  return language && grammarReady(language) ? language : null
}

/* ------------------------------ what is colored ------------------------------- */

interface Block {
  /** Its colors so far, or null when it is not colored. */
  colors: Colors | null
  /** The doc positions colored now (on screen and the margin), or null. */
  window: readonly [number, number] | null
}

interface ColorState {
  /** Every code block, by position. */
  blocks: ReadonlyMap<number, Block>
  /** The doc positions on screen, as last measured (the top until then). */
  visible: readonly [number, number]
  /** The pickers, and the shapes (italic, bold, line backgrounds) in the colored lines. */
  decorations: DecorationSet
  /** Languages the blocks name whose grammars are not loaded yet. */
  wanted: readonly string[]
}

type Meta = { visible: readonly [number, number] } | { loaded: string }

const key = new PluginKey<ColorState>('codeColor')

function isCodeBlock(node: PMNode): boolean {
  return node.type.name === 'codeBlock'
}

/** Where `n` lines before the line holding `at` start. */
function linesBack(text: string, at: number, n: number): number {
  let i = text.lastIndexOf('\n', at - 1)
  for (let k = 0; k < n && i > 0; k++) i = text.lastIndexOf('\n', i - 1)
  return i < 0 ? 0 : i + 1
}

/** Where the line `n` lines after the line holding `at` ends. */
function linesOn(text: string, at: number, n: number): number {
  let i = text.indexOf('\n', at)
  for (let k = 0; k < n && i !== -1; k++) i = text.indexOf('\n', i + 1)
  return i < 0 ? text.length : i
}

/** Line breaks between two doc positions outside a block, or more than `limit` if there are many. */
function linesBetween(doc: PMNode, from: number, to: number, limit: number): number {
  // Far apart in characters is far apart in lines too; not worth counting.
  if (to - from > limit * 200) return limit + 1
  return doc.textBetween(from, to, '\n', '\n').split('\n').length - 1
}

/**
 * The positions of the block at `pos` within `margin` lines of what is on
 * screen, or null when it is further away than that.
 */
function reach(doc: PMNode, pos: number, text: string, visible: readonly [number, number], margin: number): [number, number] | null {
  const start = pos + 1
  const end = start + text.length
  const [v0, v1] = visible
  if (v1 < start) {
    const gap = linesBetween(doc, v1, start, margin)
    return gap > margin ? null : [start, start + linesOn(text, 0, margin - gap)]
  }
  if (v0 > end) {
    const gap = linesBetween(doc, end, v0, margin)
    return gap > margin ? null : [start + linesBack(text, text.length, margin - gap), end]
  }
  return [start + linesBack(text, Math.max(0, v0 - start), margin), start + linesOn(text, Math.min(text.length, v1 - start), margin)]
}

/**
 * The positions to color in a block: the screen and the margin around it.
 * The window stays put while the screen is still well inside it (half the
 * margin), so scrolling a line or two, or typing, does not move it.
 */
function windowOf(doc: PMNode, pos: number, text: string, visible: readonly [number, number], current: Block['window']): Block['window'] {
  const outer = reach(doc, pos, text, visible, COLOR_MARGIN_LINES)
  if (!outer) return null
  if (current && current[0] >= pos + 1 && current[1] <= pos + 1 + text.length) {
    const inner = reach(doc, pos, text, visible, COLOR_MARGIN_LINES / 2)
    if (!inner || (current[0] <= inner[0] && current[1] >= inner[1])) return current
  }
  return outer
}

/*
 * What a color cannot do, a decoration does: the classes whose rules change
 * the look beyond the color (HLJS_CSS). Each takes in what is typed at its
 * end, so typing at the end of a comment lands in it rather than in a new
 * stretch: ProseMirror matches a block's stretches in order, and one new
 * stretch has it redraw every stretch after it in the block.
 */
const SHAPES = ['hljs-comment', 'hljs-quote', 'hljs-section', 'hljs-name', 'hljs-addition', 'hljs-deletion']

function shapeOf(cls: string): string | null {
  const classes = cls.split(' ')
  for (let i = classes.length - 1; i >= 0; i--) if (SHAPES.includes(classes[i])) return classes[i]
  return null
}

/** The shapes of the colored lines, adjoining ones of one kind as one. */
function shapes(tokens: readonly Token[]): [number, number, string][] {
  const out: [number, number, string][] = []
  for (const [from, to, cls] of tokens) {
    const shape = shapeOf(cls)
    if (!shape) continue
    const last = out[out.length - 1]
    if (last && last[1] === from && last[2] === shape) last[1] = to
    else out.push([from, to, shape])
  }
  return out
}

function shapeDeco(from: number, to: number, cls: string): Decoration {
  return Decoration.inline(from, to, { class: cls }, { shape: cls, inclusiveEnd: true })
}

/**
 * Above this many stale shapes a block's decorations are rebuilt with the
 * rest of the set rather than removed one by one: DecorationSet.remove looks
 * each one up in the block's list, which is quadratic in a big block.
 */
const REMOVE_ONE_BY_ONE = 64

/** Bring the code block at `pos` up to date: its colors, its window, its shapes and its picker. */
function update(state: ColorState, doc: PMNode, pos: number, node: PMNode, prev: Block | undefined, blocks: Map<number, Block>): ColorState {
  let { decorations, wanted } = state
  const text = node.textContent
  const end = pos + node.nodeSize
  const named = grammarOf(node.attrs.language)
  if (named && !grammarReady(named) && !wanted.includes(named)) wanted = [...wanted, named]
  // The picker always shows the language as it is now; kept while it does.
  const pickerKey = `lang:${pickerValue(node.attrs.language)}`
  const picker = decorations.find(pos, end, (spec) => spec.picker === true)
  if (picker.length !== 1 || picker[0].from !== pos + 1 || picker[0].spec.key !== pickerKey) {
    if (picker.length) decorations = decorations.remove(picker)
    decorations = decorations.add(doc, [pickerWidget(pos, node.attrs.language)])
  }
  const language = colorLanguage(node)
  const window = language ? windowOf(doc, pos, text, state.visible, prev?.window ?? null) : null
  let colors: Colors | null = null
  if (language && window) {
    const was = prev?.colors?.language === language ? prev.colors : null
    const need = window[1] - pos - 1
    colors = was ? recolorText(was, text, need) : colorTo(uncolored(language, text), need)
  } else if (language && prev?.colors?.language === language) {
    // Off screen: kept for when it comes back, and brought up to date then.
    colors = prev.colors
  }
  blocks.set(pos, { colors, window })
  // Only the shapes that changed are replaced; the rest stay the same
  // decorations, so the view leaves their spans alone.
  const old = decorations.find(pos, end, (spec) => spec.shape !== undefined).sort((x, y) => x.from - y.from || x.to - y.to)
  const fresh = colors && window ? shapes(tokensIn(colors, window[0] - pos - 1, window[1] - pos - 1)) : []
  const stale: Decoration[] = []
  const added: Decoration[] = []
  let i = 0
  for (const [from, to, cls] of fresh) {
    const a = pos + 1 + from
    const b = pos + 1 + to
    while (i < old.length && (old[i].from < a || (old[i].from === a && old[i].to < b))) stale.push(old[i++])
    const d = old[i]
    if (d && d.from === a && d.to === b && d.spec.shape === cls) i++
    else added.push(shapeDeco(a, b, cls))
  }
  while (i < old.length) stale.push(old[i++])
  if (stale.length > REMOVE_ONE_BY_ONE) {
    const others = decorations.find().filter((d) => d.spec.shape === undefined || d.to <= pos || d.from >= end)
    const all = fresh.map(([from, to, cls]) => shapeDeco(pos + 1 + from, pos + 1 + to, cls))
    decorations = DecorationSet.create(doc, [...others, ...all])
  } else {
    if (stale.length) decorations = decorations.remove(stale)
    if (added.length) decorations = decorations.add(doc, added)
  }
  return { ...state, decorations, wanted }
}

/** Set the language of the code block at `pos` ('' for plain text), as one undo step. */
function setLanguageAt(tr: Transaction, pos: number, language: string): Transaction {
  closeHistory(tr)
  tr.setNodeAttribute(pos, 'language', language || null)
  return closeHistory(tr)
}

/*
 * The language picker: a button in the block's top corner, for every code
 * block (diagrams and formulas are blocks of their own), so the toolbar is
 * no wider; it opens a searchable list (code-language-picker.ts).
 */
function pickerWidget(pos: number, language: unknown): Decoration {
  const value = pickerValue(language)
  return Decoration.widget(
    pos + 1,
    (view, getPos) =>
      pickerDom(view, getPos, value, {
        languages: codeLanguages,
        choose: (v, blockPos, chosen) => {
          const node = v.state.doc.nodeAt(blockPos)
          if (node && isCodeBlock(node)) v.dispatch(setLanguageAt(v.state.tr, blockPos, chosen))
          v.focus()
        },
      }),
    { side: -1, picker: true, key: `lang:${value}`, ignoreSelection: true, stopEvent: () => true },
  )
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

/** Blocks a screen at `visible` may color: the ones near it, and the ones colored now. */
function nearBlocks(doc: PMNode, blocks: ReadonlyMap<number, Block>, visible: readonly [number, number]): Set<number> {
  const out = new Set<number>()
  for (const [pos, b] of blocks) if (b.window) out.add(pos)
  const span = COLOR_MARGIN_LINES * 200
  doc.nodesBetween(Math.max(0, visible[0] - span), Math.min(doc.content.size, visible[1] + span), (node, pos) => {
    if (isCodeBlock(node)) out.add(pos)
    return !node.isTextblock
  })
  return out
}

/** Whether a screen at `visible` colors other lines than now. */
function movesWindows(state: EditorState, visible: readonly [number, number]): boolean {
  const s = key.getState(state)
  if (!s) return false
  for (const pos of nearBlocks(state.doc, s.blocks, visible)) {
    const node = state.doc.nodeAt(pos)
    const b = s.blocks.get(pos)
    if (!node || !b) continue
    const text = node.textContent
    const was = b.window
    const now = colorLanguage(node) ? windowOf(state.doc, pos, text, visible, was) : null
    if (now !== was && (!now || !was || now[0] !== was[0] || now[1] !== was[1])) return true
  }
  return false
}

function initial(doc: PMNode): ColorState {
  let state: ColorState = { blocks: new Map(), visible: [0, 0], decorations: DecorationSet.empty, wanted: [] }
  const blocks = new Map<number, Block>()
  doc.descendants((node, pos) => {
    if (isCodeBlock(node)) state = update(state, doc, pos, node, undefined, blocks)
    return !node.isTextblock
  })
  return { ...state, blocks }
}

function apply(tr: Transaction, value: ColorState): ColorState {
  const meta = tr.getMeta(key) as Meta | undefined
  if (!tr.docChanged && !meta) return value
  const doc = tr.doc
  let state: ColorState = value
  const redo = new Set<number>()
  let prev = value.blocks
  if (tr.docChanged) {
    const mapped = new Map<number, Block>()
    let decorations = value.decorations.map(tr.mapping, doc)
    for (const [pos, b] of value.blocks) {
      const r = tr.mapping.mapResult(pos, 1)
      const node = r.deleted ? null : doc.nodeAt(r.pos)
      if (!node || !isCodeBlock(node)) {
        // No longer a code block (made a paragraph, say): its picker and shapes go.
        if (node) decorations = decorations.remove(decorations.find(r.pos, r.pos + node.nodeSize, (spec) => spec.picker === true || spec.shape !== undefined))
        continue
      }
      const window = b.window && ([tr.mapping.map(b.window[0], -1), tr.mapping.map(b.window[1], 1)] as const)
      mapped.set(r.pos, window === b.window ? b : { colors: b.colors, window })
    }
    prev = mapped
    const v = value.visible
    state = { ...value, decorations, visible: [tr.mapping.map(v[0], -1), tr.mapping.map(v[1], 1)] }
    for (const pos of touched(tr)) redo.add(pos)
  }
  if (meta && 'visible' in meta) {
    state = { ...state, visible: meta.visible }
    for (const pos of nearBlocks(doc, prev, meta.visible)) redo.add(pos)
  }
  if (meta && 'loaded' in meta) {
    // A grammar came in: color the blocks that were waiting for it.
    state = { ...state, wanted: state.wanted.filter((l) => l !== meta.loaded) }
    for (const pos of prev.keys()) if (grammarOf(doc.nodeAt(pos)?.attrs.language) === meta.loaded) redo.add(pos)
  }
  const blocks = new Map<number, Block>()
  for (const [pos, b] of prev) if (!redo.has(pos)) blocks.set(pos, b)
  for (const pos of redo) {
    const node = doc.nodeAt(pos)
    if (node && isCodeBlock(node)) state = update(state, doc, pos, node, prev.get(pos), blocks)
  }
  return { ...state, blocks }
}

/* -------------------------------- painting ------------------------------------ */

/*
 * One highlight for each color of the palette, named after its first scope
 * (`::highlight(hljs-keyword)`), shared by every editor on the page. A
 * stretch is painted in the color of its innermost class that has one, as
 * the outputs' nested spans are.
 */
const PAINT_OF = new Map<string, string>(TOKEN_COLORS.flatMap(([scopes]) => scopes.map((s): [string, string] => [`hljs-${s}`, `hljs-${scopes[0]}`])))
const paintMemo = new Map<string, string | null>()

function paintOf(cls: string): string | null {
  let paint = paintMemo.get(cls)
  if (paint === undefined) {
    paint = null
    const classes = cls.split(' ')
    for (let i = classes.length - 1; i >= 0 && !paint; i--) paint = PAINT_OF.get(classes[i]) ?? null
    paintMemo.set(cls, paint)
  }
  return paint
}

const HIGHLIGHT_CSS = TOKEN_COLORS.map(([scopes, color]) => `::highlight(hljs-${scopes[0]}) { color: ${color}; }`).join('\n')

type Paints = Map<string, Highlight>

/** The page's highlights, made once; null where the browser has no Highlight API. */
function paintsOf(doc: Document): Paints | null {
  const win = doc.defaultView as (Window & typeof globalThis) | null
  const registry = win?.CSS?.highlights
  if (!win || !registry || typeof win.Highlight !== 'function') return null
  const out: Paints = new Map()
  for (const [scopes] of TOKEN_COLORS) {
    const name = `hljs-${scopes[0]}`
    let h = registry.get(name)
    if (!h) {
      h = new win.Highlight()
      registry.set(name, h)
    }
    out.set(name, h)
  }
  return out
}

/** The text nodes of the code block at `pos`, in order, leaving out its picker. */
function textNodes(view: EditorView, pos: number): Text[] {
  const dom = view.nodeDOM(pos) as HTMLElement | null
  const out: Text[] = []
  const walk = (el: Node): void => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) out.push(n as Text)
      else if (n.nodeType === 1 && (n as HTMLElement).contentEditable !== 'false') walk(n)
    }
  }
  if (dom) walk(dom)
  return out
}

interface PaintedBlock {
  from: number
  to: number
  nodes: Text[]
  ranges: [Highlight, AbstractRange][]
}

/** Paints each colored block's colored lines, and paints them again when they or its DOM change. */
class Painter {
  private painted = new Map<Colors, PaintedBlock>()
  private readonly paints: Paints | null

  constructor(private readonly view: EditorView) {
    this.paints = paintsOf(view.dom.ownerDocument)
  }

  sync(state: ColorState): void {
    if (!this.paints) return
    const next = new Map<Colors, PaintedBlock>()
    for (const [pos, b] of state.blocks) {
      if (!b.colors || !b.window) continue
      const from = b.window[0] - pos - 1
      const to = b.window[1] - pos - 1
      const nodes = textNodes(this.view, pos)
      const was = this.painted.get(b.colors)
      if (was && was.from === from && was.to === to && was.nodes.length === nodes.length && was.nodes.every((n, i) => n === nodes[i])) {
        next.set(b.colors, was)
        this.painted.delete(b.colors)
        continue
      }
      const p = this.paint(b.colors, from, to, nodes)
      if (p) next.set(b.colors, p)
    }
    for (const p of this.painted.values()) this.erase(p)
    this.painted = next
  }

  private paint(colors: Colors, from: number, to: number, nodes: Text[]): PaintedBlock | null {
    // The DOM must hold the text the colors are for (it may not, mid-composition).
    let length = 0
    for (const n of nodes) length += n.data.length
    if (length !== colors.text.length) return null
    const doc = this.view.dom.ownerDocument
    const win = doc.defaultView as (Window & typeof globalThis) | null
    const Static = win && typeof win.StaticRange === 'function' ? win.StaticRange : null
    const ranges: [Highlight, AbstractRange][] = []
    let ni = 0
    let base = 0
    const at = (offset: number): [Text, number] => {
      while (ni < nodes.length - 1 && base + nodes[ni].data.length < offset) base += nodes[ni++].data.length
      return [nodes[ni], offset - base]
    }
    for (const [f, t, cls] of tokensIn(colors, from, to)) {
      const paint = paintOf(cls)
      const h = paint && this.paints!.get(paint)
      if (!h) continue
      const [startContainer, startOffset] = at(f)
      const [endContainer, endOffset] = at(t)
      let range: AbstractRange
      if (Static) range = new Static({ startContainer, startOffset, endContainer, endOffset })
      else {
        const r = doc.createRange()
        r.setStart(startContainer, startOffset)
        r.setEnd(endContainer, endOffset)
        range = r
      }
      h.add(range)
      ranges.push([h, range])
    }
    return { from, to, nodes, ranges }
  }

  private erase(p: PaintedBlock): void {
    for (const [h, range] of p.ranges) h.delete(range)
  }

  destroy(): void {
    for (const p of this.painted.values()) this.erase(p)
    this.painted.clear()
  }
}

/** The element the editor scrolls in: the nearest one that scrolls, else the page. */
function scrollerOf(view: EditorView): HTMLElement | null {
  for (let el = view.dom.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if (overflowY === 'auto' || overflowY === 'scroll') return el
  }
  return null
}

/**
 * The doc position of the text at a point, or null. The browser's caret at
 * the point, not ProseMirror's posAtCoords: when that finds no caret it
 * measures the text a character at a time, seconds in a 5,000-line block.
 */
function posAtPoint(view: EditorView, x: number, y: number): number | null {
  const doc = view.dom.ownerDocument as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  let node: Node | null = null
  let offset = 0
  if (typeof doc.caretPositionFromPoint === 'function') {
    const p = doc.caretPositionFromPoint(x, y)
    if (p) ({ offsetNode: node, offset } = p)
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const r = doc.caretRangeFromPoint(x, y)
    if (r) ({ startContainer: node, startOffset: offset } = r)
  }
  if (!node || !view.dom.contains(node)) return null
  try {
    return view.posAtDOM(node, offset)
  } catch {
    return null
  }
}

/** The doc positions at the top and bottom of what is on screen, or null when that cannot be told. */
function visibleRange(view: EditorView, scroller: HTMLElement | null): [number, number] | null {
  const win = view.dom.ownerDocument.defaultView
  if (!win) return null
  const box = scroller?.getBoundingClientRect() ?? { top: 0, bottom: win.innerHeight }
  const r = view.dom.getBoundingClientRect()
  const top = Math.max(box.top, r.top, 0) + 2
  const bottom = Math.min(box.bottom, r.bottom, win.innerHeight) - 2
  if (bottom <= top || r.width < 2) return null
  // Across the middle, where the text is (a line shorter than that puts the caret at its end).
  const x = r.left + r.width / 2
  const a = posAtPoint(view, x, top)
  const b = posAtPoint(view, x, bottom)
  if (a === null || b === null) return null
  return [Math.min(a, b), Math.max(a, b)]
}

/** The palette, once per page: the same rules the pdf and html shell print, and the same colors as highlights. */
function addStyles(doc: Document): void {
  if (doc.getElementById('code-color-css')) return
  const style = doc.createElement('style')
  style.id = 'code-color-css'
  style.textContent = `${HLJS_CSS}\n${HIGHLIGHT_CSS}\n`
  doc.head.append(style)
}

/** The plugin's key, for tests that tell it what is on screen (`{ visible: [from, to] }`). */
export const codeColorKey = key

export const CodeColor = Extension.create({
  name: 'codeColor',
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
            return openPickerIn(view.nodeDOM($from.before(d)) as HTMLElement | null)
          }
          return false
        },
    }
  },
  addKeyboardShortcuts() {
    return { 'Mod-Alt-l': () => this.editor.commands.focusCodeLanguage() }
  },
  addProseMirrorPlugins: () => [
    new Plugin<ColorState>({
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
        const painter = new Painter(view)
        // Each wanted grammar is asked for once; when it is in, its blocks are colored.
        const asked = new Set<string>()
        const load = (state: EditorState): void => {
          for (const language of key.getState(state)?.wanted ?? []) {
            if (asked.has(language)) continue
            asked.add(language)
            void loadGrammar(language).then((ok) => {
              if (ok && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, { loaded: language }).setMeta('addToHistory', false))
            })
          }
        }
        // What is on screen, measured once the page is laid out: told to the
        // state only when it colors other lines than now.
        // The editor may be made before it is put in the page (Tiptap's React
        // view moves it there), so the scroller is looked for when measuring,
        // and scrolling is heard from anywhere in the page.
        const doc = view.dom.ownerDocument
        const win = doc.defaultView
        let frame = 0
        const measure = (): void => {
          frame = 0
          if (view.isDestroyed || !view.dom.isConnected) return
          const visible = visibleRange(view, scrollerOf(view))
          if (visible && movesWindows(view.state, visible)) view.dispatch(view.state.tr.setMeta(key, { visible }).setMeta('addToHistory', false))
        }
        const later = (): void => {
          if (!frame && win) frame = win.requestAnimationFrame(measure)
        }
        const onScroll = (e: Event): void => {
          const t = e.target
          if (t === doc || (t instanceof Node && t.contains(view.dom))) later()
        }
        doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
        win?.addEventListener('resize', later)
        const sync = (state: EditorState): void => {
          const s = key.getState(state)
          if (s) painter.sync(s)
          load(state)
          later()
        }
        sync(view.state)
        return {
          update: (v, prevState) => {
            if (key.getState(v.state) !== key.getState(prevState)) sync(v.state)
          },
          destroy: () => {
            if (frame) win?.cancelAnimationFrame(frame)
            doc.removeEventListener('scroll', onScroll, { capture: true })
            win?.removeEventListener('resize', later)
            painter.destroy()
            closePicker()
          },
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
  const titles = new Map(GRAMMARS.map(([name, title]) => [name, title]))
  // hljs names HTML/XML "HTML, XML"; one name reads better in a list.
  const label = (name: string): string => titles.get(name)!.split(',')[0].trim()
  const all = GRAMMARS.map(([name]) => name).filter((n) => n !== 'plaintext')
  const common = COMMON.filter((n) => all.includes(n))
  const rest = all.filter((n) => !common.includes(n)).sort((a, b) => label(a).localeCompare(label(b)))
  languages = [
    { value: '', label: 'Plain text', common: true },
    ...common.map((n) => ({ value: n, label: label(n), common: true })),
    ...rest.map((n) => ({ value: n, label: label(n), common: false })),
  ]
  return languages
}
