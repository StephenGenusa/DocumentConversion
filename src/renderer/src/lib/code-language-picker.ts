import type { EditorView } from '@tiptap/pm/view'
import { grammarName, GRAMMARS } from './code-grammars'
import { placeBeside } from './place-popover'

/*
 * The language picker of a code block: a small button in the block's top
 * corner showing its language, which opens a searchable list (the ARIA
 * combobox pattern: a text box that filters a listbox). Typing filters,
 * Up and Down move through what is left, Enter chooses, Escape goes back to
 * the code where the caret was. The list is the common languages, then the
 * rest by name; a filter matches names and aliases ("js", "py", "sh").
 *
 * The list is made when the picker opens, not for every block: a document
 * of many blocks carries one button each. It is fixed-positioned beside the
 * button, kept inside the pane and the window (place-popover.ts), so the
 * block's scrolling box does not clip it.
 */

export interface PickerLanguage {
  /** The `language` attr; '' for plain text. */
  value: string
  label: string
  common: boolean
}

interface PickerOptions {
  /** Every language, in the order shown with no filter. */
  languages: () => readonly PickerLanguage[]
  /** Set the block's language (one undo step) and go back to the code. */
  choose: (view: EditorView, blockPos: number, value: string) => void
}

const openers = new WeakMap<Element, () => void>()
let open: { close: (refocus: boolean) => void } | null = null
let ids = 0

/** The corner button of a block whose language is `value` (an alias already made its language). */
export function pickerDom(view: EditorView, getPos: () => number | undefined, value: string, options: PickerOptions): HTMLElement {
  const doc = view.dom.ownerDocument
  const wrap = doc.createElement('span')
  wrap.className = 'code-lang'
  wrap.contentEditable = 'false'
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'code-lang__button'
  const label = options.languages().find((l) => l.value === value)?.label ?? value
  button.textContent = label
  button.title = 'Code language'
  button.setAttribute('aria-label', `Code language: ${label}`)
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  button.dataset.value = value
  const show = (): void => {
    const at = getPos()
    if (at !== undefined) openPicker(view, button, at - 1, value, options)
  }
  openers.set(button, show)
  button.addEventListener('click', show)
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      show()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      view.focus()
    }
  })
  wrap.append(button)
  return wrap
}

/** Open the picker of the block whose DOM is `blockDom`; false when it has none. */
export function openPickerIn(blockDom: Element | null): boolean {
  const button = blockDom?.querySelector('.code-lang__button')
  const show = button && openers.get(button)
  if (!show) return false
  show()
  return true
}

/** Lower case, and nothing but letters and digits ("C++" and "c#" stay apart: + and # are kept). */
const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9+#]/g, '')

/**
 * How well a language matches what is typed, or 0: its name or an alias
 * that is it, then one that starts with it, then a word of its name that
 * starts with it, then one that has it anywhere.
 */
function score(lang: PickerLanguage, aliases: readonly string[], typed: string): number {
  const q = fold(typed)
  if (!q) return 1
  const names = [fold(lang.label), fold(lang.value), ...aliases.map(fold)]
  if (names.includes(q)) return 5
  if (names.some((n) => n.startsWith(q))) return 4
  if (lang.label.toLowerCase().split(/[\s,./()-]+/).some((w) => fold(w).startsWith(q))) return 3
  if (names.some((n) => n.includes(q))) return 2
  return 0
}

const ALIASES = new Map(GRAMMARS.map(([name, , aliases]) => [name, aliases]))

