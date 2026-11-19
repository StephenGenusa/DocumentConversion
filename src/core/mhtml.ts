/**
 * A web page saved as one file (.mhtml, .mht): a MIME multipart/related
 * message whose first text/html part is the page and whose other parts are
 * the files it names, each under its address (Content-Location) or its
 * Content-ID. Chromium ("Saved by Blink"), Internet Explorer and Word write
 * them. Pure: bytes in, the page and its parts out.
 */

export interface MhtmlPart {
  mime: string
  charset?: string
  /** The address the page names the part by, as written. */
  location?: string
  /** Without angle brackets. */
  contentId?: string
  bytes: Buffer
}

export interface MhtmlPage {
  /** The page itself: the first text/html part. */
  html: MhtmlPart
  /** Every other part, in the file's order. */
  parts: MhtmlPart[]
}

/** How deep one multipart may sit inside another (Word nests multipart/alternative). */
const MAX_DEPTH = 4

interface Entity {
  headers: Map<string, string>
  body: string
}

/** Headers and body of one MIME entity, from text read as latin1 (one character per byte). */
function splitEntity(text: string): Entity {
  const end = /\r?\n\r?\n/.exec(text)
  // A part with no blank line is all headers when it opens with one, else all body.
  const head = end ? text.slice(0, end.index) : /^[A-Za-z][A-Za-z0-9-]*:/.test(text) ? text : ''
  const body = end ? text.slice(end.index + end[0].length) : head ? '' : text
  const headers = new Map<string, string>()
  // A line that opens with a space or a tab continues the header before it.
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line)
    if (m && !headers.has(m[1].toLowerCase())) headers.set(m[1].toLowerCase(), m[2].trim())
  }
  return { headers, body }
}

function parameter(header: string, name: string): string | undefined {
  const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(header)
  return m ? (m[1] ?? m[2]) : undefined
}

function decodeBody(body: string, encoding: string): Buffer {
  switch (encoding.toLowerCase()) {
    case 'base64':
      return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
    case 'quoted-printable':
      return Buffer.from(
        body
          .replace(/[ \t]+(?=\r?\n)/g, '')
          .replace(/=\r?\n/g, '')
          .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
        'latin1',
      )
    default:
      return Buffer.from(body, 'latin1')
  }
}

/** The parts between a multipart's boundary lines; what follows the closing one is not a part. */
function splitParts(body: string, boundary: string): string[] {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const line = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g')
  const parts: string[] = []
  let start = -1
  for (const m of body.matchAll(line)) {
    if (start >= 0) parts.push(body.slice(start, m.index))
    if (m[1]) return parts
    start = m.index + m[0].length
    start += body.startsWith('\r\n', start) ? 2 : body.startsWith('\n', start) ? 1 : 0
  }
  // No closing line: a file cut short still gives the part it was in.
  if (start >= 0 && start < body.length) parts.push(body.slice(start))
  return parts
}

function collect(text: string, depth: number, out: MhtmlPart[]): void {
  const { headers, body } = splitEntity(text)
  const type = headers.get('content-type') ?? 'text/plain'
  const mime = type.split(';')[0].trim().toLowerCase()
  if (mime.startsWith('multipart/')) {
    const boundary = parameter(type, 'boundary')
    if (!boundary || depth >= MAX_DEPTH) return
    for (const part of splitParts(body, boundary)) collect(part, depth + 1, out)
    return
  }
  out.push({
    mime,
    charset: parameter(type, 'charset'),
    location: headers.get('content-location') || undefined,
    contentId: headers.get('content-id')?.replace(/^<|>$/g, '') || undefined,
    bytes: decodeBody(body, headers.get('content-transfer-encoding') ?? '7bit'),
  })
}

/**
 * The page and its parts, or null for bytes that are not a saved page: no
 * MIME multipart at the top, or no text/html part in it. Only the head of the
 * file is looked at before deciding, so a plain HTML file costs nothing.
 */
