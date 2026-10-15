import JSZip from 'jszip'
import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import { scanElements, type XmlElement } from '../ooxml'

/**
 * ODF stores the document body in content.xml inside the package.
 *
 * Comments are dropped here, at the one door every ODF reader comes through,
 * rather than only in `odfText`. In a text document an `<office:annotation>`
 * always sits inside a `<text:p>` and `odfText` would catch it, but in a
 * presentation it is a child of `<draw:page>` — so the slide scan in odp.ts
 * meets its `<text:p>` directly and, being the first text on the page,
 * promoted "internal only, do not ship" to the slide's heading. A reviewer's
 * private remark reaching a delivered deck is the worst outcome this reader
 * has, so the strip goes where no reader can miss it. Doing it twice is free.
 *
 * The styles its spans and paragraphs refer to come back with it. Automatic
 * styles live in content.xml itself; the named ones they inherit from live in
 * styles.xml, which a minimal package may leave out.
 */
export async function loadOdfDocument(bytes: Buffer, what: string): Promise<{ xml: string; styles: OdfStyles }> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (err) {
    throw new ConversionError('read-failed', `Could not read ${what}: ${(err as Error).message}`)
  }
  const content = zip.files['content.xml']
  if (!content) throw new ConversionError('read-failed', `Not an OpenDocument ${what} (missing content.xml)`)
  const raw = await content.async('string')
  const stylesXml = (await zip.files['styles.xml']?.async('string')) ?? ''
  const named = /<office:styles\b[^>]*>([\s\S]*?)<\/office:styles>/.exec(stylesXml)?.[1] ?? ''
  const automatic = /<office:automatic-styles\b[^>]*>([\s\S]*?)<\/office:automatic-styles>/.exec(raw)?.[1] ?? ''
  return { xml: stripOdfComments(raw), styles: parseOdfStyles(named + automatic) }
}

/*
 * Inline formatting. ODF keeps none of it in the text: a `<text:span>` or
 * `<text:p>` names a style, and the style's `<style:text-properties>` says
 * bold, italic and so on, possibly by way of a parent style. Each bit below is
 * one hub tag, in the order they nest, outermost first — the same order the
 * RTF reader writes them.
 */
const BOLD = 1
const ITALIC = 2
const UNDERLINE = 4
const STRIKE = 8
const SUPER = 16
const SUB = 32
const FORMAT_TAGS: [number, string][] = [
  [BOLD, 'strong'],
  [ITALIC, 'em'],
  [UNDERLINE, 'u'],
  [STRIKE, 's'],
  [SUPER, 'sup'],
  [SUB, 'sub'],
]

/**
 * What a style says about each bit: `set` is the bits it decides at all, `on`
 * those it turns on. Kept apart because `fo:font-weight="normal"` inside a
 * bold paragraph has to switch bold OFF, not merely fail to add it.
 */
type TextFormat = { set: number; on: number }
type StyleEntry = { parent?: string; format: TextFormat }
export type OdfStyles = { text: Map<string, StyleEntry>; paragraph: Map<string, StyleEntry> }

const NO_STYLES: OdfStyles = { text: new Map(), paragraph: new Map() }

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]
}

function textFormat(props: string): TextFormat {
  let set = 0
  let on = 0
  const decide = (bit: number, value: boolean): void => {
    set |= bit
    if (value) on |= bit
  }
  const weight = attr(props, 'fo:font-weight')
  if (weight !== undefined) decide(BOLD, weight === 'bold' || Number(weight) >= 600)
  const slant = attr(props, 'fo:font-style')
  if (slant !== undefined) decide(ITALIC, slant === 'italic' || slant === 'oblique')
  const underline = attr(props, 'style:text-underline-style')
  if (underline !== undefined) decide(UNDERLINE, underline !== 'none')
  const strike = attr(props, 'style:text-line-through-style')
  if (strike !== undefined) decide(STRIKE, strike !== 'none')
  // "super 58%", "sub 58%", or a signed percentage raise: "33% 58%", "-33% 58%".
  const position = attr(props, 'style:text-position')?.trim().split(/\s+/)[0]
  if (position !== undefined) {
    const raise = position === 'super' ? 1 : position === 'sub' ? -1 : parseFloat(position) || 0
    set |= SUPER | SUB
    if (raise > 0) on |= SUPER
    if (raise < 0) on |= SUB
  }
  return { set, on }
}

