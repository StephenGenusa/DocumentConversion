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
import hljs, { highlightedRuns } from '../hljs'
import { highlightMarkup } from '../code-markup'
import type { ConvertOptions, HubDocument } from '../types'
import { DOCX_OWN_LINE } from '../draw-blocks'
import { pictureType, wordTakes } from '../pictures'
import { originalSize } from '../picture-headers'
import { codeBookmarkName } from '../code-bookmark'
import { parseCssColor, wordHex } from '../css-color'

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

/**
 * html-to-docx sizes every picture with image-size, which reads no TIFF from
 * memory and no EMF or WMF at all, and the whole document then failed. So
 * only the types it sizes are passed, told by their bytes (a page may label
 * a TIFF as a PNG). TIFF, EMF and WMF reach it as stand-ins
 * (standInOriginals); what is still here becomes its alt text.
 */
function wordSizes(src: string): boolean {
  const b64 = src.slice(src.indexOf(',') + 1, src.indexOf(',') + 1 + 64).replace(/\s+/g, '')
  return wordTakes(Buffer.from(b64.slice(0, b64.length - (b64.length % 4)), 'base64'))
}

/**
 * Word shows TIFF, EMF and WMF itself, so each is embedded as the document
 * has it (a TIFF of several pages was made one TIFF a page before here:
 * pictures.ts). html-to-docx cannot size them, so it is handed a stand-in
 * it can: a GIF whose header claims the picture's size - the size the
 * document gives it, else its own header's (picture-headers.ts) - the GIF
 * itself one pixel. After
 * html-to-docx has laid the stand-in out (extent, alt, relationship), the
 * part is given back the original's bytes, named and typed for it
 * (restoreOriginals). Each stand-in carries the original's hash in a GIF
 * comment, so two pictures never share one; a picture whose header gives no
 * size is left for dropUnresolvableImages (its alt text).
 */
interface Original {
  bytes: Buffer
  ext: string
  contentType: string
}
const ORIGINAL_TYPES: Record<string, { ext: string; contentType: string }> = {
  'image/tiff': { ext: 'tif', contentType: 'image/tiff' },
  'image/x-emf': { ext: 'emf', contentType: 'image/x-emf' },
  'image/x-wmf': { ext: 'wmf', contentType: 'image/x-wmf' },
}

function standInGif(width: number, height: number, tag: string): Buffer {
  const screen = Buffer.alloc(13)
  screen.write('GIF89a', 0, 'latin1')
  screen.writeUInt16LE(width, 6)
  screen.writeUInt16LE(height, 8)
  screen[10] = 0x80 // a global color table of two colors
  const comment = Buffer.from(tag, 'latin1')
  return Buffer.concat([
    screen,
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    Buffer.from([0x21, 0xfe, comment.length]),
    comment,
    Buffer.from([0x00]),
    // One 1x1 image at the corner: LZW minimum code size 2, codes clear, 0, end.
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]),
  ])
}

function standInOriginals(html: string, originals: Map<string, Original>): string {
  if (!/<img/i.test(html)) return html
  const dom = parseDocument(html)
  let changed = false
  for (const img of findAll((n) => n.name === 'img', dom.children)) {
    const data = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(img.attribs.src ?? '')
    if (!data) continue
    const bytes = Buffer.from(data[1].replace(/\s+/g, ''), 'base64')
    const mime = pictureType(bytes)
    const type = mime ? ORIGINAL_TYPES[mime] : undefined
    const size = type && mime ? originalSize(mime, bytes) : null
    if (!type || !size) continue
    // The size the document gives it (an RTF picture's \picwgoal), where it gives one.
    const given = (name: 'width' | 'height'): number | undefined => {
      const n = Number(img.attribs[name])
      return Number.isInteger(n) && n >= 1 && n <= 20000 ? n : undefined
    }
    const width = given('width') ?? size.width
    const height = given('height') ?? size.height
    const hash = createHash('sha1').update(bytes).digest('hex')
    const gif = standInGif(width, height, hash)
    originals.set(createHash('sha1').update(gif).digest('hex'), { bytes, ...type })
    img.attribs.src = `data:image/gif;base64,${gif.toString('base64')}`
    changed = true
  }
  return changed ? render(dom, { encodeEntities: 'utf8' }) : html
}

/** Each stand-in's part given back its original: its bytes, its extension, and every relationship to it retargeted. */
async function restoreOriginals(zip: JSZip, originals: Map<string, Original>): Promise<void> {
  const renamed = new Map<string, string>()
  for (const name of Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !zip.files[n].dir)) {
    const original = originals.get(createHash('sha1').update(await zip.files[name].async('nodebuffer')).digest('hex'))
    if (!original) continue
    const to = name.replace(/\.[^./]*$/, '') + '.' + original.ext
    zip.remove(name)
    zip.file(to, original.bytes)
    renamed.set(name, to)
  }
  if (renamed.size === 0) return
  for (const relsName of Object.keys(zip.files).filter((name) => /^word\/_rels\/.+\.rels$/.test(name))) {
    const ownerName = relsName.replace('/_rels/', '/').replace(/\.rels$/, '')
    const baseDir = ownerName.slice(0, ownerName.lastIndexOf('/') + 1)
    const xml = await zip.files[relsName].async('string')
    const rewritten = xml.replace(/<Relationship\b[^>]*>/g, (rel) => {
      const target = /\bTarget="([^"]+)"/.exec(rel)?.[1]
      const to = target ? renamed.get(resolvePart(baseDir, target)) : undefined
      if (!to) return rel
      return rel.replace(/\bTarget="[^"]*"/, `Target="${to.startsWith(baseDir) ? to.slice(baseDir.length) : `/${to}`}"`)
    })
    if (rewritten !== xml) zip.file(relsName, rewritten)
  }
}

/** Picture parts by extension, as Word names their content types. */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
}

/**
 * html-to-docx declares content types for png and jpeg only, so a GIF, BMP
 * or WebP part (and now a TIFF, EMF or WMF) had none, which Word treats as
 * a damaged file. Every picture part's extension is declared.
 */
