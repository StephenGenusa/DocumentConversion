import JSZip from 'jszip'
import { ConversionError } from '../errors'
import { sanitizeToHub } from '../allowlist'
import { escapeHtml } from '../shell'
import type { HubDocument, SourceInput } from '../types'

/**
 * A manifest/spine href is a URI reference, not a filename: OPF authors write
 * `chapter%201.xhtml` for a file called "chapter 1.xhtml", and every non-ASCII
 * title in a book produced outside an English toolchain arrives escaped the
 * same way. Looking the raw string up in the zip simply misses.
 *
 * Decoding can itself be wrong, though — `100%.xhtml` is a legal zip entry
 * name and decodeURIComponent throws on it — so both spellings are candidates
 * and the zip decides which one exists. Shared with inlineChapterImages, whose
 * own decode used to be unguarded — `<img src="100%.jpg">` threw a raw URIError
 * out of readEpub and one legally-named picture failed the whole book.
 */
function pathCandidates(href: string): string[] {
  const raw = href.split('#')[0]
  const candidates = [raw]
  try {
    const decoded = decodeURIComponent(raw)
    if (decoded !== raw) candidates.push(decoded)
  } catch {
    // Malformed escape: the href was never percent-encoding, so the raw name
    // is the only spelling there is.
  }
  return candidates
}

/** Manifest items that were supposed to be chapters, so a miss is worth saying. */
const DOCUMENT_MEDIA_TYPE = /^(application\/xhtml\+xml|text\/html)$/i

/**
 * Said in the document itself when a chapter the book promises is not in the
 * zip. A book quietly one chapter short is the worst thing this converter can
 * produce: the output looks complete and nothing anywhere says otherwise. The
 * reader has no advice channel of its own (ReadContext.onAdvice names a closed
 * set of kinds), and an in-band notice cannot be lost on the way out anyway —
 * it survives into txt, md, docx, pdf and epub alike.
 */
function missingChapterNotice(what: string): string {
  return `<p>[Missing chapter: ${escapeHtml(what)} — this file is named by the EPUB but is not inside it.]</p>`
}

function resolveRelative(base: string, href: string): string {
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''
  const joined = `${dir}${href}`.replace(/\/\.\//g, '/')
  // Collapse any ../ segments the OPF may use.
  const parts: string[] = []
  for (const segment of joined.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/**
 * Chapter images are zip-relative (`../images/fig.png`), which nothing
 * downstream can resolve: they were lost in every target, and html-to-docx
 * choked on them badly enough to truncate a whole book to its table of
 * contents. Embed them as data URIs, resolved against the chapter's path.
 */
async function inlineChapterImages(html: string, chapterPath: string, zip: JSZip): Promise<string> {
  if (!html.includes('<img')) return html
  const replacements = new Map<string, string>()
  const SRC = /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi
  for (const match of html.matchAll(SRC)) {
    const src = match[2]
    if (replacements.has(src) || /^(data|https?):/i.test(src)) continue
    let resolved: { target: string; entry: JSZip.JSZipObject } | undefined
    for (const candidate of pathCandidates(src)) {
      const target = resolveRelative(chapterPath, candidate)
      const entry = zip.files[target]
      if (entry) {
        resolved = { target, entry }
        break
      }
    }
    if (!resolved) continue
    const ext = /\.([a-z0-9]+)$/i.exec(resolved.target)?.[1]?.toLowerCase() ?? ''
    const mime = IMAGE_MIME[ext]
    if (!mime) continue
    const bytes = Buffer.from(await resolved.entry.async('nodebuffer'))
    replacements.set(src, `data:${mime};base64,${bytes.toString('base64')}`)
  }
  // Rewrite the src attribute itself, not every quoted string that happens to
  // equal it — an alt with the same text used to get a data URI written in.
  return html.replace(SRC, (whole, open: string, src: string, close: string) => {
    const dataUri = replacements.get(src)
    return dataUri ? `${open}${dataUri}${close}` : whole
  })
}

/** A link target that still means something once the book is one document. */
const RESOLVABLE_LINK = /^(https?|mailto):/i

/**
 * Unwrap the links that can no longer go anywhere, keeping their text.
 *
 * A book's chapters are separate files in the zip and cross-refer to each other
 * (`href="p8chap1.xhtml#chap-016"`). Concatenating the spine into one hub
 * document leaves those hrefs aimed at files that exist nowhere — and at
 * anchors that are gone as well, because the hub allowlist carries no `id`, so
 * one corpus chapter's 73 targets were all stripped while 260 links survived.
 * A relative href then resolves against whatever directory the OUTPUT sits in,
 * which is how a book's cross-references turned into links into the
 * converter's own temporary files.
 *
 * So the choice is between a link that silently points at the wrong thing and
 * no link at all, and this project has settled that one repeatedly: the text is
 * content and is kept, the dead affordance is not. Same-document fragments go
 * too, for the same reason — the allowlist strips what they aim at.
 *
 * Making them work instead would mean carrying `id` through the hub, which is
 * a change to the shared allowlist and to the invariant that everything it
 * passes round-trips the editor losslessly. That is recorded in
 * remaining_work.md as a decision for the owner, not one to make here.
 */
export function dropUnresolvableLinks(html: string): string {
  if (!html.includes('<a')) return html
  // Nested anchors are not legal HTML, so the first href in the match is the
  // opening tag's and the first </a> closes it.
  return html.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (whole, inner: string) => {
    const href = /\bhref="([^"]*)"/i.exec(whole)?.[1]
    return href && RESOLVABLE_LINK.test(href) ? whole : inner
  })
}

