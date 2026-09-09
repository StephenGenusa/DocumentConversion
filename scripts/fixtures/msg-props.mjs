/**
 * Small helpers for building the `__substg1.0_<TAG><TYPE>` property streams
 * `@kenjiuno/msgreader` expects inside a `.msg` CFB, plus the `__recip_*`
 * storages that carry per-recipient fields. See `cfb-writer.mjs` for the
 * container format itself.
 */
import { CFB } from './cfb-writer.mjs'

const TYPE = {
  string: '001e',
  unicode: '001f',
  binary: '0102',
  integer: '0003',
  boolean: '000b',
}

function unicodeBytes(text) {
  const buf = Buffer.alloc(text.length * 2 + 2)
  buf.write(text, 0, 'utf16le')
  return buf // trailing 2 zero bytes = the null terminator
}

/** One `__substg1.0_XXXXTTTT` document stream. */
export function prop(tag, type, data) {
  return {
    name: `__substg1.0_${tag}${TYPE[type]}`,
    type: CFB.STGTY_STREAM,
    data,
  }
}

export function strProp(tag, text) {
  return prop(tag, 'unicode', unicodeBytes(text))
}

export function intProp(tag, value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value >>> 0, 0)
  return prop(tag, 'integer', buf)
}

export function binProp(tag, bytes) {
  return prop(tag, 'binary', Buffer.from(bytes))
}

/** A `__recip_version1.0_#00000000`-style storage for one recipient. */
export function recipient(index, fields) {
  const children = []
  if (fields.name !== undefined) children.push(strProp('3001', fields.name)) // PidTagDisplayName
  if (fields.addressType !== undefined) children.push(strProp('3002', fields.addressType)) // PidTagAddrType
  if (fields.email !== undefined) children.push(strProp('3003', fields.email)) // PidTagEmailAddress
  if (fields.smtpAddress !== undefined) children.push(strProp('39FE', fields.smtpAddress)) // PidTagSmtpAddress
  if (fields.recipType !== undefined) children.push(intProp('0C15', fields.recipType)) // PidTagRecipientType
  return {
    name: `__recip_version1.0_#${String(index).padStart(8, '0')}`,
    type: CFB.STGTY_STORAGE,
    children,
  }
}

export const RECIP_TYPE = { to: 1, cc: 2, bcc: 3 }

/**
 * An attachment substorage.
 *
 * Added so the corpus can exercise `inlineMsgImages` and `guessMime`, which the
 * synthetic fixtures reached zero times: an Outlook message that carries an
 * inline picture references it from the HTML body as `cid:<contentId>`, and the
 * reader swaps that for a data URI. Without an attachment there is nothing to
 * swap, and 28 points of msg.ts went untested.
 *
 * `mimeTag` is deliberately optional — omitting it forces the reader down the
 * `guessMime(fileName)` fallback instead of taking the declared type.
 */
export function attachment(index, { fileName, contentId, mimeTag, bytes }) {
  const children = []
  if (fileName !== undefined) {
    children.push(strProp('3704', fileName)) // PidTagAttachFilename
    children.push(strProp('3707', fileName)) // PidTagAttachLongFilename
  }
  if (contentId !== undefined) children.push(strProp('3712', contentId)) // PidTagAttachContentId
  if (mimeTag !== undefined) children.push(strProp('370E', mimeTag)) // PidTagAttachMimeTag
  if (bytes !== undefined) {
    children.push(binProp('3701', bytes)) // PidTagAttachDataBinary
    children.push(intProp('0E20', bytes.length)) // PidTagAttachSize
  }
  return {
    name: `__attach_version1.0_#${String(index).padStart(8, '0')}`,
    type: CFB.STGTY_STORAGE,
    children,
  }
}
