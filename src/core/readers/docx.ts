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
import { MATH_NAMESPACES, ommlLinearText, ommlToTex } from '../omml-tex'
import { codeBookmarkLanguage } from '../code-bookmark'
import { markOpenTag, WORD_HIGHLIGHTS } from '../mark'
import { zipPartsMatch } from '../zip-scan'
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
 * mistake for a word space; Word's own tab stop width cannot be honored here,
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
 * PNGs became a 48 MB hub string. The archive budget, which bounds what a file
 * may expand to by its own size, is applied here instead
 * (src/core/inline-images.ts).
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
/* Code blocks                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Code blocks, which mammoth reads as ordinary paragraphs: it keeps no font,
 * and the paragraphs' leading spaces then collapse in every writer, so a
 * listing came back as prose with its indentation gone.
 *
 * A paragraph is code when its style says so (Word's "HTML Preformatted",
 * pandoc's "Source Code", a "Code" style) or when every run that shows text is
 * in a monospace font, by its own font, its character style or its paragraph
 * style. That covers our own docx writer, which sets a block in Courier as
 * one paragraph with a break per line, and Word's one paragraph per line.
 * Consecutive code paragraphs are one block. As with equations, each block is
 * taken out of the XML before mammoth sees it and stands as a marker meanwhile;
 * the block's text comes back as `<pre><code>`. Its language is the one our
 * docx writer named in a hidden bookmark around it (code-bookmark.ts), when
 * there is one; otherwise convert.ts guesses it as it does for any unnamed
 * block (Word keeps no language).
 *
 * Not a code block: a word of code in a sentence (the paragraph is not all
 * monospace), a heading or list paragraph, and a one-line monospace paragraph
 * in a table cell (an ID column, not a listing). Those are inline code
 * instead (see markInlineCode). A block inside a list item, which our writer
 * puts after a break in the item's paragraph, is read there (see
 * takeItemCodeBlocks).
 */

/** Style names that mean a code block, compared lower case without spaces or dashes. */
const CODE_STYLE_NAMES = new Set(['htmlpreformatted', 'preformattedtext', 'sourcecode', 'code', 'codeblock'])

const MONOSPACE =
  /\bmono\b|^(?:courier|consolas|menlo|monaco|lucida console|lucida sans typewriter|inconsolata|source code pro|cascadia code|fira code|andale mono)/i

interface WordStyle {
  id: string
  name: string
  basedOn?: string
  /** The font the style's own run properties name, if any. */
  font?: string
}

/** The font a run-properties fragment names: its ascii face, else hAnsi; a theme font is not monospace. */
function rPrFont(rPr: string): string | undefined {
  const fonts = /<w:rFonts\b([^>]*)>/.exec(rPr)?.[1]
  if (!fonts) return undefined
  const face = /\bw:(?:ascii|hAnsi)="([^"]*)"/.exec(fonts)?.[1]
  if (face) return decodeXml(face)
  return /\bw:(?:ascii|hAnsi)Theme="/.test(fonts) ? 'theme' : undefined
}

function parseWordStyles(xml: string): Map<string, WordStyle> {
  const styles = new Map<string, WordStyle>()
  for (const el of scanElements(xml, ['w:style'])) {
    const id = /\bw:styleId="([^"]*)"/.exec(el.xml)?.[1]
    if (!id) continue
    const rPr = scanElements(el.inner, ['w:rPr'])[0]?.xml ?? ''
    styles.set(id, {
      id,
      name: decodeXml(/<w:name\b[^>]*\bw:val="([^"]*)"/.exec(el.inner)?.[1] ?? id),
      basedOn: /<w:basedOn\b[^>]*\bw:val="([^"]*)"/.exec(el.inner)?.[1],
      font: rPrFont(rPr),
    })
  }
  return styles
}

/** A style and the styles it is based on, nearest first. */
function styleChain(styles: Map<string, WordStyle>, id: string | undefined): WordStyle[] {
  const chain: WordStyle[] = []
  for (let at = id; at !== undefined && chain.length < 16; ) {
    const style = styles.get(at)
    if (!style || chain.includes(style)) break
    chain.push(style)
    at = style.basedOn
  }
  return chain
}

const styleFont = (styles: Map<string, WordStyle>, id: string | undefined): string | undefined =>
  styleChain(styles, id).find((s) => s.font !== undefined)?.font

const styleKey = (name: string): string => name.toLowerCase().replace(/[\s_-]+/g, '')
const codeName = (name: string): boolean => CODE_STYLE_NAMES.has(styleKey(name))

/** The paragraph style, or one it is based on, is a code style by its name or its id. */
const isCodeStyle = (styles: Map<string, WordStyle>, id: string | undefined): boolean =>
  (id !== undefined && codeName(id)) || styleChain(styles, id).some((s) => codeName(s.name) || codeName(s.id))