function parseOdfStyles(xml: string): OdfStyles {
  const styles: OdfStyles = { text: new Map(), paragraph: new Map() }
  for (const m of xml.matchAll(/<style:style\b([^>]*?)(?:\/>|>([\s\S]*?)<\/style:style>)/g)) {
    const attrs = m[1]
    const name = attr(attrs, 'style:name')
    const family = attr(attrs, 'style:family')
    if (name === undefined || (family !== 'text' && family !== 'paragraph')) continue
    const props = /<style:text-properties\b([^>]*)>/.exec(m[2] ?? '')?.[1] ?? ''
    styles[family].set(name, { parent: attr(attrs, 'style:parent-style-name'), format: textFormat(props) })
  }
  return styles
}

/** A style's format with its ancestors' folded in; the nearest one wins. */
function resolveStyle(map: Map<string, StyleEntry>, name: string | undefined, depth = 0): TextFormat {
  const entry = name === undefined ? undefined : map.get(name)
  // The depth cap stops a parent cycle in a hand-made file looping forever.
  if (!entry || depth > 20) return { set: 0, on: 0 }
  const parent = resolveStyle(map, entry.parent, depth + 1)
  return { set: parent.set | entry.format.set, on: (parent.on & ~entry.format.set) | entry.format.on }
}

/**
 * The styles of the document being read. Set only inside withOdfStyles,
 * around synchronous work, like `documentNotes` below; `odfText` on its own
 * knows no styles and returns plain text as it always has.
 */
let documentStyles: OdfStyles = NO_STYLES

export function withOdfStyles<T>(styles: OdfStyles, build: () => T): T {
  documentStyles = styles
  try {
    return build()
  } finally {
    documentStyles = NO_STYLES
  }
}

/**
 * The formatting in force at a point in the text travels as one private-use
 * character, U+E100 plus the bits. Being a character it survives the tag
 * strip, the whitespace collapse and `escapeHtml`, so the hub tags can be
 * written afterwards — the same trick as the tab sentinel above.
 */
const MARK_BASE = 0xe100
const MARKS = /[\uE100-\uE13F]/g
const mark = (bits: number): string => String.fromCharCode(MARK_BASE + bits)

/**
 * Put a mark after every span and paragraph boundary. A heading's own style
 * is left out on purpose: heading styles are bold by default, and an <h1>
 * wrapped whole in <strong> says nothing the <h1> did not.
 */
function markFormatting(xml: string): string {
  const styles = documentStyles
  if (styles === NO_STYLES) return xml
  const stack = [0]
  const boundary = /<(\/?)(text:span|text:p|text:h)\b([^>]*?)(\/?)>/g
  return xml.replace(boundary, (tag, close: string, name: string, attrs: string, empty: string) => {
    if (empty) return tag
    // A fragment cut out by a lazy regex can close more than it opened.
    if (close) {
      if (stack.length > 1) stack.pop()
      return tag + mark(stack[stack.length - 1])
    }
    const outer = stack[stack.length - 1]
    let bits = outer
    if (name !== 'text:h') {
      const own = resolveStyle(name === 'text:span' ? styles.text : styles.paragraph, attr(attrs, 'text:style-name'))
      bits = (outer & ~own.set) | own.on
    }
    stack.push(bits)
    return tag + mark(bits)
  })
}

/**
 * Turn the marks in escaped text into hub tags. Tags open only when a
 * character needs them, so an empty span leaves no empty <strong>, and a
 * change keeps the outer tags that still apply open: bold, then bold italic,
 * reads `<strong>a <em>b</em></strong>`.
 */
