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
 */
export async function loadOdfContent(bytes: Buffer, what: string): Promise<string> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (err) {
    throw new ConversionError('read-failed', `Could not read ${what}: ${(err as Error).message}`)
  }
  const content = zip.files['content.xml']
  if (!content) throw new ConversionError('read-failed', `Not an OpenDocument ${what} (missing content.xml)`)
  return stripOdfComments(await content.async('string'))
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
function liftOdfNotes(xml: string, notes: string[]): string {
  return replaceElements(stripOdfComments(xml), ['text:note'], (note) => {
    const citation = /<text:note-citation\b[^>]*>([\s\S]*?)<\/text:note-citation>/.exec(note.inner)?.[1] ?? ''
    const mark = odfInline(citation) || NOTE_FALLBACK_MARK
    // Tolerate a missing `</text:note-body>`: callers that carve a fragment out
    // with a lazy `<text:p>…</text:p>` regex hand us a note cut off mid-body,
    // and the words in it are still the reader's only copy of that footnote.
    const bodyOpen = /<text:note-body\b[^>]*>/.exec(note.inner)
    const bodyXml = bodyOpen
      ? note.inner.slice(bodyOpen.index + bodyOpen[0].length).replace(/<\/text:note-body>[\s\S]*$/, '')
      : ''
    // Recurse: a note body may itself hold a comment that must not survive.
    const body = odfInline(liftOdfNotes(bodyXml, notes))
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
  const notes: string[] = []
  const main = odfInline(liftOdfNotes(xml, notes))
  return [main, ...notes].filter((part) => part !== '').join(' ')
}

/** The tag strip and whitespace collapse, with notes already lifted out. */
function odfInline(xml: string): string {
  return xml
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
    .trim()
}

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
      const text = odfText(part.inner)
      if (text !== '') texts.push(text)
    }
    if (texts.length === 0 && nested === '') continue
    items.push(`<li>${escapeHtml(texts.join(' '))}${nested}</li>`)
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
