import { escapeHtml } from '../shell'

export interface EmailMeta {
  from?: string
  to?: string
  cc?: string
  date?: string
  subject?: string
}

export function renderEmailHeader(meta: EmailMeta): string {
  const rows: string[] = []
  const add = (label: string, value?: string): void => {
    if (value && value.trim()) rows.push(`<tr><td>${label}</td><td>${escapeHtml(value)}</td></tr>`)
  }
  add('From', meta.from)
  add('To', meta.to)
  add('Cc', meta.cc)
  add('Date', meta.date)
  add('Subject', meta.subject)
  return rows.length ? `<table><tbody>${rows.join('')}</tbody></table>` : ''
}

export function renderAttachmentList(attachments: { name: string; size?: number }[]): string {
  if (attachments.length === 0) return ''
  const rows = attachments
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.name)}</td><td>${a.size != null ? `${a.size} bytes` : ''}</td></tr>`,
    )
    .join('')
  return `<h3>Attachments (not converted)</h3><table><tbody>${rows}</tbody></table>`
}

export function textToParagraphs(text: string): string {
  const blocks = text.split(/\r?\n\r?\n+/).filter((b) => b.trim().length > 0)
  return blocks.map((b) => `<p>${escapeHtml(b.trim()).replace(/\r?\n/g, '<br>')}</p>`).join('\n')
}

/** A part of a message a body may name by `cid:` (an inline picture), as both mail readers have it. */
export interface CidPart {
  contentId?: string
  mime: string
  bytes: Buffer
}

/** How deep an SVG part's own `cid:` pictures are followed (as the SVG sanitizer nests, MAX_NESTING). */
const CID_DEPTH = 4

/** A `cid:` URL's Content-ID: the part after the scheme, %-decoded (RFC 2392), without angle brackets. */
function cidOf(url: string): string {
  const id = url.trim().replace(/^cid:/i, '')
  try {
    return decodeURIComponent(id).replace(/^<|>$/g, '')
  } catch {
    return id.replace(/^<|>$/g, '')
  }
}

const PICTURE_TAG = /<(?:img|(?:svg:)?image)\b[^>]*>/gi
const CID_ATTRIBUTE = /(\s(?:src|href|xlink:href)\s*=\s*)(["'])\s*(cid:[^"']*)\2/gi

/**
 * Each picture a message body names by `cid:` - an `<img src>`, and an SVG's
 * `<image href>` or `xlink:href`, drawn in the body or in an SVG part itself
 * - as a data URI of the part with that Content-ID. Matched as RFC 2392 says
 * (%-decoded; the case of a Content-ID is its own, though another case is
 * taken when nothing matches exactly), per attribute, so `cid:plan1` never
 * catches `cid:plan10`. An SVG part's own `cid:` pictures are resolved the
 * same way, CID_DEPTH deep, never inside itself. One with no part is left
 * as it is, for the sanitizer to make its alt text.
 */
export function inlineCidPictures(html: string, parts: CidPart[]): string {
  if (!/cid:/i.test(html)) return html
  const exact = new Map<string, CidPart>()
  const loose = new Map<string, CidPart>()
  for (const part of parts) {
    const id = part.contentId?.trim().replace(/^<|>$/g, '')
    if (!id || part.bytes.length === 0) continue
    if (!exact.has(id)) exact.set(id, part)
    if (!loose.has(id.toLowerCase())) loose.set(id.toLowerCase(), part)
  }
  if (exact.size === 0) return html
  const uris = new Map<CidPart, string>()
  const uri = (part: CidPart, within: Set<CidPart>): string | null => {
    const svg = part.mime === 'image/svg+xml'
    if (svg && (within.has(part) || within.size >= CID_DEPTH)) return null
    if (!svg && uris.has(part)) return uris.get(part)!
    const bytes = svg ? Buffer.from(resolve(part.bytes.toString('utf8'), new Set([...within, part])), 'utf8') : part.bytes
    const out = `data:${part.mime};base64,${bytes.toString('base64')}`
    if (!svg) uris.set(part, out)
    return out
  }
  const resolve = (text: string, within: Set<CidPart>): string =>
    text.replace(PICTURE_TAG, (tag) =>
      tag.replace(CID_ATTRIBUTE, (m, lead: string, quote: string, url: string) => {
        const id = cidOf(url)
        const part = exact.get(id) ?? loose.get(id.toLowerCase())
        const src = part ? uri(part, within) : null
        return src ? `${lead}${quote}${src}${quote}` : m
      }),
    )
  return resolve(html, new Set())
}
