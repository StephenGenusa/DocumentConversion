import JSZip from 'jszip'
import { createHash, randomUUID } from 'node:crypto'
import { parseDocument } from 'htmlparser2'
import { Element, type AnyNode } from 'domhandler'
import render from 'dom-serializer'
import { escapeHtml } from '../shell'
import type { HubDocument } from '../types'

/**
 * EPUB writer.
 *
 * An epub is a zip with a required layout, and one rule in it is unforgiving:
 * readers identify the format by reading `mimetype` at a FIXED OFFSET, so that
 * entry must be written FIRST and STORED, never deflated. Getting it wrong is
 * the most common reason a generated epub refuses to open at all, which is why
 * a test checks the raw local file header rather than JSZip's own view.
 *
 * Everything else follows from the hub: chapters come from the document's own
 * headings, images come back out of the data URIs the readers inlined, and the
 * markup is re-serialized as XHTML because EPUB 2 and 3 both require
 * well-formed XML and a parse error shows the reader nothing at all.
 */

const OEBPS = 'OEBPS'
const NS = 'http://www.w3.org/1999/xhtml'

/** Minimal reading styles. Readers restyle anyway; this only avoids the ugly defaults. */
const STYLESHEET = `body { font-family: serif; line-height: 1.5; margin: 1em; }
h1, h2, h3 { line-height: 1.25; }
img { max-width: 100%; height: auto; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.85em; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #999; padding: 0.3em 0.5em; }
`

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

interface Chapter {
  /** Heading text, used for the navigation label. */
  title: string
  nodes: AnyNode[]
}

const isElement = (n: AnyNode): n is Element => n instanceof Element

function textOf(node: AnyNode): string {
  return render([node], { decodeEntities: false })
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Containers that carry no meaning of their own, so a heading inside one is
 * still a chapter heading. Deliberately does NOT include list, table or
 * blockquote elements, whose nesting IS their meaning.
 */
const TRANSPARENT = new Set(['div', 'section', 'article', 'main', 'body'])

/** Elements that can never legitimately sit inside inline markup. */
const BLOCK = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'table', 'ul', 'ol', 'blockquote', 'pre', 'hr', 'section', 'article',
])

/**
 * A `<span>` holding block content is a wrapper, not inline markup: the corpus
 * book puts thirteen of its twenty `<h1>` inside one. The hub allowlist strips
 * every attribute from a span, so such an element carries no meaning at all —
 * but only spans that really do contain block content are treated this way, so
 * ordinary inline spans keep their place.
 */
function isBlockWrapper(node: Element): boolean {
  return node.name === 'span' && (node.children as AnyNode[]).some((c) => isElement(c) && BLOCK.has(c.name))
}

/**
 * Flatten generic wrappers at the top level so the headings inside them are
 * visible to the split.
 *
 * Real books wrap each chapter's body in a <div> or <section>: scanning only
 * the hub's immediate children found no headings at all in a 231-page corpus
 * book that has twenty <h1>, and produced two chapters for the whole thing.
 * Only the top level is flattened, and only these tags, so a <div> inside a
 * table cell or list item keeps its place.
 */
export function unwrapContainers(nodes: AnyNode[]): AnyNode[] {
  const out: AnyNode[] = []
  for (const node of nodes) {
    if (isElement(node) && (TRANSPARENT.has(node.name) || isBlockWrapper(node))) {
      out.push(...unwrapContainers(node.children as AnyNode[]))
      continue
    }
    out.push(node)
  }
  return out
}

/**
 * Split the document at its own headings.
 *
 * h1 first; h2 when the document has fewer than two h1, because a book whose
 * single h1 is its title would otherwise become one enormous chapter — and one
 * huge XHTML file is exactly the shape that makes an e-reader crawl. Content
 * before the first heading is kept as its own chapter rather than dropped.
 */
export function splitChapters(nodes: AnyNode[]): Chapter[] {
  const count = (tag: string): number => nodes.filter((n) => isElement(n) && n.name === tag).length
  const level = count('h1') >= 2 ? 'h1' : count('h2') >= 2 ? 'h2' : count('h1') === 1 ? 'h1' : ''

  const chapters: Chapter[] = []
  let current: Chapter | null = null
  for (const node of nodes) {
    if (level !== '' && isElement(node) && node.name === level) {
      current = { title: textOf(node) || `Chapter ${chapters.length + 1}`, nodes: [node] }
      chapters.push(current)
      continue
    }
    if (!current) {
      current = { title: 'Start', nodes: [] }
      chapters.push(current)
    }
    current.nodes.push(node)
  }
  return chapters.filter((c) => c.nodes.length > 0)
}

interface ExtractedImage {
  name: string
  mime: string
  bytes: Buffer
}

