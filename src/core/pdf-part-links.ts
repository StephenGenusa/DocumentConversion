import { parseDocument } from 'htmlparser2'
import { Element, type AnyNode, type ParentNode } from 'domhandler'
import render from 'dom-serializer'
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFString, type PDFDocument, type PDFRef } from 'pdf-lib'
import { footnotesForOutput } from './footnotes'
import { headingAnchorsForOutput, textOf } from './heading-anchors'

/**
 * Links inside a pdf that is printed in parts.
 *
 * A document too big for one print (html-chunk.ts) is printed a part at a
 * time and the parts are joined. Each part was linked on its own, so a
 * contents entry kept its link only when its heading happened to print in the
 * same part, and the join then lost even those: Chromium names a link's
 * destination in the part's catalog, and joining copies pages, not catalogs.
 * A 900-page reference came out with a third of its contents list linked and
 * none of it working.
 *
 * So the whole document is linked once, before it is cut, and each link is
 * carried through the print as something Chromium keeps whatever part it
 * lands in: an address under PART_LINK_BASE, numbered by its target. The
 * target carries a marker with the same number, a 1px link of its own, whose
 * rectangle in the printed page says where the target is. Once the parts are
 * joined each numbered link is pointed at its marker's page and height, and
 * the markers are removed.
 *
 * The bookmarks sidebar goes the same way. Chromium writes each part an
 * outline of its own headings, in the catalog the join leaves behind, so the
 * joined file had none. Every heading is marked, linked to or not, and the
 * outline is written again from the markers, one entry per heading, nested by
 * level as Chromium nests them.
 */

/** `.invalid` never resolves (RFC 2606), so a link left unjoined goes nowhere. */
export const PART_LINK_BASE = 'https://part-link.invalid/'
const LINK = `${PART_LINK_BASE}to/`
const MARK = `${PART_LINK_BASE}at/`
/** Empty and inline, an `<a>` has no box and Chromium writes no link for it; 1px out of the flow, it does. */
const MARK_STYLE = 'position:absolute;width:1px;height:1px'

const isEl = (n: AnyNode): n is Element => n instanceof Element

function walk(nodes: AnyNode[], visit: (el: Element) => void): void {
  for (const n of nodes) {
    if (!isEl(n)) continue
    visit(n)
    walk(n.children, visit)
  }
}

