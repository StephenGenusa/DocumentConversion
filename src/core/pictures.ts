import { parseDocument } from 'htmlparser2'
import { Element, type ChildNode } from 'domhandler'
import { replaceElement } from 'domutils'
import serialize from 'dom-serializer'
import { imageMime } from './readers/image'
import { imagePlaceholder } from './inline-images'
import { MAX_PICTURE_BYTES, type PictureFormat, type RenderRequest, type RenderResult } from './rendered-blocks'
import type { DrawContext } from './draw-blocks'
import type { TargetFormat } from './types'

/*
 * The pictures each target can hold (spec D10's raster half), made right
 * once per conversion, at write time, for every writer: Converter.write()
 * calls targetPictures() after the diagrams are drawn and the SVG images
 * have their PNG copies. A picture the target holds stays exactly as the
 * document has it. One it cannot hold - TIFF in a browser, BMP in an EPUB,
 * WebP in a Kindle book - is converted by the render host (kind `picture`):
 * decoded in its sandboxed page, never in the main process, where a
 * malformed file can take the app down (Skia, in @napi-rs/canvas, crashes on
 * some), and answered in the picture format asked for (PNG unless chosen,
 * PictureFormat). Chromium has no TIFF decoder, so the page decodes TIFF
 * with UTIF.js (vendored in resources/render). What cannot be converted
 * becomes its alt text, with a notice, so no output holds a picture its
 * reader shows as a broken icon: EMF and WMF (Word's vector pictures,
 * which nothing here draws yet: vectorRequest is where that goes), and
 * anything unrecognised. SVG images do not reach here as pictures to
 * convert: svg-images.ts made PNG copies for the targets without SVG.
 *
 * Kindle (AZW3/KF8) also has a size limit, per picture: 5 MB. Classic MOBI
 * capped image records at about 127 KB (64 KB on early readers), and
 * kindlegen's MOBI7 half still shrinks pictures to that; KF8 itself has no
 * record size limit (PalmDB offsets are 32-bit), and we write KF8 only.
 * Amazon's publishing guidelines allow 5 MB per image in a KF8 book;
 * calibre's KF8 writer allows 10 MB. We take Amazon's 5 MB: under it a
 * picture is stored as given; over it, it is re-encoded - JPEG at falling
 * quality, then scaled down; PNG (transparency) scaled down - until it fits.
 */

export const KINDLE_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** Per conversion: how many pictures are converted, and how long each may take. */
export const PICTURE_LIMITS = { max: 200, eachMs: 20_000 } as const

/** The picture format a converted picture is given when nothing else is chosen (ConvertOptions.pictureFormat). */
export const DEFAULT_PICTURE_FORMAT: PictureFormat = 'png'

/** What a KF8 image record may hold. */
const KINDLE_HOLDS = new Set(['image/jpeg', 'image/png', 'image/gif'])

/** What Chromium shows (pdf, html, slides and azw4 are all drawn or read by it). Not TIFF, EMF or WMF. */
const BROWSER_HOLDS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/x-icon'])

/**
 * What a target can hold, and what it is called in a notice. `holds` is by
 * the picture's bytes (pictureType), never the type it claims. A picture of
 * a type nothing recognises is kept where `unknown` is 'keep' (a web page
 * or Markdown file may be read by something that knows it) and otherwise
 * becomes its alt text.
 */
interface PictureTarget {
  name: string
  holds: ReadonlySet<string>
  /** The largest picture stored as it is (Infinity: any size). */
  maxBytes: number
  /** The largest copy the render host may make. */
  fitBytes: number
  unknown: 'keep' | 'describe'
}

const browser = (name: string, unknown: PictureTarget['unknown']): PictureTarget => ({
  name,
  holds: BROWSER_HOLDS,
  maxBytes: Infinity,
  fitBytes: MAX_PICTURE_BYTES,
  unknown,
})

