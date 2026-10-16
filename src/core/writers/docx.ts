import HTMLtoDOCX from 'html-to-docx'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { parseDocument } from 'htmlparser2'
import { findAll, textContent } from 'domutils'
import { Element, Text, type AnyNode } from 'domhandler'
import render from 'dom-serializer'
import { renderDocumentShell } from '../shell'
import { replaceImages } from '../inline-images'
import { ownRows } from '../table-grid'
import { footnotesForOutput } from '../footnotes'
import type { HubDocument } from '../types'

/**
 * html-to-docx tries to load every <img> and gives up on the whole document
 * when one cannot be resolved — a book with 90 relative image paths came out
 * as its table of contents and nothing else (6,305 of 306,150 characters).
 *
 * Only a well-formed base64 image data URI is kept. html-to-docx fetches any
 * src that merely CONTAINS an http(s) URL, itself, outside the guarded
 * fetcher — so `data:,http://…` qualifies too, and its failure path crashes
 * the whole document ("console.warning is not a function"). Base64 cannot
 * hold a colon, so nothing kept can look like a URL. Remote images are
 * embedded at read time instead (see resolveRemoteImages). The rest are
 * dropped, keeping their alt text so the reader knows something was there.
 *
 * Parsed rather than matched, so the src checked is the src html-to-docx's own
 * parser will read (see replaceImages).
 */
const SAFE_IMAGE_DATA = /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]*$/i

/**
 * html-to-docx stores an SVG as an `image/svg+xml` part Word does not show.
 * Converter.write() gives Word a PNG copy of each SVG image (svg-images.ts);
 * one still here (no renderer, or core used on its own) goes the way of any
 * other picture Word cannot take: its alt text.
 */
const SVG_IMAGE = /^\s*data:image\/svg\+xml/i

function dropUnresolvableImages(html: string): string {
  return replaceImages(html, (src, alt) => {
    if (SAFE_IMAGE_DATA.test(src) && !SVG_IMAGE.test(src)) return null
    const text = alt?.trim()
    return text ? `<p>[${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}]</p>` : ''
  })
}

/** OPC relationship targets are relative to the folder holding the owning part. */
function resolvePart(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = baseDir.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Store each distinct image once, and drop the relationships left behind.
 *
 * html-to-docx embeds an <img> TWICE whenever the tag is not a direct child of
 * a <p>/<li> — a bare top-level image, or one inside a <figure>, <div> or
 * table cell. Its buildImage() writes the media part and a relationship, then
 * passes the same node down to buildParagraph -> buildRun, whose "picture"
 * branch writes a second copy under a fresh random name and embeds THAT one.
 * The first part and its relationship are orphaned, so every such image costs
 * twice its bytes. Repeating one image (a logo on every section) also stores a
 * fresh copy per use, which the same pass folds together.
 *
 * Identity is the image bytes, never the generated filename — html-to-docx
 * names each copy with a random id, so two names say nothing about whether the
 * pictures differ. Two genuinely different images keep two parts.
 *
 * Deleting an unreferenced image relationship is only safe because this runs
 * on our own html-to-docx output, where a picture is always reached through
 * r:embed on <a:blip>; r:link and r:id are scanned too, for good measure.
 */
async function dedupeMedia(zip: JSZip): Promise<void> {
  const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name].dir)
  if (media.length === 0) return

  // Content hash -> the one part that survives for those bytes.
  const canonical = new Map<string, string>()
  const survivor = new Map<string, string>()
  for (const name of media) {
    const hash = createHash('sha1').update(await zip.files[name].async('nodebuffer')).digest('hex')
    const first = canonical.get(hash)
    if (first) survivor.set(name, first)
    else {
      canonical.set(hash, name)
      survivor.set(name, name)
    }
  }

  const keep = new Set<string>()
  for (const relsName of Object.keys(zip.files).filter((name) => /^word\/_rels\/.+\.rels$/.test(name))) {
    const ownerName = relsName.replace('/_rels/', '/').replace(/\.rels$/, '')
    const owner = zip.files[ownerName]
    if (!owner) continue
    const baseDir = ownerName.slice(0, ownerName.lastIndexOf('/') + 1)
    const ownerXml = await owner.async('string')
    const referenced = new Set(
      [...ownerXml.matchAll(/\br:(?:embed|link|id)="([^"]+)"/g)].map((match) => match[1]),
    )
    const rewritten = (await zip.files[relsName].async('string')).replace(/<Relationship\b[^>]*>/g, (rel) => {
      if (!/relationships\/image/.test(rel)) return rel
      const id = /\bId="([^"]+)"/.exec(rel)?.[1] ?? ''
      const target = /\bTarget="([^"]+)"/.exec(rel)?.[1] ?? ''
      const part = resolvePart(baseDir, target)
      // Nothing embeds it: this is html-to-docx's orphaned first copy.
      if (!referenced.has(id)) return ''
      const kept = survivor.get(part) ?? part
      keep.add(kept)
      const retargeted = kept.startsWith(baseDir) ? kept.slice(baseDir.length) : `/${kept}`
      return rel.replace(/\bTarget="[^"]*"/, `Target="${retargeted}"`)
    })
    zip.file(relsName, rewritten)
  }

  for (const name of media) if (!keep.has(name)) zip.remove(name)
}

