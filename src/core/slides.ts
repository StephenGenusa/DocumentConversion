import { parseDocument } from 'htmlparser2'
import { isTag, isText } from 'domhandler'
import render from 'dom-serializer'
import type { AnyNode, Element } from 'domhandler'
import { SPEAKER_NOTES_TAG } from './speaker-notes'

/**
 * Cutting the hub into slides.
 *
 * A deck is not a new document model here — it is the same flat hub HTML with a
 * split rule applied. Keeping it that way is what lets every reader feed the
 * slide writers for free: anything that converts to the hub converts to slides.
 *
 * The rule, in precedence order:
 *
 *   1. `<hr>` — an explicit `---` in the source. Unambiguous, and what every
 *      other markdown-slides tool uses, so it wins wherever it appears.
 *   2. Otherwise a heading level, `h1` by default.
 *
 * A document with neither is one slide. That is the right answer rather than an
 * error: a single-slide deck is a legitimate thing to ask for.
 */

export type SplitOn = 'auto' | 'hr' | 'h1' | 'h2'

export interface Slide {
  /** The slide body, already hub-sanitised, with notes removed. */
  html: string
  /** Speaker notes for this slide, in document order, inner HTML only. */
  notes: string[]
}

export interface SlideOptions {
  splitOn?: SplitOn
}

const isElement = (node: AnyNode): node is Element => isTag(node)

/** Whether a node is worth putting on a slide at all. */
function hasSubstance(node: AnyNode): boolean {
  if (isText(node)) return node.data.trim().length > 0
  return isElement(node)
}

/**
 * Resolve `auto`. A rule anywhere in the document means the author chose rules,
 * so headings stop being separators — mixing the two silently would split more
 * often than the author asked for.
 */
function resolveRule(nodes: AnyNode[], requested: SplitOn): 'hr' | 'h1' | 'h2' {
  if (requested !== 'auto') return requested
  return nodes.some((n) => isElement(n) && n.name === 'hr') ? 'hr' : 'h1'
}

export function splitSlides(html: string, options: SlideOptions = {}): Slide[] {
  const doc = parseDocument(html)
  const nodes = doc.children.filter(hasSubstance)
  if (nodes.length === 0) return []

  const rule = resolveRule(nodes, options.splitOn ?? 'auto')

  const slides: Slide[] = []
  let body: AnyNode[] = []
  let notes: string[] = []

  /**
   * Emit only if something would be visible. This is what stops a leading rule,
   * consecutive rules, a trailing rule, or a slide holding nothing but a note
   * from producing a blank slide - each of which the naive split does.
   */
  const flush = (): void => {
    if (body.length === 0) {
      notes = []
      return
    }
    slides.push({ html: body.map((n) => render(n, { decodeEntities: false })).join(''), notes })
    body = []
    notes = []
  }

  for (const node of nodes) {
    if (isElement(node)) {
      if (rule === 'hr' && node.name === 'hr') {
        flush()
        continue
      }
      if (rule !== 'hr' && node.name === rule) {
        flush()
        body.push(node)
        continue
      }
      if (node.name === SPEAKER_NOTES_TAG) {
        notes.push(node.children.map((c) => render(c, { decodeEntities: false })).join(''))
        continue
      }
    }
    body.push(node)
  }
  flush()
  return slides
}

/**
 * Coerce an untrusted split rule from the IPC boundary.
 *
 * The renderer is the only caller today, but the boundary is a boundary: an
 * unrecognised value falls back to `auto` rather than reaching the splitter and
 * silently producing a one-slide deck.
 */
export function normalizeSlideOptions(value: unknown): { splitOn: SplitOn } {
  const raw = (value as { splitOn?: unknown } | undefined)?.splitOn
  const valid: SplitOn[] = ['auto', 'hr', 'h1', 'h2']
  return { splitOn: valid.includes(raw as SplitOn) ? (raw as SplitOn) : 'auto' }
}
