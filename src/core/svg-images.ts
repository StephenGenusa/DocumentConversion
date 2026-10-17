import { parseDocument } from 'htmlparser2'
import { Element, type ChildNode } from 'domhandler'
import { removeElement, replaceElement, textContent } from 'domutils'
import serialize from 'dom-serializer'
import { decodeSvgDataUri, sanitizeSvg, sanitizeSvgDoc, svgDataUri, svgRootAttributes, withRootAttributes, type SvgAttributes } from './svg-sanitize'
import { DOCX_MAX_WIDTH, rendersBlocks, type DrawContext } from './draw-blocks'
import { imagePlaceholder } from './inline-images'
import type { RenderResult } from './rendered-blocks'
import type { TargetFormat } from './types'

/*
 * SVG images a document carries (spec D10, B6): an .svg input, or an SVG
 * <img> from an HTML page, a paste, an EPUB, a notebook or a Word file.
 *
 *   sanitizeSvgImages   B6 for every one of them, where a document is read
 *                       and again where it is written, so the editor and
 *                       every writer only ever see a cleaned SVG.
 *   rasterizeSvgImages  a PNG copy of each, at write time, for the targets
 *                       that cannot show SVG: html-to-docx stores an SVG as
 *                       an `image/svg+xml` part Word does not display, so
 *                       Word output used to lose every SVG picture.
 *
 * Drawn diagrams are not handled here: draw-blocks.ts draws them for Word as
 * PNG to begin with.
 */

/**
 * Targets that get PNG copies of SVG images: Word, and Kindle (azw3), whose
 * image records hold JPEG, PNG or GIF only (pictures.ts).
 */
const RASTER_TARGETS: ReadonlySet<TargetFormat> = new Set(['docx', 'azw3'])

/** What each target is called in a notice. */
const TARGET_NAMES: Partial<Record<TargetFormat, string>> = { docx: 'Word', azw3: 'Kindle' }

/** Whether `target` gets PNG copies of a document's SVG images. */
export function rasterizesSvgImages(target: TargetFormat): boolean {
  return RASTER_TARGETS.has(target)
}

/**
 * How SVG images are converted: `batch` at a time, each allowed `eachMs` of
 * drawing. A source of any size (owner, 2026-10-16: the 5 MB cap is gone).
 *
 * Each distinct picture is one request to the render host, which draws one
 * at a time; an ordinary icon or plan takes a few milliseconds, so a page of
 * hundreds converts in a second or two. Every one is converted, however many
 * there are (owner, 2026-10-16: the earlier 2,000 pictures, 120 s and 100 MB
 * of PNG copies are gone). Batches keep each request to the host small, and
 * a picture that takes too long is that picture's alt text, not the end of
 * the rest.
 */
export const SVG_IMAGE_LIMITS = {
  eachMs: 10_000,
  batch: 25,
} as const

/**
 * The tallest picture Word is given, in CSS px: the text height of the Letter
 * page with the 1-inch margins the Word writer gives it (9 in at 96 px/in). With the
 * width cap (DOCX_MAX_WIDTH) a picture fits the page whatever its shape.
 */
export const DOCX_MAX_HEIGHT = 864

export function isSvgDataUri(src: string | undefined): boolean {
  return typeof src === 'string' && /^\s*data:image\/svg\+xml(?:;[^,]*)?,/i.test(src)
}

export { decodeSvgDataUri, svgDataUri }

/** CSS px per unit, for the absolute lengths an SVG's width and height may use (1em = 16px, 1ex = 8px). */
const UNIT_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  em: 16,
  ex: 8,
}

