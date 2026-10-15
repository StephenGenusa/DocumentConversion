import { createHash } from 'node:crypto'
import { parseDocument } from 'htmlparser2'
import { textContent } from 'domutils'
import type { TargetFormat } from './types'
import {
  DRAWN_KINDS,
  hubFeatures,
  renderedFormatFor,
  type RenderBlocks,
  type RenderFormat,
  type BlockKind,
  type RenderRequest,
  type RenderResult,
} from './rendered-blocks'

/*
 * Drawing a document's diagrams for output (spec B3, B5, B7), at write time.
 * Kept apart from rendered-blocks.ts, which the renderer imports and so must
 * stay free of Node modules.
 */

/**
 * The key a drawing is cached under, by the host, for conversions and the
 * editor alike (spec B5). Encoded as a JSON array so no two different
 * requests can run together into one string.
 */
export function renderCacheKey(req: RenderRequest, engineVersion: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        // `fit` only where it is given, so every earlier key stays as it was.
        req.fit
          ? [req.kind, req.display, req.format, req.source, engineVersion, req.fit.maxBytes]
          : [req.kind, req.display, req.format, req.source, engineVersion],
      ),
    )
    .digest('hex')
}

/** Per conversion (spec B7), Mermaid and Graphviz together. Formulas join when MathJax does (step 18). */
export const RENDER_LIMITS = {
  diagrams: { max: 50, eachMs: 10_000 },
} as const

/**
 * Targets that draw blocks (spec B3). md and txt keep the source with its
 * delimiters; the table targets have no place for a picture. Word and
 * Kindle (azw3) take no SVG, so they are drawn as PNG (renderedFormatFor).
 */
const RENDER_TARGETS: ReadonlySet<TargetFormat> = new Set(['pdf', 'html', 'revealjs', 'epub', 'azw4', 'docx', 'azw3'])

/** Whether `target` draws diagrams (true) or keeps them as source. */
export function rendersBlocks(target: TargetFormat): boolean {
  return RENDER_TARGETS.has(target)
}

/**
 * Marks a picture this pass drew, for the writers that must tell it from the
 * document's own images: the EPUB writer never makes one the cover. It
 * exists only between write() and the writer; the sanitiser drops it, so it
 * never comes back into a document read from this app's own output.
 */
export const RENDERED_MARKER = 'data-rendered'

/**
 * The widest picture Word is given, in CSS px: the text width of the Letter
 * page with 1-inch margins html-to-docx writes (6.5 in at 96 px/in).
 * html-to-docx takes an image's width from its style as given, so without
 * this a wide diagram would run off the page; the other targets have CSS
 * max-width.
 */
export const DOCX_MAX_WIDTH = 624

/** A B1 diagram block, in the exact form the hub writes it (rendered-blocks.ts). */
const DIAGRAM_BLOCK_SOURCE = /<pre><code class="language-(mermaid|dot)">([\s\S]*?)<\/code><\/pre>/g

/**
 * The options for HTML put on the clipboard (Convert to clipboard): what
 * Word and Outlook (and Teams) show when it is pasted. They take no SVG data URI
 * from pasted HTML, so diagrams are drawn as PNG and the document's own SVG
 * images get PNG copies, whatever was chosen for an HTML file.
 */
export const FOR_PASTING = { renderedFormat: 'png', svgImagesAsPng: true } as const

export interface DrawContext {
  renderBlocks?: RenderBlocks
  /** The choice made; renderedFormatFor decides what each target gets. */
  format?: RenderFormat
  /** SVG images as PNG even where the target shows SVG (ConvertOptions.svgImagesAsPng). */
  svgImagesAsPng?: boolean
  signal?: AbortSignal
  onAdvice?: (kind: 'render-failed', message: string) => void
}

/**
 * Draw the document's diagrams for `target` (spec B3): each B1 block that is
 * drawn becomes a centred `<img>` of an SVG or PNG data URI (renderedFormatFor)
 * with alt "Diagram"; a
 * block that is not stays source, with a notice for each failure and one for
 * the blocks over the limit. Called by `Converter.write()` before the
 * writer; this HTML exists only between there and the writer.
 *
 * Without a renderer (core used on its own), or for a target that does not
 * draw, the HTML is returned untouched and nothing is said.
 */
