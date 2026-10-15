import mammoth from 'mammoth'
import JSZip from 'jszip'
import { scanElements, decodeXml } from '../ooxml'
import { escapeHtml } from '../shell'
import {
  archiveInlineBudget,
  createImageLedger,
  imagePlaceholder,
  OVER_BUDGET,
  type ImageLedger,
} from '../inline-images'
import type { HubDocument, ReadContext, SourceInput } from '../types'
import { ommlLinearText, ommlToTex } from '../omml-tex'
import { parseDocument } from 'htmlparser2'
import { Element, type AnyNode, type ParentNode } from 'domhandler'
import render from 'dom-serializer'

/**
 * Which tables mark their first row as a header, in document order.
 *
 * mammoth emits <th> only for an explicit <w:tblHeader/>, which real documents
 * almost never set — every corpus file used <w:tblLook w:firstRow="1"> instead.
 * Without header semantics, downstream writers have to guess, and markdown
 * guessed wrong on all-text tables.
 */
async function headerFlags(bytes: Buffer): Promise<boolean[]> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const doc = zip.files['word/document.xml']
    if (!doc) return []
    const xml = await doc.async('string')
    return scanElements(xml, ['w:tbl']).map((table) => {
      if (/<w:tblHeader\b/.test(table.xml)) return true
      const look = /<w:tblLook\b[^>]*>/.exec(table.xml)?.[0] ?? ''
      return /\bw:firstRow="(1|true)"/.test(look) || /\bfirstRow="(1|true)"/.test(look)
    })
  } catch {
    return []
  }
}

/** Promote the first row of the flagged tables from <td> to <th>. */
export function promoteHeaderRows(html: string, flags: boolean[]): string {
  if (flags.length === 0 || !html.includes('<table')) return html
  let index = -1
  return html.replace(/<table[\s\S]*?<\/table>/g, (table) => {
    index++
    if (!flags[index] || table.includes('<th')) return table
    let done = false
    return table.replace(/<tr[^>]*>[\s\S]*?<\/tr>/, (row) => {
      if (done) return row
      done = true
      return row.replace(/<(\/?)td\b/g, '<$1th')
    })
  })
}

/* -------------------------------------------------------------------------- */
/* Numbered lists interrupted by their own illustrations                       */
/* -------------------------------------------------------------------------- */

/**
 * The numbering instance behind every list paragraph, in document order.
 *
 * `w:numId` points at a *numbering instance* in word/numbering.xml, not at a
 * style. Word gives a list that starts over at 1 a brand-new instance, and
 * reuses the instance for every paragraph that continues an existing count —
 * which makes it the only reliable evidence for whether two `<ol>` elements are
 * one list split by an interruption or two lists that each start at 1.
 *
 * A list paragraph with nothing visible in it is left out, because mammoth
 * drops it rather than emitting an empty `<li>`, and the sequence has to line
 * up with the emitted items one for one to be usable at all.
 */
async function listNumIds(bytes: Buffer): Promise<string[]> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const doc = zip.files['word/document.xml']
    if (!doc) return []
    const xml = await doc.async('string')
    const ids: string[] = []
    // Paragraphs inside a table are found too, and in document order: mammoth
    // emits their list items in that same order, inside the cell.
    for (const paragraph of scanElements(xml, ['w:p'])) {
      const props = scanElements(paragraph.inner, ['w:pPr'])[0]?.xml ?? ''
      // <w:pPrChange> carries the properties the paragraph had BEFORE a tracked
      // edit; its numbering is history, not what Word renders today.
      const live = props.replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, '')
      const numId = /<w:numPr\b[\s\S]*?<w:numId\b[^>]*\bw:val="(\d+)"/.exec(live)?.[1]
      // numId 0 is how Word switches numbering off for a single paragraph.
      if (!numId || numId === '0') continue
      const visible =
        /<w:(drawing|pict|object)\b/.test(paragraph.xml) ||
        [...paragraph.xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].some((m) => m[1].trim() !== '')
      if (visible) ids.push(numId)
    }
    return ids
  } catch {
    return []
  }
}

interface HtmlList {
  tag: string
  /** Offsets of the whole element, and of the content between its tags. */
  start: number
  open: number
  close: number
  end: number
  /** Every `<li>` under it, nested ones included — one per list paragraph. */
  items: number
}