function marksToHtml(text: string): string {
  let out = ''
  let open: string[] = []
  let want: string[] = []
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code >= MARK_BASE && code < MARK_BASE + 64) {
      want = FORMAT_TAGS.filter(([bit]) => (code - MARK_BASE) & bit).map(([, tag]) => tag)
      continue
    }
    if (open !== want) {
      let keep = 0
      while (keep < open.length && keep < want.length && open[keep] === want[keep]) keep++
      for (let i = open.length - 1; i >= keep; i--) out += `</${open[i]}>`
      for (let i = keep; i < want.length; i++) out += `<${want[i]}>`
      open = want
    }
    out += ch
  }
  for (let i = open.length - 1; i >= 0; i--) out += `</${open[i]}>`
  return out
}

/**
 * A tab stop, once the surrounding whitespace has been collapsed.
 *
 * A raw "\t" here would survive the tag strip and then be flattened to a single
 * space by the run-collapse below, fusing a table-of-contents entry with its
 * page number the way "Steps of Design Page 3" did in docx. Non-breaking spaces
 * hold, and being real characters they carry the separation into txt, md and
 * docx as well — a CSS rule would only reach html and pdf. Word's actual stop
 * geometry is unrecoverable either way: ODF keeps it in the paragraph style.
 */
const TAB_GAP = ' '.repeat(4)

/**
 * Marks a tab stop across the whitespace collapse. JavaScript's \s matches
 * U+00A0, so the gap has to be inserted AFTER that step or it collapses too.
 * The private-use area never appears in real document text.
 */
const TAB_SENTINEL = '\uE001'

/**
 * The sentinel together with a plain space that ended up beside it. Written
 * from the constant so the invisible character appears in the source once.
 */
const PADDED_TAB_SENTINEL = new RegExp(` ?${TAB_SENTINEL} ?`, 'g')

/**
 * Replace whole elements named in `names`, nesting and all.
 *
 * A regex cannot do this: `<office:annotation>` holds `<text:p>`, and a lazy
 * match ends on the wrong close tag. `scanElements` walks top-level elements
 * in document order without overlapping, so an `indexOf` from a monotonic
 * cursor always lands on the occurrence just scanned.
 */
function replaceElements(xml: string, names: string[], render: (el: XmlElement) => string): string {
  let out = ''
  let cursor = 0
  for (const el of scanElements(xml, names)) {
    const at = xml.indexOf(el.xml, cursor)
    if (at === -1) continue
    out += xml.slice(cursor, at) + render(el)
    cursor = at + el.xml.length
  }
  return out + xml.slice(cursor)
}

/**
 * Remove every `<office:annotation>` and its `<office:annotation-end>` marker.
 *
 * A comment is not document content: it is correspondence *about* the
 * document, and the user is converting the document in order to deliver it.
 * Inlined it pasted the remark, the `<dc:creator>` who wrote it and the
 * `<dc:date>` they wrote it on straight into the prose — "Price is
 * BobCheck this with finance ten dollars." There is nowhere safe to keep it:
 * txt, md and csv are flat, so any "clearly marked" block still reads as part
 * of the delivered text. RTF already drops its `\annotation` destination; this
 * brings ODF into line. Dropping the whole element takes the creator and date
 * with it, so neither can become prose in any target.
 *
 * A space is left behind so the words either side can never fuse; the
 * run-collapse in `odfInline` folds the doubling away.
 */
function stripOdfComments(xml: string): string {
  return replaceElements(xml, ['office:annotation'], () => ' ').replace(/<\/?office:annotation-end\b[^>]*>/g, ' ')
}

/** The mark used when a `<text:note>` carries no usable `<text:note-citation>`. */
const NOTE_FALLBACK_MARK = '*'

