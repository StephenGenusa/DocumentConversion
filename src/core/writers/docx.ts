import HTMLtoDOCX from 'html-to-docx'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { renderDocumentShell } from '../shell'
import type { HubDocument } from '../types'

/**
 * html-to-docx tries to load every <img> and gives up on the whole document
 * when one cannot be resolved — a book with 90 relative image paths came out
 * as its table of contents and nothing else (6,305 of 306,150 characters).
 * Only data: and http(s) images can ever work here; drop the rest, keeping
 * their alt text so the reader knows something was there.
 */
function dropUnresolvableImages(html: string): string {
  if (!html.includes('<img')) return html
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1] ?? ''
    if (/^(data|https?):/i.test(src)) return tag
    const alt = /\balt="([^"]*)"/i.exec(tag)?.[1]?.trim()
    return alt ? `<p>[${alt}]</p>` : ''
  })
}

/** OPC relationship targets are relative to the folder holding the owning part. */
function resolvePart(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = baseDir.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Store each distinct image once, and drop the relationships left behind.
 *
 * html-to-docx embeds an <img> TWICE whenever the tag is not a direct child of
 * a <p>/<li> — a bare top-level image, or one inside a <figure>, <div> or
 * table cell. Its buildImage() writes the media part and a relationship, then
 * passes the same node down to buildParagraph -> buildRun, whose "picture"
 * branch writes a second copy under a fresh random name and embeds THAT one.
 * The first part and its relationship are orphaned, so every such image costs
 * twice its bytes. Repeating one image (a logo on every section) also stores a
 * fresh copy per use, which the same pass folds together.
 *
 * Identity is the image bytes, never the generated filename — html-to-docx
 * names each copy with a random id, so two names say nothing about whether the
 * pictures differ. Two genuinely different images keep two parts.
 *
 * Deleting an unreferenced image relationship is only safe because this runs
 * on our own html-to-docx output, where a picture is always reached through
 * r:embed on <a:blip>; r:link and r:id are scanned too, for good measure.
 */
async function dedupeMedia(zip: JSZip): Promise<void> {
  const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name].dir)
  if (media.length === 0) return

  // Content hash -> the one part that survives for those bytes.
  const canonical = new Map<string, string>()
  const survivor = new Map<string, string>()
  for (const name of media) {
    const hash = createHash('sha1').update(await zip.files[name].async('nodebuffer')).digest('hex')
    const first = canonical.get(hash)
    if (first) survivor.set(name, first)
    else {
      canonical.set(hash, name)
      survivor.set(name, name)
    }
  }

  const keep = new Set<string>()
  for (const relsName of Object.keys(zip.files).filter((name) => /^word\/_rels\/.+\.rels$/.test(name))) {
    const ownerName = relsName.replace('/_rels/', '/').replace(/\.rels$/, '')
    const owner = zip.files[ownerName]
    if (!owner) continue
    const baseDir = ownerName.slice(0, ownerName.lastIndexOf('/') + 1)
    const ownerXml = await owner.async('string')
    const referenced = new Set(
      [...ownerXml.matchAll(/\br:(?:embed|link|id)="([^"]+)"/g)].map((match) => match[1]),
    )
    const rewritten = (await zip.files[relsName].async('string')).replace(/<Relationship\b[^>]*>/g, (rel) => {
      if (!/relationships\/image/.test(rel)) return rel
      const id = /\bId="([^"]+)"/.exec(rel)?.[1] ?? ''
      const target = /\bTarget="([^"]+)"/.exec(rel)?.[1] ?? ''
      const part = resolvePart(baseDir, target)
      // Nothing embeds it: this is html-to-docx's orphaned first copy.
      if (!referenced.has(id)) return ''
      const kept = survivor.get(part) ?? part
      keep.add(kept)
      const retargeted = kept.startsWith(baseDir) ? kept.slice(baseDir.length) : `/${kept}`
      return rel.replace(/\bTarget="[^"]*"/, `Target="${retargeted}"`)
    })
    zip.file(relsName, rewritten)
  }

  for (const name of media) if (!keep.has(name)) zip.remove(name)
}

/**
 * html-to-docx writes every zip entry STORED, so a large document balloons —
 * one workbook produced a 182 MB .docx that Word struggles to open. Repacking
 * with deflate is lossless and typically 20-30x smaller.
 */
async function recompress(docx: Buffer): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(docx)
    // Repacking is the one chance to fix the media parts; a failure there must
    // not cost the (much larger) compression win, so it is caught separately.
    try {
      await dedupeMedia(zip)
    } catch {
      /* leave the media parts as html-to-docx wrote them */
    }
    return await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      // Word wants the content-types part first.
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
  } catch {
    return docx
  }
}

/**
 * html-to-docx loses content around <span> elements — a book with 457 of them
 * came out as 6,305 of its 306,150 characters, and removing only the spans
 * restored 329,673. They are presentational, so unwrap them and keep the text.
 */
function unwrapSpans(html: string): string {
  return html.replace(/<\/?span\b[^>]*>/gi, '')
}

export async function writeDocx(doc: HubDocument): Promise<Buffer> {
  const html = renderDocumentShell(
    { ...doc, html: unwrapSpans(dropUnresolvableImages(doc.html)) },
    { target: 'docx' },
  )
  const result = await HTMLtoDOCX(html)
  return recompress(Buffer.isBuffer(result) ? result : Buffer.from(result as ArrayBuffer))
}