/**
 * An inline formula's picture sits with its bottom edge on the text baseline
 * in Word, and html-to-docx ignores vertical-align, so draw-blocks.ts hands
 * over how far each is to be lowered (`data-docx-lower`, in half-points) and
 * the run holding the picture is given Word's own lowering, `w:position`
 * (Format > Font > Position: Lowered), after html-to-docx has written it.
 *
 * The picture is found again by its bytes (html-to-docx names media at
 * random), so this is keyed by the SHA-1 of each formula's PNG.
 */
function formulaLowerings(html: string): Map<string, number> {
  const out = new Map<string, number>()
  if (!html.includes('data-docx-lower')) return out
  for (const img of findAll((n) => n.name === 'img' && n.attribs['data-docx-lower'] !== undefined, parseDocument(html).children)) {
    const lower = Number(img.attribs['data-docx-lower'])
    const data = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(img.attribs.src ?? '')
    if (data && Number.isInteger(lower) && lower > 0 && lower < 2000) {
      out.set(createHash('sha1').update(Buffer.from(data[1], 'base64')).digest('hex'), lower)
    }
  }
  return out
}

/** Elements that come after w:position in a run's properties (CT_RPr's order). */
const AFTER_POSITION = /<w:(?:sz|szCs|highlight|u|effect|bdr|shd|fitText|vertAlign|rtl|cs|em|lang|eastAsianLayout|specVanish|oMath)\b/

function withPosition(run: string, lower: number): string {
  const position = `<w:position w:val="-${lower}"/>`
  if (/<w:rPr\s*\/>/.test(run)) return run.replace(/<w:rPr\s*\/>/, `<w:rPr>${position}</w:rPr>`)
  const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)
  if (props) {
    if (props[1].includes('<w:position')) return run
    const after = AFTER_POSITION.exec(props[1])
    const inner = after ? props[1].slice(0, after.index) + position + props[1].slice(after.index) : props[1] + position
    return run.replace(props[0], `<w:rPr>${inner}</w:rPr>`)
  }
  return run.replace(/^<w:r(\s[^>]*)?>/, (open) => `${open}<w:rPr>${position}</w:rPr>`)
}

async function lowerFormulas(zip: JSZip, lowerings: Map<string, number>): Promise<void> {
  for (const relsName of Object.keys(zip.files).filter((name) => /^word\/_rels\/.+\.rels$/.test(name))) {
    const ownerName = relsName.replace('/_rels/', '/').replace(/\.rels$/, '')
    const owner = zip.files[ownerName]
    if (!owner) continue
    const baseDir = ownerName.slice(0, ownerName.lastIndexOf('/') + 1)
    const targets = new Map<string, string>()
    for (const rel of (await zip.files[relsName].async('string')).match(/<Relationship\b[^>]*>/g) ?? []) {
      if (!/relationships\/image/.test(rel)) continue
      const id = /\bId="([^"]+)"/.exec(rel)?.[1]
      const target = /\bTarget="([^"]+)"/.exec(rel)?.[1]
      if (id && target) targets.set(id, resolvePart(baseDir, target))
    }
    const hashOf = new Map<string, string>()
    for (const [id, part] of targets) {
      const file = zip.files[part]
      if (file) hashOf.set(id, createHash('sha1').update(await file.async('nodebuffer')).digest('hex'))
    }
    const xml = await owner.async('string')
    let changed = false
    const rewritten = xml.replace(/<w:r(?=[\s>])(?:(?!<\/w:r>)[\s\S])*?<w:drawing>[\s\S]*?<\/w:r>/g, (run) => {
      const id = /\br:embed="([^"]+)"/.exec(run)?.[1]
      const lower = id ? lowerings.get(hashOf.get(id) ?? '') : undefined
      if (!lower) return run
      changed = true
      return withPosition(run, lower)
    })
    if (changed) zip.file(ownerName, rewritten)
  }
}