/**
 * The targets that show pictures, and what each holds:
 *
 *   html, revealjs    Chromium's set (browsers): PNG, JPEG, GIF, WebP, BMP, AVIF, ICO
 *   pdf, azw4         the same: Chromium prints them (azw4 is a PDF inside)
 *   epub              EPUB 3.3's core media types: PNG, JPEG, GIF, WebP (and SVG)
 *   azw3              a KF8 image record: JPEG, PNG, GIF, up to 5 MB
 *   md                what Markdown viewers show: PNG, JPEG, GIF, WebP (and SVG)
 *   docx              what html-to-docx can size: PNG, JPEG, GIF, BMP, WebP
 *
 * Every other target (txt, csv, json, xlsx) holds no pictures at all.
 */
const PICTURE_TARGETS: Partial<Record<TargetFormat, PictureTarget>> = {
  html: browser('HTML', 'keep'),
  revealjs: browser('slides', 'keep'),
  pdf: browser('PDF', 'describe'),
  azw4: browser('Kindle (AZW4)', 'describe'),
  epub: {
    name: 'EPUB',
    holds: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    maxBytes: Infinity,
    fitBytes: MAX_PICTURE_BYTES,
    unknown: 'describe',
  },
  azw3: { name: 'Kindle', holds: KINDLE_HOLDS, maxBytes: KINDLE_IMAGE_MAX_BYTES, fitBytes: KINDLE_IMAGE_MAX_BYTES, unknown: 'describe' },
  md: {
    name: 'Markdown',
    holds: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    maxBytes: Infinity,
    fitBytes: MAX_PICTURE_BYTES,
    unknown: 'keep',
  },
  docx: {
    name: 'Word',
    holds: new Set(['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp']),
    maxBytes: Infinity,
    fitBytes: MAX_PICTURE_BYTES,
    unknown: 'describe',
  },
}

/** The picture types the docx writer passes to html-to-docx, by their bytes: the ones it can size. */
export function wordTakes(bytes: Buffer): boolean {
  const mime = pictureMime(bytes)
  return mime !== null && PICTURE_TARGETS.docx!.holds.has(mime)
}

/** The picture's type, by its signature (a declared type can lie), for the types a browser decodes. */
export function pictureMime(bytes: Buffer): string | null {
  const known = imageMime(bytes)
  if (known) return known
  if (bytes.length >= 26 && bytes.toString('latin1', 0, 2) === 'BM') return 'image/bmp'
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(bytes.toString('latin1', 8, 12))) {
    return 'image/avif'
  }
  if (bytes.length >= 6 && bytes.readUInt32BE(0) === 0x00000100 && bytes.readUInt16LE(4) > 0) return 'image/x-icon'
  // TIFF, either byte order. Not BigTIFF (43), which UTIF.js does not read.
  if (bytes.length >= 8 && (bytes.toString('latin1', 0, 4) === 'II*\0' || bytes.toString('latin1', 0, 4) === 'MM\0*')) return 'image/tiff'
  return null
}

/**
 * Word's vector pictures, by signature: EMF (an EMR_HEADER record whose
 * signature is " EMF") and WMF (Aldus placeable, or a bare memory or disk
 * metafile header of nine words).
 */
export function vectorMime(bytes: Buffer): string | null {
  if (bytes.length >= 88 && bytes.readUInt32LE(0) === 1 && bytes.readUInt32LE(40) === 0x464d4520) return 'image/x-emf'
  if (bytes.length >= 22 && bytes.readUInt32LE(0) === 0x9ac6cdd7) return 'image/x-wmf'
  if (bytes.length >= 18 && [1, 2].includes(bytes.readUInt16LE(0)) && bytes.readUInt16LE(2) === 9 && [0x100, 0x300].includes(bytes.readUInt16LE(4))) {
    return 'image/x-wmf'
  }
  return null
}

/** Every picture type this app recognises, by its bytes. */
export function pictureType(bytes: Buffer): string | null {
  return pictureMime(bytes) ?? vectorMime(bytes)
}