export async function drawBlocks(html: string, target: TargetFormat, ctx: DrawContext): Promise<string> {
  const render = ctx.renderBlocks
  if (!render || !rendersBlocks(target) || !hubFeatures(html).diagrams) return html

  interface Block {
    start: number
    end: number
    kind: BlockKind
    source: string
    number: number
  }
  const blocks: Block[] = []
  for (const m of html.matchAll(DIAGRAM_BLOCK_SOURCE)) {
    const kind = m[1] as BlockKind
    if (!DRAWN_KINDS.has(kind)) continue
    blocks.push({ start: m.index, end: m.index + m[0].length, kind, source: decodeText(m[2]), number: blocks.length + 1 })
  }
  if (blocks.length === 0) return html

  const { max, eachMs } = RENDER_LIMITS.diagrams
  const drawn = blocks.slice(0, max)
  if (blocks.length > max) {
    const over = blocks.length - max
    ctx.onAdvice?.(
      'render-failed',
      `This document has ${blocks.length} diagrams; the first ${max} were drawn and the other ${over} are shown as source`,
    )
  }

  const format = renderedFormatFor(target, ctx.format)
  // One request per distinct diagram: one repeated is drawn once. The key
  // is the kind and the source, so the same text in two languages is two.
  const keyOf = (b: Block): string => JSON.stringify([b.kind, b.source])
  const unique = [...new Map(drawn.map((b) => [keyOf(b), b])).values()]
  let results: RenderResult[]
  try {
    results = await render(
      unique.map(({ kind, source }) => ({ kind, source, display: true, format })),
      { signal: ctx.signal, timeoutMs: eachMs },
    )
  } catch (err) {
    if (ctx.signal?.aborted) throw err
    const message = oneLine((err as Error)?.message ?? String(err))
    ctx.onAdvice?.('render-failed', `Diagrams could not be drawn: ${message}`)
    return html
  }
  const byKey = new Map(unique.map((b, i) => [keyOf(b), results[i]]))

  let out = ''
  let at = 0
  for (const block of drawn) {
    const result = byKey.get(keyOf(block))
    let replacement: string | undefined
    const data = result && !('error' in result) && result.width > 0 && result.height > 0 ? pictureData(result, format) : undefined
    if (data !== undefined && result && !('error' in result)) {
      replacement = pictureHtml(data, format, result.width, result.height, target)
    } else {
      const why = result && 'error' in result ? oneLine(result.error) : 'the engine gave no picture'
      ctx.onAdvice?.('render-failed', `Diagram ${block.number} could not be drawn: ${why}`)
    }
    if (replacement === undefined) continue
    out += html.slice(at, block.start) + replacement
    at = block.end
  }
  return out + html.slice(at)
}

const BASE64 = /^[A-Za-z0-9+/]+=*$/
/** An SVG document, as the host returns it (sanitised there, spec B6). */
const SVG_DOCUMENT = /^\s*(?:<\?xml[^>]*\?>\s*)?<svg[\s>][\s\S]*<\/svg>\s*$/

/**
 * The picture's base64, or undefined when the answer is not one. Only
 * base64 reaches a src: the docx writer drops any data URI that is not, and
 * nothing else may break out of the attribute.
 */
function pictureData(result: { png?: string; svg?: string }, format: RenderFormat): string | undefined {
  if (format === 'svg') {
    return typeof result.svg === 'string' && SVG_DOCUMENT.test(result.svg)
      ? Buffer.from(result.svg, 'utf8').toString('base64')
      : undefined
  }
  return typeof result.png === 'string' && BASE64.test(result.png) ? result.png : undefined
}

function pictureHtml(data: string, format: RenderFormat, width: number, height: number, target: TargetFormat): string {
  const w = target === 'docx' ? Math.min(width, DOCX_MAX_WIDTH) : width
  const h = Math.round((height * w) / width)
  const mime = format === 'svg' ? 'image/svg+xml' : 'image/png'
  return (
    `<p style="text-align:center"><img src="data:${mime};base64,${data}" alt="Diagram" ` +
    `width="${Math.round(w)}" height="${h}" style="width:${Math.round(w)}px;height:auto;max-width:100%" ` +
    `${RENDERED_MARKER}="diagram"></p>`
  )
}

/** A block's text, entities undone: what the author wrote. */
function decodeText(html: string): string {
  return textContent(parseDocument(html, { decodeEntities: true }))
}

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 300 ? `${t.slice(0, 297)}...` : t || 'unknown error'
}