/** CT_TcPr's child order (ECMA-376 §17.4.70). */
const TCPR_ORDER = [
  'cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar', 'textDirection',
  'tcFitText', 'vAlign', 'hideMark', 'headers', 'cellIns', 'cellDel', 'cellMerge', 'tcPrChange',
]

/**
 * html-to-docx writes a cell's w:tcBorders first and then w:gridSpan, w:vMerge
 * and w:vAlign in the order it meets them; the schema wants the span and the
 * merge before the borders. A strict reader may ignore an element out of
 * order, and Word may offer to repair the file (LibreOffice 7.3 happens to
 * honour the span either way). Each cell's properties are put back in order. A cell continuing a row span is also
 * given `<w:gridSpan w:val="0"/>` when the span is one column wide: zero is
 * not a span, so it is dropped.
 */
function orderCellProperties(xml: string): string {
  if (!xml.includes('<w:tcPr>')) return xml
  return xml.replace(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/g, (_whole, inner: string) => {
    const children = inner.match(/<w:(\w+)\b[^>]*?\/>|<w:(\w+)\b[^>]*>[\s\S]*?<\/w:\2>/g) ?? []
    const rankOf = (element: string): number => {
      const at = TCPR_ORDER.indexOf(/^<w:(\w+)/.exec(element)?.[1] ?? '')
      return at < 0 ? TCPR_ORDER.length : at
    }
    const kept = children.filter((c) => !/^<w:gridSpan w:val="0"\s*\/>$/.test(c))
    // Sort is stable: anything unknown keeps its place after the known ones.
    return `<w:tcPr>${[...kept].sort((a, b) => rankOf(a) - rankOf(b)).join('')}</w:tcPr>`
  })
}

/**
 * html-to-docx writes every zip entry STORED, so a large document balloons —
 * one workbook produced a 182 MB .docx that Word struggles to open. Repacking
 * with deflate is lossless and typically 20-30x smaller.
 */
async function recompress(docx: Buffer, lowerings: Map<string, number> = new Map()): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(docx)
    const body = zip.file('word/document.xml')
    if (body) zip.file('word/document.xml', orderCellProperties(styleRuns(await body.async('string'))))
    if (lowerings.size > 0) {
      try {
        await lowerFormulas(zip, lowerings)
      } catch {
        /* the formulas stay where html-to-docx put them: on the baseline's top */
      }
    }
    // Repacking is the one chance to fix the media parts; a failure there must
    // not cost the (much larger) compression win, so it is caught separately.
    try {
      await dedupeMedia(zip)
    } catch {
      /* leave the media parts as html-to-docx wrote them */
    }
    return await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      // Word wants the content-types part first.
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
  } catch {
    return docx
  }
}

/**
 * html-to-docx loses content around <span> elements — a book with 457 of them
 * came out as 6,305 of its 306,150 characters, and removing only the spans
 * restored 329,673. They are presentational, so unwrap them and keep the text.
 */
function unwrapSpans(html: string): string {
  return html.replace(/<\/?span\b[^>]*>/gi, '')
}

const BLOCK = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'td', 'th', 'pre', 'blockquote', 'hr', 'div', 'aside',
])

const isElement = (node: AnyNode): node is Element => node instanceof Element
const isBlock = (node: AnyNode): boolean => isElement(node) && BLOCK.has(node.name)
const holdsBlock = (el: Element): boolean => el.children.some((c) => isElement(c) && (BLOCK.has(c.name) || holdsBlock(c)))
const serialize = (nodes: AnyNode | AnyNode[]): string => render(nodes, { encodeEntities: 'utf8' })

/** Inside a cell or list item: the containers html-to-docx loses content in. */
function contained(el: Element): boolean {
  for (let p = el.parent; p; p = p.parent) {
    if (isElement(p) && (p.name === 'td' || p.name === 'th' || p.name === 'li')) return true
  }
  return false
}

/**
 * The same nodes as a run of blocks: each stretch of inline content between
 * blocks becomes its own paragraph, so text either side of a block cannot run
 * together once its container is gone.
 */
