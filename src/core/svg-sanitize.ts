import { createHash } from 'node:crypto'
import { Parser } from 'htmlparser2'
import { imageMime } from './readers/image'

/**
 * SVG sanitizing (spec B6). Every SVG an engine draws passes through here
 * before it is embedded in a document, rasterized, or shown in the editor.
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
 * URI by the time it is sanitized for good; one still naming an address then
 * could not be fetched, and becomes its description in text, "[image: …]",
 * as a failed <img> does. Any other <image> - another raster type, something
 * that is not what it claims - is still dropped. A nested <svg> element is
 * ordinary SVG and is cleaned with the rest.
 *
 * Returns null when the input is not an SVG document at all.
 *
 * Done in one streaming pass (htmlparser2's XML tokenizer, the one linkedom
 * builds its tree from), writing the cleaned SVG as it reads: no tree is
 * built, so a 12 MB drawing costs a small multiple of its size, not the
 * gigabyte a DOM of it took. A cleaned SVG is remembered (by hash) for the
 * rest of the process, so the same SVG cleaned again where it is written, and
 * again by the render host, is not read a second and third time.
 */
export function sanitizeSvg(svg: string, opts: SanitizeOptions = {}): string | null {
  return sanitizeSvgDoc(svg, opts)?.svg ?? null
}

export interface SanitizeOptions {
  /**
   * For a reader: keep an <image> that names a web address, in the outer SVG
   * or an SVG nested in it as a data URI, its description as its aria-label,
   * for the read step to fetch. Everything else is cleaned as usual, and the
   * SVG is sanitized again without this once its pictures are fetched.
   */
  keepImageUrls?: boolean
}

/** How many SVG images may be nested inside one another below the outer SVG. */
export const MAX_NESTING = 4

/** Attributes by name, as written, their values as text (entities read). */
export type SvgAttributes = Record<string, string>

/** A sanitized SVG, with what its root says, so a caller need not read it again for that. */
export interface CleanSvg {
  svg: string
  /** The root element's name as written (`svg`, `svg:svg`). */
  name: string
  /** The root's attributes, cleaned. */
  root: Readonly<SvgAttributes>
  /** How long the root's start tag is in `svg`. */
  headLength: number
  /** Whether it names no picture by address: clean without keepImageUrls too. */
  strict: boolean
}

/** The sanitized SVG with what its root says, or null when it is not an SVG. */
export function sanitizeSvgDoc(svg: string, opts: SanitizeOptions = {}): CleanSvg | null {
  const keepImageUrls = opts.keepImageUrls === true
  const known = knownClean(svg, keepImageUrls)
  if (known) return known
  const mode: Mode = { keepImageUrls, keptAddress: false }
  const parts = sanitizeParts(svg, 0, mode)
  if (!parts) return null
  // Kept for the read step names no address after all: as clean as without keepImageUrls.
  const out = cleanSvgOf(parts.name, parts.root, parts.rest, !mode.keptAddress)
  remember(out)
  return out
}

/**
 * The cleaned SVG with its root's attributes replaced by `attributes`
 * (cleaned again as any root's are): how a picture is sized for drawing,
 * without reading the rest of it again.
 */
export function withRootAttributes(clean: CleanSvg, attributes: SvgAttributes): CleanSvg {
  // The rest is as clean as it was, and the root has just been cleaned.
  const out = cleanSvgOf(clean.name, cleanAttributes(attributes), clean.svg.slice(clean.headLength), clean.strict)
  remember(out)
  return out
}

/**
 * The attributes of an SVG's root, read from its start tag alone, or null
 * when it is not an SVG. Not sanitized: for a size, not for drawing.
 */
export function svgRootAttributes(svg: string): SvgAttributes | null {
  let found: SvgAttributes | null = null
  let done = false
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (done) return
        done = true
        if (localName(name) === 'svg') found = { ...attribs }
        parser.pause()
      },
    },
    PARSER_OPTIONS,
  )
  parser.write(svg)
  if (!done) parser.end()
  return found
}

const PARSER_OPTIONS = { xmlMode: true, decodeEntities: true, lowerCaseAttributeNames: false } as const

