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
 * Any other <image> - a remote file, another raster type, something that is
 * not what it claims - is still dropped. A nested <svg> element is ordinary
 * SVG and is cleaned with the rest.
 *
 * Returns null when the input is not an SVG document at all.
 */
export function sanitizeSvg(svg: string): string | null {
  return sanitizeAt(svg, 0)
}

/** How many SVG images may be nested inside one another below the outer SVG. */
const MAX_NESTING = 4

function sanitizeAt(svg: string, depth: number): string | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml') as unknown as Document
  } catch {
    return null
  }
  const root = doc.documentElement
  if (!root || localName(root) !== 'svg') return null
  cleanAttributes(root)
  clean(root, depth)
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
  const refs = [...el.attributes].filter((a) => attrLocalName(a.name) === 'href')
  // Two references (href and xlink:href) could disagree on what is shown.
  if (refs.length !== 1) return null
  const value = refs[0].value ?? ''
  const raster = rasterDataUri(value)
  if (raster) return { name: refs[0].name, src: raster }
  if (depth >= MAX_NESTING) return null
  const svg = decodeSvgDataUri(value)
  const clean = svg === null ? null : sanitizeAt(svg, depth + 1)
  return clean === null ? null : { name: refs[0].name, src: svgDataUri(clean) }
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

function clean(el: Element, depth: number): void {
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
      if (DROPPED_ELEMENTS.has(name) || (ANIMATION.has(name) && animatesAReference(element))) {
        element.remove()
        continue
      }
      if (name === 'style' && unsafeCss(element.textContent ?? '')) {
        element.remove()
        continue
      }
      cleanAttributes(element)
      clean(element, depth)
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
