import { parseDocument } from 'htmlparser2'
import { Element, Text, type ChildNode } from 'domhandler'
import { append, replaceElement } from 'domutils'
import serialize from 'dom-serializer'
import { imageMime } from './readers/image'
import { imagePlaceholder, MAX_FETCHED_IMAGE_BYTES } from './inline-images'
import type { PictureFormat, RenderRequest, RenderResult } from './rendered-blocks'
import { DOCX_MAX_WIDTH, type DrawContext } from './draw-blocks'
import type { TargetFormat } from './types'
import { originalSize, tiffPage, tiffPages } from './picture-headers'
import { drawMetafile, type MetafileResult } from './metafile'
import { sanitizeSvg, svgDataUri } from './svg-sanitize'
import { DOCX_MAX_HEIGHT, prepareSvgForRaster, rasterizesSvgImages } from './svg-images'
import { createHash } from 'node:crypto'

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
 * reader shows as a broken icon: anything unrecognised, and an EMF or WMF
 * the metafile drawing code cannot draw. SVG images do not reach here as
 * pictures to convert: svg-images.ts made PNG copies for the targets
 * without SVG.
 *
 * EMF and WMF (Word's vector pictures) are kept by Word; for every other
 * target they are drawn by our own code (metafile/, vectorRequest):
 *
 *   one bitmap    a metafile that is only a bitmap covering its frame (a
 *                 pasted screenshot or photograph) becomes that bitmap,
 *                 exactly: its own JPEG or PNG, or its pixels as PNG.
 *   SVG           everywhere the document's SVG images stay SVG (web
 *                 pages, slides, PDF, AZW4, EPUB, Markdown): a drawing
 *                 stays a drawing - sharp at any zoom, printed as vectors
 *                 by Chromium, its text still text - and is usually far
 *                 smaller than a picture of it. Sanitised like any SVG.
 *   PNG           where SVG images become PNG (Kindle's AZW3, Word for a
 *                 metafile whose header gives no size, HTML for pasting):
 *                 the SVG rasterised by the render host, fitted to Word's
 *                 page and drawn at twice that, like an SVG image. PNG,
 *                 not JPEG, whatever pictureFormat says: lines and text
 *                 stay crisp and colours flat.
 *
 * Where an RTF picture comes with a bitmap beside it (\\nonshppict), a
 * metafile that can be drawn is chosen over that bitmap: it is the
 * picture, the bitmap a low-resolution copy for old readers.
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

/**
 * How long each picture may take to convert. Every picture is converted,
 * however many there are (owner, 2026-10-16: the earlier cap of 200 per
 * document is gone); they are asked for `batch` at a time, as SVG images are,
 * so each request to the render host stays small.
 */
export const PICTURE_LIMITS = { eachMs: 20_000, batch: 25 } as const

/**
 * The largest copy the render host makes where the target sets no limit:
 * the largest picture the app fetches (owner, 2026-10-16). A picture of any
 * size is converted (the earlier 30 MB cap is gone); a copy that would be
 * larger still is scaled down to this, never dropped.
 */
const MAX_COPY_BYTES = MAX_FETCHED_IMAGE_BYTES

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
  /** Of the types it holds, those it holds only when their header gives their size (Word: TIFF, EMF, WMF). */
  sized?: ReadonlySet<string>
}

/**
 * What Word shows that html-to-docx cannot size: kept as they are, sized
 * from their own headers by the docx writer (originalSize). A TIFF of
 * several pages reaches Word as one TIFF a page (splitTiffPages): Word shows
 * only a TIFF's first page.
 */
const WORD_ORIGINALS: ReadonlySet<string> = new Set(['image/tiff', 'image/x-emf', 'image/x-wmf'])

