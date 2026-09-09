export interface ImageFetcher {
  (url: string): Promise<{ bytes: Buffer; contentType: string }>
}

export interface InlineBudget {
  maxImages: number
  maxPerImage: number
  maxTotal: number
}

export const DEFAULT_INLINE_BUDGET: InlineBudget = {
  maxImages: 20,
  maxPerImage: 2 * 1024 * 1024,
  maxTotal: 10 * 1024 * 1024,
}

/**
 * Generous, because it is only there to stop the tag text itself from being the
 * bomb: a hundred thousand one-byte images cost almost nothing in image bytes
 * but sixty bytes of markup each. The largest deck in the corpus carries 83.
 */
const ARCHIVE_MAX_IMAGES = 1000

/**
 * The budget for images that arrive inside the source file — a pptx or docx zip
 * — rather than over the network.
 *
 * DEFAULT_INLINE_BUDGET is the ceiling a fetched web page gets, and an archive
 * may never be allowed less than that; what it may be allowed *more* of is
 * bounded by the file the user actually opened. Every real document in the
 * corpus carries between 0.93 and 0.99 bytes of decoded image per byte of file
 * (photographs and screenshots are already compressed, so the zip barely shrinks
 * them), while the intake this exists for — a 39 KB deck of twelve 3 MB
 * single-colour PNGs — carries 1200. Twice the file's own size therefore leaves
 * every honest document untouched and still refuses the bomb.
 *
 * Counts and per-image caps are deliberately NOT taken from
 * DEFAULT_INLINE_BUDGET: its 20 images and 10 MB total are the right price for
 * fetching attacker-chosen URLs one network round trip at a time, but applied to
 * a zip they would strip 63 of the 83 figures out of the corpus training manual
 * and 40 of the 60 out of another — degrading ordinary documents, which is the
 * one thing this guard must not do. Inside an archive the bytes are the only
 * cost, so the total is what is policed.
 */
export function archiveInlineBudget(sourceByteLength: number): InlineBudget {
  const maxTotal = Math.max(DEFAULT_INLINE_BUDGET.maxTotal, sourceByteLength * 2)
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
 * A media type fit to be written into an attribute. The value comes off the
 * wire; `image/png"onerror="…` is a legal Content-Type header and would have
 * closed the attribute early. Anything not shaped like a type/subtype falls
 * back to png, which every consumer sniffs past anyway.
 */
function safeMime(contentType: string): string {
  const mime = contentType.split(';')[0].trim()
  return /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'image/png'
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
 */
export async function inlineImages(
  html: string,
  baseUrl: string,
  fetchImage: ImageFetcher,
  budget: InlineBudget = DEFAULT_INLINE_BUDGET,
  onProgress?: (stage: string, percent?: number) => void,
): Promise<string> {
  const tags = [...new Set(html.match(IMG_TAG) ?? [])]
  interface Entry {
    tag: string
    alt?: string
    dataUri?: string
    size: number
  }
  const entries: Entry[] = []
  let fetched = 0

  for (const tag of tags) {
    const src = attr(tag, 'src')
    const alt = attr(tag, 'alt')
    if (!src || src.startsWith('data:')) continue
    if (fetched >= budget.maxImages) {
      entries.push({ tag, alt, size: 0 })
      continue
    }
    fetched++
    onProgress?.(`Fetching image ${fetched}`, undefined)
    let resolved: string
    try {
      resolved = new URL(src, baseUrl).href
    } catch {
      entries.push({ tag, alt, size: 0 })
      continue
    }
    try {
      const { bytes, contentType } = await fetchImage(resolved)
      if (bytes.byteLength > budget.maxPerImage) {
        entries.push({ tag, alt, size: 0 })
        continue
      }
      const mime = safeMime(contentType)
      entries.push({ tag, alt, dataUri: `data:${mime};base64,${bytes.toString('base64')}`, size: bytes.byteLength })
    } catch {
      entries.push({ tag, alt, size: 0 })
    }
  }

  // Largest-first eviction until the total inlined bytes fit the budget.
  let total = entries.reduce((n, e) => n + e.size, 0)
  const bySize = [...entries].sort((a, b) => b.size - a.size)
  for (const e of bySize) {
    if (total <= budget.maxTotal) break
    if (e.dataUri) {
      total -= e.size
      e.dataUri = undefined
    }
  }

  let out = html
  for (const e of entries) {
    out = out.split(e.tag).join(e.dataUri ? withSrc(e.tag, e.dataUri) : imagePlaceholder(e.alt))
  }
  return out
}
