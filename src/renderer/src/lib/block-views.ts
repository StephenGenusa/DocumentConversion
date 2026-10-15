import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { DRAWN_KINDS, type BlockKind } from '../../../core/rendered-blocks'
import { renderClient, type BlockAnswer, type BlockPicture, type BlockRequest, type DrawPriority } from './render-client'

/*
 * Diagrams and formulas drawn in the editor (spec B11, B13).
 *
 * The document holds only source (the B1 form); pictures exist only here, in
 * the node views, as <img> elements whose src is a data URI of SVG the main
 * process has sanitised. Engine markup is never put into this page's DOM.
 *
 *   diagramBlock, mathBlock   the picture, or, while the cursor is inside
 *                             the block (edit mode), the source in monospace
 *                             with a live preview under it, redrawn 400 ms
 *                             after typing stops. Click or Enter opens it;
 *                             Escape or clicking away closes it. A block that
 *                             cannot be drawn shows its source with the
 *                             engine's message under it.
 *   mathInline                the picture on the text baseline; click or
 *                             Enter opens a small popover with the TeX and a
 *                             preview. Enter commits, Escape cancels.
 *
 * A kind this version has no engine for (TeX until step 18) shows its source, as conversions keep it, and edits the same way
 * without a preview: when the engine lands in DRAWN_KINDS the editor draws it
 * with no change here.
 *
 * Drawing is lazy: a block is drawn when it scrolls into view, with a
 * placeholder of its last known size (or a neutral box) until then, and the
 * blocks either side of it are asked for at the host's lowest priority.
 *
 * The source is edited as ordinary document content (the block's text, or the
 * inline atom's `tex` attribute), so every change is a transaction and undo
 * and redo work. Edit mode itself is not state of its own: it is "the
 * selection is inside this block", shown with a decoration.
 */

const PREVIEW_DELAY_MS = 400

/** Diagram starters (spec B13): enough for the live preview to show something at once. */
export const DIAGRAM_STARTERS = { mermaid: 'flowchart LR\n  A --> B', dot: 'digraph { a -> b }' } as const

const BLOCK_TYPES = new Set(['diagramBlock', 'mathBlock'])
const isBlock = (node: PMNode | null | undefined): node is PMNode => !!node && BLOCK_TYPES.has(node.type.name)

/* -------------------------------- configuration ------------------------------- */

/** Report when an element is on screen. Replaced in tests, where nothing scrolls. */
export type Watch = (el: HTMLElement, onChange: (visible: boolean) => void) => () => void

let drawable = (kind: BlockKind): boolean => DRAWN_KINDS.has(kind)
let watch: Watch = observeVisibility

/** Tests: pretend an engine exists, or drive visibility by hand. */
export function configureBlockViews(opts: { drawable?: (kind: BlockKind) => boolean; watch?: Watch } = {}): void {
  drawable = opts.drawable ?? ((kind) => DRAWN_KINDS.has(kind))
  watch = opts.watch ?? observeVisibility
}

const watched = new Map<Element, (visible: boolean) => void>()
let observer: IntersectionObserver | null = null

/**
 * One observer for every block. Its root is the viewport: an element inside
 * the edit pane's scrolling box only intersects it where the box shows it,
 * so "visible" means really on screen.
 */
function observeVisibility(el: HTMLElement, onChange: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    queueMicrotask(() => onChange(true))
    return () => {}
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting)
  })
  watched.set(el, onChange)
  observer.observe(el)
  return () => {
    watched.delete(el)
    observer?.unobserve(el)
  }
}

/* ---------------------------------- the views --------------------------------- */

/** Every drawn view of one editor, for prefetching a visible block's neighbours. */
const viewsOf = new WeakMap<EditorView, Set<DrawnView>>()
const NEIGHBOURS_AFTER = 6
const NEIGHBOURS_BEFORE = 2

abstract class DrawnView {
  protected visible = false
  protected destroyed = false
  /** The drawing (or message) for the source as it is now, once known. */
  protected answer: BlockAnswer | undefined
  /** The last picture shown, kept on screen while a changed source is drawn. */
  protected lastPicture: BlockPicture | undefined
  private asked: DrawPriority | null = null
  private unwatch: () => void = () => {}