function asBlocks(nodes: AnyNode[]): string {
  let out = ''
  let run: AnyNode[] = []
  const flush = (): void => {
    if (run.length && textContent(run).trim()) out += `<p>${serialize(run).trim()}</p>`
    run = []
  }
  for (const node of nodes) {
    if (isBlock(node)) {
      flush()
      out += serialize(node)
    } else run.push(node)
  }
  flush()
  return out
}

/**
 * A table nested in a cell, as paragraphs. A row of plain cells is one
 * paragraph with the cells separated by ` | `, the marker the .doc reader
 * already uses for a cell boundary it cannot rebuild a grid from. A row whose
 * cells hold blocks keeps those blocks, cell after cell, in order. Empty cells
 * are dropped rather than leaving `a |  | b`.
 */
function flattenTable(table: Element): string {
  return ownRows(table)
    .map((row) => {
      const cells = row.children.filter((c): c is Element => isElement(c) && (c.name === 'td' || c.name === 'th'))
      if (cells.some(holdsBlock)) return cells.map((c) => asBlocks(c.children)).join('')
      const parts = cells.filter((c) => textContent(c).trim()).map((c) => serialize(c.children).trim())
      return parts.length ? `<p>${parts.join(' | ')}</p>` : ''
    })
    .join('')
}

/**
 * Put `fresh` in place of `count` children of `parent` from `at`, relinking
 * every sibling. Done by hand because domutils' replaceElement leaves the
 * replacement's old sibling pointers in place, and appending after it then
 * follows them into the fragment it came from, reordering the pieces.
 */
function splice(parent: { children: AnyNode[] }, at: number, count: number, fresh: AnyNode[]): void {
  parent.children.splice(at, count, ...fresh)
  parent.children.forEach((child, i) => {
    child.parent = parent as Element
    child.prev = parent.children[i - 1] ?? null
    child.next = parent.children[i + 1] ?? null
  })
}

function replaceWith(el: Element, fragment: string): void {
  const parent = el.parent
  if (!parent) return
  splice(parent, parent.children.indexOf(el), 1, [...parseDocument(fragment).children])
  el.parent = null
}

function elementsOf(nodes: AnyNode[], name: string, out: Element[] = []): Element[] {
  for (const node of nodes) {
    if (!isElement(node)) continue
    if (node.name === name) out.push(node)
    elementsOf(node.children, name, out)
  }
  return out
}

/** Blocks html-to-docx keeps after other content in a list item. */
const KEPT_IN_ITEM = new Set(['ul', 'ol', 'pre', 'blockquote', 'table', 'hr', 'aside'])
const KEPT_BLOCK = /^<(ul|ol|pre|blockquote|table|hr|aside)\b/i
const HEADING = /^h[1-6]$/

/**
 * A list item's paragraphs as one run of inline text, a blank line apart.
 *
 * html-to-docx keeps only the FIRST paragraph-like piece of a list item: in
 * `<li><p>one</p><p>two</p></li>`, "two" is never written, and the same goes
 * for text followed by a <p>, <div> or heading. Inline text broken with <br>
 * survives, and so do a nested list, code block or quote after a paragraph.
 * So each stretch of paragraphs becomes inline content joined by two <br>
 * (Word shows a blank line, the nearest thing to a paragraph break inside
 * one item); a heading keeps its emphasis as <strong>. The blocks that
 * survive are left where they are.
 */
function joinItemParagraphs(li: Element): string | null {
  const pieces: string[][] = [[]]
  let inline: AnyNode[] = []
  const flushInline = (): void => {
    if (inline.length && textContent(inline).trim()) pieces[pieces.length - 1].push(serialize(inline).trim())
    inline = []
  }
  for (const node of li.children) {
    if (!isElement(node) || !BLOCK.has(node.name)) {
      inline.push(node)
      continue
    }
    flushInline()
    if (KEPT_IN_ITEM.has(node.name)) {
      pieces.push([serialize(node)], [])
      continue
    }
    const inner = serialize(node.children).trim()
    if (inner) pieces[pieces.length - 1].push(HEADING.test(node.name) ? `<strong>${inner}</strong>` : inner)
  }
  flushInline()
  // Nothing to join: the library already writes an item of one paragraph,
  // and a list, code block or quote after it. A second paragraph AFTER such
  // a block is lost all the same ("Step:", code, "Then this." in a loose
  // Markdown list), so two stretches of text either side of one are joined.
  const textRuns = pieces.filter((run) => run.length > 0 && !(run.length === 1 && KEPT_BLOCK.test(run[0])))
  if (!pieces.some((run) => run.length > 1) && textRuns.length <= 1) return null
  return pieces
    .map((run) => (run.length === 1 && KEPT_BLOCK.test(run[0]) ? run[0] : run.join('<br><br>')))
    .join('')
}

