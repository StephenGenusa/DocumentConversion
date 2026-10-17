import { guardedFetch, type GuardedFetchDeps } from './net/guarded-fetch'
import {
  inlineImages,
  isRemoteImageSrc,
  hasRemoteImages,
  dropRemoteImages,
  MAX_FETCHED_IMAGE_BYTES,
  type ImageFetcher,
} from './inline-images'
import { sanitizeToHub } from './allowlist'
import { guessCodeLanguages } from './code-language'
import { tagPastedCodeBlocks } from './readers/html'
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
 * default for the same reason. A calendar invitation arrives by mail and its
 * HTML description carries the same kind of tracking image.
 */
export const NO_FETCH_SOURCES: ReadonlySet<SourceFormat> = new Set<SourceFormat>(['eml', 'msg', 'mbox', 'ics'])

/** What fetching a document's pictures is given: cancellation, progress, the notice, and Settings → Web. */
export type PictureFetchContext = Pick<ReadContext, 'signal' | 'onProgress' | 'onAdvice' | 'web'>

function guardedImageFetcher(deps: GuardedFetchDeps, ctx: PictureFetchContext | undefined, timeoutMs?: number): ImageFetcher {
  const allowPrivate = ctx?.web?.allowLocalNetwork !== false
  return async (url) => {
    const res = await guardedFetch(url, deps, { signal: ctx?.signal, timeoutMs, maxBytes: MAX_FETCHED_IMAGE_BYTES, allowPrivate })
    return { bytes: res.bytes, contentType: res.contentType }
  }
}

/** Whether Settings → Web leaves web pictures unfetched for this read. */
export function fetchingOff(ctx: PictureFetchContext | undefined): boolean {
  return ctx?.web?.fetchPictures === false
}

/** The one notice a read with fetching off gives (spec principle 3: nothing is dropped silently). */
export function notFetchedNotice(count: number): string {
  return `${count} web picture${count === 1 ? ' was' : 's were'} not fetched (Settings → Web)`
}

/**
 * Every picture `inlineImages` would have fetched, left unfetched: each <img>
 * becomes its description, as a picture that failed to arrive does, and a
 * picture an SVG names by address is written as its description by the SVG
 * sanitizer. Nothing touches the network. The count, if any, goes out as one
 * notice.
 */
export async function withoutFetching(
  html: string,
  baseUrl: string,
  ctx: PictureFetchContext | undefined,
  select?: (src: string) => boolean,
): Promise<string> {
  let count = 0
  const refuse: ImageFetcher = async () => {
    count++
    throw new Error('not fetched')
  }
  const out = await inlineImages(html, baseUrl, refuse, MAX_FETCHED_IMAGE_BYTES, undefined, select)
  if (count > 0) ctx?.onAdvice?.('pictures-not-fetched', notFetchedNotice(count))
  return out
}

/**
 * Pasted clipboard HTML to hub HTML, with its images embedded.
 *
 * A copy from a web page carries no image bytes — only `<img src="https://...">`
 * pointing back at the site. The renderer's CSP (`img-src 'self' data:`) will
 * not load those, so they showed in the edit pane as empty boxes. Fetching them
 * here, through the same guarded fetcher and limits as a fetched web page,
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
  ctx?: PictureFetchContext,
  imageTimeoutMs: number = IMAGE_TIMEOUT_MS,
): Promise<string> {
  // A copied code block keeps (or is given) its language here, so the edit
  // pane holds it and every writer highlights it (code-language.ts).
  const clean = guessCodeLanguages(sanitizeToHub(tagPastedCodeBlocks(html)))
  if (!/<img\b[^>]*\bsrc="(?!data:)/i.test(clean)) return clean
  if (fetchingOff(ctx)) return sanitizeToHub(await withoutFetching(clean, 'about:blank', ctx))
  // Aborting `signal` is "skip the rest", not "cancel the paste": the images
  // not yet fetched fail at once, become placeholders, and the paste opens.
  const fetcher = guardedImageFetcher(deps, ctx, imageTimeoutMs)
  return sanitizeToHub(await inlineImages(clean, 'about:blank', fetcher, MAX_FETCHED_IMAGE_BYTES, ctx?.onProgress))
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
 * same outcome a write would give them anyway. With fetching off in Settings
 * (`ctx.web`) they become placeholders too, with one notice saying how many;
 * mail and invitations never fetch and give no notice, as before.
 */
export async function resolveRemoteImages(
  html: string,
  source: SourceFormat,
  deps: GuardedFetchDeps | undefined,
  ctx?: PictureFetchContext,
  imageTimeoutMs: number = IMAGE_TIMEOUT_MS,
): Promise<string> {
  if (!hasRemoteImages(html)) return html
  if (NO_FETCH_SOURCES.has(source)) return dropRemoteImages(html)
  // Only remote sources are selected, so the base only ever supplies a scheme
  // for a protocol-relative one; relative paths are left for the writers.
  const base = 'https://unresolved.invalid/'
  if (fetchingOff(ctx)) return withoutFetching(html, base, ctx, isRemoteImageSrc)
  if (!deps) return dropRemoteImages(html)
  const fetcher = guardedImageFetcher(deps, ctx, imageTimeoutMs)
  return inlineImages(html, base, fetcher, MAX_FETCHED_IMAGE_BYTES, ctx?.onProgress, isRemoteImageSrc)
}