/** The `<ol>`/`<ul>` elements that are not inside another list, in order. */
function topLevelLists(html: string): HtmlList[] {
  const pattern = /<(\/?)(ol|ul)(?:\s[^>]*)?>/g
  const found: HtmlList[] = []
  let depth = 0
  let open: { tag: string; start: number; open: number } | undefined
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match[1] === '') {
      if (depth === 0) open = { tag: match[2], start: match.index, open: pattern.lastIndex }
      depth++
      continue
    }
    if (depth === 0) continue // a stray close tag: nothing sane to do with it
    depth--
    if (depth > 0 || !open) continue
    const end = pattern.lastIndex
    found.push({
      ...open,
      close: match.index,
      end,
      items: (html.slice(open.start, end).match(/<li[\s>]/g) ?? []).length,
    })
    open = undefined
  }
  return found
}

/** An interrupting fragment as content a list item can legally hold. */
function asItemContent(fragment: string): string {
  // Markup arrives as the block elements mammoth emitted; bare text needs a
  // block of its own, and wrapping a fragment that already has one would nest
  // a <p> inside a <p>.
  return fragment.includes('<') ? fragment : `<p>${fragment}</p>`
}

/**
 * Stitch back together an ordered list that mammoth split into fragments.
 *
 * mammoth ends the `<ol>` at the first paragraph that is not a list item, so a
 * procedure with a screenshot after each step arrives as ten `<ol>` elements
 * holding thirteen `<li>` — and every fragment after the first restarts at "1".
 *
 * The fix has to be *merging*, not `<ol start="n">`: the hub allowlist
 * (src/core/allowlist.ts) permits colspan/rowspan on cells and class on
 * code/pre and no other attribute anywhere, so a `start` would be stripped by
 * any consumer that sanitizes and the numbering would break all over again.
 * Merging needs somewhere to put the interruption, and `<ol>` may hold nothing
 * but `<li>`, so the screenshot goes inside the item it illustrates — which is
 * what it belongs to anyway.
 *
 * Only ordered lists are merged. A split bullet list renders identically either
 * way, so folding its illustration into an item would indent the picture and
 * buy nothing.
 */
const ITEM_AT_END = /<\/li>\s*$/

export function mergeInterruptedOrderedLists(html: string, numIds: string[]): string {
  const lists = topLevelLists(html)
  if (lists.length < 2 || numIds.length === 0) return html
  // The numbering can only be attached to the right items when every emitted
  // <li> answers to exactly one list paragraph. When the totals disagree —
  // numbering carried by a paragraph style, an item mammoth dropped — there is
  // no way to tell which instance an item belongs to, so nothing is merged.
  if (lists.reduce((total, list) => total + list.items, 0) !== numIds.length) return html
  let cursor = 0
  const spans = lists.map((list) => {
    const span = numIds.slice(cursor, cursor + list.items)
    cursor += list.items
    return span
  })
  const inner = (i: number): string => html.slice(lists[i].open, lists[i].close)
  const continues = (a: number, b: number): boolean =>
    lists[a].tag === 'ol' &&
    lists[b].tag === 'ol' &&
    spans[a][spans[a].length - 1] === spans[b][0] &&
    // The interruption is folded into the item it followed, so there has to be
    // one to fold it into; without this guard an unexpected shape would drop it.
    ITEM_AT_END.test(inner(a))

  const out: string[] = []
  let read = 0
  for (let i = 0; i < lists.length; i++) {
    let last = i
    while (last + 1 < lists.length && continues(last, last + 1)) last++
    if (last === i) continue
    out.push(html.slice(read, lists[i].start))
    let merged = inner(i)
    for (let k = i + 1; k <= last; k++) {
      const between = html.slice(lists[k - 1].end, lists[k].start).trim()
      // Whatever stood between the fragments belongs to the item it followed.
      if (between !== '') merged = merged.replace(ITEM_AT_END, () => `${asItemContent(between)}</li>`)
      merged += inner(k)
    }
    out.push(`<ol>${merged}</ol>`)
    read = lists[last].end
    i = last
  }
  if (out.length === 0) return html
  out.push(html.slice(read))
  return out.join('')
}