  constructor(
    protected node: PMNode,
    protected view: EditorView,
    protected getPos: () => number | undefined,
  ) {}

  abstract request(): BlockRequest

  /** Start watching once the DOM exists. */
  protected start(el: HTMLElement): void {
    let set = viewsOf.get(this.view)
    if (!set) viewsOf.set(this.view, (set = new Set()))
    set.add(this)
    this.answer = this.known()
    if (this.answer && 'uri' in this.answer) this.lastPicture = this.answer
    this.unwatch = watch(el, (visible) => {
      if (this.destroyed) return
      this.visible = visible
      if (visible) {
        this.draw('visible')
        this.prefetchNeighbours()
      }
    })
  }

  protected canDraw(): boolean {
    return drawable(this.request().kind)
  }

  private known(): BlockAnswer | undefined {
    const req = this.request()
    if (!drawable(req.kind)) return { unavailable: true }
    return renderClient().known(req)
  }

  /** Ask for the current source's drawing, unless it is known or already asked for as urgently. */
  draw(priority: DrawPriority): void {
    if (this.destroyed) return
    const req = this.request()
    if (!drawable(req.kind)) {
      this.setAnswer({ unavailable: true })
      return
    }
    const hit = renderClient().known(req)
    if (hit) {
      this.setAnswer(hit)
      return
    }
    if (this.asked === 'visible' || this.asked === priority) return
    this.asked = priority
    void renderClient()
      .draw(req, priority)
      .then((answer) => {
        if (this.destroyed || this.request().source !== req.source || this.request().kind !== req.kind) return
        this.asked = null
        this.setAnswer(answer)
      })
  }

  /** The source changed: what was asked for no longer applies. */
  protected sourceChanged(): void {
    this.asked = null
    this.answer = this.known()
  }

  private setAnswer(answer: BlockAnswer): void {
    this.answer = answer
    if ('uri' in answer) this.lastPicture = answer
    this.show()
  }

  private prefetchNeighbours(): void {
    const all = [...(viewsOf.get(this.view) ?? [])]
      .map((v) => ({ v, pos: v.getPos() }))
      .filter((e): e is { v: DrawnView; pos: number } => typeof e.pos === 'number')
      .sort((a, b) => a.pos - b.pos)
    const at = all.findIndex((e) => e.v === this)
    if (at < 0) return
    for (const { v } of [...all.slice(at + 1, at + 1 + NEIGHBOURS_AFTER), ...all.slice(Math.max(0, at - NEIGHBOURS_BEFORE), at)]) {
      if (!v.visible && !v.answer) v.draw('prefetch')
    }
  }

  abstract show(): void