/**
 * html-to-docx writes NOTHING for some content inside table cells and list
 * items, and nothing says so: the page around it arrives and it does not.
 * Measured against html-to-docx 1.8.0:
 *
 *   <td><table>…</table></td>        a table nested in a cell (or th, or li)
 *   <td><div><p>…</p></div></td>     a div holding blocks in a cell (or li)
 *   <li><p>one</p><p>two</p></li>    every paragraph of an item after the first
 *   <td>a <b>b</b> c</td>             not lost, but each piece made its own paragraph
 *
 * A div of inline text survives, as do a paragraph, list, quote or code block
 * in a cell. One old-style page, laid out as a table with a navigation table
 * in the sidebar and the article in a div beside it, came out with 49 of its
 * ~1,700 characters: the menu and the footer, and none of the article.
 *
 * Word itself nests tables fine; the library does not. So a nested table is
 * flattened into paragraphs, a block-holding div in a cell or item is
 * unwrapped, and an item's paragraphs are joined (see joinItemParagraphs),
 * keeping every word in its order at the cost of the inner grid. Innermost
 * first, so a table inside a table inside a cell arrives as blocks before its
 * parent is flattened. Untouched, and unparsed, when there is no table and no
 * list.
 */
export function flattenForDocx(source: string): string {
  if (!/<(table|li)\b/i.test(source)) return source
  const dom = parseDocument(source)
  let changed = false
  for (const table of elementsOf(dom.children, 'table').reverse()) {
    if (!contained(table)) continue
    replaceWith(table, flattenTable(table))
    changed = true
  }
  for (const div of elementsOf(dom.children, 'div').reverse()) {
    if (!contained(div) || !holdsBlock(div)) continue
    replaceWith(div, asBlocks(div.children))
    changed = true
  }
  // A cell's inline formatting: html-to-docx gives each inline child of a
  // <td> its own paragraph, so "a <strong>b</strong> c" came out as three
  // lines. Inside a <p> they are runs of one paragraph, as anywhere else.
  for (const cell of [...elementsOf(dom.children, 'td'), ...elementsOf(dom.children, 'th')]) {
    // A picture is left where it is: dedupeMedia expects its cell form.
    if (!cell.children.some((c) => isElement(c) && !BLOCK.has(c.name)) || elementsOf(cell.children, 'img').length) continue
    splice(cell, 0, cell.children.length, [...parseDocument(asBlocks(cell.children)).children])
    changed = true
  }
  for (const li of elementsOf(dom.children, 'li').reverse()) {
    const joined = joinItemParagraphs(li)
    if (joined === null) continue
    splice(li, 0, li.children.length, [...parseDocument(joined).children])
    changed = true
  }
  return changed ? serialize(dom.children) : source
}

/**
 * html-to-docx writes the text of a <pre> as it is, newlines and all, and Word
 * shows a newline in a run as a space: a code block came out as one long line.
 * A <br> straight inside <pre> or <code> is dropped too, but one wrapped in a
 * <span> becomes a <w:br/> (so a <br> already there is wrapped as well), a line break inside the block's one paragraph —
 * so the block stays a single monospace unit, and the runs keep their spaces
 * and tabs (xml:space="preserve"). Run after unwrapSpans, which would take the
 * wrappers off again, and which has by then merged any highlighting span a
 * newline fell inside into plain text. The newline that ends the last line is
 * dropped rather than leaving an empty line under the block.
 *
 * In a list item the block shares a paragraph with the item's text, so a
 * break also goes between them, where there is text either side.
 */
