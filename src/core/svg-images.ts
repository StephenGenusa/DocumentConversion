import { DOMParser } from 'linkedom'
import { parseDocument } from 'htmlparser2'
import { Element, type ChildNode } from 'domhandler'
import { removeElement, replaceElement, textContent } from 'domutils'
import serialize from 'dom-serializer'
import { decodeSvgDataUri, sanitizeSvg, svgDataUri } from './svg-sanitize'
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
 * page with 1-inch margins html-to-docx writes (9 in at 96 px/in). With the
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

function svgRoot(svg: string): Element | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml') as unknown as Document
  } catch {
    return null
  }
  const root = doc.documentElement as unknown as globalThis.Element | null
  if (!root) return null
  const name = (root.localName || root.tagName || '').toLowerCase()
  return (name === 'svg' || name.endsWith(':svg') ? root : null) as unknown as Element | null
}

type DomElement = globalThis.Element

/** The size an SVG is shown at when nothing else says, in CSS px: as a browser sizes it in an <img>. */
function intrinsicOf(root: DomElement): { width: number; height: number } {
  const w = lengthPx(root.getAttribute('width'))
  const h = lengthPx(root.getAttribute('height'))
  const box = viewBoxOf(root.getAttribute('viewBox'))
  if (w && h) return { width: w, height: h }
  if (box) {
    if (w) return { width: w, height: (w * box.height) / box.width }
    if (h) return { width: (h * box.width) / box.height, height: h }
    return box
  }
  // CSS's default size for a replaced element with no size of its own.
  return { width: w ?? 300, height: h ?? 150 }
}

/** An SVG's own size in CSS px (width/height, else its viewBox, else 300x150), or null when it is not an SVG. */
export function svgIntrinsicSize(svg: string): { width: number; height: number } | null {
  const root = svgRoot(svg) as unknown as DomElement | null
  return root ? intrinsicOf(root) : null
}

export interface RasterSize {
  /** The <img>'s own width or height, when it gives one. */
  width?: number
  height?: number
  maxWidth?: number
  maxHeight?: number
}

/**
 * The SVG ready to be drawn as a PNG: sanitised (B6), with its root sized in
 * whole px at the size the picture will be shown, and a viewBox so the
 * drawing scales with it. The size is part of the markup, so it is part of
 * the host's cache key. Null when it is not an SVG.
 */
export function prepareSvgForRaster(svg: string, size: RasterSize): { svg: string; width: number; height: number } | null {
  const clean = sanitizeSvg(svg)
  if (!clean) return null
  const root = svgRoot(clean) as unknown as DomElement | null
  if (!root) return null
  const own = intrinsicOf(root)
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

  // Without a viewBox the drawing's user units are px of its own size, and it
  // would not scale with a new width and height.
  if (!viewBoxOf(root.getAttribute('viewBox'))) root.setAttribute('viewBox', `0 0 ${trim(own.width)} ${trim(own.height)}`)
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  const style = root.getAttribute('style')
  if (style) {
    // A size in the root's style outranks the attributes.
    const rest = style
      .split(';')
      .filter((d) => d.trim() && !/^\s*(width|height|min-width|min-height|max-width|max-height)\s*:/i.test(d))
      .join(';')
    if (rest) root.setAttribute('style', rest)
    else root.removeAttribute('style')
  }
  return { svg: root.toString(), width, height }
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
 * B6 for every SVG image in a document: each SVG <img> gets the sanitised
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
 * SVG, sanitised (B6) with the pictures it names by address kept for the
 * read step to fetch, at its own size, its aria-label or <title> as alt.
 * Without this the hub sanitiser dropped the element and the drawing with it.
 *
 * The SVG is taken from the source as written: an HTML parser lower-cases
 * names an SVG needs as they are (viewBox, preserveAspectRatio). It must end
 * where an HTML parser ends it, at its own `</svg>`; one that runs on to the
 * end of the page is left alone, for the sanitiser to drop as before. One
 * marked aria-hidden="true" is decoration and is left alone too.
 */
export function inlineSvgElements(html: string): string {
  if (!/<svg[\s>/]/i.test(html)) return html
  const dom = parseDocument(html, { withStartIndices: true, withEndIndices: true })
  const found: Array<{ start: number; end: number; img: string }> = []
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
      const raw = html.slice(start, end + 1)
      if (!/(?:<\/(?:[\w-]+:)?svg\s*>|\/>)$/i.test(raw)) continue
      const img = inlineSvgImage(raw, node)
      if (img !== null) found.push({ start, end, img })
    }
  }
  visit(dom.children)
  let out = html
  for (const { start, end, img } of found.reverse()) out = `${out.slice(0, start)}${img}${out.slice(end + 1)}`
  return out
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
  const clean = sanitizeSvg(htmlEntitiesAsXml(svgText), { keepImageUrls: true })
  const size = clean ? svgIntrinsicSize(clean) : null
  if (!clean || !size) return null
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
        // The rasteriser went down before this one: said once, above.
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
      failed(job.number, result && 'error' in result ? oneLine(result.error) : 'the rasteriser gave no picture')
      replaceWith(job.el, placeholderFor(job.el))
    }
  }
  return serialize(dom, { encodeEntities: 'utf8' })
}
