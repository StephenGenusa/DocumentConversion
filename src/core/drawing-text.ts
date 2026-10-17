import { ConversionError } from './errors'
import { lonePicture } from './lone-picture'
import { drawMetafile, GlyphFonts, readingOrder, type FontFiles } from './metafile'
import { vectorMime } from './picture-types'
import { escapeHtml } from './shell'
import type { TargetFormat } from './types'

/*
 * An EMF or WMF drawing on its own (an .emf or .wmf file, or the edit pane's
 * copy of one) written as text (owner, 2026-10-17): what it says is its labels,
 * in reading order (metafile/labels.ts: top to bottom, left to right by where
 * each is drawn).
 *
 *   txt  the labels, one a line. A drawing with no text is refused: there is
 *        nothing to write, and its file name would be a made-up document.
 *   md   the drawing, as every Markdown copy of a document gets its pictures
 *        (an SVG data URI, pictures.ts), then its labels as a list: the
 *        picture is the document, the list is its words, searchable and
 *        readable where the picture is not shown (a plain editor, a viewer
 *        that drops data URIs). Paragraphs would read the labels as prose,
 *        which they are not.
 *
 * Any other document with a drawing in it keeps the drawing's alt text, as
 * every picture in a text copy does.
 */

const DRAWING_SRC = /\ssrc\s*=\s*"data:image\/x-[ew]mf;base64,([A-Za-z0-9+/=\s]+)"/i

export function drawingAsText(html: string, target: TargetFormat, fontFiles?: FontFiles): string {
  if (target !== 'txt' && target !== 'md') return html
  if (!lonePicture(html)) return html
  const src = DRAWING_SRC.exec(html)
  if (!src) return html
  const bytes = Buffer.from(src[1].replace(/\s+/g, ''), 'base64')
  if (!vectorMime(bytes)) return html
  const drawn = drawMetafile(bytes, { fonts: fontFiles ? new GlyphFonts(fontFiles) : undefined })
  const labels = 'error' in drawn ? [] : readingOrder(drawn.labels)
  if (target === 'txt') {
    if (labels.length === 0) throw new ConversionError('unsupported', 'This drawing holds no text to write as plain text')
    return labels.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')
  }
  if (labels.length === 0) return html
  return `${html}\n<ul>${labels.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
}