// ---- What has been cleaned already ------------------------------------

/**
 * SVGs this process has cleaned, by SHA-256 of the clean markup: cleaning a
 * clean SVG gives it back as it is, so one seen here is not read again. Only
 * large ones (the hash costs less than the read only there), only outer ones
 * (a nested SVG is cleaned with fewer levels of nesting left), and `strict`
 * only for those that name no picture by address (one cleaned with
 * keepImageUrls may still). Kept on globalThis so core and the render host
 * share it when they are bundled apart; it holds hashes and root attributes,
 * never the markup.
 */
interface Known {
  strict: boolean
  name: string
  root: Readonly<SvgAttributes>
  headLength: number
}

const KNOWN_MIN_LENGTH = 64 * 1024
const KNOWN_MAX = 256
const KNOWN_KEY = Symbol.for('docconversion.svg-sanitize.known-clean')

function knownMap(): Map<string, Known> {
  const g = globalThis as unknown as Record<symbol, Map<string, Known> | undefined>
  return (g[KNOWN_KEY] ??= new Map())
}

const hashOf = (svg: string): string => createHash('sha256').update(svg, 'utf8').digest('base64')

function knownClean(svg: string, keepImageUrls: boolean): CleanSvg | null {
  if (svg.length < KNOWN_MIN_LENGTH) return null
  const map = knownMap()
  const key = hashOf(svg)
  const k = map.get(key)
  if (!k || !(k.strict || keepImageUrls)) return null
  map.delete(key)
  map.set(key, k)
  return { svg, name: k.name, root: k.root, headLength: k.headLength, strict: k.strict }
}

function remember(clean: CleanSvg): void {
  if (clean.svg.length < KNOWN_MIN_LENGTH) return
  const map = knownMap()
  const key = hashOf(clean.svg)
  const was = map.get(key)
  map.delete(key)
  map.set(key, { strict: clean.strict || was?.strict === true, name: clean.name, root: clean.root, headLength: clean.headLength })
  while (map.size > KNOWN_MAX) map.delete(map.keys().next().value!)
}

// ---- Writing ------------------------------------------------------------