/** A length in CSS px, or undefined for a percentage, auto, or anything unreadable. */
function lengthPx(value: string | null): number | undefined {
  if (!value) return undefined
  const m = /^\s*\+?(\d*\.?\d+(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(value)
  if (!m) return undefined
  const unit = UNIT_PX[m[2].toLowerCase()]
  const n = Number(m[1]) * (unit ?? NaN)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function viewBoxOf(value: string | null): { width: number; height: number } | undefined {
  const parts = (value ?? '').trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2] <= 0 || parts[3] <= 0) return undefined
  return { width: parts[2], height: parts[3] }
}

/** The size an SVG is shown at when nothing else says, in CSS px, from its root's attributes: as a browser sizes it in an <img>. */
export function svgSizeOf(root: Readonly<SvgAttributes>): { width: number; height: number } {
  const w = lengthPx(root.width ?? null)
  const h = lengthPx(root.height ?? null)
  const box = viewBoxOf(root.viewBox ?? null)
  if (w && h) return { width: w, height: h }
  if (box) {
    if (w) return { width: w, height: (w * box.height) / box.width }
    if (h) return { width: (h * box.width) / box.height, height: h }
    return box
  }
  // CSS's default size for a replaced element with no size of its own.
  return { width: w ?? 300, height: h ?? 150 }
}

/** An SVG's own size in CSS px (width/height, else its viewBox, else 300x150), or null when it is not an SVG. Reads its root's start tag only. */
export function svgIntrinsicSize(svg: string): { width: number; height: number } | null {
  const root = svgRootAttributes(svg)
  return root ? svgSizeOf(root) : null
}

export interface RasterSize {
  /** The <img>'s own width or height, when it gives one. */
  width?: number
  height?: number
  maxWidth?: number
  maxHeight?: number
}

/**
 * The SVG ready to be drawn as a PNG: sanitized (B6), with its root sized in
 * whole px at the size the picture will be shown, and a viewBox so the
 * drawing scales with it. The size is part of the markup, so it is part of
 * the host's cache key. Null when it is not an SVG.
 */
export function prepareSvgForRaster(svg: string, size: RasterSize): { svg: string; width: number; height: number } | null {
  const clean = sanitizeSvgDoc(svg)
  if (!clean) return null
  const own = svgSizeOf(clean.root)
  let w: number
  let h: number
  if (size.width && size.width > 0) {
    w = size.width
    h = size.height && size.height > 0 ? size.height : (w * own.height) / own.width
  } else if (size.height && size.height > 0) {
    h = size.height
    w = (h * own.width) / own.height
  } else {
    w = own.width
    h = own.height
  }
  const scale = Math.min(1, (size.maxWidth ?? Infinity) / w, (size.maxHeight ?? Infinity) / h)
  const width = Math.max(1, Math.round(w * scale))
  const height = Math.max(1, Math.round(h * scale))

  // Only the root's start tag changes; the rest is not read again.
  const root: SvgAttributes = { ...clean.root }
  // Without a viewBox the drawing's user units are px of its own size, and it
  // would not scale with a new width and height.
  if (!viewBoxOf(root.viewBox ?? null)) root.viewBox = `0 0 ${trim(own.width)} ${trim(own.height)}`
  root.width = String(width)
  root.height = String(height)
  const style = root.style
  if (style) {
    // A size in the root's style outranks the attributes.
    const rest = style
      .split(';')
      .filter((d) => d.trim() && !/^\s*(width|height|min-width|min-height|max-width|max-height)\s*:/i.test(d))
      .join(';')
    if (rest) root.style = rest
    else delete root.style
  }
  return { svg: withRootAttributes(clean, root).svg, width, height }
}

function trim(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

const HAS_SVG_IMAGE = /data:image\/svg\+xml/i

/** Elements an <img> sits in as part of a line: a placeholder there is inline, not a paragraph. */
const INLINE_PARENTS = new Set([
  'p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'span', 'em', 'strong', 'b', 'i', 'u', 's',
  'sup', 'sub', 'code', 'caption', 'figcaption', 'label', 'small', 'mark', 'del', 'ins', 'q', 'cite', 'dt', 'dd',
])

function placeholderFor(el: Element): ChildNode[] {
  const alt = el.attribs.alt?.trim()
  const text = alt ? alt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : undefined
  const parent = el.parent instanceof Element ? el.parent.name : undefined
  return parseDocument(imagePlaceholder(text, parent && INLINE_PARENTS.has(parent) ? 'inline' : 'block')).children
}

function replaceWith(el: Element, nodes: ChildNode[]): void {
  if (nodes.length === 0) {
    removeElement(el)
    return
  }
  // One node: the placeholder is a single <p> or <em>.
  replaceElement(el, nodes[0])
}

/** Every SVG <img> in document order. */
function svgImages(nodes: ChildNode[], out: Element[] = []): Element[] {
  for (const node of nodes) {
    if (!(node instanceof Element)) continue
    if (node.name === 'img' && isSvgDataUri(node.attribs.src)) out.push(node)
    else svgImages(node.children, out)
  }
  return out
}

/**
 * B6 for every SVG image in a document: each SVG <img> gets the sanitized
 * SVG as a base64 data URI; one that is not an SVG at all becomes its alt
 * text. Anything else is returned untouched.
 */
export function sanitizeSvgImages(html: string): string {
  if (!HAS_SVG_IMAGE.test(html)) return html
  const dom = parseDocument(html)
  const images = svgImages(dom.children)
  let changed = false
  for (const el of images) {
    const svg = decodeSvgDataUri(el.attribs.src)
    const clean = svg === null ? null : sanitizeSvg(svg)
    if (clean === null) {
      replaceWith(el, placeholderFor(el))
      changed = true
      continue
    }
    const src = svgDataUri(clean)
    if (src !== el.attribs.src) {
      el.attribs.src = src
      changed = true
    }
  }
  return changed ? serialize(dom, { encodeEntities: 'utf8' }) : html
}

const escapeAttr = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Attributes an inline <svg> hands to its <img>, so the HTML reader's hidden-content rules still see them. */
const CARRIED_ATTRIBUTES = ['class', 'style', 'hidden'] as const

/**
 * Each SVG drawn inline in an HTML page or a Markdown file (`<svg>…</svg>`
 * in the markup), as an SVG image like any other: a base64 data URI of the
 * SVG, sanitized (B6) with the pictures it names by address kept for the
 * read step to fetch, at its own size, its aria-label or <title> as alt.
 * Without this the hub sanitizer dropped the element and the drawing with it.
 *
 * The SVG is taken from the source as written: an HTML parser lower-cases
 * names an SVG needs as they are (viewBox, preserveAspectRatio). It must end
 * where an HTML parser ends it, at its own `</svg>`; one that runs on to the
 * end of the page is left alone, for the sanitizer to drop as before. One
 * marked aria-hidden="true" is decoration and is left alone too.
 *
 * An icon from a sprite sheet (`<svg><use href="#icon"/></svg>`, its
 * `<symbol id="icon">` in another SVG on the page) is given copies of what
 * it refers to there, in a `<defs>` of its own (pageReferences), so the
 * picture shows the icon; one whose reference is nowhere on the page, and
 * that draws nothing else, is left alone. The sprite sheet itself, an SVG of
 * symbols that draws nothing, is left alone too.
 */
export function inlineSvgElements(html: string): string {
  if (!/<svg[\s>/]/i.test(html)) return html
  const dom = parseDocument(html, { withStartIndices: true, withEndIndices: true })
  const found: Array<{ start: number; end: number; img: string }> = []
  let ids: Map<string, Element> | undefined
  const visit = (nodes: ChildNode[]): void => {
    for (const node of nodes) {
      if (!(node instanceof Element)) continue
      if (node.name !== 'svg') {
        visit(node.children)
        continue
      }
      const start = node.startIndex
      const end = node.endIndex
      if (start === null || end === null || node.attribs['aria-hidden'] === 'true') continue
      let raw = html.slice(start, end + 1)
      if (!/(?:<\/(?:[\w-]+:)?svg\s*>|\/>)$/i.test(raw)) continue
      if (isSpriteSheet(node)) continue
      const refs = pageReferences(node, (ids ??= svgIds(dom.children)))
      if (refs === null) continue
      if (refs.length > 0) {
        const defs = `<defs>${refs.map((el) => html.slice(el.startIndex!, el.endIndex! + 1)).join('')}</defs>`
        raw = raw.replace(/^<[^>]*>/, (open) => open + defs)
      }
      const img = inlineSvgImage(raw, node)
      if (img !== null) found.push({ start, end, img })
    }
  }
  visit(dom.children)
  let out = html
  for (const { start, end, img } of found.reverse()) out = `${out.slice(0, start)}${img}${out.slice(end + 1)}`
  return out
}

/** Elements that hold definitions, not drawing: what is in them is drawn only where it is used. */
const DEFINITIONS = new Set(['defs', 'symbol', 'clippath', 'mask', 'pattern', 'marker', 'lineargradient', 'radialgradient', 'filter', 'title', 'desc', 'metadata', 'style'])

/** Elements that draw. */
const DRAWING = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'use', 'foreignobject'])