/** A paragraph's text as written: tabs, breaks and spaces kept. Deleted text and field codes are left out. */
function codeParagraphText(inner: string): string {
  const body = inner
    .replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/, '')
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, '')
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '')
  let text = ''
  for (const m of body.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr|noBreakHyphen)\b[^>]*\/>/g)) {
    if (m[1] !== undefined) text += decodeXml(m[1])
    else text += m[2] === 'tab' ? '\t' : m[2] === 'noBreakHyphen' ? '-' : '\n'
  }
  return text
}

/** A code block taken out of the XML: its text, and the language its bookmark names. */
export interface CodeBlock {
  text: string
  language?: string
}

/** The start of one of our language bookmarks (code-bookmark.ts). */
const CODE_BOOKMARK = /<w:bookmarkStart\b[^>]*\bw:name="(_DocConvCode_[^"]*)"[^>]*\/>/

/** The language the first of our bookmarks starting in `xml` names, if any and readable. */
const bookmarkLanguage = (xml: string): string | undefined => {
  const name = CODE_BOOKMARK.exec(xml)?.[1]
  return name === undefined ? undefined : codeBookmarkLanguage(decodeXml(name))
}

/**
 * Our language bookmarks taken out, start and end, so mammoth makes no
 * anchor of them: on a block they have done their work, and on text that is
 * no longer code (its font changed) they name nothing.
 */
function dropCodeBookmarks(xml: string): string {
  const starts = new RegExp(CODE_BOOKMARK.source, 'g')
  const ids = new Set([...xml.matchAll(starts)].map((m) => /\bw:id="([^"]*)"/.exec(m[0])?.[1]))
  if (!ids.size) return xml
  return xml.replace(starts, '').replace(/<w:bookmarkEnd\b[^>]*\bw:id="([^"]*)"[^>]*\/>/g, (end, id: string) => (ids.has(id) ? '' : end))
}

/** Bookmarks between two paragraphs are not anything between them. */
const BOOKMARK = /<w:bookmark(?:Start|End)\b[^>]*\/>/g

interface CodeParagraph {
  start: number
  end: number
  text: string
  /** Where the paragraph before it ends: one of our bookmarks there starts this block. */
  from: number
}

/**
 * Whether one `<w:p>` is code, and its text if so; `byStyle` when its style
 * says so rather than its fonts. With `fonts` false only the style counts.
 */
function asCodeParagraph(
  paragraph: string,
  styles: Map<string, WordStyle>,
  inTable: boolean,
  fonts: boolean,
): { text: string; byStyle: boolean } | undefined {
  const pPr = /^<w:p\b[^>]*>\s*(<w:pPr\b[\s\S]*?<\/w:pPr>)/.exec(paragraph)?.[1] ?? ''
  if (/<w:numPr\b|<w:outlineLvl\b/.test(pPr)) return undefined
  if (/<w:(?:drawing|pict|object|txbxContent)\b|<(?:[\w-]+:)?oMath/.test(paragraph)) return undefined
  const pStyle = /<w:pStyle\b[^>]*\bw:val="([^"]*)"/.exec(pPr)?.[1]
  if (pStyle && /^heading|^title$/i.test(pStyle)) return undefined
  const text = codeParagraphText(paragraph)
  if (isCodeStyle(styles, pStyle)) return { text, byStyle: true }
  if (!fonts) return undefined
  const paragraphFont = styleFont(styles, pStyle)
  let shown = false
  for (const r of scanElements(paragraph.replace(/<w:del\b[\s\S]*?<\/w:del>/g, ''), ['w:r'])) {
    if (codeParagraphText(r.inner).trim() === '') continue
    shown = true
    const rPr = scanElements(r.inner, ['w:rPr'])[0]?.xml ?? ''
    const rStyle = /<w:rStyle\b[^>]*\bw:val="([^"]*)"/.exec(rPr)?.[1]
    const font = rPrFont(rPr) ?? styleFont(styles, rStyle) ?? paragraphFont
    if (!font || !MONOSPACE.test(font)) return undefined
  }
  if (!shown) {
    // An empty paragraph between two lines of code is a blank line in it.
    const markFont = rPrFont(scanElements(pPr, ['w:rPr'])[0]?.xml ?? '') ?? paragraphFont
    return markFont && MONOSPACE.test(markFont) ? { text, byStyle: false } : undefined
  }
  if (inTable && !text.includes('\n')) return undefined
  return { text, byStyle: false }
}

/**
 * Whether the document's own body face is monospace (its default paragraph
 * style or its run defaults): a screenplay or a typewritten letter, where the
 * font says nothing about code.
 */
function monospaceBody(stylesXml: string, styles: Map<string, WordStyle>): boolean {
  const defaults = /<w:docDefaults\b[\s\S]*?<\/w:docDefaults>/.exec(stylesXml)?.[0] ?? ''
  const normal = /<w:style\b(?=[^>]*\bw:type="paragraph")(?=[^>]*\bw:default="(?:1|true)")[^>]*\bw:styleId="([^"]*)"/.exec(stylesXml)?.[1]
  const face = styleFont(styles, normal) ?? rPrFont(defaults)
  return face !== undefined && MONOSPACE.test(face)
}

