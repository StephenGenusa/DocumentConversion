import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import type { HubDocument, SourceInput } from '../types'
import { imageMime, isHeic, pictureMime, vectorMime } from '../picture-types'
import { tiffPage, tiffPages, tiffShownSize } from '../picture-headers'
import { readMetafile } from './metafile'

export { imageMime }

/**
 * escapeHtml() is for TEXT: it handles `&`, `<` and `>` and leaves quotes
 * alone, which is correct between tags and wrong inside an attribute. A
 * filename is user data and may hold a `"`, which closes the attribute early
 * and lets the rest of the name be parsed as markup.
 */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/**
 * Embed mode: the image becomes the document. OCR mode is handled by the OCR pipeline.
 *
 * Any picture this app reads (picture-types.ts) is taken as it is, and the
 * picture step (pictures.ts) gives each target one it can hold: PNG, JPEG,
 * GIF and WebP go everywhere; BMP, AVIF and ICO, which Chromium shows, are
 * converted for the targets that do not; a TIFF is kept by Word and
 * converted for the rest. An EMF or WMF is a drawing (readers/metafile.ts).
 */
export async function readImage(src: SourceInput): Promise<HubDocument> {
  if (vectorMime(src.bytes)) return readMetafile(src)
  const mime = pictureMime(src.bytes)
  if (!mime) {
    if (isHeic(src.bytes)) {
      throw new ConversionError('image-unsupported', 'HEIC pictures (as iPhones save them) cannot be read here; save it as JPEG first')
    }
    throw new ConversionError('image-unsupported', 'Unsupported or corrupt image (PNG, JPEG, GIF, WebP, TIFF, BMP, AVIF, ICO)')
  }
  const name = src.filename?.split(/[\\/]/).pop()
  const alt = escapeAttr(name ?? 'image')
  if (mime === 'image/tiff' && !tiffPages(src.bytes)?.length) {
    throw new ConversionError('image-unsupported', 'This TIFF has no page that can be read')
  }
  const html = mime === 'image/tiff' ? tiffHtml(src.bytes, name ?? 'image') : `<img src="data:${mime};base64,${src.bytes.toString('base64')}" alt="${alt}">`
  return { html, title: name }
}

/**
 * A TIFF file: each of its pages a picture of its own, in order, a rule
 * between them (on paper and in a slide deck, a new page), each alt text the
 * file's name with its page number: no target shows more than a TIFF's
 * first page, so a fax or a scanned letter of several pages becomes a
 * document of as many. Each page is taken out as a one-page TIFF, its data
 * byte for byte (picture-headers.ts), so Word still keeps it as it is. A
 * file whose pages cannot all be taken out is kept whole, for the picture
 * step to split as it can. Each picture is given the size it is shown at:
 * its pixels at its resolution (a 300 dpi scan at its paper size).
 */
function tiffHtml(bytes: Buffer, name: string): string {
  const pages = tiffPages(bytes)!
  const own = pages.length === 1 && pages[0].index === 0 ? [bytes] : pages.map((p) => tiffPage(bytes, p.index))
  const parts = own.length > 0 && own.every((b) => b !== null) ? (own as Buffer[]) : [bytes]
  return parts
    .map((page, i) => {
      const label = parts.length > 1 ? `${name} (page ${i + 1} of ${parts.length})` : name
      const info = tiffPages(page)?.[0]
      const size = tiffShownSize(page) ?? (info ? { width: info.width, height: info.height } : null)
      const sized = size ? ` width="${Math.max(1, Math.round(size.width))}" height="${Math.max(1, Math.round(size.height))}"` : ''
      return `<img src="data:image/tiff;base64,${page.toString('base64')}" alt="${escapeAttr(label)}"${sized}>`
    })
    .join('\n<hr>\n')
}

/**
 * The text of a file that may be an SVG: UTF-8, or UTF-16 when it opens
 * with that byte-order mark. Any BOM is dropped.
 */
export function svgText(bytes: Buffer, limit = bytes.length): string {
  const end = Math.min(limit, bytes.length)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le', 2, end)
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2, end - ((end - 2) % 2))
    return Buffer.from(body).swap16().toString('utf16le')
  }
  return bytes.toString('utf8', 0, end).replace(/^﻿/, '')
}

/** How far into a file the SVG sniff looks for the root element: past a long license comment. */
const SVG_SNIFF_BYTES = 64 * 1024

/**
 * Is this an SVG file (spec D10)? Its first element must be `<svg>` (with or
 * without a prefix), after whitespace, the XML declaration and other
 * processing instructions, comments and a doctype (whose internal subset may
 * hold anything). Generic XML, or XML that holds an <svg> further in, is not.
 */
export function looksLikeSvg(bytes: Buffer): boolean {
  let s = svgText(bytes, SVG_SNIFF_BYTES)
  for (;;) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('<?')) {
      const end = s.indexOf('?>')
      if (end < 0) return false
      s = s.slice(end + 2)
    } else if (s.startsWith('<!--')) {
      const end = s.indexOf('-->', 4)
      if (end < 0) return false
      s = s.slice(end + 3)
    } else if (/^<!doctype\s/i.test(s)) {
      const end = doctypeEnd(s)
      if (end < 0) return false
      s = s.slice(end)
    } else {
      return /^<(?:[A-Za-z_][\w.-]*:)?svg[\s/>]/.test(s)
    }
  }
}

/** Where a doctype that starts `s` ends, past any internal subset; -1 when it does not. */
function doctypeEnd(s: string): number {
  let i = '<!doctype'.length
  let quote = ''
  let inSubset = false
  while (i < s.length) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (inSubset && s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      if (end < 0) return -1
      i = end + 3
      continue
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '[') {
      inSubset = true
    } else if (c === ']') {
      inSubset = false
    } else if (c === '>' && !inSubset) {
      return i + 1
    }
    i++
  }
  return -1
}