/* -------------------------------------------------------------------------- */
/* Tab stops                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a Word tab becomes. HTML collapses a raw tab to a single space, which
 * glued every table-of-contents entry to its page number: "Steps of Design
 * Page 3" reads as one string, and there is no way back to two fields from it.
 *
 * No-break spaces rather than a tab, a dot leader or CSS, because the gap has
 * to survive the targets that have no stylesheet at all — txt, md, docx, csv —
 * and a run of U+00A0 is the one thing that comes through every writer intact
 * while still being nothing but whitespace. Four of them is a gap no reader can
 * mistake for a word space; Word's own tab stop width cannot be honoured here,
 * since the hub has no way to carry it.
 */
const TAB_GAP = '\u00a0'.repeat(4)

/** Replace tabs in text with a gap that does not collapse, leaving tags alone. */
export function keepTabsVisible(html: string): string {
  if (!html.includes('\t')) return html
  return html.replace(/<[^>]*>|[^<]+/g, (chunk) =>
    chunk.startsWith('<') ? chunk : chunk.replace(/\t/g, TAB_GAP),
  )
}

/**
 * Field codes whose result is page furniture rather than content.
 *
 * A header carrying only these is a page number or a printed-on date; it must
 * never become the document's title. Word stores the last-computed result in a
 * <w:t>, so the text alone looks like ordinary content — the instruction is
 * the only reliable tell.
 */
const FURNITURE_FIELD =
  /\b(PAGE|NUMPAGES|SECTIONPAGES|DATE|TIME|FILENAME|AUTHOR|SAVEDATE|PRINTDATE|CREATEDATE)\b/i

/** "3", "Page 4", "2 of 17", "5/12" — a page number however it was typed. */
const PAGE_NUMBER = /^(page\s*)?\d+(\s*(of|\/|-|—)\s*\d+)?$/i

/**
 * All that survives "Page {PAGE} of {NUMPAGES}" once the fields are stripped:
 * the connective glue between them, and nothing else.
 */
const FIELD_GLUE = /^(page|pg\.?|p\.|of|out of)?[\s\W]*$/i

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
/** A date on its own line: "October 11, 2023", "11 October 2023". */
const DATE_ONLY = new RegExp(`^(?:${MONTH}\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+${MONTH},?\\s+\\d{2,4})$`, 'i')

/** Standing notices that say nothing about *this* document. */
const BOILERPLATE = /^(draft|confidential|internal|internal use only|do not distribute|proprietary(\s*(&|and)\s*confidential)?)$/i

/**
 * A title is short. Anything longer is a running notice — a confidentiality
 * banner, a distribution list — that would only add noise at the top of the
 * converted document.
 */
const MAX_TITLE_LENGTH = 120

/**
 * Remove the runs a furniture field contributes, leaving real text behind.
 *
 * Both field shapes have to go: the compact <w:fldSimple>, and the complex
 * begin/instrText/separate/result/end run sequence. The complex form is cut as
 * a flat span, which leaves torn <w:r> tags behind — harmless, because only
 * <w:t> content is read afterwards. Nested fields (a field inside a field's
 * result) would cut too little; they do not occur in headers.
 */
function stripFurnitureFields(xml: string): string {
  let out = xml.replace(
    /<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/>[\s\S]*?<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>/g,
    (field) => {
      const instr = /<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/.exec(field)?.[1] ?? ''
      return FURNITURE_FIELD.test(instr) ? '' : field
    },
  )
  for (const field of scanElements(out, ['w:fldSimple'])) {
    const instr = /\bw:instr="([^"]*)"/.exec(field.xml)?.[1] ?? ''
    if (FURNITURE_FIELD.test(instr)) out = out.replace(field.xml, '')
  }
  return out
}

/** Visible text of one <w:p>, with tabs and breaks kept as spaces. */
function paragraphText(xml: string): string {
  const spaced = stripFurnitureFields(xml).replace(/<w:(tab|br|cr)\b[^>]*>/g, ' ')
  const runs = [...spaced.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1]))
  return runs.join('').replace(/\s+/g, ' ').trim()
}

/**
 * The title-like text of a header part, or nothing if it is page furniture.
 *
 * Exported for the sake of the furniture rules, which are the whole risk here:
 * promoting a page number or a date to the document's title is worse than
 * dropping the header entirely.
 */