  protected stop(): void {
    this.destroyed = true
    this.unwatch()
    viewsOf.get(this.view)?.delete(this)
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}

/** An <img> for a picture, reusing the one there when it can. */
function pictureInto(box: HTMLElement, picture: { uri: string; width: number; height: number }, alt: string): HTMLImageElement {
  let img = box.firstElementChild instanceof HTMLImageElement ? box.firstElementChild : null
  if (!img || box.childElementCount !== 1) {
    box.replaceChildren()
    img = el('img', 'rb__img', { draggable: 'false' })
    box.append(img)
  }
  if (img.getAttribute('src') !== picture.uri) img.setAttribute('src', picture.uri)
  img.setAttribute('width', String(picture.width))
  img.setAttribute('height', String(picture.height))
  img.alt = alt
  return img
}

const KIND_LABEL: Record<BlockKind, string> = { mermaid: 'Mermaid diagram', dot: 'Graphviz diagram', math: 'TeX formula' }

/** diagramBlock and mathBlock: picture, or source with a live preview. */
class BlockView extends DrawnView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private picture: HTMLElement
  private message: HTMLElement
  private bar: HTMLElement
  private preview: HTMLElement
  private editing = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, decorations: readonly Decoration[]) {
    super(node, view, getPos)
    this.dom = el('div', `rb rb--${node.type.name === 'mathBlock' ? 'math' : 'diagram'}`)
    this.bar = el('div', 'rb__bar', { contenteditable: 'false' })
    const pre = el('pre', 'rb__source', { spellcheck: 'false' })
    this.contentDOM = el('code', '')
    pre.append(this.contentDOM)
    this.picture = el('div', 'rb__picture', { contenteditable: 'false' })
    this.message = el('div', 'rb__message', { contenteditable: 'false', role: 'status' })
    this.preview = el('div', 'rb__preview', { contenteditable: 'false', 'aria-live': 'polite' })
    this.dom.append(this.bar, pre, this.message, this.picture, this.preview)
    // Click the picture to edit (spec B11). Handled here, not by ProseMirror,
    // which would select the whole block instead.
    this.picture.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      this.openEditing()
    })
    this.editing = decorations.some((d) => (d.spec as { rbEditing?: boolean }).rbEditing)
    this.start(this.dom)
    this.show()
  }

  request(): BlockRequest {
    return {
      kind: this.node.type.name === 'mathBlock' ? 'math' : (this.node.attrs.language as BlockKind),
      source: this.node.textContent,
      display: true,
    }
  }

  private openEditing(): void {
    const pos = this.getPos()
    if (typeof pos !== 'number') return
    const end = pos + 1 + this.node.content.size
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)))
    this.view.focus()
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false
    const before = this.request()
    this.node = node
    const wasEditing = this.editing
    this.editing = decorations.some((d) => (d.spec as { rbEditing?: boolean }).rbEditing)
    const now = this.request()
    if (now.source !== before.source || now.kind !== before.kind) {
      this.sourceChanged()
      if (this.editing && !this.answer) {
        // Live preview: redraw once typing pauses.
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.draw('visible'), PREVIEW_DELAY_MS)
      } else if (this.visible) this.draw('visible')
    } else if (wasEditing && !this.editing && this.timer !== undefined) {
      // Closed before the preview caught up: draw the final source now.
      clearTimeout(this.timer)
      this.timer = undefined
      this.draw('visible')
    } else if (this.editing && !wasEditing && !this.answer) this.draw('visible')
    this.show()
    return true
  }

  show(): void {
    const req = this.request()
    const can = this.canDraw()
    const answer = this.answer
    const state = this.editing
      ? 'editing'
      : !can
        ? 'source'
        : answer && 'uri' in answer
          ? 'picture'
          : answer && 'error' in answer
            ? 'error'
            : 'waiting'
    this.dom.dataset.state = state
    this.dom.classList.toggle('rb--nopreview', !can)
    const alt = req.kind === 'math' ? req.source : 'Diagram'

    if (state === 'editing') {
      this.bar.textContent = `${KIND_LABEL[req.kind]} · Esc to finish`
      const stale = this.lastPicture
      if (!can) this.preview.replaceChildren()
      else if (answer && 'uri' in answer) pictureInto(this.preview, answer, alt).classList.remove('rb__img--stale')
      else if (answer && 'error' in answer) this.preview.replaceChildren(errorLine(answer.error))
      else if (stale) pictureInto(this.preview, stale, alt).classList.add('rb__img--stale')
      else if (!req.source.trim()) this.preview.replaceChildren()
      else this.preview.replaceChildren(placeholder(renderClient().sizeOf(req), req.kind))
    }
    if (state === 'picture' && answer && 'uri' in answer) pictureInto(this.picture, answer, alt)
    if (state === 'waiting') {
      const old = this.lastPicture
      if (old) pictureInto(this.picture, old, alt)
      else this.picture.replaceChildren(placeholder(renderClient().sizeOf(req), req.kind))
    }
    this.message.replaceChildren(...(state === 'error' && answer && 'error' in answer ? [errorLine(answer.error)] : []))
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode')
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode')
  }

  stopEvent(e: Event): boolean {
    // The picture's own click handler; and nothing in the preview or the bar
    // is for ProseMirror (a click there must not move the cursor out).
    const t = e.target as Node | null
    if (!t) return false
    if (this.preview.contains(t) || this.bar.contains(t)) {
      if (e.type === 'mousedown') e.preventDefault()
      return true
    }
    return e.type === 'mousedown' && this.picture.contains(t)
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    if (m.type === 'selection') return false
    return !this.contentDOM.contains(m.target)
  }

  destroy(): void {
    clearTimeout(this.timer)
    this.stop()
  }
}