/**
 * Past this many paragraphs with text, a document whose paragraphs are nearly
 * all (MONOSPACE_SHARE) monospace by their fonts alone is set in that face, not
 * full of code. Our own writer makes a code block one paragraph, so its output
 * never comes near.
 */
const MONOSPACE_DOCUMENT_MIN = 20
const MONOSPACE_SHARE = 0.8

/**
 * Replace each run of code paragraphs in `xml` (word/document.xml) with one
 * marker paragraph, appending each block's text and language to `blocks` in
 * order. With `inline`, the runs of code left in sentences are given that
 * style id too. Our language bookmarks are taken out (dropCodeBookmarks); one
 * starting in a paragraph also starts a new block, so two blocks written one
 * after the other stay two.
 */
export function takeCodeBlocks(xml: string, stylesXml: string, marker: string, blocks: CodeBlock[], inline?: string): string {
  const styles = parseWordStyles(stylesXml)
  // Where each table lies, to tell a paragraph in a cell.
  const tables: [number, number][] = []
  let from = 0
  for (const t of scanElements(xml, ['w:tbl'])) {
    const at = xml.indexOf(t.xml, from)
    if (at < 0) continue
    tables.push([at, at + t.xml.length])
    from = at + t.xml.length
  }
  const inTable = (at: number): boolean => tables.some(([s, e]) => at > s && at < e)

  const fonts = !monospaceBody(stylesXml, styles)
  const found: { start: number; end: number; code?: { text: string; byStyle: boolean } }[] = []
  let shown = 0
  let byFont = 0
  let cursor = 0
  for (const p of scanElements(xml, ['w:p'])) {
    const at = xml.indexOf(p.xml, cursor)
    if (at < 0) continue
    cursor = at + p.xml.length
    const code = asCodeParagraph(p.xml, styles, inTable(at), fonts)
    found.push({ start: at, end: cursor, code })
    if (!/<w:t(?:\s[^>]*)?>[^<]*\S/.test(p.xml)) continue
    shown++
    if (code && !code.byStyle) byFont++
  }
  const setInMonospace = shown >= MONOSPACE_DOCUMENT_MIN && byFont > shown * MONOSPACE_SHARE

  const groups: CodeParagraph[][] = []
  let group: CodeParagraph[] = []
  const close = (): void => {
    // Blank lines at either end of a block are not part of it.
    while (group.length && group[0].text.trim() === '') group.shift()
    while (group.length && group[group.length - 1].text.trim() === '') group.pop()
    if (group.length) groups.push(group)
    group = []
  }
  let previous = 0
  for (const { start, end, code } of found) {
    if (!code || (setInMonospace && !code.byStyle)) close()
    else {
      const prev = group[group.length - 1]
      if (prev && (xml.slice(prev.end, start).replace(BOOKMARK, '').trim() !== '' || CODE_BOOKMARK.test(xml.slice(prev.end, end)))) close()
      group.push({ start, end, text: code.text, from: previous })
    }
    previous = end
  }
  close()

  let out = ''
  let last = 0
  for (const g of groups) {
    out += xml.slice(last, g[0].start) + `<w:p><w:r><w:t>${marker}${blocks.length}\ue001</w:t></w:r></w:p>`
    blocks.push({ text: g.map((p) => p.text).join('\n'), language: bookmarkLanguage(xml.slice(g[0].from, g[g.length - 1].end)) })
    last = g[g.length - 1].end
  }
  out += xml.slice(last)
  if (fonts && !setInMonospace) out = takeItemCodeBlocks(out, styles, marker, blocks)
  out = dropCodeBookmarks(out)
  // The blocks are markers by now, so none of their runs is read as inline code.
  return inline === undefined ? out : markInlineCode(out, styles, inline, fonts && !setInMonospace)
}

/** A line break inside a paragraph (not a page or column break). */
const LINE_BREAK = /<w:br\b(?![^>]*\bw:type="(?:page|column)")[^>]*\/>|<w:cr\b[^>]*\/>/g

/** The parts of a paragraph between its properties and its end that can hold runs. */
const PARAGRAPH_CHILDREN = ['w:r', 'w:hyperlink', 'w:ins', 'w:del', 'w:smartTag', 'w:sdt', 'w:fldSimple', 'w:customXml', 'w:moveTo', 'w:moveFrom']

/**
 * A code block inside a list item. Our docx writer puts it in the item's own
 * paragraph (Word has no block inside a numbered paragraph): the item's text,
 * a break, the block's lines in Courier a break apart (a blank line as two),
 * and, when the item goes on after it, a break and the rest of its text.
 *
 * So in a list paragraph whose first line is ordinary text, each stretch of
 * later lines set wholly in a monospace face (by the same test as a code
 * paragraph's runs, blank lines allowed inside) becomes a marker run, which
 * restoreCodeBlocks makes `<pre><code>` inside the `<li>`, the breaks around
 * it dropped. A list paragraph that is all monospace, or a word of code in
 * one, is left to inline code: Word's own list items look like that, and
 * nothing tells a listing apart. Only with fonts on and the document not set
 * in a monospace face (see takeCodeBlocks).
 */
