import MsgReaderImport from '@kenjiuno/msgreader'

// Transpiled-CJS default export: vitest/esbuild interop resolves .default,
// rollup's runtime interop in the built app does not — resolve it explicitly.
const MsgReader = ((MsgReaderImport as unknown as { default?: unknown }).default ??
  MsgReaderImport) as typeof MsgReaderImport
// @ts-ignore -- @kenjiuno/decompressrtf ships no types
import { decompressRTF } from '@kenjiuno/decompressrtf'
import { deEncapsulateSync } from 'rtf-stream-parser'
import * as iconv from 'iconv-lite'
import { ConversionError } from '../errors'
import { decodeTextBytes } from './txt'
import { sanitizeToHub } from '../allowlist'
import { rtfStringToHubHtml } from './rtf'
import { renderAttachmentList, renderEmailHeader, textToParagraphs } from './email-common'
import type { HubDocument, SourceInput } from '../types'

export interface MsgAttachment {
  fileName?: string
  contentLength?: number
  /** cid used by an <img> in the body, when the attachment is inline. */
  contentId?: string
  mimeType?: string
  content?: Uint8Array
}

export interface MsgFields {
  subject?: string
  senderName?: string
  /** PidTagSenderEmailAddress — an X.500 DN when the sender is an Exchange user. */
  senderEmail?: string
  /** PidTagSenderSmtpAddress / PidTagSentRepresentingSmtpAddress: the real address. */
  senderSmtpAddress?: string
  recipients: {
    name?: string
    email?: string
    /** PidTagSmtpAddress (0x39FE) — set even when `email` holds an X.500 DN. */
    smtpAddress?: string
    recipType?: string
  }[]
  date?: string
  bodyHtml?: string
  /** PidTagRtfCompressed bytes (LZFu-compressed, or MELA uncompressed container). */
  compressedRtf?: Uint8Array
  bodyText?: string
  attachments: MsgAttachment[]
}

/**
 * Outlook bodies reference inline images as `cid:` (or, after RTF
 * de-encapsulation, by a bare filename). The hub sanitizer only allows
 * data:/http(s) on img, so an unresolved cid loses its src entirely — which
 * both drops the image and made the docx writer throw on a src-less <img>.
 */
function inlineMsgImages(html: string, attachments: MsgAttachment[]): string {
  let out = html
  for (const att of attachments) {
    if (!att.content || att.content.length === 0) continue
    const mime = att.mimeType || guessMime(att.fileName)
    if (!mime.startsWith('image/')) continue
    const dataUri = `data:${mime};base64,${Buffer.from(att.content).toString('base64')}`
    for (const token of [att.contentId, att.fileName].filter(Boolean) as string[]) {
      const bare = token.replace(/[<>]/g, '')
      out = out.split(`cid:${bare}`).join(dataUri)
      // De-encapsulated Outlook HTML often points straight at the filename.
      out = out.replace(
        new RegExp(`(<img[^>]*\\bsrc=")([^"]*${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(")`, 'gi'),
        `$1${dataUri}$3`,
      )
    }
  }
  return out
}

function guessMime(filename?: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(filename ?? '')?.[1]?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'application/octet-stream'
}

/**
 * Exchange stores an internal party's PidTagEmailAddress as an X.500
 * distinguished name — `/o=Example/ou=Exchange Administrative Group
 * (FYDIBOHF23SPDLT)/cn=Recipients/cn=U3UE6D2` — rather than an address.
 */
function isX500Dn(value: string): boolean {
  return /^\/(?:o|ou|c|cn|dc|a|p|admd|prmd)=/i.test(value.trim())
}

/** The real SMTP address, or nothing — never a distinguished name. */
function pickAddress(email?: string, smtpAddress?: string): string | undefined {
  for (const candidate of [smtpAddress, email]) {
    const trimmed = candidate?.trim()
    if (trimmed && !isX500Dn(trimmed)) return trimmed
  }
  return undefined
}

/**
 * Printed verbatim, a DN opens with `<` in visible prose (reading as a broken
 * close tag) and blows the header table out to five wrapped lines per
 * recipient. With no SMTP address anywhere in the .msg, the display name alone
 * carries more for the reader than the DN does.
 */
function formatParty(name?: string, email?: string, smtpAddress?: string): string | undefined {
  const address = pickAddress(email, smtpAddress)
  if (name && address) return `${name} <${address}>`
  return address || name || undefined
}

/**
 * The three-step .msg body pipeline (spec F5): (1) decompress
 * PidTagRtfCompressed; (2) RTF-encapsulated HTML (\fromhtml1 — the common
 * Outlook case) is de-encapsulated back to the original HTML; (3) only
 * genuine RTF bodies fall back to the degrading RTF converter.
 */