/** What a picture's type is called in a notice: "EMF" for image/x-emf, "TIFF" for image/tiff. */
function typeName(mime: string): string {
  return mime.replace(/^image\//, '').replace(/^(x-|vnd\.(ms-|microsoft\.)?)/, '').toUpperCase()
}

/** Whether these bytes are stored as they are: one of `holds` (a Kindle's JPEG, PNG or GIF unless given), under the limit. */
export function storableAsIs(bytes: Buffer, maxBytes = KINDLE_IMAGE_MAX_BYTES, holds: ReadonlySet<string> = KINDLE_HOLDS): boolean {
  const mime = pictureMime(bytes)
  return mime !== null && holds.has(mime) && bytes.length <= maxBytes
}

/**
 * EMF and WMF, for a target that cannot hold them: the request that draws
 * one as a picture, or null when nothing can (now: always). This is where
 * an EMF drawing step plugs in - answer a render request for the vector
 * source, and its result is stored like any other converted picture, in
 * the picture format asked for. Until then each becomes its alt text.
 */
function vectorRequest(_mime: string, _bytes: Buffer, _format: PictureFormat): RenderRequest | null {
  return null
}

const DATA_IMAGE = /^\s*data:(image\/[\w.+-]+)(?:;[^,]*)?;base64,([\s\S]*)$/i

function dataBytes(src: string): { declared: string; bytes: Buffer } | null {
  const m = DATA_IMAGE.exec(src)
  return m ? { declared: m[1].toLowerCase(), bytes: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') } : null
}

/** Every <img> in document order. */
function images(nodes: ChildNode[], out: Element[] = []): Element[] {
  for (const node of nodes) {
    if (!(node instanceof Element)) continue
    if (node.name === 'img') out.push(node)
    else images(node.children, out)
  }
  return out
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toPlaceholder(el: Element): void {
  const alt = el.attribs.alt?.trim()
  const inline = el.parent instanceof Element
  const [node] = parseDocument(imagePlaceholder(alt ? escapeText(alt) : undefined, inline ? 'inline' : 'block')).children
  replaceElement(el, node)
}

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 300 ? `${t.slice(0, 297)}...` : t || 'unknown error'
}

const BASE64 = /^[A-Za-z0-9+/]+=*$/

/**
 * Make every data: picture one `target` can hold. Pictures it holds as they
 * are stay untouched; the others go to the render host, in `ctx.pictureFormat`
 * (PNG unless chosen) - except a picture the target holds but not at its
 * size (a Kindle's 5 MB), which is made smaller as JPEG (PNG when it has
 * transparency), the smaller of the two for a photograph. Without a
 * renderer nothing is converted and what the target cannot hold becomes its
 * alt text here, with a notice; for a target that shows no pictures the
 * HTML is returned as it came. A document with nothing to change is
 * returned as it came, so a picture-less document is written as before.
 */
export async function targetPictures(html: string, target: TargetFormat, ctx: DrawContext): Promise<string> {
  const render = ctx.renderBlocks
  const profile = PICTURE_TARGETS[target]
  if (!profile || !/<img/i.test(html)) return html
  const format = ctx.pictureFormat ?? DEFAULT_PICTURE_FORMAT
  const dom = parseDocument(html)
  interface Job {
    el: Element
    number: number
    request: RenderRequest
  }
  const jobs: Job[] = []
  let changed = false
  const failed = (n: number, why: string): void =>
    ctx.onAdvice?.('render-failed', `Picture ${n} could not be stored for ${profile.name}: ${why}`)
  const describe = (el: Element, n: number, why: string): void => {
    failed(n, why)
    toPlaceholder(el)
    changed = true
  }
  const picture = (source: string, as: PictureFormat): RenderRequest => ({
    kind: 'picture',
    source,
    display: true,
    format: 'png',
    fit: { maxBytes: profile.fitBytes, as },
  })
  let number = 0
  for (const el of images(dom.children)) {
    const data = dataBytes(el.attribs.src ?? '')
    if (!data || data.declared === 'image/svg+xml') continue
    number++
    const mime = pictureType(data.bytes)
    if (mime && profile.holds.has(mime) && data.bytes.length <= profile.maxBytes) continue
    if (!mime) {
      if (profile.unknown === 'describe') describe(el, number, `${typeName(data.declared)} pictures are not converted`)
      continue
    }
    if (data.bytes.length > MAX_PICTURE_BYTES) {
      describe(el, number, `it is over ${Math.round(MAX_PICTURE_BYTES / (1024 * 1024))} MB`)
      continue
    }
    if (vectorMime(data.bytes)) {
      const request = render ? vectorRequest(mime, data.bytes, format) : null
      if (request) jobs.push({ el, number, request })
      else describe(el, number, `${typeName(mime)} pictures are not converted`)
      continue
    }
    if (!render) {
      describe(el, number, `${typeName(mime)} pictures are not converted`)
      continue
    }
    // Held, but too large: made smaller in the kind that shrinks best.
    const as: PictureFormat = profile.holds.has(mime) ? 'jpeg' : format
    jobs.push({ el, number, request: picture(`data:${mime};base64,${data.bytes.toString('base64')}`, as) })
  }
  const { max, eachMs } = PICTURE_LIMITS
  for (const job of jobs.slice(max)) {
    toPlaceholder(job.el)
    changed = true
  }
  if (jobs.length > max) {
    ctx.onAdvice?.(
      'render-failed',
      `This document has ${jobs.length} pictures to convert for ${profile.name}; the first ${max} were converted and the other ${jobs.length - max} are shown as their descriptions`,
    )
  }
  const converted = jobs.slice(0, max)
  if (render && converted.length > 0) {
    changed = true
    const keyOf = (r: RenderRequest): string => JSON.stringify([r.kind, r.source, r.fit, r.page])
    const unique = [...new Map(converted.map((j) => [keyOf(j.request), j.request])).values()]
    let results: RenderResult[] | undefined
    try {
      results = await render(unique, { signal: ctx.signal, timeoutMs: eachMs })
    } catch (err) {
      if (ctx.signal?.aborted) throw err
      ctx.onAdvice?.('render-failed', `Pictures could not be converted for ${profile.name}: ${oneLine((err as Error)?.message ?? String(err))}`)
    }
    const byKey = new Map(unique.map((r, i) => [keyOf(r), results?.[i]]))
    for (const job of converted) {
      const result = byKey.get(keyOf(job.request))
      if (!results) {
        toPlaceholder(job.el)
        continue
      }
      if (result && !('error' in result)) {
        const png = typeof result.png === 'string' && BASE64.test(result.png) ? result.png : undefined
        const jpeg = typeof result.jpeg === 'string' && BASE64.test(result.jpeg) ? result.jpeg : undefined
        if (png || jpeg) {
          job.el.attribs.src = png ? `data:image/png;base64,${png}` : `data:image/jpeg;base64,${jpeg}`
          continue
        }
      }
      failed(job.number, result && 'error' in result ? oneLine(result.error) : 'the converter gave no picture')
      toPlaceholder(job.el)
    }
  }
  return changed ? serialize(dom, { encodeEntities: 'utf8' }) : html
}

/**
 * The writer's last word (core alone, or a picture nothing converted): every
 * picture a Kindle cannot store as it is becomes its alt text - a data:
 * picture of another type or over the limit, and an <img> whose src is not
 * a data: URI at all (a path into the source's own container that resolved
 * to nothing), which in a KF8 book would point at nothing. A
 * document with nothing to change is returned as it came, so a
 * picture-less book is written exactly as before.
 */
export function kindleFallback(html: string): string {
  if (!/<img/i.test(html)) return html
  const dom = parseDocument(html)
  let changed = false
  for (const el of images(dom.children)) {
    const data = dataBytes(el.attribs.src ?? '')
    if (data && storableAsIs(data.bytes)) continue
    toPlaceholder(el)
    changed = true
  }
  return changed ? serialize(dom, { encodeEntities: 'utf8' }) : html
}