function takeItemCodeBlocks(xml: string, styles: Map<string, WordStyle>, marker: string, blocks: CodeBlock[]): string {
  if (!xml.includes('<w:numPr')) return xml
  let out = ''
  let last = 0
  let cursor = 0
  for (const p of scanElements(xml, ['w:p'])) {
    const at = xml.indexOf(p.xml, cursor)
    if (at < 0) continue
    cursor = at + p.xml.length
    const fresh = itemCodeParagraph(p.xml, styles, marker, blocks)
    if (fresh === undefined) continue
    out += xml.slice(last, at) + fresh
    last = cursor
  }
  return out + xml.slice(last)
}

/** One list paragraph with its code lines as marker runs, or undefined when it has none. */
function itemCodeParagraph(paragraph: string, styles: Map<string, WordStyle>, marker: string, blocks: CodeBlock[]): string | undefined {
  const head = /^<w:p\b[^>]*>\s*(?:<w:pPr\b[\s\S]*?<\/w:pPr>|<w:pPr\/>)?/.exec(paragraph)![0]
  if (!/<w:numPr\b/.test(head) || /<w:outlineLvl\b/.test(head)) return undefined
  const pStyle = /<w:pStyle\b[^>]*\bw:val="([^"]*)"/.exec(head)?.[1]
  if (pStyle && /^heading|^title$/i.test(pStyle)) return undefined
  const body = paragraph.slice(head.length, paragraph.length - '</w:p>'.length)
  if (!body.match(LINE_BREAK)) return undefined
  const paragraphFont = styleFont(styles, pStyle)
  const monospaceRun = (r: string): boolean => {
    const rPr = /^<w:r\b[^>]*>\s*(<w:rPr\b[\s\S]*?<\/w:rPr>|<w:rPr\/>)?/.exec(r)?.[1] ?? ''
    const rStyle = /<w:rStyle\b[^>]*\bw:val="([^"]*)"/.exec(rPr)?.[1]
    const font = rPrFont(rPr) ?? styleFont(styles, rStyle) ?? paragraphFont
    return font !== undefined && MONOSPACE.test(font)
  }

  // The paragraph as pieces: each break a piece of its own (a run holding
  // text and breaks is split, its properties on each part), and whether each
  // other piece shows text and is all monospace.
  const pieces: { xml: string; isBreak: boolean; shown: boolean; mono: boolean }[] = []
  const piece = (x: string): void => {
    const shown = codeParagraphText(x).trim() !== '' || /<w:(?:drawing|pict|object)\b|<(?:[\w-]+:)?oMath/.test(x)
    const mono = !/<w:(?:drawing|pict|object)\b|<(?:[\w-]+:)?oMath/.test(x) && scanElements(x, ['w:r']).every((r) => codeParagraphText(r.inner).trim() === '' || monospaceRun(r.xml))
    pieces.push({ xml: x, isBreak: false, shown, mono })
  }
  let from = 0
  for (const el of scanElements(body, PARAGRAPH_CHILDREN)) {
    const elAt = body.indexOf(el.xml, from)
    if (elAt < 0) return undefined
    if (elAt > from) piece(body.slice(from, elAt))
    from = elAt + el.xml.length
    const breaks = el.inner.match(LINE_BREAK)
    if (!breaks) {
      piece(el.xml)
      continue
    }
    // A break in a link or a tracked change: not split, so not read.
    if (el.name !== 'w:r') return undefined
    const open = /^<w:r\b[^>]*>/.exec(el.xml)![0]
    const rPr = /^\s*(<w:rPr\b[\s\S]*?<\/w:rPr>|<w:rPr\/>)/.exec(el.inner)?.[1] ?? ''
    const content = el.inner.slice(el.inner.indexOf(rPr) + rPr.length)
    for (const part of content.split(new RegExp(`(${LINE_BREAK.source})`))) {
      if (part === '' || part === undefined) continue
      const x = `${open}${rPr}${part}</w:r>`
      if (part.match(LINE_BREAK)?.[0] === part) pieces.push({ xml: x, isBreak: true, shown: false, mono: false })
      else piece(x)
    }
  }
  if (from < body.length) piece(body.slice(from))

  // The lines between breaks: text, code or blank.
  const lines: { first: number; last: number; kind: 'text' | 'code' | 'blank' }[] = []
  let start = 0
  pieces.forEach((pc, i) => {
    if (!pc.isBreak && i < pieces.length - 1) return
    const end = pc.isBreak ? i - 1 : i
    const own = pieces.slice(start, end + 1)
    const kind = !own.some((o) => o.shown) ? 'blank' : own.every((o) => !o.shown || o.mono) ? 'code' : 'text'
    lines.push({ first: start, last: end, kind })
    start = i + 1
  })
  // The item's own text comes first.
  if (lines.find((l) => l.kind !== 'blank')?.kind !== 'text') return undefined

  const replaced = new Map<number, { last: number; xml: string }>()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'code') continue
    let j = i
    for (let k = i + 1; k < lines.length && lines[k].kind !== 'text'; k++) if (lines[k].kind === 'code') j = k
    const text = lines
      .slice(i, j + 1)
      .map((l) => codeParagraphText(pieces.slice(l.first, l.last + 1).map((pc) => pc.xml).join('')))
      .join('\n')
    replaced.set(lines[i].first, { last: lines[j].last, xml: `<w:r><w:t>${marker}${blocks.length}\ue002</w:t></w:r>` })
    // Our bookmark starts after the break that ends the line before (lines[0] is text).
    const span = pieces.slice(lines[i - 1].last + 1, lines[j].last + 1).map((pc) => pc.xml).join('')
    blocks.push({ text, language: bookmarkLanguage(span) })
    i = j
  }
  if (!replaced.size) return undefined
  let fresh = head
  for (let i = 0; i < pieces.length; i++) {
    const block = replaced.get(i)
    if (block) {
      fresh += block.xml
      i = block.last
    } else fresh += pieces[i].xml
  }
  return fresh + '</w:p>'
}

