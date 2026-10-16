import { parseDocument } from 'htmlparser2'
import { Element, type ChildNode } from 'domhandler'
import { replaceElement } from 'domutils'
import serialize from 'dom-serializer'
import { imageMime } from './readers/image'
import { imagePlaceholder } from './inline-images'
import { MAX_PICTURE_BYTES, type RenderResult } from './rendered-blocks'
import type { DrawContext } from './draw-blocks'
import type { TargetFormat } from './types'

/*
 * Pictures for a Kindle book (AZW3/KF8). A KF8 image record holds a JPEG,
 * PNG or GIF, and this app stores one exactly as the document has it when it
 * is one of those and under the size limit. Anything else - WebP, BMP, AVIF,
 * ICO, TIFF, or a picture over the limit - is re-encoded by the render host
 * (kind `picture`): decoded in its sandboxed page, never in the main
 * process, where a malformed file can take the app down (Skia, in
 * @napi-rs/canvas, crashes on some), and answered as PNG when it has
 * transparency, JPEG when not. Chromium has no TIFF decoder, so the page
 * decodes TIFF with UTIF.js (vendored in resources/render). What cannot be
 * stored becomes its alt text, with a notice, so a book never holds a
 * reference to nothing: EMF and WMF (Word's vector pictures, which nothing
 * here can draw), and anything unrecognised. SVG images do not reach here:
 * they get PNG copies first (svg-images.ts).
 *
 * Size limit, per picture: 5 MB. Classic MOBI capped image records at about
 * 127 KB (64 KB on early readers), and kindlegen's MOBI7 half still shrinks
 * pictures to that; KF8 itself has no record size limit (PalmDB offsets are
 * 32-bit), and we write KF8 only. Amazon's publishing guidelines allow 5 MB
 * per image in a KF8 book; calibre's KF8 writer allows 10 MB. We take
 * Amazon's 5 MB: under it a picture is stored as given; over it, it is
 * re-encoded - JPEG at falling quality, then scaled down; PNG (transparency)
 * scaled down - until it fits.
 */

export const KINDLE_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** Per conversion: how many pictures are re-encoded, and how long each may take. */
export const KINDLE_PICTURE_LIMITS = { max: 200, eachMs: 20_000 } as const

/** What a KF8 image record may hold. */
const STORABLE = new Set(['image/jpeg', 'image/png', 'image/gif'])

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

/** What a picture's type is called in a notice: "EMF" for image/x-emf, "TIFF" for image/tiff. */
function typeName(mime: string): string {
  return mime.replace(/^image\//, '').replace(/^(x-|vnd\.(ms-|microsoft\.)?)/, '').toUpperCase()
}

/** Whether a Kindle stores these bytes as they are: JPEG, PNG or GIF, under the limit. */
export function storableAsIs(bytes: Buffer, maxBytes = KINDLE_IMAGE_MAX_BYTES): boolean {
  const mime = imageMime(bytes)
  return mime !== null && STORABLE.has(mime) && bytes.length <= maxBytes
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
 * Make every data: picture Kindle-ready, at write time, for azw3 (called by
 * Converter.write() after the SVG images have their PNG copies). Pictures a
 * Kindle stores as they are stay untouched; the others go to the render
 * host. Without a renderer, or for another target, the HTML is returned as
 * it came, and the writer turns what it cannot store into alt text
 * (kindleFallback).
 */
export async function kindlePictures(html: string, target: TargetFormat, ctx: DrawContext): Promise<string> {
  const render = ctx.renderBlocks
  if (!render || target !== 'azw3' || !/<img/i.test(html)) return html
  const dom = parseDocument(html)
  interface Job {
    el: Element
    number: number
    source: string
  }
  const jobs: Job[] = []
  let changed = false
  const failed = (n: number, why: string): void =>
    ctx.onAdvice?.('render-failed', `Picture ${n} could not be stored for Kindle: ${why}`)
  let number = 0
  for (const el of images(dom.children)) {
    const data = dataBytes(el.attribs.src ?? '')
    if (!data || data.declared === 'image/svg+xml') continue
    number++
    if (storableAsIs(data.bytes)) continue
    const mime = pictureMime(data.bytes)
    if (!mime) {
      failed(number, `a Kindle cannot show ${typeName(data.declared)} pictures`)
      toPlaceholder(el)
      changed = true
    } else if (data.bytes.length > MAX_PICTURE_BYTES) {
      failed(number, `it is over ${Math.round(MAX_PICTURE_BYTES / (1024 * 1024))} MB`)
      toPlaceholder(el)
      changed = true
    } else {
      jobs.push({ el, number, source: `data:${mime};base64,${data.bytes.toString('base64')}` })
    }
  }
  const { max, eachMs } = KINDLE_PICTURE_LIMITS
  for (const job of jobs.slice(max)) {
    toPlaceholder(job.el)
    changed = true
  }
  if (jobs.length > max) {
    ctx.onAdvice?.(
      'render-failed',
      `This document has ${jobs.length} pictures to convert for Kindle; the first ${max} were converted and the other ${jobs.length - max} are shown as their descriptions`,
    )
  }
  const converted = jobs.slice(0, max)
  if (converted.length > 0) {
    changed = true
    const unique = [...new Set(converted.map((j) => j.source))]
    let results: RenderResult[] | undefined
    try {
      results = await render(
        unique.map((source) => ({ kind: 'picture', source, display: true, format: 'png', fit: { maxBytes: KINDLE_IMAGE_MAX_BYTES } })),
        { signal: ctx.signal, timeoutMs: eachMs },
      )
    } catch (err) {
      if (ctx.signal?.aborted) throw err
      ctx.onAdvice?.('render-failed', `Pictures could not be converted for Kindle: ${oneLine((err as Error)?.message ?? String(err))}`)
    }
    const bySource = new Map(unique.map((source, i) => [source, results?.[i]]))
    for (const job of converted) {
      const result = bySource.get(job.source)
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
 * document with nothing to change is returned as it came, so a picture-less
 * book is written exactly as before.
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