export function unpackMhtml(bytes: Buffer): MhtmlPage | null {
  const head = bytes.toString('latin1', 0, 4096).replace(/^﻿|^\xef\xbb\xbf/, '')
  if (!/^[A-Za-z][A-Za-z0-9-]*:/.test(head) || !/^Content-Type:\s*multipart\//im.test(head)) return null
  const parts: MhtmlPart[] = []
  collect(bytes.toString('latin1').replace(/^\xef\xbb\xbf/, ''), 0, parts)
  const index = parts.findIndex((p) => p.mime === 'text/html')
  if (index < 0) return null
  return { html: parts[index], parts: parts.filter((_, i) => i !== index) }
}

/**
 * Repeats of a picture already put in the page draw on a budget of this many
 * times the saved page's own size, plus REPEAT_FLOOR, so a file that names one
 * large picture thousands of times cannot grow into gigabytes of data URIs.
 * A picture's first use is never counted, so a real page keeps every picture.
 */
const REPEAT_FACTOR = 2
const REPEAT_FLOOR = 8 * 1024 * 1024

const PICTURE_TAG = /<(?:img|(?:svg:)?image)\b[^>]*>/gi
const SOURCE_ATTRIBUTE = /(\s(?:src|href|xlink:href)\s*=\s*)(["'])([^"']*)\2/gi

/** An attribute's value as the address it writes: the entities a URL meets, decoded. */
function attributeUrl(value: string): string {
  return value
    .trim()
    .replace(/&amp;|&#38;|&#x26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function absolute(url: string, base?: string): string | undefined {
  try {
    return new URL(url, base).href
  } catch {
    return undefined
  }
}

/**
 * Each picture the page names - an `<img src>`, an SVG's `<image href>` or
 * `xlink:href` - as a data URI of the part saved under that address, or under
 * that Content-ID for a `cid:` one. An address is matched as written, then
 * resolved against the page's own. A picture with no part is left as it is,
 * and so is a repeat past the budget (REPEAT_FACTOR).
 */
export function inlineMhtmlPictures(html: string, page: MhtmlPage): string {
  const base = page.html.location
  const byLocation = new Map<string, MhtmlPart>()
  const byId = new Map<string, MhtmlPart>()
  for (const part of page.parts) {
    if (!part.mime.startsWith('image/') || part.bytes.length === 0) continue
    if (part.contentId && !byId.has(part.contentId)) byId.set(part.contentId, part)
    if (!part.location) continue
    if (!byLocation.has(part.location)) byLocation.set(part.location, part)
    const resolved = absolute(part.location, base)
    if (resolved && !byLocation.has(resolved)) byLocation.set(resolved, part)
  }
  if (byLocation.size === 0 && byId.size === 0) return html
  const uris = new Map<MhtmlPart, string>()
  const savedSize = page.parts.reduce((sum, p) => sum + p.bytes.length, page.html.bytes.length)
  let repeatBudget = REPEAT_FACTOR * savedSize + REPEAT_FLOOR
  const find =(url: string): MhtmlPart | undefined => {
    if (/^cid:/i.test(url)) {
      const id = url.replace(/^cid:/i, '')
      try {
        return byId.get(decodeURIComponent(id))
      } catch {
        return byId.get(id)
      }
    }
    const resolved = absolute(url, base)
    return byLocation.get(url) ?? (resolved ? byLocation.get(resolved) : undefined)
  }
  return html.replace(PICTURE_TAG, (tag) =>
    tag.replace(SOURCE_ATTRIBUTE, (m, lead: string, quote: string, value: string) => {
      const part = find(attributeUrl(value))
      if (!part) return m
      let uri = uris.get(part)
      if (!uri) {
        uri = `data:${part.mime};base64,${part.bytes.toString('base64')}`
        uris.set(part, uri)
      } else {
        // Past the budget a repeat keeps its address, like a picture the
        // file did not save.
        if (uri.length > repeatBudget) return m
        repeatBudget -= uri.length
      }
      return `${lead}${quote}${uri}${quote}`
    }),
  )
}