function openPicker(view: EditorView, button: HTMLButtonElement, blockPos: number, value: string, options: PickerOptions): void {
  open?.close(false)
  const doc = view.dom.ownerDocument
  const win = doc.defaultView
  const id = `code-lang-${++ids}`
  const all = [...options.languages()]
  // A language the outputs do not know is offered as itself, first.
  if (!all.some((l) => l.value === value)) all.unshift({ value, label: value, common: true })

  const pop = doc.createElement('div')
  pop.className = 'code-lang-pop'
  const input = doc.createElement('input')
  input.className = 'code-lang-pop__filter'
  input.type = 'text'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.placeholder = 'Filter languages'
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-label', 'Code language')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-expanded', 'true')
  input.setAttribute('aria-controls', `${id}-list`)
  const list = doc.createElement('ul')
  list.className = 'code-lang-pop__list'
  list.id = `${id}-list`
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Languages')
  const empty = doc.createElement('p')
  empty.className = 'code-lang-pop__empty'
  empty.textContent = 'No language by that name'
  empty.hidden = true
  pop.append(input, list, empty)

  let shown: { lang: PickerLanguage; el: HTMLElement }[] = []
  let active = -1
  const activate = (i: number, scroll = true): void => {
    if (shown[active]) shown[active].el.setAttribute('aria-selected', 'false')
    active = shown.length ? Math.max(0, Math.min(shown.length - 1, i)) : -1
    const a = shown[active]
    if (a) {
      a.el.setAttribute('aria-selected', 'true')
      input.setAttribute('aria-activedescendant', a.el.id)
      if (scroll) a.el.scrollIntoView({ block: 'nearest' })
    } else input.removeAttribute('aria-activedescendant')
  }
  const option = (lang: PickerLanguage, n: number): HTMLElement => {
    const li = doc.createElement('li')
    li.id = `${id}-${n}`
    li.className = 'code-lang-pop__option'
    li.setAttribute('role', 'option')
    li.setAttribute('aria-selected', 'false')
    li.dataset.value = lang.value
    li.textContent = lang.label
    if (lang.value === value) {
      li.classList.add('code-lang-pop__option--current')
      li.setAttribute('aria-current', 'true')
    }
    return li
  }
  const render = (): void => {
    const typed = input.value
    const scored = all.map((lang, i) => ({ lang, i, s: score(lang, ALIASES.get(lang.value) ?? [], typed) })).filter((x) => x.s > 0)
    // Typed: the best matches first, the common languages before the rest among equals.
    if (typed.trim()) scored.sort((a, b) => b.s - a.s || Number(b.lang.common) - Number(a.lang.common) || a.i - b.i)
    list.replaceChildren()
    shown = []
    let group: HTMLElement | null = null
    scored.forEach(({ lang }, n) => {
      const li = option(lang, n)
      shown.push({ lang, el: li })
      if (!typed.trim() && !lang.common) {
        if (!group) {
          // The rest, a group under a heading of its own (named for a screen reader by the group).
          const head = doc.createElement('div')
          head.className = 'code-lang-pop__heading'
          head.setAttribute('aria-hidden', 'true')
          head.textContent = 'More languages'
          group = doc.createElement('ul')
          group.className = 'code-lang-pop__group'
          group.setAttribute('role', 'group')
          group.setAttribute('aria-label', 'More languages')
          const holder = doc.createElement('li')
          holder.setAttribute('role', 'presentation')
          holder.append(head, group)
          list.append(holder)
        }
        group.append(li)
      } else list.append(li)
    })
    empty.hidden = shown.length > 0
    // With nothing typed the block's language is where the list starts; typed, the best match.
    activate(typed.trim() ? 0 : Math.max(0, shown.findIndex((x) => x.lang.value === value)))
  }

  const close = (refocus: boolean): void => {
    if (open?.close !== close) return
    open = null
    if (frame) win?.cancelAnimationFrame(frame)
    doc.removeEventListener('scroll', onScroll, { capture: true })
    doc.removeEventListener('pointerdown', onOutside, { capture: true })
    win?.removeEventListener('resize', later)
    button.setAttribute('aria-expanded', 'false')
    pop.remove()
    if (refocus && !view.isDestroyed) view.focus()
  }
  const choose = (i: number): void => {
    const lang = shown[i]?.lang
    if (!lang) return
    close(false)
    if (!view.isDestroyed) options.choose(view, blockPos, lang.value)
  }

  input.addEventListener('input', render)
  input.addEventListener('keydown', (e) => {
    const page = Math.max(1, Math.floor(list.clientHeight / (shown[0]?.el.offsetHeight || 24)) - 1)
    if (e.key === 'ArrowDown') activate(active + 1)
    else if (e.key === 'ArrowUp') activate(active - 1)
    else if (e.key === 'PageDown') activate(active + page)
    else if (e.key === 'PageUp') activate(active - page)
    else if (e.key === 'Enter') choose(active)
    else if (e.key === 'Escape' || e.key === 'Tab') close(true)
    else return
    e.preventDefault()
    e.stopPropagation()
  })
  // Clicking an option chooses it; pressing it does not take the focus from the filter.
  list.addEventListener('mousedown', (e) => e.preventDefault())
  list.addEventListener('click', (e) => {
    const li = (e.target as Element).closest('[role=option]')
    const i = shown.findIndex((x) => x.el === li)
    if (i >= 0) choose(i)
  })
  list.addEventListener('mousemove', (e) => {
    const li = (e.target as Element).closest('[role=option]')
    const i = shown.findIndex((x) => x.el === li)
    if (i >= 0 && i !== active) activate(i, false)
  })
  // Leaving it (a click elsewhere, the focus moving away) closes it, changing nothing.
  const onOutside = (e: Event): void => {
    const t = e.target as Node
    if (!pop.contains(t) && t !== button) close(false)
  }
  input.addEventListener('blur', () => {
    win?.setTimeout(() => {
      if (open?.close === close && !pop.contains(doc.activeElement)) close(false)
    }, 0)
  })

  // Beside the button, inside the pane and the window; it follows the block as the pane scrolls.
  let frame = 0
  const place = (): void => {
    frame = 0
    if (!button.isConnected) return close(false)
    // A short pane may not hold a usable list: then it may reach past the pane, inside the window.
    placeBeside(pop, button, view.dom, { align: 'end', gap: 4, minHeight: 200 })
  }
  const later = (): void => {
    if (!frame && win) frame = win.requestAnimationFrame(place)
  }
  const onScroll = (e: Event): void => {
    if (!(e.target instanceof Node && pop.contains(e.target))) later()
  }

  open = { close }
  render()
  doc.body.append(pop)
  button.setAttribute('aria-expanded', 'true')
  place()
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  doc.addEventListener('pointerdown', onOutside, { capture: true })
  win?.addEventListener('resize', later)
  input.focus({ preventScroll: true })
  shown[active]?.el.scrollIntoView({ block: 'nearest' })
}

/** Close the picker if one is open (an editor going away, a test). */
export function closePicker(): void {
  open?.close(false)
}

/** The picker entry for a block's `language` attr: an alias as its language, an unknown name as itself. */
export function pickerValue(language: unknown): string {
  if (typeof language !== 'string' || !language) return ''
  const name = grammarName(language) ?? language
  return name === 'plaintext' ? '' : name
}
