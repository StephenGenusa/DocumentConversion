import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import type { HubDocument, SourceInput } from '../types'

export function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a/.test(bytes.toString('latin1', 0, 6))) return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * escapeHtml() is for TEXT: it handles `&`, `<` and `>` and leaves quotes
 * alone, which is correct between tags and wrong inside an attribute. A
 * filename is user data and may hold a `"`, which closes the attribute early
 * and lets the rest of the name be parsed as markup.
 */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/** Embed mode: the image becomes the document. OCR mode is handled by the OCR pipeline. */
export async function readImage(src: SourceInput): Promise<HubDocument> {
  const mime = imageMime(src.bytes)
  if (!mime) throw new ConversionError('image-unsupported', 'Unsupported or corrupt image (PNG, JPEG, GIF, WebP)')
  const name = src.filename?.split(/[\\/]/).pop()
  const alt = escapeAttr(name ?? 'image')
  return {
    html: `<img src="data:${mime};base64,${src.bytes.toString('base64')}" alt="${alt}">`,
    title: name,
  }
}