function breakCodeLines(source: string): string {
  if (!/<pre\b/i.test(source)) return source
  const dom = parseDocument(source)
  const pres = elementsOf(dom.children, 'pre')
  if (!pres.length) return source
  const lineBreak = (): Element => new Element('span', {}, [new Element('br', {})])
  const hasText = (nodes: AnyNode[]): boolean => textContent(nodes).trim() !== ''
  for (const pre of pres) {
    const texts: Text[] = []
    const collect = (nodes: AnyNode[]): void => {
      for (const node of nodes) {
        if (node instanceof Text) texts.push(node)
        else if (isElement(node) && node.name === 'br') splice(node.parent!, node.parent!.children.indexOf(node), 1, [lineBreak()])
        else if (isElement(node)) collect(node.children)
      }
    }
    collect(pre.children)
    const last = texts.findLast((t) => t.data !== '')
    if (last) last.data = last.data.replace(/\r?\n$/, '')
    for (const text of texts) {
      const lines = text.data.split(/\r?\n/)
      if (lines.length === 1) continue
      const fresh: AnyNode[] = []
      lines.forEach((line, i) => {
        if (i) fresh.push(lineBreak())
        if (line) fresh.push(new Text(line))
      })
      const parent = text.parent!
      splice(parent, parent.children.indexOf(text), 1, fresh)
    }
    const li = pre.parent
    if (li instanceof Element && li.name === 'li') {
      const at = li.children.indexOf(pre)
      if (hasText(li.children.slice(at + 1))) splice(li, at + 1, 0, [lineBreak()])
      if (hasText(li.children.slice(0, at))) splice(li, at, 0, [lineBreak()])
    }
  }
  return serialize(dom.children)
}

/** The font html-to-docx itself gives a top-level code block. */
const CODE_FONT = 'Courier'

/**
 * html-to-docx sets a <pre> in Courier only when the <pre> is a paragraph of
 * its own: at the top level or in a table cell. In a list item the item's
 * text and the block share one paragraph, the <pre> is read as a run, and its
 * text came out in the body font. Inline <code> is never given a font at all.
 *
 * The one font the library honours on a run is a `font-family` on a <span>,
 * so each piece of code text is wrapped in one. A span holding just text is
 * the shape breakCodeLines already relies on; the spans that lost content
 * (see unwrapSpans) are gone by now, so these are the only ones. Rewriting
 * w:rFonts in document.xml afterwards would mean finding code runs again
 * among the library's output, with nothing in it to tell them apart.
 *
 * A top-level or in-cell block already gets Courier from the library and is
 * left alone.
 */
function monospaceCode(source: string): string {
  if (!/<code\b|<pre\b/i.test(source)) return source
  const dom = parseDocument(source)
  const within = (el: Element, name: string): boolean => {
    for (let p = el.parent; p; p = p.parent) if (isElement(p) && p.name === name) return true
    return false
  }
  const targets = [
    ...elementsOf(dom.children, 'pre').filter((pre) => within(pre, 'li')),
    ...elementsOf(dom.children, 'code').filter((code) => !within(code, 'pre')),
  ]
  if (!targets.length) return source
  const wrap = (nodes: AnyNode[]): void => {
    for (const node of [...nodes]) {
      if (node instanceof Text && node.data !== '') {
        const parent = node.parent!
        splice(parent, parent.children.indexOf(node), 1, [new Element('span', { style: `font-family: ${CODE_FONT}` }, [new Text(node.data)])])
      } else if (isElement(node) && !(node.name === 'span' && node.attribs.style)) wrap(node.children)
    }
  }
  for (const el of targets) wrap(el.children)
  return serialize(dom.children)
}

/** Run formatting, one bit each, carried to Word in a stand-in colour (see flattenFormatting). */
const BOLD = 1
const ITALIC = 2
const UNDERLINE = 4
const STRIKE = 8
const SUPER = 16
const SUB = 32
const MARK = 64

const FORMAT_BITS: Record<string, number> = {
  strong: BOLD, b: BOLD,
  em: ITALIC, i: ITALIC, cite: ITALIC, var: ITALIC, dfn: ITALIC,
  u: UNDERLINE, ins: UNDERLINE,
  s: STRIKE, del: STRIKE, strike: STRIKE,
  sup: SUPER, sub: SUB,
  mark: MARK,
}
/** Set in the code font, as a browser sets them in its monospace one. */
const MONOSPACE = new Set(['code', 'kbd', 'samp', 'tt'])
/** Inline elements html-to-docx writes an empty run for: their text is kept, unformatted. */
const TRANSPARENT = new Set(['span', 'small', 'big', 'abbr', 'acronym', 'time', 'data', 'bdi', 'bdo', 'font', 'q'])
/** Left exactly as they are: a code block keeps its own line-break spans. */
const UNTOUCHED = new Set(['pre', 'svg', 'math', 'script', 'style'])