export function headerTitleFromXml(xml: string): string | undefined {
  const text = scanElements(xml, ['w:p'])
    .map((p) => paragraphText(p.xml))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length < 2 || text.length > MAX_TITLE_LENGTH) return undefined
  // No letters at all means a number, a date, or a rule of dashes.
  if (!/[A-Za-z]/.test(text)) return undefined
  if (PAGE_NUMBER.test(text) || DATE_ONLY.test(text) || BOILERPLATE.test(text)) return undefined
  if (FIELD_GLUE.test(text)) return undefined
  return text
}

/**
 * The document's page header, read straight from the zip.
 *
 * mammoth only converts word/document.xml, so headers never reach the hub —
 * and on form-style documents (the corpus supply request) the header holds
 * the only statement of what the document *is*. Footers are deliberately not
 * read: they are page furniture (page numbers, confidentiality notices) and
 * dropping them is correct.
 *
 * Several header parts can exist for one section — first page, even pages,
 * everything else. The default one is the document's own; a first-page part
 * usually repeats it, so it is only consulted when the default is missing or
 * turns out to be furniture.
 */
async function headerTitle(bytes: Buffer): Promise<string | undefined> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const docPart = zip.files['word/document.xml']
    const relsPart = zip.files['word/_rels/document.xml.rels']
    if (!docPart || !relsPart) return undefined
    const [doc, rels] = await Promise.all([docPart.async('string'), relsPart.async('string')])
    const targets = new Map<string, string>()
    for (const rel of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
      if (!/relationships\/header/.test(rel)) continue
      const id = /\bId="([^"]+)"/.exec(rel)?.[1]
      const target = /\bTarget="([^"]+)"/.exec(rel)?.[1]
      if (id && target) targets.set(id, target)
    }
    if (targets.size === 0) return undefined
    const refs = [...doc.matchAll(/<w:headerReference\b[^>]*>/g)].map((m) => ({
      type: /\bw:type="([^"]*)"/.exec(m[0])?.[1] ?? 'default',
      id: /\br:id="([^"]*)"/.exec(m[0])?.[1] ?? '',
    }))
    // Stable sort: default first, then first-page, then even — and within a
    // rank, the earliest section wins, so a title is taken from the front of
    // the document rather than from some later section's banner.
    const rank = (type: string): number => (type === 'default' ? 0 : type === 'first' ? 1 : 2)
    refs.sort((a, b) => rank(a.type) - rank(b.type))
    const seen = new Set<string>()
    for (const ref of refs) {
      const target = targets.get(ref.id)
      if (!target) continue
      const name = target.startsWith('/') ? target.slice(1) : `word/${target}`
      // Sections routinely share one header part; read each part only once so
      // an eight-section document cannot yield the same title eight times.
      if (seen.has(name) || !zip.files[name]) continue
      seen.add(name)
      const title = headerTitleFromXml(await zip.files[name].async('string'))
      if (title) return title
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Body text, tags and entities gone, for a case-insensitive containment test. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * Fold the page header into the hub document.
 *
 * It goes in as an <h1> at the very top rather than only as `title`, because
 * `title` reaches almost nothing downstream: txt, md, docx, csv, json and xlsx
 * writers never read it, so a header left there would still vanish from every
 * target the way it does today. As a heading it survives into all of them, and
 * `title` is set alongside so the html <title> and the pdf running head get it
 * too. It is emitted once for the whole document, never once per page.
 */
function withHeaderTitle(html: string, header: string | undefined): HubDocument {
  if (!header) return { html }
  // A body that opens with its own heading already states what it is; adding
  // the page banner above it would give the document two competing titles.
  if (/^\s*<h[1-3][\s>]/i.test(html)) return { html }
  // Already said in the body (form documents often repeat the banner): keep it
  // as the title, but do not print it twice.
  if (plainText(html).includes(plainText(header).trim())) return { html, title: header }
  return { html: `<h1>${escapeHtml(header)}</h1>\n${html}`, title: header }
}

/* -------------------------------------------------------------------------- */
/* Inline images                                                               */
/* -------------------------------------------------------------------------- */

/**
 * mammoth's default image handler inlines every picture as a data URI with no
 * ceiling of any kind, so a 39 KB document holding twelve heavily deflated 3 MB
 * PNGs became a 48 MB hub string. The same budget the URL and email intakes
 * already enforce is applied here instead (src/core/inline-images.ts).
 *
 * An image the budget refuses is left with no `src`, which
 * `replaceUninlinedImages` below turns into its alt text — the shape
 * `sanitizeToHub` already uses for an <img> whose src it had to strip. mammoth
 * gives no way to emit anything but an <img> from here.
 */
function budgetedImageConverter(ledger: ImageLedger): ReturnType<typeof mammoth.images.imgElement> {
  return mammoth.images.imgElement(async (image) => {
    const bytes = await image.readAsBuffer()
    if (!ledger.admit(bytes.byteLength)) {
      // mammoth's types insist on a src; leaving it out is the whole point.
      return {} as { src: string }
    }
    return { src: `data:${image.contentType};base64,${bytes.toString('base64')}` }
  })
}

/** `<img>` with no `src` attribute — quote-aware, so an alt holding `>` is safe. */
const IMG_WITHOUT_SRC = /<img\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi

/**
 * Every `<img>` the converter above refused becomes its alt text, in place.
 *
 * Inline rather than a block: mammoth emits pictures inside the paragraph they
 * sit in, and a `<p>` there would nest a block inside a block.
 */
export function replaceUninlinedImages(html: string): string {
  if (!html.includes('<img')) return html
  return html.replace(IMG_WITHOUT_SRC, (tag) => {
    if (/(?<![\w:.-])src\s*=/i.test(tag)) return tag
    // mammoth escapes `&`, `<`, `>` and `"` in attribute values, so the alt can
    // be lifted into text as it stands.
    const alt = /(?<![\w:.-])alt="([^"]*)"/i.exec(tag)?.[1]?.trim()
    return imagePlaceholder(alt ? `${alt} — ${OVER_BUDGET}` : OVER_BUDGET, 'inline')
  })
}