async function declareMediaTypes(zip: JSZip): Promise<void> {
  const part = zip.file('[Content_Types].xml')
  if (!part) return
  const xml = await part.async('string')
  const declared = new Set([...xml.matchAll(/<Default\b[^>]*\bExtension="([^"]+)"/g)].map((m) => m[1].toLowerCase()))
  const missing = new Set<string>()
  for (const name of Object.keys(zip.files)) {
    if (!name.startsWith('word/media/') || zip.files[name].dir) continue
    const ext = /\.([^./]+)$/.exec(name)?.[1].toLowerCase()
    if (ext && MEDIA_TYPES[ext] && !declared.has(ext)) missing.add(ext)
  }
  if (missing.size === 0) return
  const defaults = [...missing].map((ext) => `<Default Extension="${ext}" ContentType="${MEDIA_TYPES[ext]}"/>`).join('')
  // Defaults before the overrides, as Word writes them.
  zip.file('[Content_Types].xml', /<Override\b/.test(xml) ? xml.replace(/<Override\b/, `${defaults}<Override`) : xml.replace('</Types>', `${defaults}</Types>`))
}

function dropUnresolvableImages(html: string): string {
  return replaceImages(html, (src, alt) => {
    if (SAFE_IMAGE_DATA.test(src) && !SVG_IMAGE.test(src) && wordSizes(src)) return null
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

/** The `w:` children of an element's inside, each whole. */
const childrenOf = (inner: string): string[] => inner.match(/<w:(\w+)\b[^>]*?\/>|<w:(\w+)\b[^>]*>[\s\S]*?<\/w:\2>/g) ?? []

/** Children put in the schema's order. Sort is stable: anything unknown keeps its place after the known ones. */
function inOrder(children: string[], order: readonly string[]): string[] {
  const rankOf = (element: string): number => {
    const at = order.indexOf(/^<w:(\w+)/.exec(element)?.[1] ?? '')
    return at < 0 ? order.length : at
  }
  return [...children].sort((a, b) => rankOf(a) - rankOf(b))
}

/**
 * html-to-docx writes a cell's w:tcBorders first and then w:gridSpan, w:vMerge
 * and w:vAlign in the order it meets them; the schema wants the span and the
 * merge before the borders. A strict reader may ignore an element out of
 * order, and Word may offer to repair the file (LibreOffice 7.3 happens to
 * honor the span either way). Each cell's properties are put back in order
 * (by schemaOrder). A cell continuing a row span is also
 * given `<w:gridSpan w:val="0"/>` when the span is one column wide: zero is
 * not a span, so it is dropped.
 */
function orderCellProperties(xml: string): string {
  if (!xml.includes('<w:gridSpan w:val="0"')) return xml
  return xml.replace(/<w:gridSpan w:val="0"\s*\/>/g, '')
}

/** CT_PPrBase's child order, then CT_PPr's own. */
const PPR_ORDER = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers',
  'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE',
  'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents',
  'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle',
  'rPr', 'sectPr', 'pPrChange',
]
/** The sides of a table's, a cell's or a paragraph's borders and margins. */
const SIDES = ['top', 'start', 'left', 'bottom', 'end', 'right', 'insideH', 'insideV', 'tl2br', 'tr2bl', 'between', 'bar']

/**
 * The child order of every element html-to-docx or this writer writes whose
 * children the schema puts in a sequence: ISO/IEC 29500-4's wml.xsd, the
 * transitional schema Word writes (CT_TblBorders, CT_TcBorders and the
 * margins keep left and right beside start and end; ECMA-376's first edition
 * had left and right only, in the same places). A run's properties are a
 * choice there, in any order, but are given the first edition's sequence
 * (RPR_ORDER) all the same, as styleRuns does; a row's (w:trPr) are a choice
 * in both.
 */
const SCHEMA_ORDER: Record<string, readonly string[]> = {
  pPr: PPR_ORDER,
  tblPr: [
    'tblStyle', 'tblpPr', 'tblOverlap', 'bidiVisual', 'tblStyleRowBandSize', 'tblStyleColBandSize', 'tblW', 'jc',
    'tblCellSpacing', 'tblInd', 'tblBorders', 'shd', 'tblLayout', 'tblCellMar', 'tblLook', 'tblCaption', 'tblDescription',
    'tblPrChange',
  ],
  tblBorders: SIDES,
  tblCellMar: SIDES,
  tcPr: TCPR_ORDER,
  tcBorders: SIDES,
  tcMar: SIDES,
  pBdr: SIDES,
  sectPr: [
    'headerReference', 'footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders',
    'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter',
    'docGrid', 'printerSettings', 'sectPrChange',
  ],
}

/**
 * Each element of SCHEMA_ORDER given its children in the schema's order, and
 * each run's properties RPR_ORDER. html-to-docx writes them in the order it
 * meets the HTML and CSS: a paragraph's w:spacing after its w:jc, a table's
 * w:tblCellSpacing after its borders and its w:jc last, a cell's border sides
 * as its style names them. An element holding anything but whole `w:`
 * children is left as it is.
 */
function schemaOrder(xml: string): string {
  const orders: [string, readonly string[]][] = [...Object.entries(SCHEMA_ORDER), ['rPr', RPR_ORDER]]
  for (const [name, order] of orders) {
    if (!xml.includes(`<w:${name}>`)) continue
    xml = xml.replace(new RegExp(`<w:${name}>([\\s\\S]*?)<\\/w:${name}>`, 'g'), (whole, inner: string) => {
      const children = childrenOf(inner)
      const tight = (text: string): string => text.replace(/>\s+</g, '><').trim()
      if (tight(children.join('')) !== tight(inner)) return whole
      return `<w:${name}>${inOrder(children, order).join('')}</w:${name}>`
    })
  }
  return xml
}

/**
 * html-to-docx writes a table's grid (w:tblGrid) before the first row of
 * each <thead> and <tbody>, so a table with both had two, the second among
 * the rows, where the schema has one, right after w:tblPr. The widest is
 * kept there; of two as wide, the first (a <colgroup>'s, with its widths).
 */
function oneGrid(xml: string): string {
  if (!/<\/w:tblGrid>[\s\S]*?<w:tblGrid>/.test(xml)) return xml
  return xml.replace(/<w:tbl>((?:(?!<w:tbl>)[\s\S])*?)<\/w:tbl>/g, (whole, inner: string) => {
    const grids = inner.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/g) ?? []
    if (grids.length < 2) return whole
    const columns = (grid: string): number => grid.split('<w:gridCol').length
    const widest = grids.reduce((a, b) => (columns(b) > columns(a) ? b : a))
    const rest = inner.replace(/\s*<w:tblGrid>[\s\S]*?<\/w:tblGrid>/g, '')
    return `<w:tbl>${rest.includes('</w:tblPr>') ? rest.replace('</w:tblPr>', () => `</w:tblPr>${widest}`) : widest + rest}</w:tbl>`
  })
}

/**
 * A cell spanning rows at the END of its row (`<th rowspan="2">Result</th>`
 * as the last header) lost its continuation in the next row: html-to-docx
 * writes a row's pending continuations only before each of its own cells, so
 * one owed after the last cell was written into the row after, before that
 * row's last cell. The header's second row came out a column short, the
 * first body row a column long and shifted, and Word drew every column after
 * it out of line. Each row short of the grid takes back the continuation the
 * next row holds at the place it is missing (or gets an empty one).
 */
const TC = /<w:tc>(?:(?!<w:tc>)[\s\S])*?<\/w:tc>/g
function trailingRowSpans(xml: string): string {
  if (!xml.includes('w:vMerge')) return xml
  return xml.replace(/<w:tbl>((?:(?!<w:tbl>)[\s\S])*?)<\/w:tbl>/g, (whole, inner: string) => {
    if (!inner.includes('w:vMerge')) return whole
    const grid = /<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/.exec(inner)
    const columns = grid ? (grid[1].match(/<w:gridCol\b/g) ?? []).length : 0
    if (columns === 0) return whole
    const rows = [...inner.matchAll(/(<w:tr\b[^>]*>)([\s\S]*?)(<\/w:tr>)/g)]
    const parsed = rows.map((m): { head: string; cells: string[]; tail: string } => {
      const first = m[2].search(/<w:tc>/)
      return { head: m[1] + (first < 0 ? m[2] : m[2].slice(0, first)), cells: first < 0 ? [] : (m[2].slice(first).match(TC) ?? []), tail: m[3] }
    })
    const span = (cell: string): number => Number(/<w:gridSpan w:val="(\d+)"/.exec(cell)?.[1] ?? 1) || 1
    const width = (cells: string[]): number => cells.reduce((n, c) => n + span(c), 0)
    const isContinue = (cell: string): boolean => /<w:vMerge w:val="continue"\s*\/>/.test(cell)
    let changed = false
    for (let r = 0; r < parsed.length; r++) {
      const row = parsed[r]
      const next = parsed[r + 1]
      while (width(row.cells) < columns) {
        const at = width(row.cells)
        let moved = false
        if (next && width(next.cells) > columns) {
          let pos = 0
          for (let k = 0; k < next.cells.length; k++) {
            if (pos === at && isContinue(next.cells[k])) {
              row.cells.push(next.cells.splice(k, 1)[0])
              moved = true
              break
            }
            pos += span(next.cells[k])
          }
        }
        if (!moved) break
        changed = true
      }
    }
    if (!changed) return whole
    let i = 0
    const rebuilt = inner.replace(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g, () => {
      const row = parsed[i++]
      return row.head + row.cells.join('') + row.tail
    })
    return `<w:tbl>${rebuilt}</w:tbl>`
  })
}

/**
 * html-to-docx's document template opens the body with its w:sectPr (page
 * size and margins), and the paragraphs follow it; the schema (CT_Body) has
 * the body's section properties last, after every paragraph and table.
 * LibreOffice reads it either way, but a validating reader rejects the whole
 * body ("w:p is not expected"), and Word may offer to repair the file, so it
 * is moved to the end.
 */
function sectionLast(xml: string): string {
  return xml.replace(/(<w:body>\s*)(<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>)([\s\S]*?)(\s*<\/w:body>)/, (_whole, open: string, section: string, rest: string, close: string) =>
    rest.trim() ? `${open}${rest.trim()}${section}${close}` : _whole,
  )
}

/**
 * html-to-docx writes every zip entry STORED, so a large document balloons —
 * one workbook produced a 182 MB .docx that Word struggles to open. Repacking
 * with deflate is lossless and typically 20-30x smaller.
 */
async function recompress(
  docx: Buffer,
  lowerings: Map<string, number> = new Map(),
  colored: ColoredLook[] = [],
  originals: Map<string, Original> = new Map(),
  languages: string[] = [],
  bordered: CellBorders[] = [],
): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(docx)
    // Before anything else hashes the media: the stand-ins become the pictures they stand for.
    try {
      if (originals.size > 0) await restoreOriginals(zip, originals)
      await declareMediaTypes(zip)
    } catch {
      /* the stand-ins stay: one-pixel GIFs at each picture's size */
    }
    const body = zip.file('word/document.xml')
    if (body) zip.file('word/document.xml', codeBookmarks(schemaOrder(trailingRowSpans(oneGrid(orderCellProperties(cellBorderSides(styleRuns(sectionLast(await body.async('string')), colored), bordered))))), languages))
    for (const name of ['word/styles.xml', 'word/numbering.xml']) {
      const part = zip.file(name)
      if (part) zip.file(name, schemaOrder(await part.async('string')))
    }
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

/** How far a definition sits in from its term, per level of nesting: half an inch, Word's own step. */
const DEFINITION_INDENT_PT = 36

/**
 * Word has no definition list, and html-to-docx writes a `<dl>`'s terms and
 * definitions as plain paragraphs, alike. So each term becomes a paragraph of
 * its own in bold, and each paragraph of a definition is indented below it
 * (`margin-left`, which html-to-docx writes as the paragraph's indent),
 * deeper for a list inside a definition. Text sitting loose in a definition
 * is given a paragraph to indent; a list, table or code block in one is left
 * as it is. Innermost first, so an inner list's indents are set before its
 * outer one adds none over them.
 */
export function definitionListsForDocx(source: string): string {
  if (!/<dl\b/i.test(source)) return source
  const dom = parseDocument(source)
  for (const dl of elementsOf(dom.children, 'dl').reverse()) {
    let depth = 1
    for (let p = dl.parent; p; p = p.parent) if (isElement(p) && p.name === 'dl') depth++
    const indent = `margin-left: ${depth * DEFINITION_INDENT_PT}pt`
    let out = ''
    for (const item of dl.children) {
      if (!isElement(item)) continue
      if (item.name === 'dt') {
        const term = serialize(item.children).trim()
        if (term) out += `<p><strong>${term}</strong></p>`
        continue
      }
      if (item.name !== 'dd') {
        out += serialize(item)
        continue
      }
      let inline: AnyNode[] = []
      const flush = (): void => {
        if (inline.length && textContent(inline).trim()) out += `<p style="${indent}">${serialize(inline).trim()}</p>`
        inline = []
      }
      for (const node of item.children) {
        if (!isBlock(node)) {
          inline.push(node)
          continue
        }
        flush()
        const el = node as Element
        if (el.name === 'p' && !/margin-left/.test(el.attribs.style ?? '')) el.attribs.style = indent
        out += serialize(el)
      }
      flush()
    }
    replaceWith(dl, out)
  }
  return serialize(dom.children)
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
 * Display math that stood inside a paragraph (draw-blocks.ts marks its
 * picture DOCX_OWN_LINE, between two <br>s): a Word paragraph has one
 * alignment, so the paragraph is split around it, the formula centered in a
 * paragraph of its own and the text either side keeping the paragraph's
 * attributes, as pandoc writes display math to Word. In a list item or a
 * cell the paragraph is left whole (html-to-docx loses content there, and
 * an item's pieces would become items of their own), so the formula keeps
 * its line between the two breaks.
 */
function centerOwnLineFormulas(source: string): string {
  if (!source.includes(DOCX_OWN_LINE)) return source
  const dom = parseDocument(source)
  // The picture, or the TeX of one that could not be drawn (draw-blocks.ts undrawnHtml).
  const ownLine = (n: AnyNode | undefined): n is Element =>
    !!n && isElement(n) && (n.name === 'img' || n.name === 'code') && n.attribs[DOCX_OWN_LINE] !== undefined
  const isBr = (n: AnyNode | undefined): boolean => !!n && isElement(n) && n.name === 'br'
  let changed = false
  for (const p of elementsOf(dom.children, 'p')) {
    if (!p.children.some(ownLine) || contained(p)) continue
    const attrs = serialize(new Element('p', p.attribs)).replace(/<\/p>$/, '')
    let out = ''
    let run: AnyNode[] = []
    const flush = (): void => {
      if (run.some((n) => !(n instanceof Text) || n.data.trim())) out += `${attrs}${serialize(run).trim()}</p>`
      run = []
    }
    const kids = p.children
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i]
      if (!ownLine(kid)) {
        run.push(kid)
        continue
      }
      if (isBr(run.at(-1))) run.pop()
      flush()
      delete kid.attribs[DOCX_OWN_LINE]
      out += `<p style="text-align:center">${serialize(kid)}</p>`
      if (isBr(kids[i + 1])) i++
    }
    flush()
    replaceWith(p, out)
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

/**
 * Each code block whose language highlight.js knows, colored as the pdf and
 * html outputs color it. Word cannot apply a stylesheet, so the color goes
 * on each run: a <span> with an inline `color`, which html-to-docx writes as
 * `w:color`. Run after unwrapSpans, which would strip these, and before
 * breakCodeLines, which splits their text at each newline (a multi-line
 * docstring or comment keeps its color on every line).
 */
function colorCode(source: string): string {
  if (!/<code class="language-/.test(source)) return source
  return source.replace(/(<pre(?:\s[^>]*)?>\s*<code class="language-([\w+-]+)">)([\s\S]*?)(<\/code>)/g, (match, open: string, lang: string, body: string, close: string) =>
    hljs.getLanguage(lang) ? `${open}${highlightedRuns(highlightMarkup(body, lang))}${close}` : match,
  )
}

/** colorCode, unless code color is off (ConvertOptions.codeColor): then code stays plain. */
function colorCodeIf(on: boolean, source: string): string {
  return on ? colorCode(source) : source
}

/**
 * Stand-ins for where each code block with a language starts and ends:
 * CODE_OPEN or CODE_CLOSE, the block's number in `languages`, CODE_STOP.
 * Private-use, so never real content (see KEPT).
 */
const CODE_OPEN = ''
const CODE_CLOSE = ''
const CODE_STOP = ''

/**
 * Word keeps no code language, so the docx reader had to guess it. Each code
 * block's language goes in a hidden bookmark around the block instead
 * (code-bookmark.ts says why a bookmark). The library writes no bookmarks, so
 * each block is given a stand-in at its start and end, a <span> of its own
 * that html-to-docx makes a run of its own, and codeBookmarks turns those runs
 * into the bookmark. Run after breakCodeLines, which would take a newline
 * off the end stand-in rather than the code, and before flattenFormatting,
 * which gives the stand-ins the code font like the rest of the block.
 */
function markCodeLanguages(source: string, languages: string[]): string {
  if (!/<code class="language-/.test(source)) return source
  const dom = parseDocument(source)
  let changed = false
  for (const pre of elementsOf(dom.children, 'pre')) {
    const code = pre.children.find((c): c is Element => isElement(c) && c.name === 'code')
    const lang = /(?:^|\s)language-([\w+-]+)/.exec(code?.attribs.class ?? '')?.[1]
    if (!code || !lang) continue
    const n = languages.push(lang) - 1
    splice(code, 0, 0, [new Element('span', {}, [new Text(`${CODE_OPEN}${n}${CODE_STOP}`)])])
    splice(code, code.children.length, 0, [new Element('span', {}, [new Text(`${CODE_CLOSE}${n}${CODE_STOP}`)])])
    changed = true
  }
  return changed ? serialize(dom.children) : source
}

/**
 * markCodeLanguages's stand-in runs as the bookmarks they stand for: a
 * bookmarkStart in place of the run at the block's start and a bookmarkEnd in
 * place of the one at its end, children of the paragraph among its runs, as
 * CT_P allows. A stand-in that shares its run with text (a space joined to
 * it) leaves the run, the bookmark going before it at the start, after it at
 * the end. A block that lost either stand-in, or whose name cannot be a
 * bookmark name, gets none; every stand-in goes.
 */
function codeBookmarks(xml: string, languages: string[]): string {
  if (!languages.length || !/[]/.test(xml)) return xml
  const stand = /[](\d+)/g
  const found = new Map<number, number>()
  for (const m of xml.matchAll(stand)) found.set(Number(m[1]), (found.get(Number(m[1])) ?? 0) + 1)
  // Clear of any bookmark id already there (html-to-docx 1.8.0 writes none).
  let id = Math.max(-1, ...[...xml.matchAll(/<w:bookmark(?:Start|End)\b[^>]*\bw:id="(\d+)"/g)].map((m) => Number(m[1]))) + 1
  const ids = new Map<number, { id: number; name: string }>()
  for (const [n, count] of found) {
    const name = count === 2 ? codeBookmarkName(ids.size, languages[n] ?? '') : undefined
    if (name) ids.set(n, { id: id++, name })
  }
  const out = xml.replace(/<w:r(?:\s[^>]*)?>(?:(?!<\/w:r>)[\s\S])*?[]\d+(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, (r) => {
    const marks = [...r.matchAll(stand)]
    const rest = r.replace(stand, '')
    const empty = [...rest.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].every((t) => t[1] === '') && !/<w:(?:br|tab|cr)\b/.test(rest)
    let before = ''
    let after = ''
    for (const m of marks) {
      const b = ids.get(Number(m[1]))
      if (!b) continue
      if (m[0].startsWith(CODE_OPEN)) before += `<w:bookmarkStart w:id="${b.id}" w:name="${b.name}"/>`
      else after += `<w:bookmarkEnd w:id="${b.id}"/>`
    }
    return before + (empty ? '' : rest) + after
  })
  return out.replace(/[-]/g, '')
}

/** The font html-to-docx itself gives a top-level code block. */
const CODE_FONT = 'Courier'

/**
 * html-to-docx sets a <pre> in Courier only when the <pre> is a paragraph of
 * its own: at the top level or in a table cell. In a list item the item's
 * text and the block share one paragraph, the <pre> is read as a run, and its
 * text came out in the body font. Inline <code> is never given a font at all.
 *
 * The one font the library honors on a run is a `font-family` on a <span>,
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
      } else if (isElement(node) && node.name === 'span' && node.attribs.style) {
        // colorCode's runs: already one span per piece of text, so the font joins the color.
        if (!/font-family/.test(node.attribs.style)) node.attribs.style += `; font-family: ${CODE_FONT}`
      } else if (isElement(node)) wrap(node.children)
    }
  }
  for (const el of targets) wrap(el.children)
  return serialize(dom.children)
}

/** Run formatting, one bit each, carried to Word in a stand-in color (see flattenFormatting). */
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
/** Left exactly as they are. */
const UNTOUCHED = new Set(['svg', 'math', 'script', 'style'])

/**
 * The stand-in color: `0D0C` and the formatting bits as two hex digits, or
 * `0D0B` and the index of a formatted run's real color, background and bits
 * in the document's ColoredLook list. Near black, so a run the post-pass somehow
 * misses still reads as text.
 */
const STAND_IN = /<w:color w:val="0D0([BC])([0-9A-Fa-f]{2})"\/>/
const STAND_IN_BITS = /0D0([BC])([0-9A-F]{2})/i

/** A formatted run that also has a color or a background: its bits, and each as Word's RRGGBB. */
interface ColoredLook {
  bits: number
  color?: string
  background?: string
}

/** The most colored looks one document gives stand-ins to (two hex digits); the rest lose the color, as before. */
const MAX_COLORED = 256

interface Look {
  bits: number
  font?: string
  /** The run's own color: on its formatting tag, or a highlighted code block's (colorCode's spans). */
  color?: string
  /** The `color` of the paragraph, heading or cell around it, which html-to-docx gives its plain runs. */
  blockColor?: string
  /** The run's own background, on its formatting tag or one around it. */
  background?: string
  /** Inside a <pre>: a line break is kept in its span (see breakCodeLines). */
  pre?: boolean
}

/** Elements whose `color` html-to-docx carries to every run in them (measured: not div, li or blockquote). */
const COLORED_BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th'])

const colorIn = (el: Element): string | undefined => /(?:^|;)\s*color:\s*([^;]+)/i.exec(el.attribs.style ?? '')?.[1]?.trim()

/**
 * An element's own background as Word's RRGGBB: its `background-color`
 * (normalizeColors has made it hex, or taken it out when it gives no color),
 * else the color word of a `background` shorthand. None when it gives no
 * color, so the background around it shows.
 */
function backgroundIn(el: Element): string | undefined {
  const style = el.attribs.style ?? ''
  const own = /(?:^|;)\s*background-color:\s*([^;]+)/i.exec(style)?.[1]
  if (own) return wordHex(own.trim())
  const shorthand = /(?:^|;)\s*background:\s*([^;]+)/i.exec(style)?.[1] ?? ''
  const words = shorthand.match(/[^\s(]+\([^)]*\)|[^\s]+/g) ?? []
  return words.map((w) => wordHex(w)).findLast(Boolean)
}

/**
 * Word's 16 highlight colors (ST_HighlightColor) by their RRGGBB: the 16
 * colors of HTML 4, one for one. A background that is exactly one of them is
 * written as a highlight, which is what Word's own Text Highlight Color makes
 * and what its highlight tools find and clear; any other is shading, which
 * keeps the exact color.
 */
const WORD_HIGHLIGHTS: Record<string, string> = {
  FFFF00: 'yellow', '00FF00': 'green', '00FFFF': 'cyan', FF00FF: 'magenta', '0000FF': 'blue', FF0000: 'red',
  '000000': 'black', FFFFFF: 'white', '000080': 'darkBlue', '008080': 'darkCyan', '008000': 'darkGreen',
  '800080': 'darkMagenta', '800000': 'darkRed', '808000': 'darkYellow', '808080': 'darkGray', C0C0C0: 'lightGray',
}

/** Declarations whose colors html-to-docx reads (a border's as one of its words). */
const BORDER = new Set(['border', 'border-top', 'border-right', 'border-bottom', 'border-left'])
const COLOR_DECLARATION = /(?:color|border)[\w-]*\s*:/i

/**
 * html-to-docx reads a color as a name, #rrggbb, #rgb or a comma rgb() or
 * hsl() of whole numbers, and writes black for anything else: rgba(), space
 * syntax, hwb(), currentColor, even `inherit`. flattenFormatting read only
 * hex and rgb(), so the bold words of a paragraph colored by name or hsl()
 * lost the color. Every `color`, `background-color` and border color is
 * written as #RRGGBB first (css-color.ts reads every CSS form), so both meet
 * one form only.
 *
 * What gives no color of its own is left out, and the color around it shows,
 * as in a browser: `inherit`, `initial`, `unset`, a color that is not one,
 * and `transparent` or a fully transparent color (a run or cell is left
 * uncolored rather than hidden). currentColor is the element's color, its
 * own or the one it inherits, when that is known. Word has no alpha, so a
 * semi-transparent color is blended with the white page.
 */
function normalizeColors(source: string): string {
  if (!/\bstyle\s*=/i.test(source) || !COLOR_DECLARATION.test(source)) return source
  const dom = parseDocument(source)
  let changed = false
  const walk = (nodes: AnyNode[], inherited: string | undefined): void => {
    for (const node of nodes) {
      if (!isElement(node) || UNTOUCHED.has(node.name)) continue
      const style = node.attribs.style
      let current = inherited
      if (style !== undefined && COLOR_DECLARATION.test(style)) {
        const pieces = style.split(';')
        const declarations = pieces.map((d) => /^\s*([\w-]+)\s*:\s*([\s\S]*?)\s*(?:!\s*important\s*)?$/i.exec(d))
        const hexOf = (css: string): string | undefined => (parseCssColor(css) === 'currentcolor' ? current : wordHex(css))
        // The last `color` counts; currentColor there, or no color, is the one inherited.
        const own = declarations.filter((d) => d?.[1].toLowerCase() === 'color').pop()
        const ownHex = own ? hexOf(own[2]) : undefined
        if (ownHex) current = ownHex
        const kept = pieces.flatMap((text, i): string[] => {
          const d = declarations[i]
          const property = d?.[1].toLowerCase() ?? ''
          // Anything else kept as it is: a url() may hold a `;` of its own.
          if (!d || !(property === 'color' || property === 'background-color' || BORDER.has(property))) return [text]
          if (property === 'color') return d === own && ownHex ? [` color: #${ownHex}`] : []
          if (property === 'background-color') {
            const hex = hexOf(d[2])
            return hex ? [` background-color: #${hex}`] : []
          }
          // A border's words: each that is a color written as hex (a function
          // kept whole). A transparent one is no border: html-to-docx drew it black.
          const words = d[2].match(/[^\s(]+\([^)]*\)|[^\s]+/g) ?? []
          const unseen = (w: string): boolean => {
            const color = parseCssColor(w)
            return color === 'transparent' || (typeof color === 'object' && color.a === 0)
          }
          if (words.some(unseen)) return [` ${property}: ${property === 'border' ? 'none' : '0'}`]
          return [` ${property}: ${words.map((w) => (parseCssColor(w) && hexOf(w) ? `#${hexOf(w)}` : w)).join(' ')}`]
        })
        const restyled = kept.join(';').trim()
        if (restyled !== style) {
          changed = true
          if (restyled.replace(/[\s;]/g, '')) node.attribs.style = restyled
          else delete node.attribs.style
        }
      }
      walk(node.children, current)
    }
  }
  walk(dom.children, undefined)
  return changed ? serialize(dom.children) : source
}

/** One side of a cell's border, as Word writes it: `nil` for none. */
interface BorderSide {
  val: string
  /** Eighths of a point. */
  sz?: number
  color?: string
}
type CellBorders = Record<'top' | 'left' | 'bottom' | 'right', BorderSide>

const CELL_SIDES = ['top', 'left', 'bottom', 'right'] as const
/** CSS border styles as Word's (ST_Border); none and hidden are no border. */
const BORDER_STYLES: Record<string, string> = {
  solid: 'single', dashed: 'dashed', dotted: 'dotted', double: 'double', groove: 'threeDEngrave',
  ridge: 'threeDEmboss', inset: 'inset', outset: 'outset', none: 'nil', hidden: 'nil',
}
const BORDER_KEYWORD_WIDTHS: Record<string, number> = { thin: 1, medium: 3, thick: 5 }
/** The most cells one document gives border stand-ins to (four hex digits); past it, html-to-docx's own borders. */
const MAX_BORDERED_CELLS = 0x10000
/** A cell's border stand-in color: `0E` and the cell's index in the document's CellBorders list. */
const BORDER_STAND_IN = /w:color="0E([0-9A-F]{4})"/

/** A CSS border width in points, or undefined when `word` is not one. */
function borderWidthPt(word: string): number | undefined {
  const keyword = BORDER_KEYWORD_WIDTHS[word.toLowerCase()]
  if (keyword !== undefined) return keyword * 0.75
  const m = /^(\d*\.?\d+)(px|pt|em|rem|mm|cm|in)?$/i.exec(word)
  if (!m) return undefined
  const n = parseFloat(m[1])
  const unit = (m[2] ?? 'px').toLowerCase()
  const pt = { px: 0.75, pt: 1, em: 12, rem: 12, mm: 72 / 25.4, cm: 72 / 2.54, in: 72 }[unit] ?? 0.75
  return n * pt
}

/** CSS's one-to-four values for the four sides, as top, left, bottom, right. */
function fourSides<T>(values: T[]): [T, T, T, T] | undefined {
  const [a, b = a, c = a, d = b] = values
  return a === undefined ? undefined : [a, d, c, b]
}

/**
 * A cell's border sides from its style, as a browser draws them: each side
 * is none until a style is given (`border-style` starts as none), medium
 * (3px) wide and in the cell's text color until a width or color is. Later
 * declarations win; a shorthand resets its sides. Undefined when the style
 * says nothing about borders.
 */
function cellBordersOf(style: string, textColor: string | undefined): CellBorders | undefined {
  type Css = { style: string; width: number; color?: string }
  const sides: Record<(typeof CELL_SIDES)[number], Css> = {
    top: { style: 'none', width: 2.25 },
    left: { style: 'none', width: 2.25 },
    bottom: { style: 'none', width: 2.25 },
    right: { style: 'none', width: 2.25 },
  }
  let any = false
  for (const piece of style.split(';')) {
    const d = /^\s*(border(?:-(top|right|bottom|left))?(?:-(width|style|color))?)\s*:\s*([\s\S]*?)\s*(?:!\s*important\s*)?$/i.exec(piece)
    if (!d) continue
    any = true
    const named = d[2]?.toLowerCase() as (typeof CELL_SIDES)[number] | undefined
    const part = d[3]?.toLowerCase()
    const words = d[4].match(/[^\s(]+\([^)]*\)|[^\s]+/g) ?? []
    const targets = named ? [named] : [...CELL_SIDES]
    if (!part) {
      // A shorthand: whatever it leaves out goes back to its initial value.
      const shorthand: Css = { style: 'none', width: 2.25 }
      for (const w of words) {
        const lower = w.toLowerCase()
        if (BORDER_STYLES[lower]) shorthand.style = lower
        else if (borderWidthPt(w) !== undefined) shorthand.width = borderWidthPt(w)!
        else if (w === '0') shorthand.width = 0
        else shorthand.color = parseCssColor(w) === 'currentcolor' ? undefined : (wordHex(w) ?? undefined)
      }
      for (const side of targets) sides[side] = { ...shorthand }
      continue
    }
    // A longhand: one value for a side, or one to four for all of them.
    const values = named ? [words[0]] : words
    const spread = named ? undefined : fourSides(values)
    targets.forEach((side, i) => {
      const value = spread ? spread[i] : values[0]
      if (value === undefined) return
      if (part === 'style' && BORDER_STYLES[value.toLowerCase()]) sides[side].style = value.toLowerCase()
      if (part === 'width') sides[side].width = borderWidthPt(value) ?? (value === '0' ? 0 : sides[side].width)
      if (part === 'color') sides[side].color = parseCssColor(value) === 'currentcolor' ? undefined : (wordHex(value) ?? undefined)
    })
  }
  if (!any) return undefined
  const word = (css: Css): BorderSide => {
    const val = BORDER_STYLES[css.style] ?? 'nil'
    if (val === 'nil' || css.width <= 0) return { val: 'nil' }
    // Word draws from a quarter point to twelve, in eighths.
    return { val, sz: Math.min(96, Math.max(2, Math.round(css.width * 8))), color: css.color ?? textColor ?? 'auto' }
  }
  return { top: word(sides.top), left: word(sides.left), bottom: word(sides.bottom), right: word(sides.right) }
}

/**
 * html-to-docx draws a cell's border sides in one color and one stroke, the
 * last side's, and gives the sides a cell's style leaves out its thin default
 * line; so `border-top: 2px solid red` came out a red box. Each cell whose
 * style speaks of its borders is listed in `cells`, with every side as its
 * CSS says, and its border declarations give way to one plain border in a
 * stand-in color naming the entry. cellBorderSides then writes the cell's
 * w:tcBorders from the entry. A cell whose style has no border keeps the
 * table's grid, as before.
 */
function cellBordersForDocx(source: string, cells: CellBorders[]): string {
  if (!/<t[dh]\b[^>]*\bstyle\s*=[^>]*\bborder/i.test(source)) return source
  const dom = parseDocument(source)
  for (const cell of [...elementsOf(dom.children, 'td'), ...elementsOf(dom.children, 'th')]) {
    const style = cell.attribs.style
    if (!style || cells.length >= MAX_BORDERED_CELLS) continue
    const sides = cellBordersOf(style, wordHex(colorIn(cell) ?? '') ?? undefined)
    if (!sides) continue
    const at = cells.push(sides) - 1
    const rest = style.split(';').filter((d) => !/^\s*border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?\s*:/i.test(d))
    cell.attribs.style = [...rest.map((d) => d.trim()).filter(Boolean), `border: 1px solid #0E${at.toString(16).toUpperCase().padStart(4, '0')}`].join('; ')
  }
  return serialize(dom.children)
}

/** Each stand-in cell border (see cellBordersForDocx) as the sides its CSS gave. */
function cellBorderSides(xml: string, cells: CellBorders[]): string {
  if (cells.length === 0) return xml
  return xml.replace(/<w:tcBorders>(?:(?!<\/w:tcBorders>)[\s\S])*<\/w:tcBorders>/g, (borders) => {
    const at = BORDER_STAND_IN.exec(borders)
    const cell = at ? cells[parseInt(at[1], 16)] : undefined
    if (!cell) return borders
    const side = (name: string, b: BorderSide): string =>
      b.val === 'nil' ? `<w:${name} w:val="nil"/>` : `<w:${name} w:val="${b.val}" w:sz="${b.sz}" w:space="0" w:color="${b.color}"/>`
    return `<w:tcBorders>${CELL_SIDES.map((name) => side(name, cell[name])).join('')}</w:tcBorders>`
  })
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
 * the document is written, styleRuns turns each stand-in color back into
 * Word's own w:b, w:i, w:u, w:strike, w:vertAlign and w:highlight. The code
 * font travels as the span's font-family, which html-to-docx does honor.
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
 * A code block is flattened the same way, once breakCodeLines and
 * monospaceCode have shaped it: html-to-docx keeps only the innermost tag
 * there too, and a <strong>'s bold ran on to the end of the block. Every
 * piece of its text is given the code font, a highlighted block's runs keep
 * their color, and its line-break spans stay as they are.
 *
 * A stand-in color takes the place of the color html-to-docx gives a run
 * from its paragraph, heading or cell, so the bold words of a red paragraph
 * came out black. A formatted run with a color, the paragraph's or its own
 * (which wins), is listed in `colored`, and its stand-in names the entry.
 * So is one with a background of its own (`background-color`, or the color
 * of a `background`), carried into the formatting inside it: the span held
 * only color and font, so a background on formatted text was lost, and a
 * <mark> was yellow whatever its color. styleRuns writes it as Word's
 * highlight when it is one of Word's highlight colors, else as shading.
 */
function flattenFormatting(source: string, colored: ColoredLook[] = []): string {
  if (!/<(strong|b|em|i|cite|var|dfn|u|ins|s|del|strike|sup|sub|mark|code|kbd|samp|tt|span|small|big|abbr|acronym|time|data|bdi|bdo|font|q|a|pre)\b/i.test(source)) {
    return source
  }
  const dom = parseDocument(source.replace(KEPT, ''))

  const lookOf = (el: Element, look: Look): Look | null => {
    const bit = FORMAT_BITS[el.name]
    if (bit) {
      // A superscript inside a subscript (or the other way) takes the inner one.
      const bits = bit === SUPER || bit === SUB ? (look.bits & ~(SUPER | SUB)) | bit : look.bits | bit
      return { ...look, bits }
    }
    if (MONOSPACE.has(el.name)) return { ...look, font: CODE_FONT }
    if (el.name === 'span') {
      // monospaceCode's and colorCode's spans: the only ones left by now.
      const font = /font-family:\s*([^;]+)/i.exec(el.attribs.style ?? '')?.[1]?.trim()
      return { ...look, ...(font ? { font } : {}) }
    }
    if (TRANSPARENT.has(el.name)) return look
    return null
  }
  const withOwnColor = (el: Element, look: Look): Look => {
    const color = colorIn(el)
    const background = backgroundIn(el)
    return { ...look, ...(color ? { color } : {}), ...(background ? { background } : {}) }
  }

  const index = new Map<string, number>()
  const standIn = (look: Look): string => {
    const color = wordHex(look.color ?? look.blockColor ?? '')
    const background = look.background
    if (color || background) {
      const key = `${look.bits}:${color ?? ''}:${background ?? ''}`
      let at = index.get(key)
      if (at === undefined && colored.length < MAX_COLORED) {
        at = colored.push({ bits: look.bits, color, background }) - 1
        index.set(key, at)
      }
      if (at !== undefined) return `#0D0B${at.toString(16).toUpperCase().padStart(2, '0')}`
    }
    return `#0D0C${look.bits.toString(16).toUpperCase().padStart(2, '0')}`
  }

  // No bits and no background: a run's own color goes as it is, and the block's is left to html-to-docx.
  const styleOf = (look: Look): string =>
    [look.bits || look.background ? `color: ${standIn(look)}` : look.color ? `color: ${look.color}` : '', look.font ? `font-family: ${look.font}` : '']
      .filter(Boolean)
      .join('; ')

  const lineBreak = (el: Element): boolean => el.name === 'br' || (el.name === 'span' && el.children.length > 0 && el.children.every((c) => isElement(c) && c.name === 'br'))

  const restyle = (node: AnyNode, look: Look): AnyNode[] => {
    if (node instanceof Text) {
      if (node.data === '' || (!look.bits && !look.font && !look.color && !look.background)) return [node]
      return [new Element('span', { style: styleOf(look) }, [new Text(node.data)])]
    }
    if (!isElement(node) || UNTOUCHED.has(node.name)) return [node]
    if (look.pre && lineBreak(node)) return [node.name === 'br' ? new Element('span', {}, [node]) : node]
    if (node.name === 'pre') {
      splice(node, 0, node.children.length, node.children.flatMap((child) => restyle(child, { ...look, font: CODE_FONT, pre: true })))
      joinSpaces(node, colored)
      if (!elementsOf(node.children, 'a').length) return [node]
      // html-to-docx writes the runs of a <pre> itself and makes no hyperlink
      // of an <a> there; it does in a paragraph's own children. Every run now
      // names its font, so a <p> looks the same; in a list item, where the
      // block is a run of the item's paragraph, its pieces join the item's.
      if (node.parent instanceof Element && node.parent.name === 'li') return [...node.children]
      node.name = 'p'
      return [node]
    }
    const formatted = lookOf(node, look)
    const own = formatted && withOwnColor(node, formatted)
    const blockColor = COLORED_BLOCK.has(node.name) ? colorIn(node) : undefined
    // A link stays a link (html-to-docx makes the hyperlink); its own
    // background goes to the text in it, which html-to-docx would drop.
    const linkBackground = node.name === 'a' ? backgroundIn(node) : undefined
    const inner = own ?? (blockColor ? { ...look, blockColor, color: undefined } : linkBackground ? { ...look, background: linkBackground } : look)
    let kids = node.children.flatMap((child) => restyle(child, inner))
    if (node.name === 'q') kids = [new Text('\u201C'), ...kids, new Text('\u201D')]
    if (own) return kids
    splice(node, 0, node.children.length, kids)
    joinSpaces(node, colored)
    if (node.name === 'a' && node.children.length > 1 && !elementsOf(node.children, 'img').length) {
      splice(node, 0, node.children.length, [new Element('span', {}, [...node.children])])
    }
    return [node]
  }

  for (const node of [...dom.children]) {
    const fresh = restyle(node, { bits: 0 })
    splice(dom, dom.children.indexOf(node), 1, fresh)
  }
  return serialize(dom.children).replace(KEPT, (c) => (c === KEPT_SPACE ? '&#32;' : '&#9;'))
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

/** A leaf whose formatting draws across its spaces too: strike, underline, highlight, a background. */
function drawsLine(node: AnyNode, colored: ColoredLook[]): boolean {
  if (!isElement(node)) return false
  const standIn = STAND_IN_BITS.exec(node.attribs.style ?? '')
  if (!standIn) return false
  const value = parseInt(standIn[2], 16)
  const look = standIn[1].toUpperCase() === 'B' ? colored[value] : { bits: value }
  return ((look?.bits ?? 0) & (STRIKE | UNDERLINE | MARK)) !== 0 || !!look?.background
}

/**
 * Stand-ins for a space and a tab kept as a piece of their own (see
 * joinSpaces), written out as character references once serialized.
 * Private-use, so never real content.
 */
const KEPT_SPACE = '\uE003'
const KEPT_TAB = '\uE004'
const KEPT = /[\uE003\uE004]/g

/**
 * Join each whitespace-only piece of inline text to the text beside it, as
 * html-to-docx drops it otherwise: to plain text after it if there is some,
 * else to a neighbor that draws no line through a space (`~~a~~ b` must not
 * strike the space), the one before first. Whitespace between blocks has no
 * text beside it and is left alone.
 *
 * With only a struck, underlined or highlighted neighbor (`~~a~~ __b__`, or
 * the indent in front of struck code), the piece stays apart, in its own
 * font, its spaces written as `&#32;`: html-to-docx drops white space between
 * two tags (its minifier), not a character reference.
 */
function joinSpaces(parent: Element, colored: ColoredLook[]): void {
  for (let i = 0; i < parent.children.length; i++) {
    const node = parent.children[i]
    const own = leafText(node)
    if (!own || own.data === '' || own.data.trim() !== '') continue
    const prev = parent.children[i - 1]
    const next = parent.children[i + 1]
    const before = leafText(prev)
    const after = leafText(next)
    const draws = (n: AnyNode): boolean => drawsLine(n, colored)
    const into = after && (next instanceof Text || (!draws(next) && (!before || draws(prev)))) ? next : before ? prev : after ? next : null
    if (!into) continue
    if (draws(into)) {
      const font = isElement(node) ? /font-family:\s*([^;]+)/i.exec(node.attribs.style ?? '')?.[1]?.trim() : undefined
      const kept = new Text(own.data.replace(/ /g, KEPT_SPACE).replace(/\t/g, KEPT_TAB))
      splice(parent, i, 1, [font ? new Element('span', { style: `font-family: ${font}` }, [kept]) : kept])
      continue
    }
    if (into === next) after!.data = own.data + after!.data
    else before!.data += own.data
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

/** The run properties a stand-in color stands for. A <mark>'s own background takes the place of its yellow. */
function propertiesFor(bits: number, color?: string, background?: string): string[] {
  const out: string[] = []
  if (color) out.push(`<w:color w:val="${color}"/>`)
  if (bits & BOLD) out.push('<w:b/>')
  if (bits & ITALIC) out.push('<w:i/>')
  if (bits & STRIKE) out.push('<w:strike/>')
  const highlight = background ? WORD_HIGHLIGHTS[background] : bits & MARK ? 'yellow' : undefined
  if (highlight) out.push(`<w:highlight w:val="${highlight}"/>`)
  else if (background) out.push(`<w:shd w:val="clear" w:color="auto" w:fill="${background}"/>`)
  if (bits & UNDERLINE) out.push('<w:u w:val="single"/>')
  if (bits & SUPER) out.push('<w:vertAlign w:val="superscript"/>')
  else if (bits & SUB) out.push('<w:vertAlign w:val="subscript"/>')
  return out
}

/**
 * Each stand-in color flattenFormatting left becomes the formatting it
 * stands for, the run's properties put in the schema's order (html-to-docx
 * writes them in the order it met them: a hyperlink's w:rStyle after w:b),
 * and a colored one's color put back.
 */
function styleRuns(xml: string, colored: ColoredLook[] = []): string {
  if (!STAND_IN.test(xml)) return xml
  return xml.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (whole, inner: string) => {
    const standIn = STAND_IN.exec(inner)
    if (!standIn) return whole
    const value = parseInt(standIn[2], 16)
    const look: ColoredLook | undefined = standIn[1].toUpperCase() === 'B' ? colored[value] : { bits: value }
    // A run's own background wins over the paragraph's, which html-to-docx gave it as w:shd.
    const kept = (inner.match(/<w:\w+\b[^>]*?\/>|<w:(\w+)\b[^>]*>[\s\S]*?<\/w:\1>/g) ?? []).filter(
      (e) => !STAND_IN.test(e) && !(look?.background && /^<w:(?:shd|highlight)\b/.test(e)),
    )
    const names = new Set(kept.map((e) => /^<w:(\w+)/.exec(e)?.[1]))
    const added = propertiesFor(look?.bits ?? 0, look?.color, look?.background).filter((e) => !names.has(/^<w:(\w+)/.exec(e)?.[1]))
    const all = [...kept, ...added].sort((a, b) => rank(a) - rank(b))
    return `<w:rPr>${all.join('')}</w:rPr>`
  })
}

/**
 * html-to-docx writes a block quote as ONE paragraph, its paragraphs run
 * together: a GitHub alert came out "NoteThe move is set…", and a quote of
 * two paragraphs lost the break between them. A quote of paragraphs only is
 * handed over as one quote for each, which Word shows as the same indented
 * block, paragraph by paragraph.
 */
export function quoteParagraphsForDocx(html: string): string {
  if (!html.includes('<blockquote>')) return html
  return html.replace(/<blockquote>((?:\s*<p>(?:(?!<\/?blockquote\b)[\s\S])*?<\/p>){2,}\s*)<\/blockquote>/g, (_whole, inner: string) =>
    (inner.match(/<p>[\s\S]*?<\/p>/g) ?? []).map((p) => `<blockquote>${p}</blockquote>`).join('\n'),
  )
}

export async function writeDocx(doc: HubDocument, opts?: ConvertOptions): Promise<Buffer> {
  const colored: ColoredLook[] = []
  const originals = new Map<string, Original>()
  const languages: string[] = []
  const bordered: CellBorders[] = []
  const pictures = dropUnresolvableImages(standInOriginals(footnotesForOutput(doc.html, 'plain'), originals))
  const html = renderDocumentShell(
    {
      ...doc,
      html: flattenFormatting(
        cellBordersForDocx(
          normalizeColors(monospaceCode(markCodeLanguages(breakCodeLines(colorCodeIf(opts?.codeColor !== false, centerOwnLineFormulas(unwrapSpans(flattenForDocx(definitionListsForDocx(quoteParagraphsForDocx(pictures))))))), languages))),
          bordered,
        ),
        colored,
      ),
    },
    { target: 'docx' },
  )
  const result = await HTMLtoDOCX(html)
  return recompress(Buffer.isBuffer(result) ? result : Buffer.from(result as ArrayBuffer), formulaLowerings(html), colored, originals, languages, bordered)
}
