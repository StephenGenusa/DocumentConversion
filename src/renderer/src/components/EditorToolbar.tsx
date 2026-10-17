import { Fragment, useEffect, useRef, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { normalizeLinkUrl } from '../lib/link-url'
import {
  IconBulletList,
  IconClear,
  IconCode,
  IconDiagram,
  IconLink,
  IconOrderedList,
  IconQuote,
  IconRedo,
  IconRule,
  IconTable,
  IconUndo,
} from './editor-icons'

/**
 * The formatting toolbar for the edit pane.
 *
 * What it offers is decided by `src/core/allowlist.ts`, not by taste: the hub
 * sanitizer's tag list is the set of things that survive a conversion, the
 * editor schema is required to model all of them, and anything outside it would
 * be a control that silently loses its effect on the way out. So the toolbar
 * covers headings, both list kinds, blockquote, inline code and code blocks,
 * links, tables, rules, footnotes and the seven inline marks — and nothing else.
 *
 * Headings stop at 3 for authoring. h4–h6 are in the hub and round-trip
 * untouched when they arrive in pasted content; they are simply not worth five
 * more entries in a dropdown.
 */

type Control =
  | {
      kind: 'select'
      label: string
      value: string
      options: ReadonlyArray<readonly [string, string]>
      onChange: (value: string) => void
    }
  | {
      kind: 'menu'
      label: string
      content: React.ReactNode
      items: ReadonlyArray<MenuItem>
    }
  | {
      kind: 'button'
      label: string
      content: React.ReactNode
      /** The tooltip, when it says more than the label (a shortcut). */
      title?: string
      /** Rendered as text rather than an icon; sizes the button differently. */
      text?: boolean
      className?: string
      active?: boolean
      /** `aria-disabled`, not `disabled` — see the note on focus below. */
      off?: boolean
      onClick: () => void
    }

interface MenuItem {
  label: string
  /** The shortcut, shown beside the label. */
  keys?: string
  onSelect: () => void
}

const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
const keys = (k: string): string => (MAC ? k.replace('Mod+', '⌘').replace('Shift+', '⇧').replace('Alt+', '⌥') : k.replace('Mod+', 'Ctrl+'))

const BLOCKS = [
  ['p', 'Paragraph'],
  ['h1', 'Heading 1'],
  ['h2', 'Heading 2'],
  ['h3', 'Heading 3'],
  ['code', 'Code block'],
] as const

export function EditorToolbar({
  editor,
  sourceFormat,
}: {
  editor: Editor | null
  /**
   * The format the document was read from. A code listing (the code reader)
   * is shown as a file, so diagrams and formulas are not offered there
   * (spec B13).
   */
  sourceFormat?: string
}): React.JSX.Element | null {
  /*
   * TipTap v3 does NOT re-render on every transaction — `shouldRerenderOnTransaction`
   * defaults to false — so reading `editor.isActive(...)` straight into JSX
   * gives a toolbar whose pressed states never change. `useEditorState` is the
   * v3 answer: it re-renders only when one of these values actually flips.
   */
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: !!e?.isActive('bold'),
      italic: !!e?.isActive('italic'),
      underline: !!e?.isActive('underline'),
      strike: !!e?.isActive('strike'),
      superscript: !!e?.isActive('superscript'),
      subscript: !!e?.isActive('subscript'),
      code: !!e?.isActive('code'),
      bulletList: !!e?.isActive('bulletList'),
      orderedList: !!e?.isActive('orderedList'),
      blockquote: !!e?.isActive('blockquote'),
      link: !!e?.isActive('link'),
      inTable: !!e?.isActive('table'),
      block: blockOf(e),
      canUndo: !!e?.can().undo(),
      canRedo: !!e?.can().redo(),
    }),
  })

  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)

  /*
   * `role="toolbar"` promises the toolbar is a SINGLE tab stop whose controls
   * are reached with the arrow keys. Browsers do not implement that — it is the
   * author's job — and declaring the role without it leaves a promise unkept.
   *
   * The standard pattern: exactly one control is tabbable at a time (the last
   * one used), Left/Right move between them wrapping at the ends, Home/End jump
   * to either edge. Tabbing therefore skips the whole toolbar in one press
   * rather than fifteen, which is the entire point of the role.
   */
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [tabStop, setTabStop] = useState(0)

  /** The Formula or Diagram menu that is open, by label. */
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  useEffect(() => {
    if (menuOpen === null) return
    const close = (e: MouseEvent): void => {
      if (!(e.target as Element | null)?.closest?.('.tb-menu')) setMenuOpen(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  function onToolbarKeys(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
    // A select owns Left/Right for changing its own value.
    if (e.target instanceof HTMLSelectElement && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      return
    }
    // The open menu's items are not stops of the toolbar; the menu handles its own keys.
    if ((e.target as Element).closest('[role="menu"]')) return
    const controls = Array.from(toolbarRef.current?.querySelectorAll('button:not([role="menuitem"]), select') ?? [])
    if (controls.length === 0) return
    e.preventDefault()
    const active = controls.findIndex((c) => c === document.activeElement)
    const from = active === -1 ? tabStop : active
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? controls.length - 1
          : e.key === 'ArrowRight'
            ? (from + 1) % controls.length
            : (from - 1 + controls.length) % controls.length
    setTabStop(next)
    ;(controls[next] as HTMLElement).focus()
  }

  if (!editor || !state) return null

  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

  function openLink(): void {
    if (!editor) return
    setLinkValue(String(editor.getAttributes('link').href ?? ''))
    setLinkError(null)
    setLinkOpen(true)
    // Focus after the row exists.
    setTimeout(() => linkInputRef.current?.select(), 0)
  }

  function applyLink(): void {
    const href = normalizeLinkUrl(linkValue)
    if (!href) {
      setLinkError('Enter a web address or an email link (http, https or mailto).')
      return
    }
    chain().extendMarkRange('link').setLink({ href }).run()
    setLinkOpen(false)
  }

  function removeLink(): void {
    chain().extendMarkRange('link').unsetLink().run()
    setLinkOpen(false)
  }

  const groups: Control[][] = [
    [
      {
        kind: 'select',
        label: 'Paragraph style',
        value: state.block,
        options: BLOCKS,
        onChange: (v) => setBlock(editor, v),
      },
    ],
    [
      mark('Bold', <span className="tb-b">B</span>, state.bold, () => chain().toggleBold().run()),
      mark('Italic', <span className="tb-i">I</span>, state.italic, () =>
        chain().toggleItalic().run(),
      ),
      mark('Underline', <span className="tb-u">U</span>, state.underline, () =>
        chain().toggleUnderline().run(),
      ),
      mark('Strikethrough', <span className="tb-s">S</span>, state.strike, () =>
        chain().toggleStrike().run(),
      ),
      // One or the other: raising subscript text makes it superscript, not both.
      mark('Superscript', <span className="tb-sup">x<sup>2</sup></span>, state.superscript, () =>
        chain().unsetSubscript().toggleSuperscript().run(),
      ),
      mark('Subscript', <span className="tb-sub">x<sub>2</sub></span>, state.subscript, () =>
        chain().unsetSuperscript().toggleSubscript().run(),
      ),
      icon('Inline code', <IconCode />, state.code, () => chain().toggleCode().run()),
    ],
    [
      icon('Bulleted list', <IconBulletList />, state.bulletList, () =>
        chain().toggleBulletList().run(),
      ),
      icon('Numbered list', <IconOrderedList />, state.orderedList, () =>
        chain().toggleOrderedList().run(),
      ),
      icon('Quote', <IconQuote />, state.blockquote, () => chain().toggleBlockquote().run()),
    ],
    [
      icon('Link', <IconLink />, state.link || linkOpen, openLink),
      icon('Insert table', <IconTable />, false, () =>
        chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      ),
      icon('Horizontal rule', <IconRule />, false, () => chain().setHorizontalRule().run()),
      // A reference at the cursor and its note at the end, with the cursor in the note.
      {
        ...icon('Insert footnote', <span className="tb-fn">fn</span>, false, () => chain().insertFootnote().run()),
        title: `Insert footnote (${keys('Mod+Alt+F')})`,
      },
      // Diagrams and formulas (spec B13); not for code listings.
      ...(sourceFormat === 'code'
        ? []
        : [
            menu('Formula', <span className="tb-fx">fx</span>, [
              { label: 'Inline formula', keys: keys('Mod+Shift+M'), onSelect: () => chain().insertMathInline().run() },
              { label: 'Formula block', onSelect: () => chain().insertMathBlock().run() },
            ]),
            menu('Diagram', <IconDiagram />, [
              { label: 'Mermaid diagram', onSelect: () => chain().insertDiagram('mermaid').run() },
              { label: 'Graphviz diagram', onSelect: () => chain().insertDiagram('dot').run() },
            ]),
          ]),
    ],
    [
      { ...icon('Undo', <IconUndo />, false, () => chain().undo().run()), off: !state.canUndo },
      { ...icon('Redo', <IconRedo />, false, () => chain().redo().run()), off: !state.canRedo },
      icon('Clear formatting', <IconClear />, false, () =>
        chain().unsetAllMarks().clearNodes().run(),
      ),
    ],
  ]

  /*
   * Table editing appears only with the caret inside a table. Always-on it
   * would be six more controls for something most documents never contain —
   * and these are labeled rather than drawn, because five variants of a grid
   * with a plus or a minus on it are indistinguishable at 16 pixels.
   */
  if (state.inTable) {
    groups.push([
      text('Row +', () => chain().addRowAfter().run()),
      text('Row −', () => chain().deleteRow().run()),
      text('Col +', () => chain().addColumnAfter().run()),
      text('Col −', () => chain().deleteColumn().run()),
      text('Delete table', () => chain().deleteTable().run()),
    ])
  }

  const flat = groups.flat()
  const stop = Math.min(tabStop, flat.length - 1)

  return (
    <div className="clip-pane__bar">
      <div
        className="clip-pane__toolbar"
        role="toolbar"
        aria-label="Formatting"
        ref={toolbarRef}
        onKeyDown={onToolbarKeys}
      >
        {/* Each group is one flex item, so a narrow pane wraps BETWEEN groups.
            Letting controls wrap individually splits a group across two rows,
            which reads as a layout bug rather than as a deliberate shelf. */}
        {groups.map((group, gi) => (
          <Fragment key={gi}>
            {gi > 0 && (
              <span className="clip-pane__sep" role="separator" aria-orientation="vertical" />
            )}
            <span className="clip-pane__group">
              {group.map((control) =>
                control.kind === 'menu' ? (
                  <ToolbarMenu
                    key={control.label}
                    control={control}
                    tabbable={flat.indexOf(control) === stop}
                    open={menuOpen === control.label}
                    setOpen={(o) => setMenuOpen(o ? control.label : null)}
                  />
                ) : (
                  render(control, flat.indexOf(control) === stop)
                ),
              )}
            </span>
          </Fragment>
        ))}
      </div>

      {linkOpen && (
        <div className="clip-pane__link">
          <input
            ref={linkInputRef}
            type="text"
            value={linkValue}
            aria-label="Link address"
            aria-invalid={linkError !== null}
            placeholder="https://example.com"
            onChange={(e) => {
              setLinkValue(e.target.value)
              setLinkError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink()
              if (e.key === 'Escape') setLinkOpen(false)
            }}
          />
          <button className="btn btn--mini" onClick={applyLink}>
            Apply
          </button>
          {state.link && (
            <button className="btn btn--mini" onClick={removeLink}>
              Remove
            </button>
          )}
          <button className="btn btn--mini btn--ghost" onClick={() => setLinkOpen(false)}>
            Cancel
          </button>
          {linkError && (
            <span className="clip-pane__link-error" role="alert">
              {linkError}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A toolbar button that opens a short menu (the menu-button pattern): Enter,
 * Space or Down opens it on its first item, Up and Down move, Escape closes it
 * and returns to the button, and choosing an item runs it.
 */
function ToolbarMenu({
  control,
  tabbable,
  open,
  setOpen,
}: {
  control: Control & { kind: 'menu' }
  tabbable: boolean
  open: boolean
  setOpen: (open: boolean) => void
}): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const focusItem = (i: number): void => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    items[(i + items.length) % items.length]?.focus()
  }
  useEffect(() => {
    if (open) focusItem(0)
  }, [open])

  function onListKeys(e: React.KeyboardEvent<HTMLDivElement>): void {
    const items = Array.from(listRef.current?.querySelectorAll('[role="menuitem"]') ?? [])
    const at = items.indexOf(document.activeElement as Element)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusItem(at + (e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      focusItem(e.key === 'Home' ? 0 : -1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
    } else if (e.key === 'Tab') setOpen(false)
    e.stopPropagation()
  }

  return (
    <span className="tb-menu">
      <button
        ref={buttonRef}
        className={['btn', 'btn--mini', 'btn--icon', open ? 'btn--on' : ''].filter(Boolean).join(' ')}
        aria-label={control.label}
        title={control.label}
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {control.content}
        <span className="tb-menu__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="tb-menu__list" role="menu" aria-label={control.label} ref={listRef} onKeyDown={onListKeys}>
          {control.items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              tabIndex={-1}
              className="tb-menu__item"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              <span>{item.label}</span>
              {item.keys && <span className="tb-menu__keys">{item.keys}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

function render(control: Control, tabbable: boolean): React.JSX.Element {
  if (control.kind === 'menu') throw new Error('menus are rendered by ToolbarMenu')
  if (control.kind === 'select') {
    return (
      <select
        key={control.label}
        className="tb-select"
        aria-label={control.label}
        tabIndex={tabbable ? 0 : -1}
        value={control.value}
        onChange={(e) => control.onChange(e.target.value)}
      >
        {control.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    )
  }
  return (
    <button
      key={control.label}
      className={[
        'btn',
        'btn--mini',
        control.text ? 'btn--label' : 'btn--icon',
        control.active ? 'btn--on' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={control.label}
      title={control.title ?? control.label}
      tabIndex={tabbable ? 0 : -1}
      // A disabled control is removed from the tab order and from most screen
      // readers' output, so an undo button that is merely unavailable would
      // vanish rather than read as unavailable. `aria-disabled` keeps it
      // announced and reachable; the handler is what actually declines.
      aria-disabled={control.off ? true : undefined}
      aria-pressed={control.active === undefined ? undefined : control.active}
      onClick={() => {
        if (!control.off) control.onClick()
      }}
    >
      {control.content}
    </button>
  )
}

function icon(
  label: string,
  content: React.ReactNode,
  active: boolean,
  onClick: () => void,
): Control & { kind: 'button' } {
  return { kind: 'button', label, content, active, onClick }
}

function mark(
  label: string,
  content: React.ReactNode,
  active: boolean,
  onClick: () => void,
): Control & { kind: 'button' } {
  return { kind: 'button', label, content, active, onClick }
}

function menu(label: string, content: React.ReactNode, items: MenuItem[]): Control & { kind: 'menu' } {
  return { kind: 'menu', label, content, items }
}

/** A labeled control: no `aria-pressed`, because it is an action, not a state. */
function text(label: string, onClick: () => void): Control & { kind: 'button' } {
  return { kind: 'button', label, content: label, text: true, onClick }
}

function blockOf(editor: Editor | null): string {
  if (!editor) return 'p'
  if (editor.isActive('codeBlock')) return 'code'
  for (const level of [1, 2, 3] as const) {
    if (editor.isActive('heading', { level })) return `h${level}`
  }
  return 'p'
}

function setBlock(editor: Editor, value: string): void {
  const chain = editor.chain().focus()
  if (value === 'code') chain.setCodeBlock().run()
  else if (value === 'p') chain.setParagraph().run()
  else chain.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run()
}
