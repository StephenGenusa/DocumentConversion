import { parseDocument } from 'htmlparser2'
import { append, removeElement, replaceElement } from 'domutils'
import { Element } from 'domhandler'
import render from 'dom-serializer'
import { imageMime } from './readers/image'
import { decodeSvgDataUri, svgDataUri, svgImageUrls, withSvgImagePictures } from './svg-sanitize'

export interface ImageFetcher {
  (url: string): Promise<{ bytes: Buffer; contentType: string }>
}

/**
 * The largest single picture fetched over the network: a fetched page, a
 * paste, and a document's remote images at read time.
 *
 * Not a product limit (owner, 2026-10-16: no picture count, no per-document
 * total): a ceiling so one response cannot exhaust memory. A picture is held
 * as its bytes and then as a base64 data URI a third larger, in one string;
 * 200 MB is far beyond any photograph a page shows and still leaves that
 * string well inside what the JavaScript engine can hold. Time is bounded by
 * the per-picture timeout, and the user's Skip or Cancel.
 */
export const MAX_FETCHED_IMAGE_BYTES = 200 * 1024 * 1024

/** Images downloaded at once. Enough to hide latency, few enough to be polite to one host. */
const FETCH_CONCURRENCY = 4

/**
 * The budget for images that arrive inside the source file (a pptx, docx or
 * rtf) rather than over the network. Its one job is the decompression bomb:
 * a small file that expands to a vast document.
 */
export interface ArchiveBudget {
  /** Bytes the document's pictures may come to, each charged ARCHIVE_IMAGE_OVERHEAD on top. */
  maxTotal: number
}

/**
 * The least an archive is allowed, however small the file. An honest file
 * carries about a byte of image per byte of file, so twice its size covers
 * it and this floor only matters for a tiny file, which is exactly the
 * bomb's shape. Raising it lets a 40 KB file expand to that many megabytes
 * of hub.
 */
const ARCHIVE_MIN_TOTAL = 10 * 1024 * 1024

/**
 * What each picture costs beyond its own bytes: about the markup its tag
 * adds to the document. This, not a count, is what stops the tag text itself
 * from being the bomb (one tiny picture referred to a million times costs
 * almost nothing in image bytes, but sixty bytes of markup each), so an
 * honest document may hold any number of pictures: ten thousand cost 640 KB
 * of the budget.
 */
const ARCHIVE_IMAGE_OVERHEAD = 64

/**
 * The budget for a source file of this size.
 *
 * Every archive gets at least ARCHIVE_MIN_TOTAL; what it may be allowed *more*
 * of is bounded by the file the user actually opened. Every real document in the
 * corpus carries between 0.93 and 0.99 bytes of decoded image per byte of file
 * (photographs and screenshots are already compressed, so the zip barely shrinks
 * them), while the intake this exists for (a 39 KB deck of twelve 3 MB
 * single-color PNGs) carries 1200. Twice the file's own size therefore leaves
 * every honest document untouched and still refuses the bomb. There is no
 * count and no per-picture cap: the total already bounds any single picture,
 * and a smaller one would only drop the one big photograph a legitimate
 * document is allowed.
 */
export function archiveInlineBudget(sourceByteLength: number): ArchiveBudget {
  return { maxTotal: Math.max(ARCHIVE_MIN_TOTAL, sourceByteLength * 2) }
}

/**
 * Tracks what a budget has left, in document order.
 *
 * Order is the whole policy: an early figure is worth more than a late one, and
 * a reader cannot hold every image in memory to evict the largest afterwards;
 * that is the memory cost the budget exists to avoid.
 */
export interface ImageLedger {
  /** Whether an image of this size would be admitted, charging nothing. */
  fits(byteLength: number): boolean
  /** Whether it is admitted, charging the budget when it is. */
  admit(byteLength: number): boolean
}

export function createImageLedger(budget: ArchiveBudget): ImageLedger {
  let spent = 0
  const cost = (byteLength: number): number => byteLength + ARCHIVE_IMAGE_OVERHEAD
  const fits = (byteLength: number): boolean => spent + cost(byteLength) <= budget.maxTotal
  return {
    fits,
    admit(byteLength: number): boolean {
      if (!fits(byteLength)) return false
      spent += cost(byteLength)
      return true
    },
  }
}

