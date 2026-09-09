import StarterKit from '@tiptap/starter-kit'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { Node } from '@tiptap/core'
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

export const EDITOR_EXTENSIONS: Extensions = [
  StarterKit,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  Image.configure({ allowBase64: true }),
  SpeakerNotes,
]