/**
 * Lift `<text:note>` bodies out of the running text, collecting them in
 * `notes` for the caller to append after the block's own text.
 *
 * Walked as ordinary inline text a note is a disaster twice over: the citation
 * fuses to the word in front of it — "The catalogue record1See appendix B...", which
 * also turns a 400 V rating into a different number — and the body is spliced
 * into the middle of the sentence.
 *
 * A footnote IS content, so it is kept rather than dropped. The citation stays
 * where the author put it as a bracketed, space-separated mark and the body
 * moves to the end of the block, which is as close to real footnote placement
 * as this seam allows. It cannot be markup: the hub allowlist has no `sup`,
 * `aside` or `section`, and `odfText` returns plain text that its callers
 * escape into a `<p>`, `<li>` or `<td>`. Brackets and a real space need no CSS
 * and so survive the flat targets — txt, md and csv carry them verbatim (md
 * escapes them to `\[1\]` so the mark cannot be read as a link reference).
 * Endnotes take the same shape; their citation already distinguishes them.
 */
/**
 * While a whole document is being read, its notes go here instead: the
 * citation becomes a marker the reader turns into a reference in the hub's
 * footnote model (src/core/footnotes.ts), and the bodies become its notes
 * list. The bracketed text above is for odfText on its own, outside a
 * document. Set only inside collectOdfNotes, around synchronous work.
 */
let documentNotes: string[] | null = null
const NOTE_REF = (i: number): string => `zOdFnOtE${i}Zz`

export function collectOdfNotes(build: () => string): string {
  const notes: string[] = []
  documentNotes = notes
  let html: string
  try {
    html = build()
  } finally {
    documentNotes = null
  }
  if (notes.length === 0) return html
  const body = html.replace(/zOdFnOtE(\d+)Zz/g, (_m, i: string) => `<sup data-fn="${Number(i) + 1}">${Number(i) + 1}</sup>`)
  const items = notes.map((text, i) => `<li data-fn="${i + 1}"><p>${marksToHtml(escapeHtml(text))}</p></li>`)
  return `${body}\n<ol>${items.join('')}</ol>`
}

function liftOdfNotes(xml: string, notes: string[]): string {
  return replaceElements(stripOdfComments(xml), ['text:note'], (note) => {
    const citation = /<text:note-citation\b[^>]*>([\s\S]*?)<\/text:note-citation>/.exec(note.inner)?.[1] ?? ''
    const mark = odfInline(citation).replace(MARKS, '') || NOTE_FALLBACK_MARK
    // Tolerate a missing `</text:note-body>`: callers that carve a fragment out
    // with a lazy `<text:p>…</text:p>` regex hand us a note cut off mid-body,
    // and the words in it are still the reader's only copy of that footnote.
    const bodyOpen = /<text:note-body\b[^>]*>/.exec(note.inner)
    const bodyXml = bodyOpen
      ? note.inner.slice(bodyOpen.index + bodyOpen[0].length).replace(/<\/text:note-body>[\s\S]*$/, '')
      : ''
    // Recurse: a note body may itself hold a comment that must not survive.
    const body = odfInline(liftOdfNotes(bodyXml, notes))
    if (documentNotes) {
      documentNotes.push(body)
      return NOTE_REF(documentNotes.length - 1)
    }
    if (body !== '') notes.push(`[${mark}] ${body}`)
    return ` [${mark}] `
  })
}

/**
 * Strip ODF inline markup and decode entities, leaving plain text.
 *
 * Every element that stands for whitespace has to be replaced BEFORE the
 * generic tag strip, or the words either side of it are glued together.
 * `<text:s>` carries an optional `text:c` count, `<text:line-break>` is not
 * guaranteed to be written self-closing, and block boundaries inside the
 * fragment (a cell or list item holding several paragraphs) separate words too.
 */
export function odfText(xml: string): string {
  return odfMarked(xml).replace(MARKS, '')
}

/**
 * A fragment both ways at once: `text` plain, for titles and emptiness
 * checks, and `html` escaped with its inline formatting as hub tags. One call,
 * because reading a fragment twice would record its footnotes twice. Pass the
 * whole `<text:p>` rather than its inner XML so the paragraph's own style
 * counts.
 */
