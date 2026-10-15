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

/** How far into a file the SVG sniff looks for the root element: past a long licence comment. */
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
