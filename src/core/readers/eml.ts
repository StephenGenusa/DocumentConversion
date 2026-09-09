import PostalMimeImport from 'postal-mime'

// Same interop hazard as msgreader: resolve the default export explicitly.
const PostalMime = ((PostalMimeImport as unknown as { default?: unknown }).default ??
  PostalMimeImport) as typeof PostalMimeImport
import { ConversionError } from '../errors'
import { sanitizeToHub } from '../allowlist'
import { renderAttachmentList, renderEmailHeader, textToParagraphs } from './email-common'
import type { HubDocument, SourceInput } from '../types'

function formatAddress(a?: { name?: string; address?: string }): string | undefined {
  if (!a) return undefined
  if (a.name && a.address) return `${a.name} <${a.address}>`
  return a.address || a.name || undefined
}

function toBase64(content: ArrayBuffer | Uint8Array | string): string {
  if (typeof content === 'string') return Buffer.from(content, 'utf8').toString('base64')
  return Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content)).toString('base64')
}

/** postal-mime hands back an ISO timestamp; show it the way mail clients do. */
function formatDate(date?: string): string | undefined {
  if (!date) return undefined
  const parsed = new Date(date)
  return Number.isNaN(parsed.getTime()) ? date : parsed.toUTCString()
}

export async function readEml(src: SourceInput): Promise<HubDocument> {
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>
  try {
    parsed = await PostalMime.parse(src.bytes)
  } catch (err) {
    throw new ConversionError('eml-parse-failed', `Could not parse email: ${(err as Error).message}`)
  }
  if (!parsed.from && !parsed.subject && !parsed.html && !parsed.text) {
    throw new ConversionError('eml-parse-failed', 'Not an email message')
  }

  let body: string
  if (parsed.html) {
    let html = parsed.html
    // Resolve inline cid: references to data URIs before sanitizing.
    for (const att of parsed.attachments ?? []) {
      if (!att.contentId) continue
      const cid = att.contentId.replace(/[<>]/g, '')
      html = html.split(`cid:${cid}`).join(`data:${att.mimeType};base64,${toBase64(att.content)}`)
    }
    body = sanitizeToHub(html)
  } else {
    body = textToParagraphs(parsed.text ?? '')
  }

  // An image already embedded inline is not also an attachment to list.
  const inlined = new Set(
    (parsed.attachments ?? []).filter((a) => a.contentId).map((a) => a.contentId as string),
  )
  const attachments = (parsed.attachments ?? [])
    .filter((a) => a.disposition !== 'inline' && !(a.contentId && inlined.has(a.contentId)))
    .map((a) => ({
      name: a.filename || 'attachment',
      size: typeof a.content === 'string' ? a.content.length : a.content?.byteLength,
    }))

  const header = renderEmailHeader({
    from: formatAddress(parsed.from),
    to: (parsed.to ?? []).map((a) => formatAddress(a)).filter(Boolean).join(', '),
    cc: (parsed.cc ?? []).map((a) => formatAddress(a)).filter(Boolean).join(', '),
    date: formatDate(parsed.date),
    subject: parsed.subject,
  })
  return { html: `${header}\n${body}\n${renderAttachmentList(attachments)}`, title: parsed.subject }
}