/**
 * The stand-in colour: `0D0C` and the formatting bits as two hex digits.
 * Near black, so a run the post-pass somehow misses still reads as text.
 */
const STAND_IN = /<w:color w:val="0D0C([0-9A-Fa-f]{2})"\/>/

interface Look {
  bits: number
  font?: string
}

/**
 * html-to-docx 1.8.0 maps <i> to italic but not <em>; it has a case for
 * <s>/<del>/<strike> that never sets anything; and in nested tags each one
 * replaces the formatting of the tag around it, so `<em><strong>` is bold
 * only. On a <span> it reads font-weight:bold, font-family, font-size, color
 * and background-color, and nothing for italic, underline, strike or
 * vertical-align. Every reader's output reaches Word through it, so ***both***
 * and ~~struck~~ lost their formatting from any source.
 *
 * So each piece of formatted text becomes a <span> holding only that text —
 * the one shape html-to-docx writes faithfully (see unwrapSpans) — whose
 * `color` is a stand-in naming every style the text has, inherited through
 * any depth of nesting; the formatting tags themselves are taken away. Once
 * the document is written, styleRuns turns each stand-in colour back into
 * Word's own w:b, w:i, w:u, w:strike, w:vertAlign and w:highlight. The code
 * font travels as the span's font-family, which html-to-docx does honour.
 *
 * Taking the tags away also mends three other losses, measured:
 *  - a link inside formatting (`<strong><a>`) was written as plain text, as
 *    html-to-docx only makes a hyperlink of an <a> in a paragraph's own
 *    children; and of an <a> it writes only the FIRST child, so a link
 *    holding formatting is wrapped in one plain <span> holding all of it;
 *  - a text node of only whitespace is dropped, so `**a** *b*` read "ab":
 *    such a space is joined to the text beside it;
 *  - a <br> inside formatting, and the text of a tag it does not know
 *    (<kbd>, <small>, <abbr>), were not written at all.
 *
 * A code block is left alone: breakCodeLines and monospaceCode have shaped it.
 */
function flattenFormatting(source: string): string {
  if (!/<(strong|b|em|i|cite|var|dfn|u|ins|s|del|strike|sup|sub|mark|code|kbd|samp|tt|span|small|big|abbr|acronym|time|data|bdi|bdo|font|q|a)\b/i.test(source)) {
    return source
  }
  const dom = parseDocument(source)

  const lookOf = (el: Element, look: Look): Look | null => {
    const bit = FORMAT_BITS[el.name]
    if (bit) {
      // A superscript inside a subscript (or the other way) takes the inner one.
      const bits = bit === SUPER || bit === SUB ? (look.bits & ~(SUPER | SUB)) | bit : look.bits | bit
      return { ...look, bits }
    }
    if (MONOSPACE.has(el.name)) return { ...look, font: CODE_FONT }
    if (el.name === 'span') {
      // monospaceCode's spans: the only ones left by now.
      const font = /font-family:\s*([^;]+)/i.exec(el.attribs.style ?? '')?.[1]?.trim()
      return font ? { ...look, font } : look
    }
    if (TRANSPARENT.has(el.name)) return look
    return null
  }

  const styleOf = (look: Look): string =>
    [look.bits ? `color: #0D0C${look.bits.toString(16).toUpperCase().padStart(2, '0')}` : '', look.font ? `font-family: ${look.font}` : '']
      .filter(Boolean)
      .join('; ')

  const restyle = (node: AnyNode, look: Look): AnyNode[] => {
    if (node instanceof Text) {
      if (node.data === '' || (!look.bits && !look.font)) return [node]
      return [new Element('span', { style: styleOf(look) }, [new Text(node.data)])]
    }
    if (!isElement(node) || UNTOUCHED.has(node.name)) return [node]
    const own = lookOf(node, look)
    let kids = node.children.flatMap((child) => restyle(child, own ?? look))
    if (node.name === 'q') kids = [new Text('\u201C'), ...kids, new Text('\u201D')]
    if (own) return kids
    splice(node, 0, node.children.length, kids)
    joinSpaces(node)
    if (node.name === 'a' && node.children.length > 1 && !elementsOf(node.children, 'img').length) {
      splice(node, 0, node.children.length, [new Element('span', {}, [...node.children])])
    }
    return [node]
  }

  for (const node of [...dom.children]) {
    const fresh = restyle(node, { bits: 0 })
    splice(dom, dom.children.indexOf(node), 1, fresh)
  }
  return serialize(dom.children)
}