/**
 * Word footnotes and endnotes in the hub's model (src/core/footnotes.ts).
 *
 * mammoth writes a note as `<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup>`
 * and a list of `<li id="footnote-1">…<a href="#footnote-ref-1">↑</a></li>`;
 * endnotes the same with `endnote-`. The hub has no internal links, so those
 * arrived as the text "[1]" and a list ending in a stray "↑". Footnote N
 * becomes label `N`, endnote N `eN`; the ↑ back-link goes (writers make their
 * own); the lists become one notes list, numbered later from first reference.
 */
export function wordNotesToHub(html: string): string {
  if (!/href="#(?:foot|end)note-\d+"/.test(html)) return html
  const root = parseDocument(html)
  const label = (kind: string, n: string): string => (kind === 'foot' ? n : `e${n}`)
  const items: Element[] = []
  const lists = new Set<Element>()
  const walk = (nodes: AnyNode[]): void => {
    for (const node of [...nodes]) {
      if (!(node instanceof Element)) continue
      const ref = node.name === 'sup' ? refTarget(node) : null
      if (ref) {
        node.attribs = { 'data-fn': label(ref[1], ref[2]) }
        node.children = []
        setText(node, ref[2])
        continue
      }
      const note = node.name === 'li' ? /^(foot|end)note-(\d+)$/.exec(node.attribs.id ?? '') : null
      if (note) {
        node.attribs = { 'data-fn': label(note[1], note[2]) }
        dropBackLinks(node)
        items.push(node)
        if (node.parent instanceof Element && node.parent.name === 'ol') lists.add(node.parent)
        continue
      }
      walk(node.children as AnyNode[])
    }
  }
  walk(root.children as AnyNode[])
  for (const ol of lists) {
    const parent = ol.parent as ParentNode | null
    if (!parent) continue
    parent.children.splice(parent.children.indexOf(ol), 1)
  }
  if (items.length > 0) {
    const ol = new Element('ol', {}, items)
    for (const li of items) li.parent = ol
    root.children.push(ol)
  }
  return render(root.children, { encodeEntities: 'utf8' })
}

function refTarget(sup: Element): RegExpExecArray | null {
  const kids = sup.children.filter((c) => !(c.type === 'text' && !(c as { data: string }).data.trim()))
  const a = kids.length === 1 && kids[0] instanceof Element && kids[0].name === 'a' ? kids[0] : null
  return a ? /^#(foot|end)note-(\d+)$/.exec(a.attribs.href ?? '') : null
}