export async function msgToHub(fields: MsgFields): Promise<HubDocument> {
  let body = ''
  if (fields.bodyHtml) {
    body = sanitizeToHub(inlineMsgImages(fields.bodyHtml, fields.attachments))
  } else if (fields.compressedRtf && fields.compressedRtf.length > 0) {
    // decompressRTF's types want number[], but any Uint8Array works at runtime.
    const compressed = Buffer.from(fields.compressedRtf) as unknown as number[]
    const rtf = Buffer.from(decompressRTF(compressed)).toString('latin1')
    if (/\\fromhtml1\b/.test(rtf)) {
      const res = deEncapsulateSync(rtf, { decode: iconv.decode, mode: 'html' })
      body = sanitizeToHub(inlineMsgImages(String(res.text), fields.attachments))
    } else {
      body = await rtfStringToHubHtml(rtf)
    }
  } else if (fields.bodyText) {
    body = textToParagraphs(fields.bodyText)
  }

  const party = (r: { name?: string; email?: string; smtpAddress?: string }): string | undefined =>
    formatParty(r.name, r.email, r.smtpAddress)
  const byType = (type: string): string =>
    fields.recipients
      .filter((r) => (r.recipType ?? 'to').toLowerCase() === type)
      .map(party)
      .filter(Boolean)
      .join(', ')
  const header = renderEmailHeader({
    from: formatParty(fields.senderName, fields.senderEmail, fields.senderSmtpAddress),
    // Recipients carry their role; merging Cc into To loses who was copied.
    to: byType('to') || fields.recipients.map(party).filter(Boolean).join(', '),
    cc: byType('cc'),
    date: fields.date,
    subject: fields.subject,
  })
  const inlined = new Set(
    fields.attachments.filter((a) => a.contentId).map((a) => (a.contentId as string).replace(/[<>]/g, '')),
  )
  const attachments = fields.attachments
    .filter((a) => !(a.contentId && inlined.has(a.contentId.replace(/[<>]/g, ''))))
    .map((a) => ({ name: a.fileName || 'attachment', size: a.contentLength }))
  return { html: `${header}\n${body}\n${renderAttachmentList(attachments)}`, title: fields.subject }
}

/**
 * The HTML body, decoded.
 *
 * PidTagHtml (0x1013) is a BINARY property, so msgreader hands `html` back as a
 * Uint8Array. This was cast straight to `string`, and the cast was a lie: every
 * .msg carrying an HTML body — which is how Outlook normally stores one — threw
 * `TypeError: out.split is not a function` inside `inlineMsgImages`. It went
 * unseen because the documents this was developed against carried RTF bodies,
 * so the branch never ran on real input.
 *
 * The bytes are in the message's own codepage, which PidTagInternetCodepage
 * names when it is present; `decodeTextBytes` applies the same
 * strict-UTF-8-before-the-declaration rule used for text files.
 */
function htmlBody(data: Record<string, unknown>): string | undefined {
  const raw = data.html
  if (typeof raw === 'string') return raw || undefined
  if (raw == null) return undefined
  const bytes = Buffer.from(raw as Uint8Array)
  if (bytes.length === 0) return undefined
  return decodeTextBytes(bytes, codepageName(data.internetCodepage)) || undefined
}

/** Windows codepage number to a label iconv-lite understands. */
function codepageName(value: unknown): string | undefined {
  if (typeof value !== 'number' || value <= 0) return undefined
  if (value === 65001) return 'utf-8'
  if (value === 20127) return 'us-ascii'
  if (value >= 1250 && value <= 1258) return `windows-${value}`
  if (value === 28591) return 'iso-8859-1'
  return undefined
}

export async function readMsg(src: SourceInput): Promise<HubDocument> {
  let fields: MsgFields
  try {
    // MsgReader's types want ArrayBuffer/DataView, but any Uint8Array works at runtime.
    const reader = new MsgReader(src.bytes as unknown as ArrayBuffer)
    const data = reader.getFileData() as unknown as Record<string, unknown>
    if (data.error) throw new Error(String(data.error))
    fields = {
      subject: data.subject as string | undefined,
      senderName: data.senderName as string | undefined,
      senderEmail: data.senderEmail as string | undefined,
      // Not creatorSMTPAddress/lastModifierSMTPAddress: those name whoever
      // created or last saved the item, which in this corpus is a third party.
      senderSmtpAddress: ((data.senderSmtpAddress as string | undefined) ??
        (data.sentRepresentingSmtpAddress as string | undefined)) as string | undefined,
      recipients: (data.recipients as MsgFields['recipients']) ?? [],
      date: (data.messageDeliveryTime as string | undefined) ?? undefined,
      bodyHtml: htmlBody(data),
      compressedRtf: data.compressedRtf as Uint8Array | undefined,
      bodyText: data.body as string | undefined,
      attachments: (data.attachments as MsgAttachment[] | undefined) ?? [],
    }
    // Attachment bytes are fetched separately; inline images need them.
    const withReader = reader as unknown as {
      getAttachment(index: number): { fileName?: string; content?: Uint8Array }
    }
    fields.attachments = fields.attachments.map((att, i) => {
      const raw = att as MsgAttachment & { pidContentId?: string }
      try {
        const loaded = withReader.getAttachment(i)
        return { ...raw, contentId: raw.contentId ?? raw.pidContentId, content: loaded?.content }
      } catch {
        return { ...raw, contentId: raw.contentId ?? raw.pidContentId }
      }
    })
  } catch (err) {
    throw new ConversionError('msg-parse-failed', `Could not parse .msg: ${(err as Error).message}`)
  }
  return msgToHub(fields)
}
