import { parseDocument } from 'htmlparser2'
import { Element, Text, type AnyNode, type ParentNode } from 'domhandler'
import render from 'dom-serializer'

/**
 * Links to a document's own headings: `[Sources](#11-sources)`, and the
 * contents list a Markdown author writes at the top.
 *
 * The hub keeps the link (`<a href="#11-sources">`) but no heading carries an
 * id, so in the pdf the link had nothing to point at and Chromium dropped it,
 * and every contents entry printed as dead blue text. As with footnotes, the
 * anchors are the writer's own: each heading's id is the one GitHub would give
 * it, set only where a link asks for it, so the hub's no-internal-links rule
 * is untouched. A link resolves to its heading, or to an id the writer already
 * made (a footnote's); one that resolves to nothing keeps its text and loses
 * the link. Each writer then links them as its format does: html, pdf, epub
 * and azw3 by id, docx by bookmark, revealjs by slide.
 */

const isEl = (n: AnyNode): n is Element => n instanceof Element
const HEADING = /^h[1-6]$/

function walk(nodes: AnyNode[], visit: (el: Element) => void): void {
  for (const n of nodes) {
    if (!isEl(n)) continue
    visit(n)
    walk(n.children, visit)
  }
}

/** A heading's text as a reader sees it; a footnote's number is not part of it. */
function textOf(nodes: AnyNode[]): string {
  let s = ''
  for (const n of nodes) {
    if (n instanceof Text) s += n.data
    else if (isEl(n) && !(n.name === 'sup' && n.attribs.class === 'fnref')) s += textOf(n.children)
  }
  return s
}

/**
 * The anchor GitHub gives a heading (github-slugger): lower case, everything
 * but letters, marks, digits, connector punctuation, spaces and hyphens
 * removed, and each space made a hyphen, so "10. Things not confirmed" is
 * `10-things-not-confirmed` and "TL;DR for the RTX 4090 (24 GB)" is
 * `tldr-for-the-rtx-4090-24-gb`.
 */
export function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-')
}

function unwrap(a: Element): void {
  const parent = a.parent as ParentNode | null
  if (!parent) return
  const at = parent.children.indexOf(a)
  parent.children.splice(at, 1, ...a.children)
  parent.children.forEach((c, i) => {
    c.parent = parent
    c.prev = parent.children[i - 1] ?? null
    c.next = parent.children[i + 1] ?? null
  })
}

function fragmentOf(href: string): string {
  const raw = href.slice(1)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function headingAnchorsForOutput(html: string): string {
  if (!html.includes('href="#')) return html
  const root = parseDocument(html)
  const links: Element[] = []
  const ids = new Set<string>()
  const headings: Element[] = []
  walk(root.children, (el) => {
    if (el.name === 'a' && el.attribs.href?.startsWith('#')) links.push(el)
    if (el.attribs.id) ids.add(el.attribs.id)
    if (HEADING.test(el.name)) headings.push(el)
  })
  if (links.length === 0) return html

  // Every heading is counted, linked or not, so a repeated title is numbered
  // `-1`, `-2` in the order GitHub numbers it.
  const bySlug = new Map<string, Element>()
  const slugOf = new Map<Element, string>()
  const used = new Map<string, number>()
  for (const h of headings) {
    if (h.attribs.id) continue
    const base = githubSlug(textOf(h.children))
    let n = used.get(base) ?? 0
    let slug = n === 0 ? base : `${base}-${n}`
    while (bySlug.has(slug) || ids.has(slug)) slug = `${base}-${++n}`
    used.set(base, n + 1)
    bySlug.set(slug, h)
    slugOf.set(h, slug)
  }

  for (const a of links) {
    const want = fragmentOf(a.attribs.href)
    if (ids.has(want)) continue
    const heading = bySlug.get(want) ?? bySlug.get(want.toLowerCase())
    if (!heading) {
      unwrap(a)
      continue
    }
    const slug = slugOf.get(heading)!
    heading.attribs.id = slug
    a.attribs.href = `#${slug}`
  }
  return render(root.children, { encodeEntities: 'utf8' })
}
