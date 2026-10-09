import { guardedFetch, type GuardedFetchDeps } from './net/guarded-fetch'
import {
  inlineImages,
  isRemoteImageSrc,
  hasRemoteImages,
  dropRemoteImages,
  DEFAULT_INLINE_BUDGET,
  type ImageFetcher,
} from './inline-images'
import { sanitizeToHub } from './allowlist'
import type { ReadContext, SourceFormat } from './types'

/**
 * One dead host should cost seconds rather than guardedFetch's 20s default.
 * There is no overall deadline: a paste or a conversion shows its progress
 * and the user decides when to stop waiting.
 */
const IMAGE_TIMEOUT_MS = 10_000

/**
 * Inputs whose remote images are never fetched. An email's remote images are
 * how its sender learns it was opened — and when, and from where — so a
 * converter must not open it on the user's behalf. Mail clients block them by
 * default for the same reason.
 */
const NO_FETCH_SOURCES: ReadonlySet<SourceFormat> = new Set<SourceFormat>(['eml', 'msg', 'mbox'])

function guardedImageFetcher(deps: GuardedFetchDeps, signal: AbortSignal | undefined, timeoutMs: number): ImageFetcher {
  return async (url) => {
    const res = await guardedFetch(url, deps, { signal, timeoutMs, maxBytes: DEFAULT_INLINE_BUDGET.maxPerImage })
    return { bytes: res.bytes, contentType: res.contentType }
  }
}

/**
 * Pasted clipboard HTML to hub HTML, with its images embedded.
 *
 * A copy from a web page carries no image bytes — only `<img src="https://...">`
 * pointing back at the site. The renderer's CSP (`img-src 'self' data:`) will
 * not load those, so they showed in the edit pane as empty boxes. Fetching them
 * here, through the same guarded fetcher and budget as a fetched web page,
 * gives the pane and the writers a data URI like every other input.
 *
 * Sanitized first, so only http(s) and data: sources are left to fetch, and
 * again after, so the result carries the same guarantee `sanitizeToHub` gives.
 * Clipboard HTML has no base URL: a relative source cannot be resolved and
 * becomes a placeholder, which still says more than an invisible box.
 */
export async function pastedHtmlToHub(
  html: string,
  deps: GuardedFetchDeps,
  ctx?: Pick<ReadContext, 'signal' | 'onProgress'>,
  imageTimeoutMs: number = IMAGE_TIMEOUT_MS,
): Promise<string> {
  const clean = sanitizeToHub(html)
  if (!/<img\b[^>]*\bsrc="(?!data:)/i.test(clean)) return clean
  // Aborting `signal` is "skip the rest", not "cancel the paste": the images
  // not yet fetched fail at once, become placeholders, and the paste opens.
  const fetcher = guardedImageFetcher(deps, ctx?.signal, imageTimeoutMs)
  return sanitizeToHub(await inlineImages(clean, 'about:blank', fetcher, DEFAULT_INLINE_BUDGET, ctx?.onProgress))
}

/**
 * A read document's remote images, embedded — or, where they must not be
 * fetched, replaced by their alt text.
 *
 * Runs once at the read boundary so no writer ever sees a remote image: left
 * in place, html-to-docx and Chromium's print window each fetched them with
 * no SSRF guard or size limit, a single dead host failed a whole docx, and the
 * html, slide and e-book outputs depended on a third-party site staying up.
 *
 * Without `deps` nothing is fetched and remote images become placeholders, the
 * same outcome a write would give them anyway.
 */
export async function resolveRemoteImages(
  html: string,
  source: SourceFormat,
  deps: GuardedFetchDeps | undefined,
  ctx?: Pick<ReadContext, 'signal' | 'onProgress'>,
  imageTimeoutMs: number = IMAGE_TIMEOUT_MS,
): Promise<string> {
  if (!hasRemoteImages(html)) return html
  if (!deps || NO_FETCH_SOURCES.has(source)) return dropRemoteImages(html)
  const fetcher = guardedImageFetcher(deps, ctx?.signal, imageTimeoutMs)
  // Only remote sources are selected, so the base only ever supplies a scheme
  // for a protocol-relative one; relative paths are left for the writers.
  return inlineImages(html, 'https://unresolved.invalid/', fetcher, DEFAULT_INLINE_BUDGET, ctx?.onProgress, isRemoteImageSrc)
}
