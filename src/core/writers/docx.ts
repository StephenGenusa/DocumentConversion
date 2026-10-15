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

/**
 * html-to-docx writes every zip entry STORED, so a large document balloons —
 * one workbook produced a 182 MB .docx that Word struggles to open. Repacking
 * with deflate is lossless and typically 20-30x smaller.
 */
async function recompress(docx: Buffer, lowerings: Map<string, number> = new Map()): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(docx)
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
  // Nothing to join: the library already writes an item of one paragraph.
  if (!pieces.some((run) => run.length > 1)) return null
  return pieces
    .map((run) => (run.length === 1 && /^<(ul|ol|pre|blockquote|table|hr|aside)\b/i.test(run[0]) ? run[0] : run.join('<br><br>')))
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

export async function writeDocx(doc: HubDocument): Promise<Buffer> {
  const html = renderDocumentShell(
    { ...doc, html: breakCodeLines(unwrapSpans(flattenForDocx(dropUnresolvableImages(footnotesForOutput(doc.html, 'plain'))))) },
    { target: 'docx' },
  )
  const result = await HTMLtoDOCX(html)
  return recompress(Buffer.isBuffer(result) ? result : Buffer.from(result as ArrayBuffer), formulaLowerings(html))
}