function setText(el: Element, text: string): void {
  const t = parseDocument(text).children
  el.children = t
  for (const c of t) c.parent = el
}

/** Remove the ↑ link back to the reference, and the space mammoth puts before it. */
function dropBackLinks(li: Element): void {
  const visit = (el: Element): void => {
    el.children = el.children.filter((c) => {
      if (c instanceof Element && c.name === 'a' && /^#(?:foot|end)note-ref-\d+$/.test(c.attribs.href ?? '')) return false
      if (c instanceof Element) visit(c)
      return true
    })
    const last = el.children[el.children.length - 1] as { type?: string; data?: string } | undefined
    if (last?.type === 'text' && typeof last.data === 'string') last.data = last.data.replace(/\s+$/, '')
    el.children.forEach((c, i) => {
      c.parent = el
      c.prev = el.children[i - 1] ?? null
      c.next = el.children[i + 1] ?? null
    })
  }
  visit(li)
}

/* -------------------------------------------------------------------------- */
/* Word equations                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Word equations as formulas (spec B12). mammoth does not know OMML and drops
 * `m:oMath` silently ("Inline x² end." became "Inline  end."), so each
 * equation is taken out of the XML before mammoth sees it, turned into TeX
 * (src/core/omml-tex.ts), and put back afterwards as the hub's math (B1).
 *
 * What stands in for it meanwhile is an ordinary text run holding a marker:
 * private-use characters around a prefix the document's own text does not
 * contain, and the equation's number. mammoth carries text through untouched,
 * into footnotes and endnotes too, so the marker lands exactly where the
 * equation stood.
 */
export interface WordEquation {
  tex: string
  /** An `m:oMathPara`: a math paragraph, drawn on a line of its own when it is alone in its paragraph. */
  display: boolean
  /** Some element was not understood and is its linear text in `tex`. */
  partial: boolean
}

/** The parts mammoth reads that can hold equations. */
const MATH_PARTS = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']

/** A marker prefix the text of none of the parts contains. */
export function equationMarker(xmls: string[]): string {
  // The text as mammoth will see it: a private-use character can be written
  // as a character reference too.
  const reference = new RegExp(`&#(?:x0*e000|0*${0xe000});`, 'gi')
  const texts = xmls.map((x) => x.replace(reference, '\ue000'))
  let marker = '\ue000eq'
  for (let i = 0; texts.some((t) => t.includes(marker)); i++) marker = `\ue000eq${i.toString(36)}x`
  return marker
}

/**
 * Replace every top-level `m:oMathPara` / `m:oMath` of one part with a marker
 * run, appending each equation's TeX to `equations` in document order.
 */
export function takeEquations(xml: string, marker: string, equations: WordEquation[]): string {
  if (!xml.includes('<m:oMath')) return xml
  const found = scanElements(xml, ['m:oMathPara', 'm:oMath'])
  if (found.length === 0) return xml
  let out = ''
  let cursor = 0
  for (const el of found) {
    const at = xml.indexOf(el.xml, cursor)
    if (at < 0) continue
    const display = el.name === 'm:oMathPara'
    // Parsed as a fragment: the reader matches prefixed names, so the
    // namespace declarations on the part's root are not needed.
    const fragment = el.xml
    let eq: WordEquation
    try {
      const { tex, unknown } = ommlToTex(fragment, { display })
      eq = { tex, display, partial: unknown.length > 0 }
    } catch {
      // Never dropped: at worst, the equation's own characters.
      eq = { tex: safeLinear(fragment), display, partial: true }
    }
    out += xml.slice(cursor, at) + `<w:r><w:t>${marker}${equations.length}\ue001</w:t></w:r>`
    equations.push(eq)
    cursor = at + el.xml.length
  }
  return out + xml.slice(cursor)
}

function safeLinear(fragment: string): string {
  try {
    return ommlLinearText(fragment).replace(/[\\{}%#&_$^~]/g, (c) => (c === '\\' ? '\\backslash ' : c === '^' ? '\\hat{}' : c === '~' ? '\\sim ' : `\\${c}`))
  } catch {
    return ''
  }
}

/**
 * Whether a Word file holds equations, without converting it: the add-time
 * features hint (src/core/features-hint.ts) for a docx. Only the three XML
 * parts are inflated, so this is cheap even for a file full of pictures.
 * Undefined when the bytes are not a readable package.
 */
export async function docxHasEquations(bytes: Buffer): Promise<boolean | undefined> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    for (const name of MATH_PARTS) {
      if (zip.files[name] && (await zip.files[name].async('string')).includes('<m:oMath')) return true
    }
    return zip.files['word/document.xml'] ? false : undefined
  } catch {
    return undefined
  }
}

/** The package with its equations replaced by markers, or undefined when it has none. */
async function extractEquations(
  bytes: Buffer,
): Promise<{ bytes: Buffer; marker: string; equations: WordEquation[] } | undefined> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const parts = MATH_PARTS.filter((name) => zip.files[name])
    const xmls = await Promise.all(parts.map((name) => zip.files[name].async('string')))
    if (!xmls.some((x) => x.includes('<m:oMath'))) return undefined
    const marker = equationMarker(xmls)
    const equations: WordEquation[] = []
    parts.forEach((name, i) => zip.file(name, takeEquations(xmls[i], marker, equations)))
    if (equations.length === 0) return undefined
    return { bytes: await zip.generateAsync({ type: 'nodebuffer' }), marker, equations }
  } catch {
    return undefined
  }
}