function errorLine(message: string): HTMLElement {
  const line = el('span', 'rb__error')
  line.textContent = message
  return line
}

/** A box the size the block was last drawn at, or a neutral one. */
function placeholder(size: { width: number; height: number } | undefined, kind: BlockKind): HTMLElement {
  const box = el('span', `rb__placeholder${size ? '' : ' rb__placeholder--unknown'}`, { 'aria-label': 'Drawing…', role: 'img' })
  if (size) {
    box.style.width = `${size.width}px`
    box.style.aspectRatio = `${size.width} / ${size.height}`
  } else box.style.height = kind === 'math' ? '3rem' : '7.5rem'
  return box
}

/* ------------------------------ inline formulas ------------------------------- */

type InlineOpen = { open: number | null; fresh: boolean }
const inlineKey = new PluginKey<InlineOpen>('mathInlineOpen')

/** Open (or close, with null) the popover of the inline formula at `pos`. */
export function setInlineOpen(tr: Transaction, pos: number | null, fresh = false): Transaction {
  return tr.setMeta(inlineKey, { open: pos, fresh })
}

class InlineView extends DrawnView implements NodeView {
  dom: HTMLElement
  private face: HTMLElement
  private pop: HTMLElement | null = null
  private input: HTMLInputElement | null = null
  private popPreview: HTMLElement | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private previewTex = ''
  private fresh = false

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, decorations: readonly Decoration[]) {
    super(node, view, getPos)
    this.dom = el('span', 'rm', { contenteditable: 'false' })
    this.face = el('span', 'rm__face')
    this.dom.append(this.face)
    this.face.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || this.pop) return
      e.preventDefault()
      const pos = this.getPos()
      if (typeof pos === 'number') this.view.dispatch(setInlineOpen(this.view.state.tr, pos))
    })
    this.start(this.dom)
    this.show()
    this.syncPopover(decorations)
  }

  request(): BlockRequest {
    return { kind: 'math', source: String(this.node.attrs.tex), display: false }
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false
    const changed = node.attrs.tex !== this.node.attrs.tex
    this.node = node
    if (changed) {
      this.sourceChanged()
      if (this.visible) this.draw('visible')
    }
    this.show()
    this.syncPopover(decorations)
    return true
  }

  show(): void {
    const req = this.request()
    const answer = this.answer
    const can = this.canDraw()
    const state = !can ? 'source' : answer && 'uri' in answer ? 'picture' : answer && 'error' in answer ? 'error' : 'waiting'
    this.dom.dataset.state = state
    if (state === 'picture' && answer && 'uri' in answer) {
      const img = pictureInto(this.face, answer, req.source)
      img.style.verticalAlign = answer.baseline !== undefined ? `${-answer.baseline}px` : 'middle'
      return
    }
    const size = renderClient().sizeOf(req)
    if (state === 'waiting' && size) {
      const box = placeholder(size, 'math')
      box.classList.add('rm__placeholder')
      this.face.replaceChildren(box)
      return
    }
    // Source: no engine yet, not drawn yet, or the engine's message on hover.
    const code = el('code', 'rm__src')
    code.textContent = req.source || ' '
    if (state === 'error' && answer && 'error' in answer) code.title = answer.error
    this.face.replaceChildren(code)
  }

  private syncPopover(decorations: readonly Decoration[]): void {
    const spec = decorations.map((d) => d.spec as { rbOpen?: boolean; fresh?: boolean }).find((s) => s.rbOpen)
    if (spec && !this.pop) this.openPopover(Boolean(spec.fresh))
    else if (!spec && this.pop) this.closePopover()
  }

  private openPopover(fresh: boolean): void {
    this.fresh = fresh
    const pop = el('span', 'rm-pop', { role: 'dialog', 'aria-label': 'Edit formula' })
    const input = el('input', 'rm-pop__input', { type: 'text', spellcheck: 'false', 'aria-label': 'TeX', placeholder: 'TeX, e.g. x^2 + y^2' })
    input.value = String(this.node.attrs.tex)
    const preview = el('span', 'rm-pop__preview', { 'aria-live': 'polite' })
    const hint = el('span', 'rm-pop__hint')
    hint.textContent = 'Enter to apply · Esc to cancel'
    pop.append(input, preview, hint)
    this.dom.append(pop)
    this.dom.classList.add('rm--open')
    this.pop = pop
    this.input = input
    this.popPreview = preview
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.finish(true, true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.finish(false, true)
      }
    })
    input.addEventListener('input', () => {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.drawPreview(), PREVIEW_DELAY_MS)
    })
    // Clicking away commits, as leaving any other field would.
    input.addEventListener('blur', () => {
      if (this.pop) this.finish(true, false)
    })
    this.drawPreview()
    requestAnimationFrame(() => {
      if (this.input !== input) return
      input.focus()
      input.select()
      // Keep it inside the pane: shift it left at the right edge, and put it
      // above the formula when the pane has no room for it below.
      const pane = (this.view.dom.parentElement ?? this.view.dom).getBoundingClientRect()
      let box = pop.getBoundingClientRect()
      if (box.right > pane.right) pop.style.left = `${Math.min(0, pane.right - box.right)}px`
      if (box.bottom > pane.bottom) {
        const face = this.dom.getBoundingClientRect()
        if (face.top - pane.top > box.height + 8) pop.classList.add('rm-pop--above')
        box = pop.getBoundingClientRect()
        if (box.bottom > pane.bottom || box.top < pane.top) pop.scrollIntoView({ block: 'nearest' })
      }
    })
  }

  private drawPreview(): void {
    const preview = this.popPreview
    if (!preview || !this.input) return
    const tex = this.input.value
    this.previewTex = tex
    if (!this.canDraw() || !tex.trim()) {
      preview.replaceChildren()
      preview.hidden = true
      return
    }
    preview.hidden = false
    const req: BlockRequest = { kind: 'math', source: tex, display: false }
    const put = (a: BlockAnswer): void => {
      if (this.popPreview !== preview || this.previewTex !== tex) return
      if ('uri' in a) pictureInto(preview, a, tex)
      else if ('error' in a) preview.replaceChildren(errorLine(a.error))
    }
    const hit = renderClient().known(req)
    if (hit) put(hit)
    else void renderClient().draw(req, 'visible').then(put)
  }

  /** Close the popover, keeping the typed TeX (commit) or not. An empty formula is removed. */
  private finish(commit: boolean, refocus: boolean): void {
    const input = this.input
    if (!input) return
    const tex = commit ? input.value : String(this.node.attrs.tex)
    const fresh = this.fresh
    this.closePopover()
    const pos = this.getPos()
    if (typeof pos !== 'number') return
    const { state } = this.view
    let tr = setInlineOpen(state.tr, null)
    if (!tex.trim()) {
      tr = tr.delete(pos, pos + 1)
      if (fresh) tr.setMeta('addToHistory', false)
      if (refocus) tr.setSelection(TextSelection.create(tr.doc, pos))
    } else {
      if (tex !== this.node.attrs.tex) {
        tr = tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, tex })
        // A new formula's TeX belongs to its insertion: one undo removes both.
        if (fresh) tr.setMeta('addToHistory', false)
      }
      if (refocus) tr.setSelection(TextSelection.create(tr.doc, pos + 1))
    }
    this.view.dispatch(tr)
    if (refocus) this.view.focus()
  }

  private closePopover(): void {
    clearTimeout(this.timer)
    const pop = this.pop
    this.pop = null
    this.input = null
    this.popPreview = null
    this.dom.classList.remove('rm--open')
    pop?.remove()
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode')
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode')
  }

  stopEvent(e: Event): boolean {
    const t = e.target as Node | null
    if (t && this.pop?.contains(t)) return true
    return e.type === 'mousedown' && !!t && this.face.contains(t)
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    clearTimeout(this.timer)
    this.closePopover()
    this.stop()
  }
}

