import JSZip from 'jszip'
import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import { decodeXml, scanElements } from '../ooxml'
import { imageMime } from './image'
import {
  archiveInlineBudget,
  createImageLedger,
  imagePlaceholder,
  OVER_BUDGET,
  type ImageLedger,
} from '../inline-images'
import type { HubDocument, SourceInput } from '../types'

/** Placeholders that are page furniture, not slide content. */
const FURNITURE = new Set(['sldNum', 'dt', 'ftr'])

/** What a paragraph's own `<a:pPr>` says about its bullet. */
type BulletKind = 'char' | 'auto' | 'none' | 'inherit'

interface SlideParagraph {
  /** One entry per line: an `<a:br>` starts a new line in the same paragraph. */
  lines: string[]
  /** Outline level from `<a:pPr lvl="N">`; 0 when absent. */
  level: number
  bullet: BulletKind
  /** `<a:buAutoNum type="…">`, which decides the `<ol>` numbering style. */
  autoNum?: string
}

/**
 * Lines of one `<a:p>`. Runs are joined with nothing — PowerPoint splits runs
 * mid-word constantly — but `<a:br>` is a soft line break and must separate
 * them, or a title reads "InvertersField Training Overview". The
 * break is not always self-closing: PowerPoint writes `<a:br><a:rPr/></a:br>`.
 *
 * `<a:t/>` is self-closing too (a blank line) and must not be treated as an
 * opening tag, or the scan runs on to the next `</a:t>` and swallows the
 * intervening markup as text.
 */
function paragraphLines(pInner: string): string[] {
  const lines: string[] = []
  let current = ''
  for (const el of scanElements(pInner, ['a:t', 'a:br'])) {
    if (el.name === 'a:br') {
      lines.push(current)
      current = ''
      continue
    }
    current += decodeXml(el.inner)
  }
  lines.push(current)
  // Drops the blank line a trailing <a:br> would otherwise leave behind.
  return lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line !== '')
}

/**
 * A paragraph's list properties. `<a:pPr>` is the first child of `<a:p>` by
 * schema, so anchoring the match there keeps `<a:fld>`'s own `<a:pPr>` out.
 */
function paragraphProps(pInner: string): { level: number; bullet: BulletKind; autoNum?: string } {
  if (!/^\s*<a:pPr[\s/>]/.test(pInner)) return { level: 0, bullet: 'inherit' }
  const pPr = scanElements(pInner, ['a:pPr'])[0]
  if (!pPr) return { level: 0, bullet: 'inherit' }
  const level = Number(/<a:pPr\b[^>]*\blvl="(\d+)"/.exec(pPr.xml)?.[1] ?? 0)
  const autoNum = /<a:buAutoNum\b[^>]*\btype="([^"]+)"/.exec(pPr.inner)?.[1]
  const bullet: BulletKind = /<a:buNone[\s/>]/.test(pPr.inner)
    ? 'none'
    : /<a:buAutoNum[\s/>]/.test(pPr.inner)
      ? 'auto'
      : /<a:buChar[\s/>]/.test(pPr.inner)
        ? 'char'
        : 'inherit'
  return { level: Number.isFinite(level) ? Math.min(level, 8) : 0, bullet, autoNum }
}

function slideParagraphs(xml: string): SlideParagraph[] {
  return scanElements(xml, ['a:p'])
    .map((p) => ({ lines: paragraphLines(p.inner), ...paragraphProps(p.inner) }))
    .filter((p) => p.lines.length > 0)
}

/** Paragraph texts, one string per `<a:p>`, for places that want plain text. */
function paragraphs(xml: string): string[] {
  return slideParagraphs(xml).map((p) => p.lines.join(' '))
}

/**
 * `<a:buAutoNum type>` → the closest HTML `<ol type>`; arabic is the default.
 *
 * A Map, not an object literal: the key is an attribute value out of the slide
 * XML, and a plain literal inherits `Object.prototype`, so `type="constructor"`
 * came back as a function and the deck rendered
 * `<ol type="function Object() { [native code] }">`.
 */
const OL_TYPE = new Map<string, string>(
  Object.entries({
    alphaLc: 'a',
    alphaLcParenBoth: 'a',
    alphaLcParenR: 'a',
    alphaLcPeriod: 'a',
    alphaUc: 'A',
    alphaUcParenBoth: 'A',
    alphaUcParenR: 'A',
    alphaUcPeriod: 'A',
    romanLc: 'i',
    romanLcParenBoth: 'i',
    romanLcParenR: 'i',
    romanLcPeriod: 'i',
    romanUc: 'I',
    romanUcParenBoth: 'I',
    romanUcParenR: 'I',
    romanUcPeriod: 'I',
  }),
)

interface ListNode {
  lines: string[]
  ordered: boolean
  autoNum?: string
  children: ListNode[]
}

/** A paragraph's lines as inline HTML — a soft break stays inside the block. */
function inlineText(lines: string[]): string {
  return lines.map(escapeHtml).join('<br>')
}