/**
 * Character styles that mean inline code: Word's "HTML Code" (and its
 * "HTML Typewriter"), pandoc's "Verbatim Char", and plain "Code" styles;
 * compared as CODE_STYLE_NAMES are.
 */
const CODE_CHAR_STYLE_NAMES = new Set(['htmlcode', 'htmltypewriter', 'verbatimchar', 'code', 'codechar', 'inlinecode', 'sourcecode'])

const isCodeCharStyle = (styles: Map<string, WordStyle>, id: string | undefined): boolean =>
  (id !== undefined && CODE_CHAR_STYLE_NAMES.has(styleKey(id))) ||
  styleChain(styles, id).some((s) => CODE_CHAR_STYLE_NAMES.has(styleKey(s.name)) || CODE_CHAR_STYLE_NAMES.has(styleKey(s.id)))

/**
 * Inline code, which mammoth reads as plain text for the same reason: a run
 * in a code character style, or (with `fonts`) in a monospace face by its own
 * font, its character style or its paragraph style, in a paragraph that is
 * not a code block. Our docx writer sets inline code in Courier this way.
 * Each such run is given the style `id`, which readDocx's style map makes
 * `<code>`; mammoth joins neighboring runs into one. A run of only spaces is
 * code only between two runs of code ("npm" " " "test"). `fonts` is false in
 * a document set in a monospace face (see monospaceBody, MONOSPACE_SHARE),
 * where only the styles count.
 */
function markInlineCode(xml: string, styles: Map<string, WordStyle>, id: string, fonts: boolean): string {
  let out = ''
  let last = 0
  let cursor = 0
  for (const p of scanElements(xml, ['w:p'])) {
    const at = xml.indexOf(p.xml, cursor)
    if (at < 0) continue
    cursor = at + p.xml.length
    const pPr = /^<w:p\b[^>]*>\s*(<w:pPr\b[\s\S]*?<\/w:pPr>)/.exec(p.xml)?.[1] ?? ''
    const paragraphFont = styleFont(styles, /<w:pStyle\b[^>]*\bw:val="([^"]*)"/.exec(pPr)?.[1])
    // Each run: whether it is code, and whether it shows only spaces.
    const runs: { at: number; xml: string; rPr: string; rStyle?: string; code: boolean; blank: boolean }[] = []
    let from = 0
    for (const r of scanElements(p.xml, ['w:r'])) {
      const rAt = p.xml.indexOf(r.xml, from)
      if (rAt < 0) continue
      from = rAt + r.xml.length
      if (/<w:(?:footnoteReference|endnoteReference|drawing|pict|object)\b/.test(r.inner)) continue
      const rPr = /^\s*(<w:rPr\b[\s\S]*?<\/w:rPr>|<w:rPr\/>)/.exec(r.inner)?.[1] ?? ''
      const rStyle = /<w:rStyle\b[^>]*\bw:val="([^"]*)"/.exec(rPr)?.[1]
      const font = rPrFont(rPr) ?? styleFont(styles, rStyle) ?? paragraphFont
      const code = isCodeCharStyle(styles, rStyle) || (fonts && font !== undefined && MONOSPACE.test(font))
      runs.push({ at: rAt, xml: r.xml, rPr, rStyle, code, blank: codeParagraphText(r.inner).trim() === '' })
    }
    const shown = runs.filter((r) => !r.blank)
    const marked = runs.filter((r) => {
      if (!r.code) return false
      if (!r.blank) return true
      const before = shown.filter((s) => s.at < r.at).pop()
      const after = shown.find((s) => s.at > r.at)
      return !!before?.code && !!after?.code && /^[ \t\u00a0]+$/.test(codeParagraphText(r.xml))
    })
    if (!marked.length) continue
    let para = ''
    let pLast = 0
    for (const r of marked) {
      // The run's own style goes: mammoth maps none of a run's styles but
      // "Strong", which is kept as bold.
      const strong = styleChain(styles, r.rStyle).some((s) => styleKey(s.name) === 'strong')
      const props = r.rPr
        .replace(/^<w:rPr\/>$/, '')
        .replace(/^<w:rPr\b[^>]*>|<\/w:rPr>$/g, '')
        .replace(/<w:rStyle\b[^>]*\/>/, '')
      const rPr = `<w:rPr><w:rStyle w:val="${id}"/>${props}${strong && !/<w:b\b/.test(props) ? '<w:b/>' : ''}</w:rPr>`
      const open = /^<w:r\b[^>]*>/.exec(r.xml)![0]
      const body = r.xml.slice(open.length)
      const rest = r.rPr ? body.replace(r.rPr, '') : body
      para += p.xml.slice(pLast, r.at) + open + rPr + rest
      pLast = r.at + r.xml.length
    }
    out += xml.slice(last, at) + para + p.xml.slice(pLast)
    last = cursor
  }
  return out + xml.slice(last)
}