/** A text node, or one of flattenFormatting's spans holding just text: its Text. */
function leafText(node: AnyNode | null | undefined): Text | null {
  if (!node) return null
  if (node instanceof Text) return node
  if (isElement(node) && node.name === 'span' && node.children.length === 1 && node.children[0] instanceof Text) {
    return node.children[0]
  }
  return null
}

/** A leaf whose formatting draws across its spaces too: strike, underline, highlight. */
function drawsLine(node: AnyNode): boolean {
  if (!isElement(node)) return false
  const bits = /0D0C([0-9A-F]{2})/i.exec(node.attribs.style ?? '')?.[1]
  return bits !== undefined && (parseInt(bits, 16) & (STRIKE | UNDERLINE | MARK)) !== 0
}

/**
 * Join each whitespace-only piece of inline text to the text beside it, as
 * html-to-docx drops it otherwise: to plain text after it if there is some,
 * else to a neighbour that draws no line through a space (`~~a~~ b` must not
 * strike the space), the one before first. Whitespace between blocks has no
 * text beside it and is left alone.
 */
function joinSpaces(parent: Element): void {
  for (let i = 0; i < parent.children.length; i++) {
    const node = parent.children[i]
    const own = leafText(node)
    if (!own || own.data === '' || own.data.trim() !== '') continue
    const prev = parent.children[i - 1]
    const next = parent.children[i + 1]
    const before = leafText(prev)
    const after = leafText(next)
    if (after && (next instanceof Text || (!drawsLine(next) && (!before || drawsLine(prev))))) after.data = own.data + after.data
    else if (before) before.data += own.data
    else if (after) after.data = own.data + after.data
    else continue
    splice(parent, i, 1, [])
    i--
  }
}

/** CT_RPr's child order (ECMA-376 §17.3.2.28): Word may refuse a run out of it. */
const RPR_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow',
  'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern',
  'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs',
  'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath',
]
const rank = (element: string): number => {
  const at = RPR_ORDER.indexOf(/^<w:(\w+)/.exec(element)?.[1] ?? '')
  return at < 0 ? RPR_ORDER.length : at
}

/** The run properties a stand-in colour stands for. */
function propertiesFor(bits: number): string[] {
  const out: string[] = []
  if (bits & BOLD) out.push('<w:b/>')
  if (bits & ITALIC) out.push('<w:i/>')
  if (bits & STRIKE) out.push('<w:strike/>')
  if (bits & MARK) out.push('<w:highlight w:val="yellow"/>')
  if (bits & UNDERLINE) out.push('<w:u w:val="single"/>')
  if (bits & SUPER) out.push('<w:vertAlign w:val="superscript"/>')
  else if (bits & SUB) out.push('<w:vertAlign w:val="subscript"/>')
  return out
}

/**
 * Each stand-in colour flattenFormatting left becomes the formatting it
 * stands for, the run's properties put in the schema's order (html-to-docx
 * writes them in the order it met them: a hyperlink's w:rStyle after w:b).
 */
function styleRuns(xml: string): string {
  if (!STAND_IN.test(xml)) return xml
  return xml.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (whole, inner: string) => {
    const standIn = STAND_IN.exec(inner)
    if (!standIn) return whole
    const kept = (inner.match(/<w:\w+\b[^>]*?\/>|<w:(\w+)\b[^>]*>[\s\S]*?<\/w:\1>/g) ?? []).filter((e) => !STAND_IN.test(e))
    const names = new Set(kept.map((e) => /^<w:(\w+)/.exec(e)?.[1]))
    const added = propertiesFor(parseInt(standIn[1], 16)).filter((e) => !names.has(/^<w:(\w+)/.exec(e)?.[1]))
    const all = [...kept, ...added].sort((a, b) => rank(a) - rank(b))
    return `<w:rPr>${all.join('')}</w:rPr>`
  })
}

export async function writeDocx(doc: HubDocument): Promise<Buffer> {
  const html = renderDocumentShell(
    {
      ...doc,
      html: flattenFormatting(
        monospaceCode(breakCodeLines(unwrapSpans(flattenForDocx(dropUnresolvableImages(footnotesForOutput(doc.html, 'plain')))))),
      ),
    },
    { target: 'docx' },
  )
  const result = await HTMLtoDOCX(html)
  return recompress(Buffer.isBuffer(result) ? result : Buffer.from(result as ArrayBuffer), formulaLowerings(html))
}