function relink(parent: ParentNode): void {
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

/** A heading for the bookmarks sidebar: its text, its level (1 to 6) and its marker's number. */
export interface PartHeading {
  title: string
  level: number
  mark: string
}

export interface LinkedForParts {
  html: string
  headings: PartHeading[]
}

const HEADING = /^h([1-6])$/

/**
 * Link the whole document (notes and headings, as the shell would), then make
 * every link to a place in it one that survives being printed in parts, and
 * mark every heading for the bookmarks.
 */
export function linkAcrossParts(html: string): LinkedForParts {
  const linked = headingAnchorsForOutput(footnotesForOutput(html, 'links'))
  if (!linked.includes('href="#') && !/<h[1-6][\s>]/.test(linked)) return { html: linked, headings: [] }
  const root = parseDocument(linked)
  const links: Element[] = []
  const titled: Element[] = []
  const byId = new Map<string, Element>()
  walk(root.children, (el) => {
    if (el.name === 'a' && el.attribs.href?.startsWith('#')) links.push(el)
    if (el.attribs.id && !byId.has(el.attribs.id)) byId.set(el.attribs.id, el)
    if (HEADING.test(el.name)) titled.push(el)
  })
  const numberOf = new Map<Element, number>()
  const numbered = (target: Element): number => {
    let n = numberOf.get(target)
    if (n === undefined) {
      n = numberOf.size + 1
      numberOf.set(target, n)
    }
    return n
  }
  for (const a of links) {
    const target = byId.get(fragmentOf(a.attribs.href))
    if (target) a.attribs.href = `${LINK}${numbered(target)}`
  }
  const headings: PartHeading[] = []
  for (const h of titled) {
    // As Chromium's own outline: a heading with no text has no entry.
    const title = textOf(h.children).replace(/\s+/g, ' ').trim()
    if (title) headings.push({ title, level: Number(HEADING.exec(h.name)![1]), mark: String(numbered(h)) })
  }
  for (const [target, n] of numberOf) {
    const mark = new Element('a', { href: `${MARK}${n}`, style: MARK_STYLE, 'aria-hidden': 'true' })
    // A link cannot hold a link, so a target that is one (a note's reference) has its marker beside it.
    const into = target.name === 'a' ? (target.parent as ParentNode | null) : target
    if (!into) continue
    const at = target.name === 'a' ? into.children.indexOf(target) : 0
    into.children.splice(at, 0, mark)
    relink(into)
  }
  return { html: render(root.children, { encodeEntities: 'utf8' }), headings }
}

function uriOf(annot: PDFDict): string | undefined {
  if (annot.get(PDFName.of('Subtype')) !== PDFName.of('Link')) return undefined
  const action = annot.lookup(PDFName.of('A'))
  if (!(action instanceof PDFDict)) return undefined
  const uri = action.lookup(PDFName.of('URI'))
  return uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : undefined
}

/**
 * Point each numbered link at its marker, in a document whose parts are
 * already joined. A link whose marker never printed is removed, leaving its
 * text, rather than left pointing at an address that does not exist. Given
 * the document's headings, the bookmarks are written from their markers.
 */
export function joinPartLinks(doc: PDFDocument, headings?: PartHeading[]): void {
  const pages = doc.getPages().map((page) => {
    const annots = page.node.Annots()
    const entries: { annot: PDFDict; raw: ReturnType<PDFArray['get']>; uri?: string }[] = []
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = annots!.lookup(i)
      if (annot instanceof PDFDict) entries.push({ annot, raw: annots!.get(i), uri: uriOf(annot) })
    }
    return { ref: page.ref, node: page.node, entries }
  })

  const places = new Map<string, { page: PDFRef; top: number }>()
  for (const page of pages) {
    for (const { annot, uri } of page.entries) {
      if (!uri?.startsWith(MARK)) continue
      const n = uri.slice(MARK.length)
      const rect = annot.lookup(PDFName.of('Rect'))
      // The first marker wins: a table's header row is repeated on every part.
      if (places.has(n) || !(rect instanceof PDFArray) || rect.size() < 4) continue
      const ys = [rect.lookup(1), rect.lookup(3)].map((v) => (v instanceof PDFNumber ? v.asNumber() : 0))
      places.set(n, { page: page.ref, top: Math.max(...ys) })
    }
  }

  for (const page of pages) {
    if (!page.entries.some((e) => e.uri?.startsWith(PART_LINK_BASE))) continue
    const kept = doc.context.obj([])
    for (const { annot, raw, uri } of page.entries) {
      if (uri?.startsWith(LINK)) {
        const place = places.get(uri.slice(LINK.length))
        if (!place) continue
        annot.delete(PDFName.of('A'))
        // Left and zoom are left as the reader has them; only the height moves.
        annot.set(PDFName.of('Dest'), doc.context.obj([place.page, PDFName.of('XYZ'), PDFNull, place.top, PDFNull]))
      } else if (uri?.startsWith(PART_LINK_BASE)) continue
      kept.push(raw)
    }
    page.node.set(PDFName.of('Annots'), kept)
  }

  if (headings) writeOutline(doc, headings, places)
}

/**
 * The bookmarks sidebar: an entry per heading that printed, under the nearest
 * heading before it of a higher level, every level open, as Chromium writes it.
 */
function writeOutline(doc: PDFDocument, headings: PartHeading[], places: Map<string, { page: PDFRef; top: number }>): void {
  interface Item {
    ref: PDFRef
    dict: PDFDict
    level: number
    children: Item[]
  }
  const rootRef = doc.context.nextRef()
  const top: Item[] = []
  const open: Item[] = []
  for (const h of headings) {
    const place = places.get(h.mark)
    if (!place) continue
    while (open.length > 0 && open[open.length - 1].level >= h.level) open.pop()
    const parent = open[open.length - 1]
    const dict = doc.context.obj({
      Title: PDFHexString.fromText(h.title),
      Dest: [place.page, PDFName.of('XYZ'), PDFNull, place.top, PDFNull],
      Parent: parent?.ref ?? rootRef,
    })
    const item: Item = { ref: doc.context.register(dict), dict, level: h.level, children: [] }
    ;(parent?.children ?? top).push(item)
    open.push(item)
  }
  if (top.length === 0) return
  /** Chain the siblings and give their parent its first, last and count; returns how many entries are under it. */
  const chain = (items: Item[], parent: PDFDict): number => {
    let count = items.length
    items.forEach((item, i) => {
      if (i > 0) item.dict.set(PDFName.of('Prev'), items[i - 1].ref)
      if (i < items.length - 1) item.dict.set(PDFName.of('Next'), items[i + 1].ref)
      if (item.children.length > 0) count += chain(item.children, item.dict)
    })
    parent.set(PDFName.of('First'), items[0].ref)
    parent.set(PDFName.of('Last'), items[items.length - 1].ref)
    parent.set(PDFName.of('Count'), PDFNumber.of(count))
    return count
  }
  const root = doc.context.obj({ Type: 'Outlines' })
  chain(top, root)
  doc.context.assign(rootRef, root)
  doc.catalog.set(PDFName.of('Outlines'), rootRef)
}
