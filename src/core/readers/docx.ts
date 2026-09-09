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
import type { HubDocument, SourceInput } from '../types'

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

export async function readDocx(src: SourceInput): Promise<HubDocument> {
  const ledger = createImageLedger(archiveInlineBudget(src.bytes.byteLength))
  const [{ value }, flags, header, numIds] = await Promise.all([
    mammoth.convertToHtml({ buffer: src.bytes }, { convertImage: budgetedImageConverter(ledger) }),
    headerFlags(src.bytes),
    headerTitle(src.bytes),
    listNumIds(src.bytes),
  ])
  const html = keepTabsVisible(
    mergeInterruptedOrderedLists(promoteHeaderRows(replaceUninlinedImages(value), flags), numIds),
  )
  return withHeaderTitle(html, header)
}