/**
 * Nest list items by outline level. Levels are re-based onto 0,1,2… first: the
 * real decks put every bullet of a flat list at `lvl="1"`, and reading that
 * absolutely would wrap the whole list in an empty outer one.
 */
function listTree(items: SlideParagraph[]): ListNode[] {
  const depths = [...new Set(items.map((i) => i.level))].sort((a, b) => a - b)
  const roots: ListNode[] = []
  const stack: ListNode[] = []
  for (const item of items) {
    const node: ListNode = {
      lines: item.lines,
      ordered: item.bullet === 'auto',
      autoNum: item.autoNum,
      children: [],
    }
    // A level with no parent above it cannot indent further than one step.
    const depth = Math.min(depths.indexOf(item.level), stack.length)
    stack.length = depth
    if (depth === 0) roots.push(node)
    else stack[depth - 1].children.push(node)
    stack.push(node)
  }
  return roots
}

/** Siblings render as one list per run of like-bulleted items. */
function renderListNodes(nodes: ListNode[]): string {
  let html = ''
  for (let i = 0; i < nodes.length; ) {
    const ordered = nodes[i].ordered
    const tag = ordered ? 'ol' : 'ul'
    const type = ordered ? OL_TYPE.get(nodes[i].autoNum ?? '') : undefined
    let items = ''
    while (i < nodes.length && nodes[i].ordered === ordered) {
      const n = nodes[i++]
      items += `<li>${inlineText(n.lines)}${n.children.length > 0 ? renderListNodes(n.children) : ''}</li>`
    }
    html += `<${tag}${type ? ` type="${type}"` : ''}>${items}</${tag}>`
  }
  return html
}

/**
 * Slide text as block HTML. A paragraph counts as a list item only when its own
 * `<a:pPr>` carries `<a:buChar>` or `<a:buAutoNum>` — explicit, unambiguous
 * evidence that PowerPoint draws a bullet there. `<a:buNone>` and paragraphs
 * with no bullet markup at all stay paragraphs: level 0 of these decks' masters
 * has no bullet, so inheritance cannot be assumed.
 */
function renderTextBody(paras: SlideParagraph[]): string[] {
  const out: string[] = []
  let run: SlideParagraph[] = []
  const flush = (): void => {
    if (run.length > 0) out.push(renderListNodes(listTree(run)))
    run = []
  }
  for (const para of paras) {
    if (para.bullet === 'char' || para.bullet === 'auto') {
      run.push(para)
      continue
    }
    flush()
    out.push(`<p>${inlineText(para.lines)}</p>`)
  }
  flush()
  return out
}

function placeholderType(shapeXml: string): string | undefined {
  return /<p:ph\b[^>]*\btype="([^"]+)"/.exec(shapeXml)?.[1]
}

function isTitlePlaceholder(shapeXml: string): boolean {
  const type = placeholderType(shapeXml)
  return type === 'title' || type === 'ctrTitle'
}

/** A DrawingML table: <a:tbl> → rows of <a:tc>, honouring gridSpan/rowSpan. */
function renderTable(tableXml: string): string | null {
  const rows: string[] = []
  let any = false
  for (const row of scanElements(tableXml, ['a:tr'])) {
    const cells: string[] = []
    for (const cell of scanElements(row.inner, ['a:tc'])) {
      // Continuation cells of a merge carry no content of their own.
      if (/\b(hMerge|vMerge)="(1|true)"/.test(cell.xml)) continue
      const text = paragraphs(cell.inner).join(' ')
      if (text) any = true
      const colspan = Number(/\bgridSpan="(\d+)"/.exec(cell.xml)?.[1] ?? 1)
      const rowspan = Number(/\browSpan="(\d+)"/.exec(cell.xml)?.[1] ?? 1)
      const attrs =
        (colspan > 1 ? ` colspan="${Math.min(colspan, 1000)}"` : '') +
        (rowspan > 1 ? ` rowspan="${Math.min(rowspan, 1000)}"` : '')
      cells.push(`<td${attrs}>${escapeHtml(text)}</td>`)
    }
    if (cells.length > 0) rows.push(`<tr>${cells.join('')}</tr>`)
  }
  return any ? `<table><tbody>${rows.join('')}</tbody></table>` : null
}

/**
 * The uncompressed size the zip's own central directory claims for an entry.
 *
 * Read before decompressing, exactly as expandZipArchive does: a picture that
 * cannot fit the budget should never be inflated at all, or the memory the
 * budget exists to protect has already been spent. The header can lie, so the
 * real length is charged below once it is known.
 */
