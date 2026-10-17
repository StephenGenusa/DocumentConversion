import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import { drawMetafile, readingOrder } from '../metafile'
import { emfSize, wmfSize } from '../picture-headers'
import { pictureMime, vectorMime } from '../picture-types'
import type { HubDocument, SourceInput } from '../types'
import { readImage } from './image'
import { readSvg } from './svg'

/**
 * The most of a drawing's text its alt text holds. A drawing is not a
 * document: past this, the alt text says the start and stops.
 */
const MAX_ALT_CHARS = 1000

/**
 * An .emf or .wmf file (Word's vector pictures): a drawing, as an .svg file
 * is. The file itself becomes the document, kept as it is, so Word keeps
 * the original; the picture step (pictures.ts) draws it for every other
 * target with our own drawing code (metafile/): as SVG where the target
 * holds SVG (its text still text, selectable in a PDF), as PNG where it
 * does not. It is given the size its header says (an EMF's frame, a
 * placeable WMF's box), or the size it is drawn at.
 *
 * Its alt text is the text the drawing holds, in reading order (the labels
 * of a plan or a chart, top to bottom and left to right: metafile/labels.ts),
 * so a screen reader says what it says; the file's name when it holds none.
 * A plain-text or Markdown copy gives the labels one each (drawing-text.ts). A
 * raster picture or an SVG saved with an .emf name is read as what it is.
 */
export async function readMetafile(src: SourceInput): Promise<HubDocument> {
  const mime = vectorMime(src.bytes)
  if (!mime) {
    if (pictureMime(src.bytes)) return readImage(src)
    return readSvg(src)
  }
  const name = src.filename?.split(/[\\/]/).pop()
  const drawn = drawMetafile(src.bytes)
  const header = mime === 'image/x-emf' ? emfSize(src.bytes) : wmfSize(src.bytes)
  const size = header ?? ('error' in drawn ? null : { width: drawn.width, height: drawn.height })
  if (!size) {
    const why = 'error' in drawn ? `: ${drawn.error}` : ''
    throw new ConversionError('image-unsupported', `This ${mime === 'image/x-emf' ? 'EMF' : 'WMF'} picture cannot be read${why}`)
  }
  const words = 'error' in drawn ? '' : capAlt(readingOrder(drawn.labels).join(' ')) || drawingText(drawn.svg)
  const alt = words || name || 'drawing'
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  return {
    html: `<img src="data:${mime};base64,${src.bytes.toString('base64')}" alt="${escapeAttr(alt)}" width="${width}" height="${height}">`,
    title: name,
  }
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** The text of a drawing's SVG (metafile/svg.ts writes each run as one escaped <text>), one line, at most MAX_ALT_CHARS. */
export function drawingText(svg: string): string {
  const runs: string[] = []
  for (const m of svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)) {
    const run = m[1]
      .replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (all, hex: string, dec: string, named: string) => {
        if (named) return ENTITIES[named] ?? all
        const code = hex ? parseInt(hex, 16) : Number(dec)
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      })
      .trim()
    if (run) runs.push(run)
  }
  return capAlt(runs.join(' '))
}

/** One line, at most MAX_ALT_CHARS, cut at a word. */
function capAlt(words: string): string {
  const text = words.replace(/\s+/g, ' ').trim()
  if (text.length <= MAX_ALT_CHARS) return text
  const cut = text.slice(0, MAX_ALT_CHARS)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_ALT_CHARS / 2))}...`
}
