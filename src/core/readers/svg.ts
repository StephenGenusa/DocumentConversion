import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import { sanitizeSvgDoc } from '../svg-sanitize'
import { svgDataUri, svgSizeOf } from '../svg-images'
import type { HubDocument, SourceInput } from '../types'
import { imageMime, readImage, svgText } from './image'

/**
 * An .svg file (spec D10): the picture becomes the document, as with any
 * other image, embedded as a base64 `image/svg+xml` data URI of the SVG after
 * B6 sanitizing (svg-sanitize.ts: no script, handlers, external references,
 * prolog or doctype). Its size is written on the <img>, so every target
 * shows it at the size the file gives. The editor shows it as an ordinary
 * image. Its text is not extracted: it is a picture. A picture it names by
 * a web address is fetched where the document is read, like an <img>'s.
 *
 * A raster image saved with an .svg name is read as the image it is.
 */
export async function readSvg(src: SourceInput): Promise<HubDocument> {
  if (imageMime(src.bytes)) return readImage(src)
  // Pictures it names by address are kept for the read step to fetch.
  const doc = sanitizeSvgDoc(svgText(src.bytes), { keepImageUrls: true })
  if (!doc) throw new ConversionError('image-unsupported', 'This is not a readable SVG image')
  const { svg } = doc
  const size = svgSizeOf(doc.root)
  const name = src.filename?.split(/[\\/]/).pop()
  const alt = escapeHtml(name ?? 'image').replace(/"/g, '&quot;')
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  return {
    html: `<img src="${svgDataUri(svg)}" alt="${alt}" width="${width}" height="${height}">`,
    title: name,
  }
}