/**
 * Said in place of an image the budget refused. It names the reason, because
 * "[image: not included]" alone reads like a broken file rather than a decision
 * the converter made and can explain.
 */
export const OVER_BUDGET = 'not included — over this document’s image budget'

/**
 * One `<img>` element, quote-aware.
 *
 * `[^>]*` is not good enough: `<img alt="a > b" src="…">` ends at the `>`
 * inside the alt, so the rest of the tag is left loose in the document as
 * visible garbage and the image is never inlined. A `>` is only the end of the
 * tag when it is outside a quoted attribute value.
 *
 * A quoted value may not contain `<`, though. With an unbalanced quote in one
 * tag, an unbounded quoted alternative ran on through the following paragraphs
 * and made them part of the "tag" — and if that image then failed, the
 * placeholder replaced the paragraphs too. A tag whose quotes do not balance
 * is left alone instead.
 */
const IMG_TAG = /<img\b(?:"[^"<]*"|'[^'<]*'|[^>"'])*>/gi

/**
 * The attributes of a tag, in order, each with the span its value occupies.
 *
 * Tokenized left to right rather than searched for by name: a name-anchored
 * regex, however careful its lookbehind, still finds `src=` in the middle of
 * an alt ("see src=evil.png here") and reads THAT as the source — the tracker
 * got fetched, the data URI went into the alt, and the real src stayed on the
 * network. Walking the attributes means a value is only ever a value.
 */
interface Attribute {
  name: string
  value: string
  /** Where the value (quotes included, if any) sits in the tag. */
  start: number
  end: number
}