/* ------------------------------ the node views -------------------------------- */

type ViewProps = { node: PMNode; view: EditorView; getPos: () => number | undefined; decorations: readonly Decoration[] }

export const blockNodeView = (p: ViewProps): NodeView => new BlockView(p.node, p.view, p.getPos, p.decorations)
export const inlineNodeView = (p: ViewProps): NodeView => new InlineView(p.node, p.view, p.getPos, p.decorations)

/* ---------------------------- edit mode and commands -------------------------- */

/** The rendered block the selection is inside, as its position and node. */
function blockAround(state: EditorState): { pos: number; node: PMNode } | null {
  const { $from, $to } = state.selection
  if (state.selection instanceof NodeSelection || $from.depth === 0 || !isBlock($from.parent) || $from.parent !== $to.parent) return null
  return { pos: $from.before(), node: $from.parent }
}

/**
 * The block open in edit mode, by position: the block the selection is in,
 * once the selection has been moved there. A document that merely starts
 * with a diagram (where the initial cursor sits) does not open it.
 */
const editKey = new PluginKey<number | null>('renderedBlockEditing')

function editingAt(state: EditorState): { pos: number; node: PMNode } | null {
  const pos = editKey.getState(state)
  if (pos === null || pos === undefined) return null
  const node = state.doc.nodeAt(pos)
  return isBlock(node) ? { pos, node } : null
}