const browser = (name: string, unknown: PictureTarget['unknown']): PictureTarget => ({
  name,
  holds: BROWSER_HOLDS,
  maxBytes: Infinity,
  fitBytes: MAX_COPY_BYTES,
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
 *   docx              PNG, JPEG, GIF, BMP, WebP, and TIFF, EMF and WMF as they are
 *                     (one-page TIFF; each sized from its header)
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
    fitBytes: MAX_COPY_BYTES,
    unknown: 'describe',
  },
  azw3: { name: 'Kindle', holds: KINDLE_HOLDS, maxBytes: KINDLE_IMAGE_MAX_BYTES, fitBytes: KINDLE_IMAGE_MAX_BYTES, unknown: 'describe' },
  md: {
    name: 'Markdown',
    holds: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    maxBytes: Infinity,
    fitBytes: MAX_COPY_BYTES,
    unknown: 'keep',
  },
  docx: {
    name: 'Word',
    holds: new Set(['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', ...WORD_ORIGINALS]),
    maxBytes: Infinity,
    fitBytes: MAX_COPY_BYTES,
    unknown: 'describe',
    sized: WORD_ORIGINALS,
  },
}

function holds(profile: PictureTarget, mime: string, bytes: Buffer): boolean {
  if (!profile.holds.has(mime) || bytes.length > profile.maxBytes) return false
  return !profile.sized?.has(mime) || originalSize(mime, bytes) !== null
}

