import { parseDocument } from 'htmlparser2'
import { Element, Text, type AnyNode, type ParentNode } from 'domhandler'
import render from 'dom-serializer'

/**
 * Footnotes in the hub.
 *
 *   <sup data-fn="label">n</sup>             a reference
 *   <ol><li data-fn="label">…</li></ol>      the notes, once, last
 *
 * A notes list is an <ol> whose items ALL carry a label; no attribute on the
 * <ol> itself. (One was tried: sanitize-html and dom-serializer write an empty
 * attribute bare and the editor's DOM writes it `=""`, so the hub and the
 * editor could never agree on the bytes.)
 *
 * A label joins a reference to its note; the number shown is derived, never
 * trusted, so an edit that moves or deletes a reference can never leave two
 * notes numbered alike. The hub has no internal links (see the anchors
 * spec), so the label is the only join there is, and each writer turns it
 * into whatever its format links with: anchors, EPUB note references, `[^x]`,
 * or plain numbers where nothing links.
 */

/** What a label may be: safe in an attribute, an id, a URL fragment and `[^label]`. */
export const FOOTNOTE_LABEL = /^[A-Za-z0-9_.-]{1,64}$/

/** A raw label (an author's `[^Smith 2020]`, a Word note id) made safe, and unique among `taken`. */
export function safeLabel(raw: string, taken?: Set<string>): string {
  const base = raw.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'note'
  let label = base
  for (let n = 2; taken?.has(label); n++) label = `${base}-${n}`
  taken?.add(label)
  return label
}

const isEl = (n: AnyNode): n is Element => n instanceof Element
const serialize = (nodes: AnyNode | AnyNode[]): string => render(nodes, { encodeEntities: 'utf8' })

function elements(nodes: AnyNode[], out: Element[] = []): Element[] {
  for (const n of nodes) {
    if (!isEl(n)) continue
    out.push(n)
    elements(n.children, out)
  }
  return out
}

function detach(el: AnyNode): void {
  const parent = el.parent as ParentNode | null
  if (!parent) return
  const i = parent.children.indexOf(el as never)
  if (i >= 0) parent.children.splice(i, 1)
  relink(parent)
  el.parent = null
}

function relink(parent: ParentNode): void {
  parent.children.forEach((c, i) => {
    c.parent = parent
    c.prev = parent.children[i - 1] ?? null
    c.next = parent.children[i + 1] ?? null
  })
}

function setChildren(parent: ParentNode, children: AnyNode[]): void {
  parent.children = children
  relink(parent)
}

const isRef = (el: Element): boolean => el.name === 'sup' && el.attribs['data-fn'] !== undefined
const isList = (el: Element): boolean => {
  if (el.name !== 'ol') return false
  const items = el.children.filter(isEl)
  return items.length > 0 && items.every((c) => c.name === 'li' && c.attribs['data-fn'] !== undefined)
}

interface Parsed {
  root: ParentNode
  refs: Element[]
  items: Element[]
  /** label -> number shown */
  numbers: Map<string, number>
}

/**
 * Find every reference and note, pull the note lists out of the tree, and
 * number them. Notes keep their order unless `reorder`, which sorts them by
 * first reference with unreferenced notes after: right for a document just
 * read, wrong after an edit, where the editor already showed its numbering.
 */
function parse(html: string, reorder: boolean): Parsed {
  const root = parseDocument(html)
  const all = elements(root.children)
  const refs = all.filter(isRef)
  const lists = all.filter(isList)
  const taken = new Set<string>()
  const items: Element[] = []
  for (const list of lists) {
    for (const li of list.children.filter(isEl).filter((c) => c.name === 'li')) {
      const raw = li.attribs['data-fn']
      li.attribs['data-fn'] = raw && FOOTNOTE_LABEL.test(raw) && !taken.has(raw) ? raw : safeLabel(raw || 'note', taken)
      taken.add(li.attribs['data-fn'])
      items.push(li)
    }
  }
  for (const list of lists) detach(list)
  if (reorder) {
    const first = new Map<string, number>()
    refs.forEach((r, i) => {
      if (!first.has(r.attribs['data-fn'])) first.set(r.attribs['data-fn'], i)
    })
    const rank = (li: Element): number => first.get(li.attribs['data-fn']) ?? Number.MAX_SAFE_INTEGER
    items.sort((a, b) => rank(a) - rank(b))
  }
  const numbers = new Map<string, number>()
  items.forEach((li, i) => numbers.set(li.attribs['data-fn'], i + 1))
  for (const r of refs) {
    const label = r.attribs['data-fn']
    if (!numbers.has(label)) numbers.set(label, numbers.size + 1)
  }
  return { root, refs, items, numbers }
}