/** The package with its code blocks replaced by markers, or undefined when it has none. */
async function extractCodeBlocks(
  bytes: Buffer,
): Promise<{ bytes: Buffer; marker: string; blocks: CodeBlock[]; inline?: string } | undefined> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const doc = zip.files['word/document.xml']
    if (!doc) return undefined
    const xml = await doc.async('string')
    const stylesXml = (await zip.files['word/styles.xml']?.async('string')) ?? ''
    // Cheap test first: no monospace face or code style named anywhere, no code.
    if (!MONOSPACE_HINT.test(xml) && !MONOSPACE_HINT.test(stylesXml) && !CODE_BOOKMARK.test(xml)) return undefined
    const marker = uniqueMarker([xml], 'code')
    const blocks: CodeBlock[] = []
    let inline = 'DocConvInlineCode'
    for (let i = 0; stylesXml.includes(inline) || xml.includes(inline); i++) inline = `DocConvInlineCode${i.toString(36)}x`
    const taken = takeCodeBlocks(xml, stylesXml, marker, blocks, inline)
    const hasInline = taken.includes(`w:val="${inline}"`)
    // Kept for our bookmarks alone too, taken out of text that is no longer code.
    if (blocks.length === 0 && !hasInline && taken === xml) return undefined
    zip.file('word/document.xml', taken)
    return { bytes: await zip.generateAsync({ type: 'nodebuffer' }), marker, blocks, inline: hasInline ? inline : undefined }
  } catch {
    return undefined
  }
}

/** Any font name or style name that could make a paragraph or a run code. */
const MONOSPACE_HINT =
  /mono|courier|consolas|menlo|monaco|lucida|inconsolata|source ?code|cascadia|fira code|andale|preformatted|html ?(?:code|typewriter)|verbatim|w:val="(?:inline ?)?code/i

/**
 * mammoth puts a run's style outside its bold and italic, `<code><strong>x</strong></code>`;
 * code wholly in one formatting tag is turned inside out, as Markdown writes it (**`x`**).
 */
export function codeInsideFormatting(html: string): string {
  let out = html
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/<code>(<(strong|em|s|u|sup|sub)>)((?:(?!<\/?code\b|<\/?\2>)[\s\S])*)<\/\2><\/code>/g, '$1<code>$3</code></$2>')
    if (next === out) break
    out = next
  }
  return out
}

/**
 * Each code block's marker paragraph as `<pre><code>`, of the language its
 * bookmark named (left for convert.ts to guess when none); a marker found
 * anywhere else as its text.
 */
export function restoreCodeBlocks(html: string, marker: string, blocks: CodeBlock[]): string {
  const m = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const text = (n: string): string => escapeHtml(blocks[Number(n)]?.text ?? '')
  const block = (n: string): string => {
    const language = blocks[Number(n)]?.language
    return `<pre><code${language ? ` class="language-${language}"` : ''}>${text(n)}</code></pre>`
  }
  return html
    .replace(new RegExp(`<p>${m}(\\d+)\ue001</p>`, 'g'), (_, n: string) => block(n))
    // A block inside a list item (takeItemCodeBlocks), the breaks around it gone.
    .replace(new RegExp(`(?:<br\\s*/?>\\s*)*${m}(\\d+)\ue002(?:\\s*<br\\s*/?>)*`, 'g'), (_, n: string) => block(n))
    .replace(new RegExp(`${m}(\\d+)\ue001`, 'g'), (_, n: string) => text(n))
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
  /** An `m:oMathPara`: a math paragraph, drawn on a line of its own (a block when it is alone in its paragraph). */
  display: boolean
  /** Some element was not understood and is its linear text in `tex`. */
  partial: boolean
}

/** The parts mammoth reads that can hold equations. */
const MATH_PARTS = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']

/** Whether a part may hold an equation, under any prefix: a quick test before the real scan. */
const MATH_TAG = /<(?:[\w-]+:)?oMath[\s/>P]/
const mayHoldMath = (xml: string): boolean => MATH_TAG.test(xml)

