import { DOMParser } from 'linkedom'

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
 * Returns null when the input is not an SVG document at all.
 */
export function sanitizeSvg(svg: string): string | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml') as unknown as Document
  } catch {
    return null
  }
  const root = doc.documentElement
  if (!root || localName(root) !== 'svg') return null
  cleanAttributes(root)
  clean(root)
  return root.toString()
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

function clean(el: Element): void {
  for (const child of [...el.childNodes]) {
    if (child.nodeType === 1) {
      const element = child as Element
      const name = localName(element)
      if (DROPPED_ELEMENTS.has(name) || (ANIMATION.has(name) && animatesAReference(element))) {
        element.remove()
        continue
      }
      if (name === 'style' && unsafeCss(element.textContent ?? '')) {
        element.remove()
        continue
      }
      cleanAttributes(element)
      clean(element)
    } else if (child.nodeType !== 3 && child.nodeType !== 4) {
      // Comments, processing instructions: nothing an SVG needs.
      child.remove()
    }
  }
}

function cleanAttributes(el: Element): void {
  for (const attr of [...el.attributes]) {
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