export function odfRich(xml: string): { text: string; html: string } {
  const marked = odfMarked(xml)
  return { text: marked.replace(MARKS, ''), html: marksToHtml(escapeHtml(marked)) }
}

function odfMarked(xml: string): string {
  const notes: string[] = []
  const main = odfInline(liftOdfNotes(xml, notes))
  return [main, ...notes].filter((part) => part !== '').join(' ')
}

/** The tag strip and whitespace collapse, with notes already lifted out. */
function odfInline(xml: string): string {
  return markFormatting(xml)
    .replace(/<text:s\b[^>]*?\/?>/g, (tag) => {
      const count = Number(/\btext:c="(\d+)"/.exec(tag)?.[1] ?? 1)
      return ' '.repeat(Number.isFinite(count) ? Math.min(Math.max(count, 1), 100) : 1)
    })
    // One stop per ELEMENT: matching open and close separately would
    // score <text:tab></text:tab> as two.
    .replace(/<text:tab\b[^>]*>(?:<\/text:tab>)?/g, TAB_SENTINEL)
    .replace(/<\/?text:line-break\b[^>]*>/g, ' ')
    .replace(/<\/(text:p|text:h|text:list-item|text:list-header|text:list)>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    // The gap below is already a strong separator, so a space that ended up
    // beside it (from a lifted note mark, say) only widens it unevenly.
    .replace(PADDED_TAB_SENTINEL, TAB_SENTINEL)
    .split(TAB_SENTINEL)
    .join(TAB_GAP)
    // Trim through the formatting marks, keeping the marks themselves: the
    // last one is what resets the formatting for whatever is joined on after.
    .replace(EDGE_SPACE, (edge) => edge.replace(/\s/g, ''))
}

/** Whitespace at either end of a fragment, with any marks among it. */
const EDGE_SPACE = /^[\s\uE100-\uE13F]+|[\s\uE100-\uE13F]+$/g

/**
 * The `<li>`s of one `<text:list>`. A nested `<text:list>` belongs INSIDE the
 * item that introduces it — flattening it glues the parent's text onto its
 * first child and throws the structure away. Element scanning rather than a
 * lazy regex is what makes finding the right `</text:list>` possible.
 */
export function odfListItems(listInner: string): string {
  const items: string[] = []
  for (const item of scanElements(listInner, ['text:list-item', 'text:list-header'])) {
    const texts: string[] = []
    let nested = ''
    for (const part of scanElements(item.inner, ['text:p', 'text:h', 'text:list'])) {
      if (part.name === 'text:list') {
        nested += odfList(part.inner)
        continue
      }
      const { text, html } = odfRich(part.xml)
      if (text !== '') texts.push(html)
    }
    if (texts.length === 0 && nested === '') continue
    items.push(`<li>${texts.join(' ')}${nested}</li>`)
  }
  return items.join('')
}

/** One `<text:list>` as a `<ul>`, or '' when it holds nothing. */
export function odfList(listInner: string): string {
  const items = odfListItems(listInner)
  return items === '' ? '' : `<ul>${items}</ul>`
}

/**
 * Append a list to `parts`, merging it into the one just pushed when the two
 * are adjacent siblings sharing a style. Writers split a single visual list
 * into a run of one-item `<text:list>` elements chained by
 * `text:continue-numbering`; kept apart they render as a stack of stub lists.
 */
export function appendOdfList(parts: string[], listXml: string, listInner: string, lastList: ListRun): ListRun {
  const items = odfListItems(listInner)
  if (items === '') return null
  const style = /\btext:style-name="([^"]*)"/.exec(listXml)?.[1] ?? ''
  if (lastList && lastList.style === style && lastList.index === parts.length - 1) {
    parts[lastList.index] = parts[lastList.index].replace(/<\/ul>$/, `${items}</ul>`)
    return lastList
  }
  parts.push(`<ul>${items}</ul>`)
  return { style, index: parts.length - 1 }
}

export type ListRun = { style: string; index: number } | null