/** Focus the editor at its start, selecting (not opening) a diagram or formula that comes first. */
export function focusAtStart(editor: { state: EditorState; view: EditorView; commands: { focus: (p: 'start') => boolean } }): void {
  const first = editor.state.doc.firstChild
  if (isBlock(first)) {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    // As TipTap's own focus does: after React has put the editor on the page.
    requestAnimationFrame(() => editor.view.focus())
  } else editor.commands.focus('start')
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    renderedBlocks: {
      /** An inline formula at the cursor (the selection's text becomes its TeX), with its popover open. */
      insertMathInline: () => ReturnType
      /** A display formula after the current block, open in source mode. */
      insertMathBlock: () => ReturnType
      /** A diagram after the current block, open in source mode, with a starter. */
      insertDiagram: (language: 'mermaid' | 'dot') => ReturnType
    }
  }
}

/** Put `node` after the block the cursor is in (or in place of an empty paragraph) and the cursor at its end. */
function insertBlockAfter(state: EditorState, tr: Transaction, node: PMNode): void {
  const sel = state.selection
  let at: number
  if (sel instanceof NodeSelection && sel.node.isBlock) at = sel.to
  else {
    const $to = sel.$to
    const depth = $to.depth > 0 ? $to.depth : 0
    const parent = $to.node(depth)
    if (depth > 0 && parent.type.name === 'paragraph' && parent.content.size === 0) {
      const from = $to.before(depth)
      tr.replaceWith(from, from + parent.nodeSize, node)
      tr.setSelection(TextSelection.create(tr.doc, from + 1 + node.content.size))
      return
    }
    at = depth > 0 ? $to.after(depth) : $to.pos
  }
  tr.insert(at, node)
  tr.setSelection(TextSelection.create(tr.doc, at + 1 + node.content.size))
}