const localName = (el: Element): string => el.name.toLowerCase().replace(/^svg:/, '')
const children = (el: Element): Element[] => el.children.filter((c): c is Element => c instanceof Element)

/** An SVG that is only definitions, at least one a <symbol>: a sprite sheet, which draws nothing. */
function isSpriteSheet(svg: Element): boolean {
  const kids = children(svg)
  return kids.some((c) => localName(c) === 'symbol') && kids.every((c) => DEFINITIONS.has(localName(c)))
}

/** Every element with an id inside an SVG on the page, by id (the first, as a browser takes it). */
function svgIds(nodes: ChildNode[], inSvg = false, out = new Map<string, Element>()): Map<string, Element> {
  for (const node of nodes) {
    if (!(node instanceof Element)) continue
    const svg = inSvg || localName(node) === 'svg'
    const id = node.attribs.id
    if (svg && id && !out.has(id)) out.set(id, node)
    svgIds(node.children, svg, out)
  }
  return out
}

/** The ids an element and what is in it refer to: `href="#id"` (and xlink:href), and `url(#id)` in any attribute. */
function referencesOf(el: Element, out = new Set<string>()): Set<string> {
  for (const [name, value] of Object.entries(el.attribs)) {
    if ((name === 'href' || name === 'xlink:href') && value.trim().startsWith('#')) out.add(value.trim().slice(1))
    for (const m of value.matchAll(/url\(\s*['"]?#([^)'"\s]+)/g)) out.add(m[1])
  }
  for (const c of children(el)) referencesOf(c, out)
  return out
}

function idsIn(el: Element, out = new Set<string>()): Set<string> {
  if (el.attribs.id) out.add(el.attribs.id)
  for (const c of children(el)) idsIn(c, out)
  return out
}

const contains = (outer: Element, inner: Element): boolean => {
  for (let p: Element | null = inner; p; p = p.parent instanceof Element ? p.parent : null) if (p === outer) return true
  return false
}

/** The most elements copied in from the page for one SVG. */
const MAX_PAGE_REFERENCES = 200

/**
 * What an SVG refers to that is not in it but elsewhere in the page's SVGs
 * (a sprite sheet's <symbol>, a gradient), and what those refer to in turn,
 * in page order. Null when it refers to something that is nowhere and draws
 * nothing else: an icon whose sheet is missing, which would be a blank picture.
 */
function pageReferences(svg: Element, ids: Map<string, Element>): Element[] | null {
  const own = idsIn(svg)
  const wanted = [...referencesOf(svg)].filter((id) => !own.has(id))
  if (wanted.length === 0) return []
  const taken: Element[] = []
  const seen = new Set<string>()
  let missing = false
  while (wanted.length > 0 && taken.length < MAX_PAGE_REFERENCES) {
    const id = wanted.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const el = ids.get(id)
    // Not on the page, or around this SVG (its own ancestor): nothing to copy.
    if (!el || contains(el, svg)) {
      missing = true
      continue
    }
    if (taken.some((t) => contains(t, el))) continue
    for (let k = taken.length - 1; k >= 0; k--) if (contains(el, taken[k])) taken.splice(k, 1)
    taken.push(el)
    for (const next of idsIn(el)) seen.add(next)
    for (const next of referencesOf(el)) if (!seen.has(next) && !own.has(next)) wanted.push(next)
  }
  if (missing && taken.length === 0 && !drawsBesidesUse(svg)) return null
  return taken.sort((a, b) => a.startIndex! - b.startIndex!)
}

/** Whether an SVG draws anything but <use>, outside its definitions. */
function drawsBesidesUse(el: Element): boolean {
  return children(el).some((c) => {
    const name = localName(c)
    if (DEFINITIONS.has(name)) return false
    return (DRAWING.has(name) && name !== 'use') || drawsBesidesUse(c)
  })
}

const XML_ENTITY_NAMES = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])

/**
 * HTML's named entities (`&nbsp;`, `&copy;`) as character references, which
 * XML reads: written in a page they mean a character, and XML has only five
 * names of its own. A name HTML does not know is left as it is.
 */
function htmlEntitiesAsXml(svg: string): string {
  return svg.replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => {
    if (XML_ENTITY_NAMES.has(name)) return m
    const text = textContent(parseDocument(m).children)
    return text === m ? m : [...text].map((c) => `&#x${c.codePointAt(0)!.toString(16)};`).join('')
  })
}

/** The <img> for one inline SVG, or null when it is not a readable one. */
function inlineSvgImage(raw: string, el: Element): string | null {
  // In a page the SVG namespace is implied; on its own an SVG must say so.
  const open = /^<[^>]*>/.exec(raw)?.[0] ?? ''
  let svgText = raw
  if (!/\sxmlns\s*=/.test(open)) svgText = svgText.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  if (/\bxlink:/.test(raw) && !/\sxmlns:xlink\s*=/.test(open)) svgText = svgText.replace(/^<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"')
  const doc = sanitizeSvgDoc(htmlEntitiesAsXml(svgText), { keepImageUrls: true })
  if (!doc) return null
  const clean = doc.svg
  const size = svgSizeOf(doc.root)
  const title = el.children.find((c): c is Element => c instanceof Element && c.name === 'title')
  const alt = (el.attribs['aria-label'] ?? (title ? textContent(title) : '')).replace(/\s+/g, ' ').trim()
  const attrs = [
    `src="${svgDataUri(clean)}"`,
    ...(alt ? [`alt="${escapeAttr(alt)}"`] : []),
    `width="${Math.max(1, Math.round(size.width))}"`,
    `height="${Math.max(1, Math.round(size.height))}"`,
    ...CARRIED_ATTRIBUTES.filter((a) => el.attribs[a] !== undefined).map((a) => `${a}="${escapeAttr(el.attribs[a])}"`),
  ]
  return `<img ${attrs.join(' ')}>`
}

/** An <img> width or height attribute as whole px, or undefined. */
function attrPx(value: string | undefined): number | undefined {
  if (!value || !/^\s*\d+(\.\d+)?\s*(px)?\s*$/i.test(value)) return undefined
  const n = Number.parseFloat(value)
  return n > 0 ? n : undefined
}

const BASE64 = /^[A-Za-z0-9+/]+=*$/

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 300 ? `${t.slice(0, 297)}...` : t || 'unknown error'
}

/**
 * PNG copies of a document's SVG images, for the targets that cannot show
 * SVG (spec D10, B3's forced PNG): each SVG <img> becomes a PNG <img> of the
 * same picture at the size it is shown (its own width/height, else the SVG's
 * size, capped at Word's text area), drawn at twice that by the render host,
 * with its alt kept. A picture that cannot be made becomes its alt text,
 * with a notice.
 *
 * Also for any picture target when `ctx.svgImagesAsPng` asks (HTML for the
 * clipboard, FOR_PASTING), at the same Word-page sizes, since Word is where
 * it is pasted.
 *
 * Without a renderer (core used on its own), or for another target, the
 * HTML is returned untouched; the docx writer then turns any SVG it is
 * still given into its alt text.
 */
export async function rasterizeSvgImages(html: string, target: TargetFormat, ctx: DrawContext): Promise<string> {
  const render = ctx.renderBlocks
  // Asked for (pasting) only where a picture has a place: never for txt or md.
  const asked = ctx.svgImagesAsPng === true && rendersBlocks(target)
  if (!render || !(rasterizesSvgImages(target) || asked) || !HAS_SVG_IMAGE.test(html)) return html
  const dom = parseDocument(html)
  const images = svgImages(dom.children)
  if (images.length === 0) return html
  const name = TARGET_NAMES[target] ?? (asked ? 'pasting' : target)
  const failed = (n: number, why: string): void =>
    ctx.onAdvice?.('render-failed', `SVG image ${n} could not be converted for ${name}: ${why}`)

  const { eachMs, batch } = SVG_IMAGE_LIMITS

  interface Job {
    el: Element
    number: number
    source: string
    width: number
    height: number
  }
  const jobs: Job[] = []
  images.forEach((el, i) => {
    const number = i + 1
    const svg = decodeSvgDataUri(el.attribs.src)
    const prepared =
      svg === null
        ? undefined
        : prepareSvgForRaster(svg, {
            width: attrPx(el.attribs.width),
            height: attrPx(el.attribs.height),
            // Kindle takes Word's page too: a picture the size of a page, drawn
            // at twice that, is sharp on any Kindle screen and stays small.
            maxWidth: DOCX_MAX_WIDTH,
            maxHeight: DOCX_MAX_HEIGHT,
          })
    if (!prepared) {
      failed(number, 'it is not a readable SVG')
      replaceWith(el, placeholderFor(el))
    } else {
      jobs.push({ el, number, ...prepared, source: prepared.svg })
    }
  })

  if (jobs.length > 0) {
    // One request per distinct picture at a given size, `batch` at a time.
    const unique = [...new Set(jobs.map((j) => j.source))]
    const bySource = new Map<string, RenderResult | undefined>()
    for (let i = 0; i < unique.length; i += batch) {
      const part = unique.slice(i, i + batch)
      let results: RenderResult[]
      try {
        results = await render(
          part.map((source) => ({ kind: 'svg', source, display: true, format: 'png' })),
          { signal: ctx.signal, timeoutMs: eachMs },
        )
      } catch (err) {
        if (ctx.signal?.aborted) throw err
        ctx.onAdvice?.('render-failed', `SVG images could not be converted for ${name}: ${oneLine((err as Error)?.message ?? String(err))}`)
        break
      }
      for (const [k, source] of part.entries()) bySource.set(source, results[k])
    }
    for (const job of jobs) {
      if (!bySource.has(job.source)) {
        // The rasterizer went down before this one: said once, above.
        replaceWith(job.el, placeholderFor(job.el))
        continue
      }
      const result = bySource.get(job.source)
      if (result && !('error' in result) && typeof result.png === 'string' && BASE64.test(result.png)) {
        const { el } = job
        el.attribs.src = `data:image/png;base64,${result.png}`
        el.attribs.width = String(job.width)
        el.attribs.height = String(job.height)
        el.attribs.style = `width:${job.width}px;height:auto;max-width:100%`
        continue
      }
      failed(job.number, result && 'error' in result ? oneLine(result.error) : 'the rasterizer gave no picture')
      replaceWith(job.el, placeholderFor(job.el))
    }
  }
  return serialize(dom, { encodeEntities: 'utf8' })
}