const ATTRIBUTE = /([^\s"'>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g

function attributes(tag: string): Attribute[] {
  const out: Attribute[] = []
  const open = /^<img\b/i.exec(tag)?.[0].length ?? 0
  ATTRIBUTE.lastIndex = open
  for (let m = ATTRIBUTE.exec(tag); m && m.index < tag.length - 1; m = ATTRIBUTE.exec(tag)) {
    const raw = m[2]
    if (raw === undefined) {
      out.push({ name: m[1].toLowerCase(), value: '', start: m.index + m[0].length, end: m.index + m[0].length })
      continue
    }
    const end = m.index + m[0].length
    out.push({
      name: m[1].toLowerCase(),
      value: /^["']/.test(raw) ? raw.slice(1, -1) : raw,
      start: end - raw.length,
      end,
    })
  }
  return out
}

function attr(tag: string, name: string): string | undefined {
  return attributes(tag).find((a) => a.name === name)?.value
}

/**
 * The tag with a new `src` value and nothing else touched.
 *
 * The old code did `tag.replace(srcValue, dataUri)` with a *string* needle,
 * which replaces the first occurrence of that text anywhere in the tag — so
 * `<img alt="logo.png" src="logo.png">` got the data URI written into its alt
 * while the remote src stayed, losing the image and leaving the document still
 * fetching from the network after the app called it self-contained.
 */
function withSrc(tag: string, uri: string): string {
  const src = attributes(tag).find((a) => a.name === 'src')
  if (!src) return tag
  return `${tag.slice(0, src.start)}"${uri}"${tag.slice(src.end)}`
}

/**
 * The image type of a fetched body, or null when it is not an image.
 *
 * The bytes decide first: a PNG served as text/plain is still a PNG, while a
 * login page, an error page or a JSON reply served with status 200 is not an
 * image, whatever its header says — embedded, it showed as the same empty box
 * a blocked remote image did. Formats without a sniffed signature (svg, avif,
 * bmp, ico) are taken on the header's word, unless the body opens like markup
 * when it should not.
 *
 * The header value also goes into an attribute, and `image/png"onerror="…` is
 * a legal Content-Type; only a plain type/subtype shape is ever written.
 */
export function fetchedImageType(contentType: string, bytes: Buffer): string | null {
  const sniffed = imageMime(bytes)
  if (sniffed) return sniffed
  const mime = contentType.split(';')[0].trim().toLowerCase()
  if (!/^image\/[\w.+-]+$/.test(mime)) return null
  const head = bytes.toString('utf8', 0, 512).trimStart().toLowerCase()
  if (mime === 'image/svg+xml') return /^(?:<\?xml|<!--|<!doctype svg|<svg)/.test(head) && head.includes('<svg') ? mime : null
  return head.startsWith('<') || head.startsWith('{') ? null : mime
}

/**
 * What an image that could not be inlined becomes: its alt text, in place, so
 * the reader can see that something was there and what it was. `text` is
 * inserted as HTML, so callers holding raw text must escape it first.
 *
 * `display: 'inline'` is for images that sit inside a paragraph (mammoth emits
 * docx images that way); a `<p>` there would nest a block inside a block.
 */
export function imagePlaceholder(text?: string, display: 'block' | 'inline' = 'block'): string {
  const body = `<em>[image: ${text || 'not included'}]</em>`
  return display === 'block' ? `<p>${body}</p>` : body
}

/**
 * Fetch each <img> (through the caller's guarded fetcher) and inline it as a
 * data URI. Every picture is fetched, however many there are; one that
 * fails, is not an image, or is over `maxPerImage` becomes its alt-text
 * placeholder.
 *
 * The pictures an SVG <img> names by address (`<image href="https://…">`)
 * are fetched the same way and put in the SVG as data URIs. One that is not
 * fetched keeps its address, and the SVG sanitizer, which every SVG passes
 * after this, writes it as its description.
 *
 * Fetches run FETCH_CONCURRENCY at a time, with progress after each.
 */
export async function inlineImages(
  html: string,
  baseUrl: string,
  fetchImage: ImageFetcher,
  maxPerImage: number = MAX_FETCHED_IMAGE_BYTES,
  onProgress?: (stage: string, percent?: number) => void,
  /** Which sources to touch; the rest are left exactly as they are. */
  select: (src: string) => boolean = () => true,
): Promise<string> {
  /** One picture to fetch, in document order. */
  interface Fetch {
    url?: string
    dataUri?: string
  }
  /** An <img> to fetch. */
  interface Entry {
    tag: string
    alt?: string
    fetch: Fetch
  }
  /** An SVG <img> naming pictures by address: each address as written, and its fetch. */
  interface SvgEntry {
    tag: string
    svg: string
    pictures: Map<string, Fetch>
  }
  const fetches: Fetch[] = []
  const entries: Entry[] = []
  const svgEntries: SvgEntry[] = []
  let wanted = 0
  const want = (src: string): Fetch => {
    const fetch: Fetch = {}
    fetches.push(fetch)
    try {
      fetch.url = new URL(src, baseUrl).href
      wanted++
    } catch {
      // Unresolvable: stays a placeholder.
    }
    return fetch
  }
  for (const tag of new Set(html.match(IMG_TAG) ?? [])) {
    const src = attr(tag, 'src')
    if (!src) continue
    if (src.startsWith('data:')) {
      const svg = decodeSvgDataUri(src)
      const urls = svg === null ? [] : [...new Set(svgImageUrls(svg))].filter(select)
      if (svg !== null && urls.length > 0) svgEntries.push({ tag, svg, pictures: new Map(urls.map((u) => [u, want(u)])) })
      continue
    }
    if (!select(src)) continue
    entries.push({ tag, alt: attr(tag, 'alt'), fetch: want(src) })
  }

  const queue = fetches.filter((e) => e.url)
  let done = 0
  const worker = async (): Promise<void> => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      try {
        const { bytes, contentType } = await fetchImage(e.url!)
        const mime = fetchedImageType(contentType, bytes)
        if (mime && bytes.byteLength <= maxPerImage) e.dataUri = `data:${mime};base64,${bytes.toString('base64')}`
      } catch {
        // Failed: stays a placeholder.
      }
      done++
      onProgress?.(`Fetched ${done} of ${wanted} image${wanted === 1 ? '' : 's'}`, (done / wanted) * 100)
    }
  }
  if (wanted > 0) {
    onProgress?.(`Fetching ${wanted} image${wanted === 1 ? '' : 's'}`, 0)
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, wanted) }, worker))
  }

  let out = html
  for (const e of entries) {
    out = out.split(e.tag).join(e.fetch.dataUri ? withSrc(e.tag, e.fetch.dataUri) : imagePlaceholder(e.alt))
  }
  for (const e of svgEntries) {
    const fetched = new Map<string, string>()
    for (const [src, f] of e.pictures) if (f.dataUri) fetched.set(src, f.dataUri)
    if (fetched.size > 0) out = out.split(e.tag).join(withSrc(e.tag, svgDataUri(withSvgImagePictures(e.svg, fetched))))
  }
  return out
}

