import { decodeSvgDataUri } from './svg-sanitize'
import { svgIntrinsicSize } from './svg-images'
import { rasterSize, type PictureSize } from './picture-headers'

/*
 * A document that is one picture and nothing else: an .svg or a photo opened
 * on its own (readers/svg.ts, readers/image.ts write a bare <img>), or a
 * Markdown or HTML page whose only block is a picture. On a fixed page such a
 * document is the picture, so the page is given to it: the PDF writer prints
 * it filling the page, and the AZW4 writer, whose page the target dictates,
 * turns that page landscape for a wide one.
 *
 * A document of pictures and nothing else, a rule between each two (a TIFF
 * of several pages opened on its own: readers/image.ts), is a picture a
 * page (picturePages): each is printed filling a page of its own.
 */

/**
 * Tags that may hold the picture without adding anything of their own: a
 * paragraph, a link, a figure with no caption, a plain box. Anything else
 * (a heading, a caption, a table, a list, an inline drawing) is content.
 */
const WRAPPERS = new Set(['p', 'div', 'span', 'a', 'figure', 'picture', 'center', 'section', 'article', 'main', 'br'])

/** How much of a data URI's payload is decoded to read a size: past any header (a JPEG's EXIF is at most 64 KB) or an SVG's root start tag. */
const SIZE_SNIFF_BYTES = 128 * 1024

/** The picture's size from its data URI: an SVG's own size, a raster's header; null for anything else. */
function sizeFromSrc(src: string): PictureSize | null {
  const m = /^\s*data:(image\/[\w.+-]+)((?:;[^,]*)?),/i.exec(src)
  if (!m) return null
  const mime = m[1].toLowerCase()
  const base64 = /;\s*base64\s*$/i.test(m[2])
  // A prefix only: a whole photo is megabytes, and its size is at the start.
  const payload = src.slice(m[0].length, m[0].length + (base64 ? Math.ceil((SIZE_SNIFF_BYTES * 4) / 3 / 4) * 4 : SIZE_SNIFF_BYTES))
  if (mime === 'image/svg+xml') {
    // An escape cut off at the end of the prefix is dropped, not misread.
    const text = decodeSvgDataUri(`data:${mime}${m[2]},${base64 ? payload : payload.replace(/%[0-9a-f]?$/i, '')}`)
    return text ? svgIntrinsicSize(text) : null
  }
  if (!base64) return null
  return rasterSize(Buffer.from(payload, 'base64'))
}

/** An <img>'s own width and height attributes, in px, when it gives both. */
function sizeFromAttributes(tag: string): PictureSize | null {
  const attr = (name: string): number | undefined => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']?\\s*([\\d.]+)(?:px)?\\s*["'\\s>/]`, 'i').exec(tag)
    const n = m ? Number(m[1]) : NaN
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const width = attr('width')
  const height = attr('height')
  return width && height ? { width, height } : null
}

/**
 * The document's one picture, when the document is one picture and nothing
 * else: its size (from the <img>'s width and height, else the picture's own,
 * else null when that cannot be told). Null for any other document.
 */
export function lonePicture(html: string): { size: PictureSize | null } | null {
  const imgs = html.match(/<img\b[^>]*>/gi)
  if (!imgs || imgs.length !== 1) return null
  const rest = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<img\b[^>]*>/i, '')
  for (const tag of rest.matchAll(/<\/?([a-z][\w-]*)/gi)) {
    if (!WRAPPERS.has(tag[1].toLowerCase())) return null
  }
  const text = rest.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#xa0;/gi, '')
  if (text.trim() !== '') return null
  const tag = imgs[0]
  const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
  return { size: sizeFromAttributes(tag) ?? (src ? sizeFromSrc(src[1] ?? src[2]) : null) }
}

/**
 * The document's pictures, when it is pictures and nothing else, one a page:
 * one picture, or several with a rule (<hr>) between each two and nothing
 * else. Each one's size, as lonePicture gives it. Null for any other
 * document.
 */
export function picturePages(html: string): { sizes: (PictureSize | null)[] } | null {
  const sizes: (PictureSize | null)[] = []
  for (const part of html.split(/<hr\b[^>]*>/i)) {
    const one = lonePicture(part)
    if (!one) return null
    sizes.push(one.size)
  }
  return { sizes }
}

/** Whether the document is pictures alone (picturePages), each wider than tall. */
export function isWideLonePicture(html: string): boolean {
  const sizes = picturePages(html)?.sizes
  return !!sizes && sizes.every((size) => !!size && size.width > size.height)
}