/**
 * Put each equation back where its marker stands: a math paragraph alone in
 * its paragraph as display math, everything else as inline math (B12, B1).
 * A marker that cannot be matched is removed, so none ever reaches the hub.
 */
export function restoreEquations(html: string, marker: string, equations: WordEquation[]): string {
  const m = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const token = `${m}(\\d+)\ue001`
  const eq = (n: string): WordEquation | undefined => equations[Number(n)]
  // mammoth writes a bookmark as an empty <a id>, and ends a note's last
  // paragraph with its ↑ link back to the reference (wordNotesToHub drops it
  // anyway); neither stops the equation being alone in its paragraph.
  const filler = '(?:\\s|<a id="[^"]*"></a>|<a href="#(?:foot|end)note-ref-\\d+">↑</a>)*'
  let out = html.replace(new RegExp(`<p>${filler}${token}${filler}</p>`, 'g'), (whole, n: string) => {
    const e = eq(n)
    if (!e?.display) return whole
    return e.tex ? `<pre><code class="language-math">${escapeHtml(e.tex)}</code></pre>` : ''
  })
  out = out.replace(new RegExp(token, 'g'), (_, n: string) => {
    const e = eq(n)
    return e?.tex ? `<code class="language-math">${escapeHtml(e.tex)}</code>` : ''
  })
  // Anything left of a marker (torn by something upstream) goes too.
  return out.replace(new RegExp(`${m}\\d*\ue001?`, 'g'), '')
}

/** One notice per document for equations with parts that are only linear text. */
function equationNotice(equations: WordEquation[], ctx?: ReadContext): void {
  const n = equations.filter((e) => e.partial).length
  if (n === 0) return
  ctx?.onAdvice?.(
    'equation-partial',
    n === 1
      ? 'One equation has a part that could not be read as a formula; that part is shown as plain characters.'
      : `${n} equations have parts that could not be read as formulas; those parts are shown as plain characters.`,
  )
}

export async function readDocx(src: SourceInput, ctx?: ReadContext): Promise<HubDocument> {
  const ledger = createImageLedger(archiveInlineBudget(src.bytes.byteLength))
  const math = await extractEquations(src.bytes)
  // The package mammoth and the list scan read: with markers where equations
  // were, so a paragraph holding only an equation is not taken for empty.
  const bytes = math?.bytes ?? src.bytes
  const [{ value }, flags, header, numIds] = await Promise.all([
    mammoth.convertToHtml({ buffer: bytes }, { convertImage: budgetedImageConverter(ledger) }),
    headerFlags(bytes),
    headerTitle(bytes),
    listNumIds(bytes),
  ])
  const converted = math ? restoreEquations(value, math.marker, math.equations) : value
  if (math) equationNotice(math.equations, ctx)
  const html = keepTabsVisible(
    mergeInterruptedOrderedLists(promoteHeaderRows(replaceUninlinedImages(converted), flags), numIds),
  )
  return withHeaderTitle(wordNotesToHub(html), header)
}
