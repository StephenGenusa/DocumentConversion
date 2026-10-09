import { parseDocument } from 'htmlparser2'
import { append, removeElement, replaceElement } from 'domutils'
import { Element } from 'domhandler'
import render from 'dom-serializer'
import { imageMime } from './readers/image'

export interface ImageFetcher {
  (url: string): Promise<{ bytes: Buffer; contentType: string }>
}

export interface InlineBudget {
  maxImages: number
  maxPerImage: number
  maxTotal: number
}

/**
 * The budget for images fetched over the network: a fetched page, a paste, and
 * a document's remote images at read time.
 *
 * Every one of those is something the user chose — a page they asked for,
 * content they copied from a page their browser had already loaded — so the
 * count is not a defence against anyone; memory is bounded by maxTotal (see
 * inlineImages) and time by the per-image timeout and the user's Cancel.
 * A hundred covers a long illustrated article; 25 MB is a few dozen photos.
 */
export const DEFAULT_INLINE_BUDGET: InlineBudget = {
  maxImages: 100,
  maxPerImage: 2 * 1024 * 1024,
  maxTotal: 25 * 1024 * 1024,
}

/** Images downloaded at once. Enough to hide latency, few enough to be polite to one host. */
const FETCH_CONCURRENCY = 4

/**
 * Generous, because it is only there to stop the tag text itself from being the
 * bomb: a hundred thousand one-byte images cost almost nothing in image bytes
 * but sixty bytes of markup each. The largest deck in the corpus carries 83.
 */
const ARCHIVE_MAX_IMAGES = 1000

/**
 * The least an archive is allowed, however small the file. Not tied to
 * DEFAULT_INLINE_BUDGET: an honest file carries about a byte of image per
 * byte of file, so twice its size covers it and this floor only matters for a
 * tiny file — which is exactly the bomb's shape. Raising it lets a 40 KB file
 * expand to that many megabytes of hub.
 */
const ARCHIVE_MIN_TOTAL = 10 * 1024 * 1024

/**
 * The budget for images that arrive inside the source file — a pptx or docx zip
 * — rather than over the network.
 *
 * Every archive gets at least ARCHIVE_MIN_TOTAL; what it may be allowed *more*
 * of is bounded by the file the user actually opened. Every real document in the
 * corpus carries between 0.93 and 0.99 bytes of decoded image per byte of file
 * (photographs and screenshots are already compressed, so the zip barely shrinks
 * them), while the intake this exists for — a 39 KB deck of twelve 3 MB
 * single-colour PNGs — carries 1200. Twice the file's own size therefore leaves
 * every honest document untouched and still refuses the bomb.
 *
 * Counts and per-image caps are deliberately NOT taken from
 * DEFAULT_INLINE_BUDGET: they are set for network fetches, where each image is
 * a round trip, and applied to a zip they would strip figures out of ordinary
 * documents (the corpus training manual carries 83, a deck 60) — degrading
 * them, which is the one thing this guard must not do. Inside an archive the
 * bytes are the only cost, so the total is what is policed.
 */
export function archiveInlineBudget(sourceByteLength: number): InlineBudget {
  const maxTotal = Math.max(ARCHIVE_MIN_TOTAL, sourceByteLength * 2)
  // The total already bounds any single image; a second, smaller per-image cap
  // would only drop the one big photograph a legitimate document is allowed.
  return { maxImages: ARCHIVE_MAX_IMAGES, maxPerImage: maxTotal, maxTotal }
}

/**
 * Tracks what a budget has left, in document order.
 *
 * Order is the whole policy: an early figure is worth more than a late one, and
 * a reader cannot hold every image in memory to evict the largest afterwards —
 * that is the memory cost the budget exists to avoid. (inlineImages below can
 * afford largest-first eviction because it has already paid for every fetch.)
 */
export interface ImageLedger {
  /** Whether an image of this size would be admitted — charging nothing. */
  fits(byteLength: number): boolean
  /** Whether it is admitted, charging the budget when it is. */
  admit(byteLength: number): boolean
}