function claimedSize(file: JSZip.JSZipObject): number {
  return (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
}

/**
 * A slide picture, inlined as a data URI, or the placeholder that says why it
 * is not there. Null only when there is no image to speak of.
 */
async function imageFor(
  embedId: string,
  relsXml: string,
  zip: JSZip,
  ledger: ImageLedger,
): Promise<string | null> {
  const target = new RegExp(`Id="${embedId}"[^>]*Target="([^"]+)"`).exec(relsXml)?.[1]
  if (!target) return null
  const path = `ppt/${target.replace(/^\.\.\//, '')}`
  const file = zip.files[path]
  if (!file) return null
  if (!ledger.fits(claimedSize(file))) return imagePlaceholder(OVER_BUDGET)
  const bytes = Buffer.from(await file.async('nodebuffer'))
  const mime = imageMime(bytes)
  // Not an image this app can embed: it was never going to appear, so it costs
  // the budget nothing and says nothing.
  if (!mime) return null
  // Charged at the real length, so a header that lied downwards buys nothing.
  if (!ledger.admit(bytes.byteLength)) return imagePlaceholder(OVER_BUDGET)
  return `<img src="data:${mime};base64,${bytes.toString('base64')}" alt="slide image">`
}

/** slide2 must sort before slide10 — OOXML names are not zero-padded. */
function slideNumber(path: string): number {
  return Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? 0)
}

async function renderShapes(
  xml: string,
  relsXml: string,
  zip: JSZip,
  out: { title?: string; body: string[] },
  ledger: ImageLedger,
): Promise<void> {
  for (const el of scanElements(xml, ['p:sp', 'p:graphicFrame', 'p:pic', 'p:grpSp'])) {
    if (el.name === 'p:grpSp') {
      await renderShapes(el.inner, relsXml, zip, out, ledger)
      continue
    }
    if (el.name === 'p:graphicFrame') {
      for (const tbl of scanElements(el.inner, ['a:tbl'])) {
        const table = renderTable(tbl.inner)
        if (table) out.body.push(table)
      }
      continue
    }
    if (el.name === 'p:pic') {
      const embed = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(el.xml)?.[1]
      if (embed) {
        const img = await imageFor(embed, relsXml, zip, ledger)
        if (img) out.body.push(img)
      }
      continue
    }
    // p:sp
    const type = placeholderType(el.xml)
    if (type && FURNITURE.has(type)) continue
    const paras = slideParagraphs(el.inner)
    if (paras.length === 0) continue
    // The title is the title PLACEHOLDER's whole text, not merely the first
    // paragraph on the slide — slide-number shapes often come first in XML.
    // A title is never a list, whatever bullet markup it happens to carry.
    if (isTitlePlaceholder(el.xml)) {
      const text = paras.map((p) => p.lines.join(' ')).join(' ')
      if (out.title === undefined) out.title = text
      else out.body.push(`<p>${escapeHtml(text)}</p>`)
      continue
    }
    out.body.push(...renderTextBody(paras))
  }
}

export async function readPptx(src: SourceInput): Promise<HubDocument> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(src.bytes)
  } catch (err) {
    throw new ConversionError('read-failed', `Could not read presentation: ${(err as Error).message}`)
  }
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  if (slidePaths.length === 0) {
    throw new ConversionError('read-failed', 'No slides found (not a PowerPoint presentation)')
  }

  // One budget for the whole deck: a per-slide one would let a hundred slides
  // add up to the same unbounded hub.
  const ledger = createImageLedger(archiveInlineBudget(src.bytes.byteLength))

  const sections: string[] = []
  for (const path of slidePaths) {
    const xml = await zip.files[path].async('string')
    const relsPath = path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')
    const relsXml = zip.files[relsPath] ? await zip.files[relsPath].async('string') : ''

    const out: { title?: string; body: string[] } = { body: [] }
    await renderShapes(xml, relsXml, zip, out, ledger)

    const parts: string[] = []
    // No title placeholder: fall back to the slide's first line of text.
    let title = out.title
    let body = out.body
    if (title === undefined) {
      const firstText = body.findIndex((b) => b.startsWith('<p>'))
      if (firstText >= 0) {
        // A soft break inside that paragraph is a line break, not literal text.
        title = body[firstText].replace(/^<p>|<\/p>$/g, '').replace(/<br>/g, ' ')
        body = body.filter((_, i) => i !== firstText)
      }
    }
    if (title) parts.push(`<h2>${escapeHtml(decodeXml(title))}</h2>`)
    parts.push(...body)

    // Speaker notes are authored content and were dropped entirely.
    const notesTarget = /Target="(\.\.\/notesSlides\/notesSlide\d+\.xml)"/.exec(relsXml)?.[1]
    if (notesTarget) {
      const notesPath = `ppt/${notesTarget.replace(/^\.\.\//, '')}`
      const notesFile = zip.files[notesPath]
      if (notesFile) {
        const notesXml = await notesFile.async('string')
        // The notes part repeats the slide's own text in a placeholder; keep
        // only the notes body.
        const bodyShapes = scanElements(notesXml, ['p:sp']).filter(
          (sp) => placeholderType(sp.xml) === 'body',
        )
        const notes = bodyShapes.flatMap((sp) => paragraphs(sp.inner)).filter(Boolean)
        if (notes.length > 0) {
          parts.push(
            `<blockquote><p><strong>Notes:</strong></p>${notes
              .map((n) => `<p>${escapeHtml(n)}</p>`)
              .join('')}</blockquote>`,
          )
        }
      }
    }
    if (parts.length > 0) sections.push(parts.join('\n'))
  }

  const name = src.filename?.split(/[\\/]/).pop()
  return { html: sections.join('\n'), title: name }
}