export async function readEpub(src: SourceInput): Promise<HubDocument> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(src.bytes)
  } catch (err) {
    throw new ConversionError('read-failed', `Could not read EPUB: ${(err as Error).message}`)
  }
  const containerFile = zip.files['META-INF/container.xml']
  if (!containerFile) throw new ConversionError('read-failed', 'Not an EPUB (missing META-INF/container.xml)')
  const container = await containerFile.async('string')
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1]
  if (!opfPath || !zip.files[opfPath]) {
    throw new ConversionError('read-failed', 'EPUB package document (.opf) not found')
  }
  const opf = await zip.files[opfPath].async('string')

  // manifest id -> href + media-type, then read chapters in spine order.
  const manifest = new Map<string, { href: string; mediaType: string }>()
  for (const m of opf.matchAll(/<item\b[^>]*\/?>/g)) {
    const tag = m[0]
    const id = /\bid="([^"]+)"/.exec(tag)?.[1]
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1]
    const mediaType = /\bmedia-type="([^"]+)"/.exec(tag)?.[1] ?? ''
    if (id && href) manifest.set(id, { href, mediaType })
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1])
  const order = spine.length > 0 ? spine : [...manifest.keys()]

  const sections: string[] = []
  const missing: string[] = []
  let chapters = 0
  for (const id of order) {
    const item = manifest.get(id)
    if (!item) {
      // A spine itemref naming an id the manifest does not define is a chapter
      // the book promises and cannot deliver. Only the spine can be wrong this
      // way, so this never fires on the manifest-order fallback.
      missing.push(`spine item "${id}"`)
      sections.push(missingChapterNotice(`spine item "${id}"`))
      continue
    }
    const candidates = pathCandidates(item.href).map((p) => resolveRelative(opfPath, p))
    const path = candidates.find((p) => zip.files[p])
    const isDocument =
      DOCUMENT_MEDIA_TYPE.test(item.mediaType) || candidates.some((p) => /\.x?html?$/i.test(p))
    if (!path) {
      // Stylesheets, fonts, cover images and the ncx are all manifest items
      // too; only a missing DOCUMENT is a missing chapter.
      if (isDocument) {
        missing.push(candidates[0])
        sections.push(missingChapterNotice(candidates[0]))
      }
      continue
    }
    if (!isDocument) continue
    const file = zip.files[path]
    const raw = await file.async('string')
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(raw)?.[1] ?? raw
    // After sanitizing, so attribute quoting is already normalized.
    const clean = dropUnresolvableLinks(sanitizeToHub(await inlineChapterImages(body, path, zip)))
    if (clean.trim()) {
      sections.push(clean)
      chapters++
    }
  }
  if (chapters === 0) {
    const detail = missing.length > 0 ? ` (missing: ${missing.slice(0, 5).join(', ')})` : ''
    throw new ConversionError('read-failed', `EPUB contains no readable chapters${detail}`)
  }

  const title =
    /<dc:title[^>]*>([^<]+)<\/dc:title>/i.exec(opf)?.[1]?.trim() || src.filename?.split(/[\\/]/).pop()
  return { html: sections.join('\n'), title }
}