export function createImageLedger(budget: InlineBudget): ImageLedger {
  let count = 0
  let spent = 0
  const fits = (byteLength: number): boolean =>
    count < budget.maxImages && byteLength <= budget.maxPerImage && spent + byteLength <= budget.maxTotal
  return {
    fits,
    admit(byteLength: number): boolean {
      if (!fits(byteLength)) return false
      count++
      spent += byteLength
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
 * Tokenised left to right rather than searched for by name: a name-anchored
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
 * data URI. Over-budget or failed images degrade to alt-text placeholders;
 * when the TOTAL exceeds the budget, the largest images are evicted first.
 *
 * Fetches run FETCH_CONCURRENCY at a time, and eviction happens as each image
 * lands rather than after the last one: holding every image until the end
 * made peak memory maxImages × maxPerImage (200 MB at a hundred images) for a
 * result that may only keep maxTotal. Now it never holds more than maxTotal
 * plus the images in flight.
 */
export async function inlineImages(
  html: string,
  baseUrl: string,
  fetchImage: ImageFetcher,
  budget: InlineBudget = DEFAULT_INLINE_BUDGET,
  onProgress?: (stage: string, percent?: number) => void,
  /** Which sources to touch; the rest are left exactly as they are. */
  select: (src: string) => boolean = () => true,
): Promise<string> {
  interface Entry {
    tag: string
    alt?: string
    url?: string
    dataUri?: string
    size: number
  }
  const entries: Entry[] = []
  let wanted = 0
  for (const tag of new Set(html.match(IMG_TAG) ?? [])) {
    const src = attr(tag, 'src')
    if (!src || src.startsWith('data:') || !select(src)) continue
    const entry: Entry = { tag, alt: attr(tag, 'alt'), size: 0 }
    entries.push(entry)
    if (wanted >= budget.maxImages) continue
    try {
      entry.url = new URL(src, baseUrl).href
      wanted++
    } catch {
      // Unresolvable: stays a placeholder.
    }
  }

  const queue = entries.filter((e) => e.url)
  let total = 0
  let done = 0
  const admit = (e: Entry, dataUri: string, size: number): void => {
    e.dataUri = dataUri
    e.size = size
    total += size
    // Largest-first, possibly the one just admitted.
    while (total > budget.maxTotal) {
      let largest: Entry | undefined
      for (const x of entries) if (x.dataUri && (!largest || x.size > largest.size)) largest = x
      if (!largest) break
      total -= largest.size
      largest.dataUri = undefined
      largest.size = 0
    }
  }
  const worker = async (): Promise<void> => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      try {
        const { bytes, contentType } = await fetchImage(e.url!)
        const mime = fetchedImageType(contentType, bytes)
        if (mime && bytes.byteLength <= budget.maxPerImage) {
          admit(e, `data:${mime};base64,${bytes.toString('base64')}`, bytes.byteLength)
        }
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
    out = out.split(e.tag).join(e.dataUri ? withSrc(e.tag, e.dataUri) : imagePlaceholder(e.alt))
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
 * source to the page's scheme. Anything that does not land on a host-less
 * file: or a data: URL is remote — including `file://host/share`, which on
 * Windows is an SMB connection that hands the host the user's NTLM hash.
 * Plain relative paths name a file beside the document and are not remote.
 */
export function isRemoteImageSrc(src: string): boolean {
  let url: URL
  try {
    url = new URL(src, 'file:///document/')
  } catch {
    return false
  }
  if (url.protocol === 'data:') return false
  return url.protocol !== 'file:' || url.hostname !== ''
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

/** Whether any <img> in the html points at the network, as a parser reads it. */
export function hasRemoteImages(html: string): boolean {
  if (!/<img/i.test(html)) return false
  let found = false
  replaceImages(html, (src) => {
    if (isRemoteImageSrc(src)) found = true
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
