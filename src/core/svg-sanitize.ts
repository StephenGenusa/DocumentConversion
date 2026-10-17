import { DOMParser } from 'linkedom'
import { imageMime } from './readers/image'

/**
 * SVG sanitising (spec B6). Every SVG an engine draws passes through here
 * before it is embedded in a document, rasterised, or shown in the editor.
 *
 * The SVG is only ever used as `<img src="data:…">`, where a browser runs no
 * script and loads nothing external, so this is the second line, not the
 * first. It removes what an SVG could use to run code or reach out if it were
 * ever handled any other way (opened on its own, inlined by a viewer, read by
 * an e-reader that treats SVG as a document):
 *
 *   elements      script, foreignObject, iframe, image, and the other HTML or
 *                 SVG elements that embed, load or submit (DROPPED_ELEMENTS)
 *   attributes    every on* handler; href / xlink:href not starting with "#";
 *                 any attribute whose value refers to a non-fragment url(),
 *                 @import or image-set()
 *   styles        a <style> element or style attribute with @import or a
 *                 non-fragment url( (after undoing CSS comments and escapes,
 *                 so `u\72 l(` is caught too)
 *   prolog        the doctype, processing instructions (an
 *                 <?xml-stylesheet?> loads a stylesheet), comments, and
 *                 anything outside the root: only the root <svg> is written
 *
 * Elements are matched by local name whatever their prefix or namespace, so
 * `<html:script>` goes the same way as `<script>`.
 *
 * Two kinds of <image> are kept, each given as a data: URI:
 *
 *   an SVG picture nested in this one (icons placed in a plan, a logo in a
 *   chart). Its SVG goes through all of the above, and is written back as
 *   base64, so what is nested is as clean as what nests it; MAX_NESTING
 *   levels deep at most.
 *   a PNG, JPEG, GIF or WebP picture (a photograph in a plan): the types SVG
 *   requires (PNG, JPEG) and the two every browser also shows. Its bytes must
 *   be the type it claims, and it is written back as base64 of that type.
 *
 * A picture named by a web address (https, or a relative or protocol-relative
 * one) is fetched when the document is read (remote-images.ts) and is a data
 * URI by the time it is sanitised for good; one still naming an address then
 * could not be fetched, and becomes its description in text, "[image: …]",
 * as a failed <img> does. Any other <image> - another raster type, something
 * that is not what it claims - is still dropped. A nested <svg> element is
 * ordinary SVG and is cleaned with the rest.
 *
 * Returns null when the input is not an SVG document at all.
 */
export function sanitizeSvg(svg: string, opts: SanitizeOptions = {}): string | null {
  return sanitizeAt(svg, 0, opts)
}

export interface SanitizeOptions {
  /**
   * For a reader: keep an <image> of the outer SVG that names a web address,
   * its description as its aria-label, for the read step to fetch. Everything
   * else is cleaned as usual, and the SVG is sanitised again without this
   * once its pictures are fetched.
   */
  keepImageUrls?: boolean
}

/** How many SVG images may be nested inside one another below the outer SVG. */
const MAX_NESTING = 4

function svgRoot(svg: string): Element | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml') as unknown as Document
  } catch {
    return null
  }
  const root = doc.documentElement
  return root && localName(root) === 'svg' ? root : null
}

function sanitizeAt(svg: string, depth: number, opts: SanitizeOptions = {}): string | null {
  const root = svgRoot(svg)
  if (!root) return null
  cleanAttributes(root)
  clean(root, depth, depth === 0 && opts.keepImageUrls === true)
  return root.toString()
}

const SVG_DATA_URI = /^\s*data:image\/svg\+xml((?:;[^,]*)?),([\s\S]*)$/i

/** The SVG markup in a data URI (base64, percent-encoded or raw), or null when it is not an SVG one. */
export function decodeSvgDataUri(src: string): string | null {
  const m = SVG_DATA_URI.exec(src)
  if (!m) return null
  const [, params, payload] = m
  let text: string
  if (/;\s*base64\s*$/i.test(params)) {
    text = Buffer.from(payload, 'base64').toString('utf8')
  } else {
    try {
      text = decodeURIComponent(payload)
    } catch {
      text = payload
    }
  }
  return text.replace(/^\uFEFF/, '')
}

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

const RASTER_DATA_URI = /^\s*data:image\/(png|jpeg|jpg|gif|webp)((?:;[^,]*)?),([\s\S]*)$/i

/**
 * A PNG, JPEG, GIF or WebP data URI as base64 of the type its bytes are, or
 * null when it is another type or its bytes are not the type it claims.
 */