/**
 * The namespaces a part declares, by prefix ('' for the default namespace):
 * those on its root, which an equation cut out of it does not carry, then
 * every other prefix bound to the math namespace anywhere in it. Equations
 * are found by that namespace, whatever its prefix; a part that declares it
 * nowhere (no valid file, but some writers) is read under `m:`, as Word writes it.
 */
function partNamespaces(xml: string): { namespaces: Record<string, string>; math: string[] } {
  const declared = (tag: string): Array<[string, string]> =>
    [...tag.matchAll(/\sxmlns(?::([A-Za-z_][\w-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1] ?? '', m[2] ?? m[3] ?? ''])
  const root = /<(?![?!])[^>]*>/.exec(xml)?.[0] ?? ''
  const namespaces: Record<string, string> = Object.fromEntries(declared(root))
  const math = new Set<string>()
  const other = new Set<string>()
  for (const [prefix, uri] of declared(xml)) {
    if (MATH_NAMESPACES.has(uri)) {
      math.add(prefix)
      namespaces[prefix] ??= uri
    } else other.add(prefix)
  }
  if (math.size === 0 && !other.has('m')) math.add('m')
  return { namespaces, math: [...math] }
}

/** A marker prefix the text of none of the parts contains. */
export function equationMarker(xmls: string[]): string {
  return uniqueMarker(xmls, 'eq')
}

/** `\ue000` and `base`, made longer until no part's text contains it. */
function uniqueMarker(xmls: string[], base: string): string {
  // The text as mammoth will see it: a private-use character can be written
  // as a character reference too.
  const reference = new RegExp(`&#(?:x0*e000|0*${0xe000});`, 'gi')
  const texts = xmls.map((x) => x.replace(reference, '\ue000'))
  let marker = `\ue000${base}`
  for (let i = 0; texts.some((t) => t.includes(marker)); i++) marker = `\ue000${base}${i.toString(36)}x`
  return marker
}

/**
 * Replace every top-level `m:oMathPara` / `m:oMath` of one part with a marker
 * run, appending each equation's TeX to `equations` in document order.
 */
export function takeEquations(xml: string, marker: string, equations: WordEquation[]): string {
  if (!mayHoldMath(xml)) return xml
  const { namespaces, math } = partNamespaces(xml)
  const names = math.flatMap((p) => (p ? [`${p}:oMathPara`, `${p}:oMath`] : ['oMathPara', 'oMath']))
  if (names.length === 0) return xml
  const found = scanElements(xml, names)
  if (found.length === 0) return xml
  let out = ''
  let cursor = 0
  for (const el of found) {
    const at = xml.indexOf(el.xml, cursor)
    if (at < 0) continue
    const display = el.name.endsWith('oMathPara')
    // Parsed as a fragment, with the part's declarations passed along.
    const fragment = el.xml
    let eq: WordEquation
    try {
      const { tex, unknown } = ommlToTex(fragment, { display, namespaces })
      eq = { tex, display, partial: unknown.length > 0 }
    } catch {
      // Never dropped: at worst, the equation's own characters.
      eq = { tex: safeLinear(fragment, namespaces), display, partial: true }
    }
    out += xml.slice(cursor, at) + `<w:r><w:t>${marker}${equations.length}\ue001</w:t></w:r>`
    equations.push(eq)
    cursor = at + el.xml.length
  }
  return out + xml.slice(cursor)
}

function safeLinear(fragment: string, namespaces: Record<string, string>): string {
  try {
    return ommlLinearText(fragment, namespaces).replace(/[\\{}%#&_$^~]/g, (c) => (c === '\\' ? '\\backslash ' : c === '^' ? '\\hat{}' : c === '~' ? '\\sim ' : `\\${c}`))
  } catch {
    return ''
  }
}

/**
 * Whether a Word file holds equations, without converting it: the add-time
 * features hint (src/core/features-hint.ts) for a docx. Only the three XML
 * parts are inflated, found through the zip's central directory and searched
 * as they inflate (zip-scan.ts), so this is cheap whatever the file's size.
 * A package that reader cannot take (ZIP64) is opened with JSZip instead, if
 * there is time left before `deadline`. Undefined when the bytes are not a
 * readable package, or time ran out.
 */
export async function docxHasEquations(bytes: Buffer, deadline = Infinity): Promise<boolean | undefined> {
  const scanned = await zipPartsMatch(bytes, MATH_PARTS, MATH_TAG, deadline)
  if (scanned !== undefined || performance.now() > deadline) return scanned
  try {
    const zip = await JSZip.loadAsync(bytes)
    for (const name of MATH_PARTS) {
      if (zip.files[name] && mayHoldMath(await zip.files[name].async('string'))) return true
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
    if (!xmls.some(mayHoldMath)) return undefined
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
 * its paragraph as display math, one that shares its paragraph with text as
 * display math inside the paragraph (the hub's `math-display`, as pandoc
 * reads `$$…$$` in a sentence), and every `m:oMath` outside a math paragraph
 * as inline math (B12, B1). A marker that cannot be matched is removed, so
 * none ever reaches the hub.
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
    return e?.tex ? `<code class="language-math${e.display ? ' math-display' : ''}">${escapeHtml(e.tex)}</code>` : ''
  })
  // Anything left of a marker (torn by something upstream) goes too.
  return out.replace(new RegExp(`${m}\\d*\ue001?`, 'g'), '')
}

/*
 * Highlighted text. Word's highlighter writes `w:highlight` with one of its 16
 * color names; mammoth reads it and writes nothing for it unless the style map
 * says what. Run shading (`w:shd` on a run) is how Google Docs and others
 * write a highlight of any color, and mammoth does not read it at all. Each
 * becomes the hub's <mark>, of its own color (src/core/mark.ts).
 */
const HIGHLIGHT_NAMES = Object.fromEntries(Object.entries(WORD_HIGHLIGHTS).map(([hex, name]) => [name, hex]))

/** A stand-in highlight name for a shading color, which mammoth passes on as it is. */
const SHADE_PREFIX = 'dc-shade-'

/** A run's own properties, first in the run (CT_R); the paragraph's run properties are left alone. */
const RUN_PROPERTIES = /(<w:r\b[^>]*>\s*<w:rPr>)([\s\S]*?)(<\/w:rPr>)/g

/**
 * The parts with each run's shading turned into a highlight mammoth reads,
 * and the shading colors found; undefined when no run is shaded. A run with a
 * highlight of its own keeps that (Word draws the highlight over the
 * shading); `auto` and white shading are none.
 */
async function shadingAsHighlight(bytes: Buffer): Promise<{ bytes: Buffer; colors: string[] } | undefined> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const parts = MATH_PARTS.filter((name) => zip.files[name])
    const xmls = await Promise.all(parts.map((name) => zip.files[name].async('string')))
    if (!xmls.some((xml) => /<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<w:shd\b/.test(xml))) return undefined
    const colors = new Set<string>()
    parts.forEach((name, i) => {
      const xml = xmls[i].replace(RUN_PROPERTIES, (whole, open: string, props: string, close: string) => {
        const shd = /<w:shd\b[^>]*>/.exec(props)?.[0]
        if (!shd || /<w:highlight\b/.test(props)) return whole
        const attr = (n: string): string | undefined => new RegExp(`\\bw:${n}="([^"]*)"`).exec(shd)?.[1]
        const fill = (attr('val') === 'solid' ? attr('color') : attr('fill'))?.toUpperCase()
        if (!fill || !/^[0-9A-F]{6}$/.test(fill) || fill === 'FFFFFF') return whole
        colors.add(fill)
        return `${open}${props}<w:highlight w:val="${SHADE_PREFIX}${fill}"/>${close}`
      })
      zip.file(name, xml)
    })
    if (colors.size === 0) return undefined
    return { bytes: await zip.generateAsync({ type: 'nodebuffer' }), colors: [...colors] }
  } catch {
    return undefined
  }
}

/** mammoth's style map for highlights: a <mark> naming its color by class, made the hub's by marksToHub. */
function highlightStyleMap(shades: string[]): string[] {
  return [
    ...Object.entries(HIGHLIGHT_NAMES).map(([name, hex]) => `highlight[color='${name}'] => mark.dc-hl-${hex}`),
    ...shades.map((hex) => `highlight[color='${SHADE_PREFIX}${hex}'] => mark.dc-hl-${hex}`),
  ]
}

export function marksToHub(html: string): string {
  return html.replace(/<mark class="dc-hl-([0-9A-F]{6})">/g, (_, hex: string) => markOpenTag(hex))
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
  // Code first: a paragraph holding an equation is never code, and the code's
  // text then never carries an equation marker.
  const code = await extractCodeBlocks(src.bytes)
  const math = await extractEquations(code?.bytes ?? src.bytes)
  // The package mammoth and the list scan read: with markers where equations
  // were, so a paragraph holding only an equation is not taken for empty.
  const unshaded = math?.bytes ?? code?.bytes ?? src.bytes
  // Last: code and equations are taken out first, so neither is read as highlighted.
  const shading = await shadingAsHighlight(unshaded)
  const bytes = shading?.bytes ?? unshaded
  const [{ value }, flags, header, numIds] = await Promise.all([
    mammoth.convertToHtml(
      { buffer: bytes },
      {
        convertImage: budgetedImageConverter(ledger),
        styleMap: [...(code?.inline ? [`r.${code.inline} => code`] : []), ...highlightStyleMap(shading?.colors ?? [])],
      },
    ),
    headerFlags(bytes),
    headerTitle(bytes),
    listNumIds(bytes),
  ])
  const converted = marksToHub(math ? restoreEquations(value, math.marker, math.equations) : value)
  if (math) equationNotice(math.equations, ctx)
  const html = keepTabsVisible(
    mergeInterruptedOrderedLists(promoteHeaderRows(replaceUninlinedImages(converted), flags), numIds),
  )
  // After keepTabsVisible: a tab in code stays a tab.
  const withCode = code ? restoreCodeBlocks(code.inline ? codeInsideFormatting(html) : html, code.marker, code.blocks) : html
  return withHeaderTitle(wordNotesToHub(withCode), header)
}