/**
 * Pull the readers' inlined `data:` images back out into files.
 *
 * The readers inline deliberately — a zip-relative path resolves nowhere once
 * the document leaves its container — so writing an epub is the one place that
 * has to reverse it. Identity is the image bytes, never the URI: a logo
 * repeated in every chapter must be stored once, exactly as the docx writer
 * already does. Remote references are left alone; they still resolve.
 */
export function extractImages(nodes: AnyNode[]): ExtractedImage[] {
  const byHash = new Map<string, ExtractedImage>()
  const walk = (list: AnyNode[]): void => {
    for (const node of list) {
      if (!isElement(node)) continue
      if (node.name === 'img') {
        const src = node.attribs?.src ?? ''
        const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(src)
        if (match) {
          const mime = match[1].toLowerCase()
          const ext = IMAGE_EXT[mime]
          if (ext) {
            const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
            const hash = createHash('sha1').update(bytes).digest('hex')
            let image = byHash.get(hash)
            if (!image) {
              image = { name: `img${String(byHash.size + 1).padStart(3, '0')}.${ext}`, mime, bytes }
              byHash.set(hash, image)
            }
            node.attribs.src = `images/${image.name}`
          }
        }
      }
      walk(node.children as AnyNode[])
    }
  }
  walk(nodes)
  return [...byHash.values()]
}

/** Serialize as XHTML: void elements self-close and every bare & is escaped. */
function toXhtml(nodes: AnyNode[]): string {
  return render(nodes, { xmlMode: true, decodeEntities: true, selfClosingTags: true })
}

function chapterDocument(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="${NS}" xml:lang="en">
<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>`
}

function navDocument(chapters: { file: string; title: string }[]): string {
  const items = chapters
    .map((c) => `<li><a href="${c.file}">${escapeHtml(c.title)}</a></li>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="${NS}" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${items}
</ol></nav>
</body>
</html>`
}

/** EPUB 2 navigation, kept because plenty of devices still read only this. */
function ncxDocument(uid: string, title: string, chapters: { file: string; title: string }[]): string {
  const points = chapters
    .map(
      (c, i) =>
        `<navPoint id="nav${i + 1}" playOrder="${i + 1}">` +
        `<navLabel><text>${escapeHtml(c.title)}</text></navLabel>` +
        `<content src="${c.file}"/></navPoint>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${uid}"/></head>
<docTitle><text>${escapeHtml(title)}</text></docTitle>
<navMap>
${points}
</navMap>
</ncx>`
}

function opfDocument(
  uid: string,
  title: string,
  language: string,
  chapters: { id: string; file: string }[],
  images: ExtractedImage[],
): string {
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...chapters.map((c) => `<item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"/>`),
    ...images.map(
      (img, i) =>
        `<item id="img${i + 1}" href="images/${img.name}" media-type="${img.mime}"` +
        `${i === 0 ? ' properties="cover-image"' : ''}/>`,
    ),
  ].join('\n')
  const spine = chapters.map((c) => `<itemref idref="${c.id}"/>`).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeHtml(title)}</dc:title>
<dc:language>${escapeHtml(language)}</dc:language>
<dc:identifier id="bookid">urn:uuid:${uid}</dc:identifier>
</metadata>
<manifest>
${manifest}
</manifest>
<spine toc="ncx">
${spine}
</spine>
</package>`
}

export async function writeEpub(doc: HubDocument): Promise<Buffer> {
  const dom = parseDocument(doc.html)
  const nodes = unwrapContainers(dom.children as AnyNode[])
  const images = extractImages(nodes)
  const chapters = splitChapters(nodes)
  const parts = (chapters.length > 0 ? chapters : [{ title: 'Document', nodes }]).map((c, i) => ({
    id: `ch${i + 1}`,
    file: `ch${String(i + 1).padStart(3, '0')}.xhtml`,
    title: c.title,
    body: toXhtml(c.nodes),
  }))

  const uid = randomUUID()
  const title = doc.title?.trim() || 'Document'
  const language = doc.language?.trim() || 'en'

  const zip = new JSZip()
  // FIRST and STORED — see the file header comment. Both are load-bearing.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="${OEBPS}/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  )
  zip.file(`${OEBPS}/style.css`, STYLESHEET)
  for (const part of parts) zip.file(`${OEBPS}/${part.file}`, chapterDocument(part.title, part.body))
  zip.file(`${OEBPS}/nav.xhtml`, navDocument(parts))
  zip.file(`${OEBPS}/toc.ncx`, ncxDocument(uid, title, parts))
  zip.file(`${OEBPS}/content.opf`, opfDocument(uid, title, language, parts, images))
  for (const img of images) zip.file(`${OEBPS}/images/${img.name}`, img.bytes)

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Promise<Buffer>
}