/**
 * The hub's footnote invariant, restored: one notes list, last, numbers that
 * match it. Run at read() and at write(); a document with no `data-fn` is
 * returned untouched, byte for byte.
 */
export function normalizeFootnotes(html: string, opts: { reorder?: boolean } = {}): string {
  if (!html.includes('data-fn')) return html
  const { root, refs, items, numbers } = parse(html, !!opts.reorder)
  for (const r of refs) setChildren(r, [new Text(String(numbers.get(r.attribs['data-fn'])))])
  if (items.length > 0) {
    const ol = new Element('ol', {})
    setChildren(ol, items)
    root.children.push(ol)
    relink(root)
  }
  return serialize(root.children)
}

/**
 * How a writer shows footnotes:
 *
 *   links  html, pdf: `<sup class="fnref"><a href="#fn-x">`, a Notes section with ↩ back-links
 *   epub   the same, with EPUB 3 noteref / footnote semantics for pop-up notes
 *   plain  docx, slides, azw3: superscript numbers and a Notes list, no links
 *   text   txt: `[1]` markers and a Notes list
 *
 * The anchors are the writer's own, made from labels it owns at both ends,
 * so the hub's no-internal-links rule is untouched.
 */
export type FootnoteStyle = 'links' | 'epub' | 'plain' | 'text'

export function footnotesForOutput(html: string, style: FootnoteStyle): string {
  if (!html.includes('data-fn')) return html
  const { root, refs, items, numbers } = parse(html, false)
  const linked = style === 'links' || style === 'epub'
  const seen = new Set<string>()
  const referenced = new Set(refs.map((r) => r.attribs['data-fn']))
  for (const r of refs) {
    const label = r.attribs['data-fn']
    const n = String(numbers.get(label))
    let fragment: string
    if (style === 'text') fragment = `[${n}]`
    else if (!linked) fragment = `<sup>${n}</sup>`
    else {
      const id = seen.has(label) ? '' : ` id="fnref-${label}"`
      seen.add(label)
      const type = style === 'epub' ? ' epub:type="noteref"' : ''
      fragment = `<sup${style === 'links' ? ' class="fnref"' : ''}><a${type} href="#fn-${label}"${id}>${n}</a></sup>`
    }
    replaceWith(r, fragment)
  }
  if (items.length > 0) {
    const notes = items.map((li) => {
      const label = li.attribs['data-fn']
      let body = serialize(li.children)
      if (linked && referenced.has(label)) {
        const back = `<a href="#fnref-${label}" class="fnback" aria-label="Back to the text">↩</a>`
        // Inside the note's last paragraph, so it does not sit alone on a line.
        body = /<\/p>\s*$/.test(body) ? body.replace(/<\/p>\s*$/, ` ${back}</p>`) : `${body} ${back}`
      }
      if (!linked) return `<li>${body}</li>`
      const type = style === 'epub' ? ' epub:type="footnote"' : ''
      return `<li id="fn-${label}"${type}>${body}</li>`
    })
    const list = `<h2>Notes</h2><ol>${notes.join('')}</ol>`
    const section =
      style === 'links'
        ? `<section class="footnotes">${list}</section>`
        : style === 'epub'
          ? `<section epub:type="endnotes" role="doc-endnotes">${list}</section>`
          : list
    root.children.push(...parseDocument(section).children)
    relink(root)
  }
  return serialize(root.children)
}

function replaceWith(el: Element, fragment: string): void {
  const parent = el.parent as ParentNode | null
  if (!parent) return
  const fresh = [...parseDocument(fragment).children]
  parent.children.splice(parent.children.indexOf(el), 1, ...fresh)
  relink(parent)
}

/**
 * Give one merged document's labels a prefix where they collide with an
 * earlier document's, so two sources each with a `[^1]` keep two notes.
 */
export function prefixCollidingLabels(html: string, taken: Set<string>, prefix: string): string {
  if (!html.includes('data-fn')) return html
  const own = new Set([...html.matchAll(/data-fn="([^"]*)"/g)].map((m) => m[1]))
  const renamed = new Map<string, string>()
  for (const label of own) {
    if (taken.has(label)) renamed.set(label, safeLabel(`${prefix}${label}`, taken))
    else taken.add(label)
  }
  if (renamed.size === 0) return html
  return html.replace(/data-fn="([^"]*)"/g, (m, label: string) => (renamed.has(label) ? `data-fn="${renamed.get(label)}"` : m))
}