function rasterDataUri(src: string): string | null {
  const m = RASTER_DATA_URI.exec(src)
  if (!m) return null
  const [, type, params, payload] = m
  const bytes = /;\s*base64\s*$/i.test(params)
    ? Buffer.from(payload, 'base64')
    : // Percent-encoded bytes, one per %XX; anything else stands for itself.
      Buffer.from(payload.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
  const claimed = type.toLowerCase() === 'jpg' ? 'image/jpeg' : `image/${type.toLowerCase()}`
  return imageMime(bytes) === claimed ? `data:${claimed};base64,${bytes.toString('base64')}` : null
}

/**
 * A nested picture's reference, cleaned: the attribute that holds it (href
 * or xlink:href, as written) and the picture as a base64 data URI - for an
 * SVG, the sanitised SVG. Null when the <image> is anything else, or an SVG
 * nested too deep.
 */
function nestedImage(el: Element, depth: number): { name: string; src: string } | null {
  const ref = imageRef(el)
  if (!ref) return null
  const value = ref.value ?? ''
  const raster = rasterDataUri(value)
  if (raster) return { name: ref.name, src: raster }
  if (depth >= MAX_NESTING) return null
  const svg = decodeSvgDataUri(value)
  const clean = svg === null ? null : sanitizeAt(svg, depth + 1)
  return clean === null ? null : { name: ref.name, src: svgDataUri(clean) }
}

/**
 * The one href of an <image> (href or xlink:href), or null when it has none
 * or two: two references could disagree on what is shown.
 */
function imageRef(el: Element): Attr | null {
  const refs = [...el.attributes].filter((a) => attrLocalName(a.name) === 'href')
  return refs.length === 1 ? refs[0] : null
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * An attribute's value as text. linkedom hands an XML attribute back as it
 * was written, entities and all (and escapes what it is given on the way
 * out), so `a?b=1&amp;c=2` is the address `a?b=1&c=2`.
 */
function attrText(value: string | null | undefined): string {
  return (value ?? '').replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (m, hex: string, dec: string, name: string) => {
    if (name) return XML_ENTITIES[name.toLowerCase()] ?? m
    const code = hex ? parseInt(hex, 16) : Number(dec)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
}

/** A web address, as a page would load it: http(s), or relative to or with the scheme of one. */
function isWebAddress(value: string): boolean {
  if (/^\s*(?:#|data:)/i.test(value)) return false
  try {
    const url = new URL(value.trim(), 'https://unresolved.invalid/')
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Every <image> below `el`, in document order. */
function imagesIn(el: Element): Element[] {
  const out: Element[] = []
  for (const child of [...el.childNodes]) {
    if (child.nodeType !== 1) continue
    if (localName(child as Element) === 'image') out.push(child as Element)
    else out.push(...imagesIn(child as Element))
  }
  return out
}

/**
 * The web address each picture in an SVG names, as written, in document order:
 * what the read step fetches. Only the outer SVG's; [] when it is not an SVG.
 */
export function svgImageUrls(svg: string): string[] {
  const root = svgRoot(svg)
  if (!root) return []
  return imagesIn(root).flatMap((el) => {
    const ref = imageRef(el)
    const url = attrText(ref?.value)
    return ref && isWebAddress(url) ? [url] : []
  })
}

/**
 * The SVG with each picture whose address is in `pictures` given that data
 * URI instead, everything else as it was. Sanitised again afterwards, which
 * checks each picture is what it claims.
 */
export function withSvgImagePictures(svg: string, pictures: ReadonlyMap<string, string>): string {
  const root = svgRoot(svg)
  if (!root) return svg
  for (const el of imagesIn(root)) {
    const ref = imageRef(el)
    const picture = ref ? pictures.get(attrText(ref.value)) : undefined
    if (ref && picture) el.setAttribute(ref.name, picture)
  }
  return root.toString()
}

/** A length attribute as a plain number of user units, or undefined. */
function userUnits(el: Element, name: string): number | undefined {
  const m = /^\s*([+-]?\d*\.?\d+)\s*(?:px)?\s*$/i.exec(el.getAttribute(name) ?? '')
  return m ? Number(m[1]) : undefined
}

/**
 * What a picture that could not be fetched becomes: its description (an
 * aria-label or <title>) in text where the picture's top-left corner was,
 * as `imagePlaceholder` (inline-images.ts) writes it for an <img>.
 */
function imagePlaceholderText(el: Element): Element {
  const label = (el.hasAttribute('aria-label') ? attrText(el.getAttribute('aria-label')) : (childTitle(el) ?? '')).replace(/\s+/g, ' ').trim()
  const colon = el.tagName.indexOf(':')
  const text = el.ownerDocument.createElement(`${colon >= 0 ? el.tagName.slice(0, colon + 1) : ''}text`)
  const height = userUnits(el, 'height')
  const size = height && height > 0 ? Math.min(12, height) : 12
  text.setAttribute('x', String(userUnits(el, 'x') ?? 0))
  text.setAttribute('y', String((userUnits(el, 'y') ?? 0) + size))
  text.setAttribute('font-size', String(size))
  text.setAttribute('font-family', 'sans-serif')
  text.setAttribute('fill', '#555')
  const transform = el.getAttribute('transform')
  if (transform) text.setAttribute('transform', transform)
  text.textContent = `[image: ${label || 'not included'}]`
  return text
}

function childTitle(el: Element): string | undefined {
  for (const child of [...el.childNodes]) {
    if (child.nodeType === 1 && localName(child as Element) === 'title') return child.textContent ?? undefined
  }
  return undefined
}

/** Elements removed with everything inside them. Lower-cased local names. */
const DROPPED_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'image',
  'feimage',
  'img',
  'object',
  'embed',
  'frame',
  'frameset',
  'link',
  'meta',
  'base',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'handler',
  'listener',
  'discard',
])

/** Animation elements, which can set an attribute (an href) to a new value. */
const ANIMATION = new Set(['set', 'animate', 'animatemotion', 'animatetransform', 'animatecolor'])

function localName(el: Element): string {
  const name = (el.localName || el.tagName || '').toLowerCase()
  const colon = name.lastIndexOf(':')
  return colon >= 0 ? name.slice(colon + 1) : name
}

function attrLocalName(name: string): string {
  const lower = name.toLowerCase()
  const colon = lower.lastIndexOf(':')
  return colon >= 0 ? lower.slice(colon + 1) : lower
}

function clean(el: Element, depth: number, keepImageUrls: boolean): void {
  for (const child of [...el.childNodes]) {
    if (child.nodeType === 1) {
      const element = child as Element
      const name = localName(element)
      const nested = name === 'image' ? nestedImage(element, depth) : null
      if (nested) {
        element.setAttribute(nested.name, nested.src)
        cleanAttributes(element, nested.name)
        // Nothing inside an <image> is drawn.
        element.replaceChildren()
        continue
      }
      const ref = name === 'image' ? imageRef(element) : null
      if (ref && isWebAddress(attrText(ref.value))) {
        if (keepImageUrls) {
          const title = childTitle(element)?.replace(/\s+/g, ' ').trim()
          if (title && !element.hasAttribute('aria-label')) element.setAttribute('aria-label', title)
          cleanAttributes(element, ref.name)
          element.replaceChildren()
        } else {
          const text = imagePlaceholderText(element)
          element.replaceWith(text)
          cleanAttributes(text)
        }
        continue
      }
      if (DROPPED_ELEMENTS.has(name) || (ANIMATION.has(name) && animatesAReference(element))) {
        element.remove()
        continue
      }
      if (name === 'style' && unsafeCss(element.textContent ?? '')) {
        element.remove()
        continue
      }
      cleanAttributes(element)
      clean(element, depth, keepImageUrls)
    } else if (child.nodeType !== 3 && child.nodeType !== 4) {
      // Comments, processing instructions: nothing an SVG needs.
      child.remove()
    }
  }
}

/** Removes the unsafe attributes; `keep` is a nested picture's reference, already cleaned. */
function cleanAttributes(el: Element, keep?: string): void {
  for (const attr of [...el.attributes]) {
    if (attr.name === keep) continue
    const name = attrLocalName(attr.name)
    const value = attr.value ?? ''
    if (
      name.startsWith('on') ||
      // xml:base would turn a "#fragment" into a reference to another file.
      name === 'base' ||
      ((name === 'href' || name === 'src') && !value.trimStart().startsWith('#')) ||
      (name === 'style' ? unsafeCss(value) : unsafeCss(value, true))
    ) {
      el.removeAttribute(attr.name)
    }
  }
}

/** `<set attributeName="href" to="javascript:…">` and its kind, or one with a non-fragment value. */
function animatesAReference(el: Element): boolean {
  const target = attrLocalName(el.getAttribute('attributeName') ?? '')
  if (target === 'href' || target === 'src' || target.startsWith('on')) return true
  return ['to', 'from', 'values', 'by'].some((a) => unsafeCss(el.getAttribute(a) ?? '', true))
}

/**
 * CSS (or an attribute value) that could load something: @import, a url()
 * that is not a "#fragment", or image-set(), which takes a bare string URL.
 * `attributeOnly` skips the @import check, which means nothing outside CSS.
 */
function unsafeCss(text: string, attributeOnly = false): boolean {
  if (!text) return false
  const css = undoCssEscapes(text.replace(/\/\*[\s\S]*?(\*\/|$)/g, '')).toLowerCase()
  if (!attributeOnly && css.includes('@import')) return true
  if (/image-set\s*\(/.test(css)) return true
  for (const m of css.matchAll(/url\s*\(\s*(['"]?)\s*([^'")\s]*)/g)) {
    if (!m[2].startsWith('#')) return true
  }
  return false
}

/** CSS escapes (`\72 `, `\u`) as the characters they stand for, so they cannot hide a keyword. */
function undoCssEscapes(text: string): string {
  return text.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (_m, hex: string | undefined, ch: string | undefined) => {
    if (hex) {
      const code = parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�'
    }
    return ch === '\n' ? '' : (ch ?? '')
  })
}