/** The picture types the docx writer passes to html-to-docx, by their bytes: the ones it can size. */
export function wordTakes(bytes: Buffer): boolean {
  const mime = pictureMime(bytes)
  return mime !== null && PICTURE_TARGETS.docx!.holds.has(mime) && !WORD_ORIGINALS.has(mime)
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

/** How an EMF or WMF reaches a target that cannot hold it (vectorRequest). */
type VectorPlan =
  | { src: string; width: number; height: number; bitmap?: { mime: string; bytes: Buffer } }
  | { request: RenderRequest; width: number; height: number }
  | { error: string }

/**
 * EMF and WMF, for a target that cannot hold them: drawn (metafile/), and
 * then given as the bitmap it is, as SVG (`raster` false), or as the
 * render request that rasterises that SVG (`raster`, with a renderer).
 * See the top of this file for which and why.
 */
function vectorRequest(mime: string, drawn: MetafileResult, opts: { raster: boolean; render: boolean }): VectorPlan {
  const type = typeName(mime)
  if ('error' in drawn) return { error: `the ${type} picture could not be drawn: ${drawn.error}` }
  const { width, height } = drawn
  if (drawn.bitmap) {
    const { mime: m, bytes } = drawn.bitmap
    return { src: `data:${m};base64,${bytes.toString('base64')}`, width, height, bitmap: { mime: m, bytes } }
  }
  const svg = sanitizeSvg(drawn.svg)
  if (!svg) return { error: `the ${type} picture could not be drawn` }
  if (!opts.raster) return { src: svgDataUri(svg), width, height }
  if (!opts.render) return { error: `${type} pictures are not converted` }
  const prepared = prepareSvgForRaster(svg, { width, height, maxWidth: DOCX_MAX_WIDTH, maxHeight: DOCX_MAX_HEIGHT })
  if (!prepared) return { error: `the ${type} picture could not be drawn` }
  return { request: { kind: 'svg', source: prepared.svg, display: true, format: 'png' }, width: prepared.width, height: prepared.height }
}

/** Each metafile drawn once per conversion, however many times a document shows it. */
function metafileDrawer(): (bytes: Buffer) => MetafileResult {
  const seen = new Map<string, MetafileResult>()
  return (bytes) => {
    const key = createHash('sha1').update(bytes).digest('hex')
    let r = seen.get(key)
    if (!r) {
      r = drawMetafile(bytes)
      seen.set(key, r)
    }
    return r
  }
}

/** An <img> given the size it is shown at, where it says none (a picture replaced by one of another size). */
function sizeIfUnsized(el: Element, width: number, height: number): void {
  if (el.attribs.width !== undefined || el.attribs.height !== undefined) return
  el.attribs.width = String(Math.max(1, Math.round(width)))
  el.attribs.height = String(Math.max(1, Math.round(height)))
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
 * A picture that came with an alternate (`data-alt-src`: an RTF picture's
 * `\\nonshppict` fallback, readers/rtf.ts) becomes whichever of the two the
 * target can use best: one it holds as it is, else one that can be
 * converted (a metafile that can be drawn, then a raster picture), else
 * the picture itself. So Word keeps an EMF, and a web page shows the EMF
 * drawn rather than the DIB written beside it for old readers. The
 * attribute goes, whichever is kept. Answers whether anything changed.
 */
function chooseAlternates(dom: ReturnType<typeof parseDocument>, profile: PictureTarget, drawable: (bytes: Buffer) => boolean): boolean {
  let changed = false
  const rank = (src: string): number => {
    const data = dataBytes(src)
    const mime = data && pictureType(data.bytes)
    if (!data || !mime) return 0
    if (holds(profile, mime, data.bytes)) return 3
    // A metafile that draws is as good as one held: it is the picture itself,
    // a bitmap beside it a low-resolution copy. (A tie keeps the first.)
    if (vectorMime(data.bytes)) return drawable(data.bytes) ? 3 : 1
    return pictureMime(data.bytes) ? 2 : 1
  }
  for (const el of images(dom.children)) {
    const alternate = el.attribs['data-alt-src']
    if (alternate === undefined) continue
    delete el.attribs['data-alt-src']
    changed = true
    if (rank(alternate) > rank(el.attribs.src ?? '')) el.attribs.src = alternate
  }
  return changed
}

/**
 * A TIFF of several pages (a fax, a scanned letter) becomes one picture per
 * page, in order, where the TIFF stood, each alt text the TIFF's with its
 * page number: no target shows more than a TIFF's first page (Word and
 * every viewer included), so a page kept inside one picture is a page
 * lost. Each page is taken out as a one-page TIFF of its own, its data byte
 * for byte (picture-headers.ts), and is then held or converted like any
 * one-page picture. A page whose data cannot be taken out on its own is
 * given to the render host as the whole file and its place in it
 * (`pageOf`). A preview (reduced-resolution copy) is not a page. Answers
 * whether anything changed.
 */
function splitTiffPages(dom: ReturnType<typeof parseDocument>, pageOf: Map<Element, number>): boolean {
  let changed = false
  for (const el of images(dom.children)) {
    const data = dataBytes(el.attribs.src ?? '')
    if (!data || pictureMime(data.bytes) !== 'image/tiff') continue
    const pages = tiffPages(data.bytes)
    if (!pages || pages.length === 0 || (pages.length === 1 && pages[0].index === 0)) continue
    const alt = el.attribs.alt?.trim()
    // A TIFF that is its paragraph's one content gets a paragraph a page (a
    // page can then start a new page of its own); one in a line of text, a
    // line a page.
    const parent = el.parent instanceof Element ? el.parent : null
    const alone =
      parent?.name === 'p' && parent.children.every((c) => c === el || (c instanceof Text && !c.data.trim()))
    let last: Element = alone ? parent! : el
    pages.forEach((page, i) => {
      const own = tiffPage(data.bytes, page.index)
      const label = pages.length > 1 ? `page ${i + 1} of ${pages.length}` : ''
      const attribs: Record<string, string> = { ...el.attribs, src: `data:image/tiff;base64,${(own ?? data.bytes).toString('base64')}` }
      const text = alt && label ? `${alt} (${label})` : alt || (label && label[0].toUpperCase() + label.slice(1))
      if (text) attribs.alt = text
      else delete attribs.alt
      const img = new Element('img', attribs)
      if (!own) pageOf.set(img, page.index)
      if (i === 0) replaceElement(el, img)
      else if (alone) {
        const p = new Element('p', { ...parent!.attribs }, [img])
        img.parent = p
        append(last, p)
        last = p
        return
      } else {
        const br = new Element('br', {})
        append(last, br)
        append(br, img)
      }
      if (!alone) last = img
    })
    changed = true
  }
  return changed
}

/** The data: URL of a converted picture, or undefined when the answer is not one. */
function answerSrc(result: RenderResult): string | undefined {
  if ('error' in result) return undefined
  const png = typeof result.png === 'string' && BASE64.test(result.png) ? result.png : undefined
  const jpeg = typeof result.jpeg === 'string' && BASE64.test(result.jpeg) ? result.jpeg : undefined
  return png ? `data:image/png;base64,${png}` : jpeg ? `data:image/jpeg;base64,${jpeg}` : undefined
}

/**
 * Each distinct request asked once, `PICTURE_LIMITS.batch` at a time, each
 * given `eachMs`. Answers by request; a request missing from the answer was
 * not reached because the converter went down (said once, here).
 */
async function convertAll(
  requests: RenderRequest[],
  render: NonNullable<DrawContext['renderBlocks']>,
  ctx: DrawContext,
  name: string,
): Promise<Map<RenderRequest, RenderResult | undefined>> {
  const { eachMs, batch } = PICTURE_LIMITS
  // By a hash of the source, made once a request: a picture's data: URL may run to hundreds of MB.
  const keys = new Map(requests.map((r) => [r, JSON.stringify([r.kind, createHash('sha1').update(r.source).digest('hex'), r.fit, r.page])]))
  const unique = [...new Map(requests.map((r) => [keys.get(r)!, r])).values()]
  const byKey = new Map<string, RenderResult | undefined>()
  for (let i = 0; i < unique.length; i += batch) {
    const part = unique.slice(i, i + batch)
    let results: RenderResult[]
    try {
      results = await render(part, { signal: ctx.signal, timeoutMs: eachMs })
    } catch (err) {
      if (ctx.signal?.aborted) throw err
      ctx.onAdvice?.('render-failed', `Pictures could not be converted for ${name}: ${oneLine((err as Error)?.message ?? String(err))}`)
      break
    }
    part.forEach((r, k) => byKey.set(keys.get(r)!, results[k]))
  }
  const out = new Map<RenderRequest, RenderResult | undefined>()
  for (const r of requests) if (byKey.has(keys.get(r)!)) out.set(r, byKey.get(keys.get(r)!))
  return out
}

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
  const pageOf = new Map<Element, number>()
  // Metafiles become SVG where the document's SVG images stay SVG, PNG where they become PNG.
  const raster = rasterizesSvgImages(target) || ctx.svgImagesAsPng === true
  const draw = metafileDrawer()
  const drawable = (bytes: Buffer): boolean => {
    const r = draw(bytes)
    return !('error' in r) && (!!r.bitmap || !raster || !!render)
  }
  let changed = chooseAlternates(dom, profile, drawable)
  changed = splitTiffPages(dom, pageOf) || changed
  interface Job {
    el: Element
    number: number
    request: RenderRequest
    /** The size it is shown at, given to an <img> that says none. */
    size?: { width: number; height: number }
  }
  const jobs: Job[] = []
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
    if (mime && holds(profile, mime, data.bytes)) continue
    if (!mime) {
      if (profile.unknown === 'describe') describe(el, number, `${typeName(data.declared)} pictures are not converted`)
      continue
    }
    if (vectorMime(data.bytes)) {
      const plan = vectorRequest(mime, draw(data.bytes), { raster, render: !!render })
      if ('error' in plan) describe(el, number, plan.error)
      else if ('request' in plan) jobs.push({ el, number, request: plan.request, size: plan })
      else {
        el.attribs.src = plan.src
        sizeIfUnsized(el, plan.width, plan.height)
        changed = true
        // The bitmap a metafile is, where the target holds it only smaller (a Kindle's 5 MB).
        const b = plan.bitmap
        if (b && !holds(profile, b.mime, b.bytes)) {
          if (render) jobs.push({ el, number, request: picture(plan.src, 'jpeg') })
          else describe(el, number, `it is over ${Math.round(profile.maxBytes / (1024 * 1024))} MB`)
        }
      }
      continue
    }
    if (!render) {
      describe(el, number, `${typeName(mime)} pictures are not converted`)
      continue
    }
    // Held, but too large: made smaller in the kind that shrinks best.
    const as: PictureFormat = profile.holds.has(mime) && data.bytes.length > profile.maxBytes ? 'jpeg' : format
    const request = picture(`data:${mime};base64,${data.bytes.toString('base64')}`, as)
    const page = pageOf.get(el)
    jobs.push({ el, number, request: page === undefined ? request : { ...request, page } })
  }
  if (render && jobs.length > 0) {
    changed = true
    const results = await convertAll(jobs.map((j) => j.request), render, ctx, profile.name)
    for (const job of jobs) {
      // The converter went down before this one: said once, in convertAll.
      if (!results.has(job.request)) {
        toPlaceholder(job.el)
        continue
      }
      const result = results.get(job.request)
      const src = result && answerSrc(result)
      if (src) {
        job.el.attribs.src = src
        if (job.size) sizeIfUnsized(job.el, job.size.width, job.size.height)
        continue
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
