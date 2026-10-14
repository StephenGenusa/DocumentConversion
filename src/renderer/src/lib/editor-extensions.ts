import StarterKit from '@tiptap/starter-kit'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import Superscript from '@tiptap/extension-superscript'
import Subscript from '@tiptap/extension-subscript'
import { Node, Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Extensions } from '@tiptap/core'

/**
 * The editor schema must model everything the hub sanitizer passes
 * (see src/core/allowlist.ts) — ProseMirror silently drops unknown nodes.
 * StarterKit (v3) covers paragraphs, headings, lists, blockquote, code
 * blocks, hr, links, and inline marks; tables and images are added here.
 */

/**
 * Speaker notes.
 *
 * allowlist.ts states the invariant: anything the sanitiser passes must
 * round-trip this editor losslessly. `aside` is in HUB_TAGS, so without a node
 * for it ProseMirror would silently drop notes the moment a user opened the
 * edit pane - the exact data loss the invariant exists to prevent.
 *
 * Block content rather than a leaf, so a note can hold more than one paragraph
 * and can be edited like any other text.
 */
const SpeakerNotes = Node.create({
  name: 'speakerNotes',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML: () => [{ tag: 'aside' }],
  renderHTML: () => ['aside', 0],
})

/*
 * Footnotes, in the hub's model (src/core/footnotes.ts):
 *
 *   <sup data-fn="label">n</sup>          footnoteRef: an inline atom
 *   <ol><li data-fn="label">…</li></ol>   footnotes > footnoteItem
 *
 * Each parses at priority 100, ahead of the Superscript mark (`sup`) and the
 * ordered list (`ol`, `li`), so a plain superscript and an ordinary numbered
 * list stay what they are. The number shown is derived (FootnoteNumbering),
 * so moving or deleting a reference can never leave two notes numbered alike.
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnoteRef: {
      /** A reference at the cursor, its note at the end of the list, and the cursor in the note. */
      insertFootnote: () => ReturnType
    }
  }
}

const labelAttr = {
  default: '',
  parseHTML: (el: HTMLElement) => el.getAttribute('data-fn') ?? '',
  renderHTML: () => ({}),
}

const FootnoteRef = Node.create({
  name: 'footnoteRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    label: labelAttr,
    num: { default: '', parseHTML: (el: HTMLElement) => el.textContent ?? '', renderHTML: () => ({}) },
  }),
  parseHTML: () => [{ tag: 'sup[data-fn]', priority: 100 }],
  renderHTML: ({ node }) => ['sup', { 'data-fn': node.attrs.label }, String(node.attrs.num)],
  addCommands() {
    return {
      insertFootnote:
        () =>
        ({ state, tr, dispatch }) => {
          const { footnoteRef, footnoteItem, footnotes, paragraph } = state.schema.nodes
          const taken = new Set<string>()
          let list: { node: PMNode; pos: number } | null = null
          state.doc.descendants((n, pos) => {
            if (n.type === footnoteRef || n.type === footnoteItem) taken.add(n.attrs.label)
            if (n.type === footnotes && !list) list = { node: n, pos }
          })
          let next = 1
          while (taken.has(String(next))) next++
          const label = String(next)
          if (!dispatch) return true
          tr.replaceSelectionWith(footnoteRef.create({ label, num: '' }), false)
          const item = footnoteItem.create({ label }, paragraph.create())
          let itemPos: number
          const found = list as { node: PMNode; pos: number } | null
          if (found) {
            itemPos = tr.mapping.map(found.pos + found.node.nodeSize - 1)
            tr.insert(itemPos, item)
          } else {
            itemPos = tr.doc.content.size + 1
            tr.insert(tr.doc.content.size, footnotes.create(null, item))
          }
          // Into the item, then into its paragraph.
          tr.setSelection(TextSelection.create(tr.doc, itemPos + 2))
          dispatch(tr.scrollIntoView())
          return true
        },
    }
  },
})

const FootnoteItem = Node.create({
  name: 'footnoteItem',
  content: 'block+',
  defining: true,
  addAttributes: () => ({ label: labelAttr }),
  parseHTML: () => [{ tag: 'li[data-fn]', priority: 100 }],
  renderHTML: ({ node }) => ['li', { 'data-fn': node.attrs.label }, 0],
})

const Footnotes = Node.create({
  name: 'footnotes',
  group: 'block',
  content: 'footnoteItem+',
  isolating: true,
  parseHTML: () => [
    {
      tag: 'ol',
      priority: 100,
      // A notes list is an <ol> whose every item is labelled; anything else
      // is an ordinary numbered list and is left to OrderedList.
      getAttrs: (el: HTMLElement) => {
        const items = Array.from(el.children)
        return items.length > 0 && items.every((c) => c.tagName === 'LI' && c.hasAttribute('data-fn')) ? null : false
      },
    },
  ],
  renderHTML: () => ['ol', 0],
})

/** References numbered by their note's place in the list; a reference with no note after them. */
const FootnoteNumbering = Extension.create({
  name: 'footnoteNumbering',
  addProseMirrorPlugins: () => [
    new Plugin({
      key: new PluginKey('footnoteNumbering'),
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some((t) => t.docChanged)) return null
        const numbers = new Map<string, number>()
        state.doc.descendants((n) => {
          if (n.type.name === 'footnoteItem' && !numbers.has(n.attrs.label)) numbers.set(n.attrs.label, numbers.size + 1)
        })
        const tr = state.tr
        state.doc.descendants((n, pos) => {
          if (n.type.name !== 'footnoteRef') return
          if (!numbers.has(n.attrs.label)) numbers.set(n.attrs.label, numbers.size + 1)
          const num = String(numbers.get(n.attrs.label))
          if (n.attrs.num !== num) tr.setNodeMarkup(pos, undefined, { ...n.attrs, num })
        })
        return tr.docChanged ? tr : null
      },
    }),
  ],
})

export const EDITOR_EXTENSIONS: Extensions = [
  // No empty trailing paragraph after the notes: they are always last, and
  // that paragraph would be written into every document that has footnotes.
  StarterKit.configure({ trailingNode: { notAfter: ['paragraph', 'footnotes'] } }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  Image.configure({ allowBase64: true }),
  // sup and sub are in HUB_TAGS; StarterKit models neither.
  Superscript,
  Subscript,
  SpeakerNotes,
  FootnoteRef,
  FootnoteItem,
  Footnotes,
  FootnoteNumbering,
]