/**
 * A source that would send the reader to the network.
 *
 * Decided by the WHATWG URL parser, resolved the way a rendered page resolves
 * it (against a local file), because that parser — not a regex — is what
 * Chromium uses: it strips tabs and newlines anywhere (`ht\tps://`), reads
 * backslashes as slashes (`\\host\share`), and resolves a protocol-relative
 * source to the page's scheme. Anything that does not land on a local
 * file: or a data: URL is remote — including a UNC share (see isUncFileUrl),
 * which on Windows is an SMB connection that hands the host the user's NTLM
 * hash. Plain relative paths name a file beside the document and are not remote.
 */
export function isRemoteImageSrc(src: string): boolean {
  let url: URL
  try {
    url = new URL(src, 'file:///document/')
  } catch {
    return false
  }
  if (url.protocol === 'data:') return false
  return url.protocol !== 'file:' || isUncFileUrl(url)
}

/**
 * A file: URL that Windows opens as a network share.
 *
 * A host is the obvious form (`file://host/share`), but not the only one: the
 * URL parser keeps `file:////host/share` — and a relative `////host/share`
 * resolved against a file: page — as an EMPTY host with a path of
 * `//host/share`, and Windows reads that path as `\\host\share`. Checking the
 * host alone let that form through. A local path never starts with `//`.
 */
export function isUncFileUrl(url: URL): boolean {
  return url.protocol === 'file:' && (url.hostname !== '' || url.pathname.startsWith('//'))
}

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Rewrite <img> elements as an HTML parser sees them, for the checks that keep
 * the network out.
 *
 * Those checks must agree with whoever acts on the markup next. html-to-docx
 * parses with htmlparser2 and fetches any src that merely CONTAINS an http(s)
 * URL, so a regex reading the string can be steered: in
 * `<img alt='a<b src="data:x"' src="https://evil/x.png">` a string match takes
 * the data: inside the alt (or no tag at all), while the parser takes the real
 * src and fetches it. Parsing here, and handing on the re-serialized result,
 * means the next parser sees exactly the attributes that were checked.
 *
 * `replace` gets each image's src ('' when it has none) and decoded alt, and
 * returns replacement HTML, or null to keep the image. Markup is only
 * re-serialized when something was replaced.
 */
export function replaceImages(html: string, replace: (src: string, alt: string | undefined) => string | null): string {
  if (!/<img/i.test(html)) return html
  const dom = parseDocument(html)
  let changed = false
  const visit = (nodes: Element['children']): void => {
    for (const node of [...nodes]) {
      if (!(node instanceof Element)) continue
      if (node.name === 'img') {
        const replacement = replace(node.attribs.src ?? '', node.attribs.alt)
        if (replacement === null) continue
        changed = true
        const fragment = parseDocument(replacement).children
        if (fragment.length === 0) {
          removeElement(node)
          continue
        }
        replaceElement(node, fragment[0])
        for (let i = 1; i < fragment.length; i++) append(fragment[i - 1], fragment[i])
        continue
      }
      visit(node.children)
    }
  }
  visit(dom.children)
  return changed ? render(dom, { encodeEntities: 'utf8' }) : html
}

/**
 * Whether any <img> in the html points at the network, as a parser reads it,
 * or is an SVG naming a picture there.
 */
export function hasRemoteImages(html: string): boolean {
  if (!/<img/i.test(html)) return false
  let found = false
  replaceImages(html, (src) => {
    if (found) return null
    if (isRemoteImageSrc(src)) found = true
    else {
      const svg = decodeSvgDataUri(src)
      if (svg !== null && svgImageUrls(svg).some(isRemoteImageSrc)) found = true
    }
    return null
  })
  return found
}

/**
 * Every remote <img> becomes its alt-text placeholder, without a request.
 *
 * For inputs whose images must not be fetched at all (an email's remote images
 * are how senders learn it was opened), and as the last word before a writer:
 * anything still remote there would be fetched by html-to-docx or Chromium
 * outside the guarded fetcher, or left in an output that claims to stand alone.
 */
export function dropRemoteImages(html: string): string {
  return replaceImages(html, (src, alt) =>
    isRemoteImageSrc(src) ? imagePlaceholder(alt ? escapeText(alt) : undefined) : null,
  )
}