export const RenderedBlocks = Extension.create({
  name: 'renderedBlocks',
  // Ahead of StarterKit's own Enter handling (lists, code blocks).
  priority: 200,

  addCommands() {
    return {
      insertMathInline:
        () =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.nodes.mathInline
          if (!type) return false
          if (!dispatch) return true
          const { from, to } = state.selection
          const tex = state.doc.textBetween(from, to, ' ')
          tr.replaceSelectionWith(type.create({ tex }), false)
          const pos = tr.selection.from - 1
          if (tr.doc.nodeAt(pos)?.type !== type) return false
          setInlineOpen(tr, pos, tex === '')
          dispatch(tr.scrollIntoView())
          return true
        },
      insertMathBlock:
        () =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.nodes.mathBlock
          if (!type) return false
          if (dispatch) {
            insertBlockAfter(state, tr, type.create())
            dispatch(tr.scrollIntoView())
          }
          return true
        },
      insertDiagram:
        (language) =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.nodes.diagramBlock
          if (!type) return false
          if (dispatch) {
            insertBlockAfter(state, tr, type.create({ language }, state.schema.text(DIAGRAM_STARTERS[language])))
            dispatch(tr.scrollIntoView())
          }
          return true
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      // Spec B13; checked free of every installed binding (plan, Step 0).
      'Mod-Shift-m': () => this.editor.commands.insertMathInline(),
      'Mod-Alt-f': () => this.editor.commands.insertFootnote(),
      Enter: () => {
        const { state, view } = this.editor
        const sel = state.selection
        if (sel instanceof NodeSelection && isBlock(sel.node)) {
          view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, sel.from + 1 + sel.node.content.size)))
          return true
        }
        if (sel instanceof NodeSelection && sel.node.type.name === 'mathInline') {
          view.dispatch(setInlineOpen(state.tr, sel.from))
          return true
        }
        // A new line in the source, never a second block.
        if (blockAround(state)) {
          view.dispatch(state.tr.insertText('\n').scrollIntoView())
          return true
        }
        return false
      },
      Escape: () => {
        const { state, view } = this.editor
        const around = blockAround(state)
        if (!around) return false
        view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, around.pos)))
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: editKey,
        state: {
          init: () => null,
          apply(tr, prev, oldState, newState): number | null {
            const around = blockAround(newState)
            if (!around) return null
            const kept = prev === null ? null : tr.mapping.mapResult(prev)
            if (kept && !kept.deleted && kept.pos === around.pos) return around.pos
            // Entered: the selection moved into the block.
            return newState.selection.eq(oldState.selection) && !tr.docChanged ? null : around.pos
          },
        },
        props: {
          // Edit mode is the selection having moved inside the block.
          decorations(state) {
            const decos: Decoration[] = []
            const around = editingAt(state)
            if (around) decos.push(Decoration.node(around.pos, around.pos + around.node.nodeSize, {}, { rbEditing: true }))
            const open = inlineKey.getState(state)
            if (open && open.open !== null) {
              const n = state.doc.nodeAt(open.open)
              if (n?.type.name === 'mathInline') decos.push(Decoration.node(open.open, open.open + 1, {}, { rbOpen: true, fresh: open.fresh }))
            }
            return decos.length ? DecorationSet.create(state.doc, decos) : null
          },
          // Arrowing onto a drawn block selects it (Enter then opens it)
          // rather than dropping the cursor into its hidden source.
          handleKeyDown(view, event) {
            const dirs: Record<string, ['up' | 'down' | 'left' | 'right', number]> = {
              ArrowUp: ['up', -1],
              ArrowLeft: ['left', -1],
              ArrowDown: ['down', 1],
              ArrowRight: ['right', 1],
            }
            const d = dirs[event.key]
            if (!d || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
            const { state } = view
            const sel = state.selection
            if (!(sel instanceof TextSelection) || !sel.empty || blockAround(state) || sel.$head.depth === 0) return false
            if (!view.endOfTextblock(d[0])) return false
            const side = d[1] < 0 ? sel.$head.before() : sel.$head.after()
            const $side = state.doc.resolve(side)
            const next = d[1] < 0 ? $side.nodeBefore : $side.nodeAfter
            if (!isBlock(next)) return false
            view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, d[1] < 0 ? side - next.nodeSize : side)).scrollIntoView())
            return true
          },
        },
        // An empty block is removed when it closes (spec B13).
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((t) => t.selectionSet || t.docChanged)) return null
          const was = editingAt(oldState)
          if (!was) return null
          let pos: number | null = was.pos
          for (const t of transactions) {
            const r = t.mapping.mapResult(pos)
            pos = r.deleted ? null : r.pos
            if (pos === null) return null
          }
          const now = editingAt(newState)
          if (now && now.pos === pos) return null
          const node = newState.doc.nodeAt(pos)
          if (!isBlock(node) || node.content.size > 0) return null
          return newState.tr.delete(pos, pos + node.nodeSize)
        },
      }),
      new Plugin<InlineOpen>({
        key: inlineKey,
        state: {
          init: (): InlineOpen => ({ open: null, fresh: false }),
          apply(tr, value): InlineOpen {
            const meta = tr.getMeta(inlineKey) as { open: number | null; fresh: boolean } | undefined
            if (meta) return meta
            if (value.open === null || !tr.docChanged) return value
            const r = tr.mapping.mapResult(value.open, 1)
            return r.deleted ? { open: null, fresh: false } : { open: r.pos, fresh: value.fresh }
          },
        },
      }),
    ]
  },
})