/** Text written in pieces and joined once, a run at a time, so a long SVG is not one string per tag. */
class Sink {
  private parts: string[] = []
  private runs: string[] = []
  length = 0
  push(text: string): void {
    if (!text) return
    this.parts.push(text)
    this.length += text.length
    if (this.parts.length >= 4096) {
      this.runs.push(this.parts.join(''))
      this.parts = []
    }
  }
  text(): string {
    if (this.parts.length > 0) {
      this.runs.push(this.parts.join(''))
      this.parts = []
    }
    const all = this.runs.length === 1 ? this.runs[0] : this.runs.join('')
    this.runs = all ? [all] : []
    return all
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\u00a0': '&#160;' }
const escapeText = (text: string): string => text.replace(/[&<>\u00a0]/g, (c) => ESCAPES[c])
const escapeAttr = (text: string): string => text.replace(/[&<>"\u00a0]/g, (c) => ESCAPES[c])

/** An XML name, as a parser reading what is written would take it: anything else would make the markup unreadable. */
const XML_NAME = /^[A-Za-z_:À-￿][\w.:·À-￿-]*$/

function startTag(name: string, attributes: SvgAttributes): string {
  let out = `<${name}`
  for (const [k, v] of Object.entries(attributes)) out += ` ${k}="${escapeAttr(v)}"`
  return out
}

function cleanSvgOf(name: string, root: SvgAttributes, rest: string, strict: boolean): CleanSvg {
  const head = `${startTag(name, root)}${rest ? '>' : ' />'}`
  return { svg: head + rest, name, root, headLength: head.length, strict }
}

// ---- Cleaning -----------------------------------------------------------

interface Parts {
  name: string
  root: SvgAttributes
  /** Everything after the root's start tag: its content and end tag, or '' when it has none. */
  rest: string
}

/** An element being written: its start tag is open (no `>` yet) until it is given content. */
interface Open {
  name: string
  sink: Sink
  opened: boolean
  /** A <style> element: its text, kept until its end to see whether it is safe. */
  css?: string[]
}

/** An <image> named by a web address, read to its end for its <title>. */
interface PendingImage {
  name: string
  attributes: SvgAttributes
  ref: string
  level: number
  title?: string[]
  titleLevel?: number
  titleDone: boolean
}

/** How a document is cleaned, and whether a picture named by address was kept (at any depth). */
interface Mode {
  keepImageUrls: boolean
  keptAddress: boolean
}

function sanitizeParts(svg: string, depth: number, mode: Mode): Parts | null {
  let level = 0
  /** The level of the element being dropped with everything in it, or 0. */
  let skipping = 0
  let pending: PendingImage | null = null
  let root: { name: string; attributes: SvgAttributes } | null = null
  let notSvg = false
  let finished = false
  const rootSink = new Sink()
  const stack: Open[] = []

  /** Where the current element's content goes, its start tag closed first. */
  const into = (): Sink => {
    const top = stack[stack.length - 1]
    if (!top) return rootSink
    if (!top.opened) {
      top.sink.push('>')
      top.opened = true
    }
    return top.sink
  }

  const parser = new Parser(
    {
      onopentag(rawName, attribs) {
        if (finished) return
        level++
        if (skipping) return
        if (pending) {
          // Inside an <image>: nothing is drawn, only its first <title> read.
          if (level === pending.level + 1 && !pending.title && !pending.titleDone && localName(rawName) === 'title') {
            pending.title = []
            pending.titleLevel = level
          }
          return
        }
        if (!root) {
          if (localName(rawName) !== 'svg' || !XML_NAME.test(rawName)) {
            notSvg = true
            finished = true
            parser.pause()
            return
          }
          root = { name: rawName, attributes: cleanAttributes(attribs) }
          return
        }
        const name = localName(rawName)
        if (!XML_NAME.test(rawName)) {
          skipping = level
          return
        }
        if (name === 'image') {
          const ref = imageRef(attribs)
          const nested = ref ? nestedImage(ref, depth, mode) : null
          if (ref && nested) {
            const attributes = cleanAttributes({ ...attribs, [ref.name]: nested }, ref.name)
            // Nothing inside an <image> is drawn.
            into().push(`${startTag(rawName, attributes)} />`)
            skipping = level
            return
          }
          if (ref && isWebAddress(ref.value)) {
            pending = { name: rawName, attributes: attribs, ref: ref.name, level, titleDone: false }
            return
          }
        }
        if (DROPPED_ELEMENTS.has(name) || (ANIMATION.has(name) && animatesAReference(attribs))) {
          skipping = level
          return
        }
        // A <style> is written apart, to its parent only once its text is known to be safe.
        const sink = name === 'style' ? new Sink() : into()
        sink.push(startTag(rawName, cleanAttributes(attribs)))
        stack.push({ name: rawName, sink, opened: false, css: name === 'style' ? [] : undefined })
      },

      ontext(text) {
        if (finished || skipping || !root || level === 0) return
        if (pending) {
          if (pending.title && !pending.titleDone) pending.title.push(text)
          return
        }
        for (const open of stack) open.css?.push(text)
        into().push(escapeText(text))
      },

      onclosetag() {
        if (finished) return
        const at = level
        level--
        if (skipping) {
          if (at === skipping) skipping = 0
          return
        }
        if (pending) {
          if (at === pending.titleLevel) pending.titleDone = true
          if (at === pending.level) {
            const p = pending
            pending = null
            if (mode.keepImageUrls) mode.keptAddress = true
            into().push(webImage(p, mode.keepImageUrls))
          }
          return
        }
        if (at === 1) {
          // The root's end: nothing after it is written.
          finished = true
          parser.pause()
          return
        }
        const open = stack.pop()!
        const end = open.opened ? `</${open.name}>` : ' />'
        if (open.css) {
          if (unsafeCss(open.css.join(''))) return
          open.sink.push(end)
          into().push(open.sink.text())
          return
        }
        open.sink.push(end)
      },
      // Comments, processing instructions, the doctype: nothing an SVG needs, and never written.
    },
    PARSER_OPTIONS,
  )
  parser.write(svg)
  if (!finished) parser.end()
  if (notSvg || !root) return null
  const r = root as { name: string; attributes: SvgAttributes }
  const content = rootSink.text()
  return { name: r.name, root: r.attributes, rest: content ? `${content}</${r.name}>` : '' }
}

/**
 * An <image> named by a web address: kept, for the read step to fetch, with
 * its description as its aria-label (`keepImageUrls`), or else its
 * description in text where its top-left corner was, as `imagePlaceholder`
 * (inline-images.ts) writes it for an <img>.
 */
function webImage(p: PendingImage, keepImageUrls: boolean): string {
  const title = p.title ? p.title.join('') : undefined
  if (keepImageUrls) {
    const label = title?.replace(/\s+/g, ' ').trim()
    const attributes = label && !('aria-label' in p.attributes) ? { 'aria-label': label, ...p.attributes } : p.attributes
    return `${startTag(p.name, cleanAttributes(attributes, p.ref))} />`
  }
  const label = ('aria-label' in p.attributes ? p.attributes['aria-label'] : (title ?? '')).replace(/\s+/g, ' ').trim()
  const colon = p.name.indexOf(':')
  const name = `${colon >= 0 ? p.name.slice(0, colon + 1) : ''}text`
  const height = userUnits(p.attributes, 'height')
  const size = height && height > 0 ? Math.min(12, height) : 12
  const attributes: SvgAttributes = {
    x: String(userUnits(p.attributes, 'x') ?? 0),
    y: String((userUnits(p.attributes, 'y') ?? 0) + size),
    'font-size': String(size),
    'font-family': 'sans-serif',
    fill: '#555',
  }
  if (p.attributes.transform) attributes.transform = p.attributes.transform
  return `${startTag(name, cleanAttributes(attributes))}>${escapeText(`[image: ${label || 'not included'}]`)}</${name}>`
}

/** A length attribute as a plain number of user units, or undefined. */
function userUnits(attributes: SvgAttributes, name: string): number | undefined {
  const m = /^\s*([+-]?\d*\.?\d+)\s*(?:px)?\s*$/i.exec(attributes[name] ?? '')
  return m ? Number(m[1]) : undefined
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
 * SVG, the sanitized SVG. Null when the <image> is anything else, or an SVG
 * nested too deep.

/**
 * A nested picture's reference, cleaned: the picture as a base64 data URI -
 * for an SVG, the sanitized SVG. Null when the <image> is anything else, or
 * an SVG nested too deep.
 */
function nestedImage(ref: { name: string; value: string }, depth: number, mode: Mode): string | null {
  const raster = rasterDataUri(ref.value)
  if (raster) return raster
  if (depth >= MAX_NESTING) return null
  const svg = decodeSvgDataUri(ref.value)
  const parts = svg === null ? null : sanitizeParts(svg, depth + 1, mode)
  return parts === null ? null : svgDataUri(cleanSvgOf(parts.name, parts.root, parts.rest, true).svg)
}

/**
 * The one href of an <image> (href or xlink:href), or null when it has none
 * or two: two references could disagree on what is shown.
 */
function imageRef(attributes: SvgAttributes): { name: string; value: string } | null {
  const refs = Object.keys(attributes).filter((name) => attrLocalName(name) === 'href')
  return refs.length === 1 ? { name: refs[0], value: attributes[refs[0]] } : null
}

/**
 * Each <image> of the outer SVG, in document order (not those inside another
 * <image>, which draws nothing): its start tag's name, attributes and place
 * in the markup. [] when it is not an SVG.
 */
function outerImages(svg: string): Array<{ name: string; attributes: SvgAttributes; start: number; end: number }> {
  // No <image> anywhere: nothing to read the whole SVG for.
  if (!/image/i.test(svg)) return []
  const out: Array<{ name: string; attributes: SvgAttributes; start: number; end: number }> = []
  let level = 0
  let inImage = 0
  let rooted = false
  let done = false
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (done) return
        level++
        if (!rooted) {
          rooted = true
          if (localName(name) !== 'svg') {
            done = true
            parser.pause()
          }
          return
        }
        if (inImage) return
        if (localName(name) === 'image') {
          inImage = level
          out.push({ name, attributes: attribs, start: parser.startIndex, end: parser.endIndex })
        }
      },
      onclosetag() {
        if (done) return
        if (level === inImage) inImage = 0
        if (--level === 0) {
          done = true
          parser.pause()
        }
      },
    },
    PARSER_OPTIONS,
  )
  parser.write(svg)
  if (!done) parser.end()
  return out
}

/**
 * The web address each picture in an SVG names, as written, in document order:
 * what the read step fetches. Only the outer SVG's; [] when it is not an SVG.
 */
export function svgImageUrls(svg: string): string[] {
  return svgImageRefs(svg).filter(isWebAddress)
}

/**
 * Every picture reference of the outer SVG (each <image>'s one href, as
 * text), in document order, repeats included: web addresses and data URIs
 * alike. [] when it is not an SVG.
 */
export function svgImageRefs(svg: string): string[] {
  return outerImages(svg).flatMap((img) => {
    const ref = imageRef(img.attributes)
    return ref ? [ref.value] : []
  })
}

/**
 * The SVG with each picture whose reference (an address, or a nested SVG's
 * data URI, as svgImageRefs gives it) is in `pictures` given that data URI
 * instead, everything else as it was. Sanitized again afterwards, which
 * checks each picture is what it claims.
 */
export function withSvgImagePictures(svg: string, pictures: ReadonlyMap<string, string>): string {
  if (pictures.size === 0) return svg
  const out: string[] = []
  let at = 0
  for (const img of outerImages(svg)) {
    const ref = imageRef(img.attributes)
    const picture = ref ? pictures.get(ref.value) : undefined
    const attributes = ref && picture ? { ...img.attributes, [ref.name]: picture } : img.attributes
    const tag = svg.slice(img.start, img.end + 1)
    out.push(svg.slice(at, img.start), `${startTag(img.name, attributes)}${/\/\s*>$/.test(tag) ? ' />' : '>'}`)
    at = img.end + 1
  }
  if (at === 0) return svg
  out.push(svg.slice(at))
  return out.join('')
}

/** A web address, as a page would load it: http(s), or relative to or with the scheme of one. */
export function isWebAddress(value: string): boolean {
  if (/^\s*(?:#|data:)/i.test(value)) return false
  try {
    const url = new URL(value.trim(), 'https://unresolved.invalid/')
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
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

const ELEMENT_LOCAL = (name: string): string => {
  const lower = name.toLowerCase()
  const colon = lower.lastIndexOf(':')
  return colon >= 0 ? lower.slice(colon + 1) : lower
}

/** An element's name without its prefix, lower-cased. */
const localName = ELEMENT_LOCAL

/** An attribute's name without its prefix, lower-cased. */
const attrLocalName = ELEMENT_LOCAL

/** The attributes that are safe, as a new set; `keep` is a nested picture's reference, already cleaned. */
function cleanAttributes(attributes: Readonly<SvgAttributes>, keep?: string): SvgAttributes {
  const out: SvgAttributes = {}
  for (const [attrName, value] of Object.entries(attributes)) {
    if (attrName !== keep) {
      const name = attrLocalName(attrName)
      if (
        !XML_NAME.test(attrName) ||
        name.startsWith('on') ||
        // xml:base would turn a "#fragment" into a reference to another file.
        name === 'base' ||
        ((name === 'href' || name === 'src') && !value.trimStart().startsWith('#')) ||
        (name === 'style' ? unsafeCss(value) : unsafeCss(value, true))
      ) {
        continue
      }
    }
    out[attrName] = value
  }
  return out
}

/** `<set attributeName="href" to="javascript:…">` and its kind, or one with a non-fragment value. */
function animatesAReference(attributes: Readonly<SvgAttributes>): boolean {
  const target = attrLocalName(attributes.attributeName ?? '')
  if (target === 'href' || target === 'src' || target.startsWith('on')) return true
  return ['to', 'from', 'values', 'by'].some((a) => unsafeCss(attributes[a] ?? '', true))
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
