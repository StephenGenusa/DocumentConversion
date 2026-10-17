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
  type PictureFormat,
  type BlockKind,
  type RenderRequest,
  type RenderResult,
} from './rendered-blocks'
import { carryDefinitions } from './tex-definitions'

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
          ? [req.kind, req.display, req.format, req.source, engineVersion, req.fit.maxBytes, req.fit.as ?? null, req.page ?? null]
          : [req.kind, req.display, req.format, req.source, engineVersion],
      ),
    )
    .digest('hex')
}

/**
 * Per conversion (spec B7): diagrams (Mermaid and Graphviz together), and
 * formulas. Formulas are asked for `batch` at a time, so the 60 s for all of
 * them can be kept to: once it has passed, no further batch is started.
 */
export const RENDER_LIMITS = {
  diagrams: { max: 50, eachMs: 10_000 },
  formulas: { max: 2000, eachMs: 2_000, totalMs: 60_000, batch: 100 },
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
  /** What a picture the target cannot hold is converted to (ConvertOptions.pictureFormat; PNG when not given). */
  pictureFormat?: PictureFormat
  signal?: AbortSignal
  onAdvice?: (kind: 'render-failed', message: string) => void
}

/**
 * Draw the document's diagrams and formulas for `target` (spec B3): each B1
 * diagram that is drawn becomes a centred `<img>` of an SVG or PNG data URI
 * (renderedFormatFor) with alt "Diagram", each formula an `<img>` whose alt
 * is its TeX (drawFormulas); a
 * block that is not stays source, with a notice for each failure and one for
 * the blocks over the limit. Called by `Converter.write()` before the
 * writer; this HTML exists only between there and the writer.
 *
 * Without a renderer (core used on its own), or for a target that does not
 * draw, the HTML is returned untouched and nothing is said.
 */
export async function drawBlocks(html: string, target: TargetFormat, ctx: DrawContext): Promise<string> {
  const render = ctx.renderBlocks
  if (!render || !rendersBlocks(target)) return html
  const features = hubFeatures(html)
  let out = html
  if (features.diagrams) out = await drawDiagrams(out, target, ctx, render)
  if (features.math && DRAWN_KINDS.has('math')) out = await drawFormulas(out, target, ctx, render)
  return out
}

async function drawDiagrams(html: string, target: TargetFormat, ctx: DrawContext, render: RenderBlocks): Promise<string> {

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

// ---------------------------------------------------------------------------
// Formulas (MathJax, step 18)
// ---------------------------------------------------------------------------

/**
 * A formula in the hub's form (rendered-blocks.ts): display math is a code
 * block, inline math the same code element alone, and display math inside a
 * paragraph that element marked `math-display`. The block form is matched
 * first, so its code element is never taken for one in a paragraph.
 */
const FORMULA_SOURCE =
  /<pre><code class="language-math(?: math-display)?">([\s\S]*?)<\/code><\/pre>|<code class="language-math( math-display)?">([\s\S]*?)<\/code>/g

/** How a formula stands: in the line, a block of its own, or display math inside a paragraph. */
type Placement = 'inline' | 'block' | 'in-paragraph'

/**
 * Marks, for the docx writer, a picture of display math that stood inside a
 * paragraph: it is put in a centred paragraph of its own there.
 */
export const DOCX_OWN_LINE = 'data-docx-own-line'

/** The host's sizes are CSS px at 8 px to the ex (spec B5). */
const PX_PER_EX = 8

/**
 * One ex of Word's text, in CSS px: html-to-docx writes Times New Roman at
 * 11 pt (14.67 px), whose x-height is 0.447 of its size. MathJax draws a
 * formula so its x-height is the text's (its ex), which in HTML targets the
 * browser does by itself (the picture is sized in ex); Word takes sizes in
 * px only, so they are scaled here.
 */
export const DOCX_EX_PX = ((11 * 96) / 72) * (916 / 2048)

const exs = (px: number): string => `${Math.round((px / PX_PER_EX) * 1000) / 1000}ex`

/**
 * Draw the document's formulas (spec B3, B7): inline ones become an `<img>`
 * in the line, lowered by the formula's depth below the baseline; display
 * ones a centred `<img>` of their own. Alt is the TeX. Sizes are in ex where
 * the target lays out CSS (so a formula follows the size of the text around
 * it: a heading, a slide, a reader's chosen size), in px at the text's size
 * for Word, with the lowering handed to the docx writer (`data-docx-lower`,
 * half-points), since html-to-docx ignores vertical-align on a picture.
 *
 * Limits: 2,000 formulas, 2 s each, 60 s in all. Beyond either, the rest
 * stay source with one notice; each formula that fails keeps its source
 * with a notice naming it ("Formula 3 could not be drawn: Undefined control
 * sequence \foo"). Numbered apart from diagrams.
 */
async function drawFormulas(html: string, target: TargetFormat, ctx: DrawContext, render: RenderBlocks): Promise<string> {
  interface Formula {
    start: number
    end: number
    display: boolean
    placement: Placement
    source: string
    number: number
    /** What is drawn: the source, after the definitions it uses from earlier formulas. */
    drawn: string
  }
  const formulas: Formula[] = []
  for (const m of html.matchAll(FORMULA_SOURCE)) {
    const placement: Placement = m[1] !== undefined ? 'block' : m[2] ? 'in-paragraph' : 'inline'
    const source = decodeText(m[1] ?? m[3])
    if (!source.trim()) continue
    const display = placement !== 'inline'
    formulas.push({ start: m.index, end: m.index + m[0].length, display, placement, source, number: formulas.length + 1, drawn: source })
  }
  if (formulas.length === 0) return html

  const { max, eachMs, totalMs, batch } = RENDER_LIMITS.formulas
  const drawn = formulas.slice(0, max)
  // Each formula is drawn alone; a \newcommand in one reaches the later ones here.
  carryDefinitions(drawn.map((f) => f.source)).forEach((tex, k) => (drawn[k].drawn = tex))
  if (formulas.length > max) {
    const n = (v: number): string => v.toLocaleString('en-US')
    ctx.onAdvice?.(
      'render-failed',
      `This document has ${n(formulas.length)} formulas; the first ${n(max)} were drawn and the other ${n(formulas.length - max)} are shown as source`,
    )
  }

  const format = renderedFormatFor(target, ctx.format)
  const keyOf = (f: Formula): string => JSON.stringify([f.display, f.drawn])
  const unique = [...new Map(drawn.map((f) => [keyOf(f), f])).values()]
  const byKey = new Map<string, RenderResult>()
  const started = Date.now()
  for (let i = 0; i < unique.length; i += batch) {
    if (i > 0 && Date.now() - started > totalMs) {
      const left = drawn.filter((f) => !byKey.has(keyOf(f))).length
      ctx.onAdvice?.('render-failed', `Drawing formulas took over ${totalMs / 1000} s; the other ${left} are shown as source`)
      break
    }
    const part = unique.slice(i, i + batch)
    let results: RenderResult[]
    try {
      results = await render(
        part.map(({ drawn: source, display }) => ({ kind: 'math', source, display, format })),
        { signal: ctx.signal, timeoutMs: eachMs },
      )
    } catch (err) {
      if (ctx.signal?.aborted) throw err
      ctx.onAdvice?.('render-failed', `Formulas could not be drawn: ${oneLine((err as Error)?.message ?? String(err))}`)
      return html
    }
    part.forEach((f, k) => byKey.set(keyOf(f), results[k]))
  }

  let out = ''
  let at = 0
  for (const f of drawn) {
    if (!byKey.has(keyOf(f))) continue
    const result = byKey.get(keyOf(f))
    const data = result && !('error' in result) && result.width > 0 && result.height > 0 ? pictureData(result, format) : undefined
    if (data === undefined || !result || 'error' in result) {
      const why = result && 'error' in result ? oneLine(result.error) : 'the engine gave no picture'
      ctx.onAdvice?.('render-failed', `Formula ${f.number} could not be drawn: ${why}`)
      continue
    }
    out += html.slice(at, f.start) + formulaHtml(data, format, result, f.placement, f.source, target)
    at = f.end
  }
  return out + html.slice(at)
}

function formulaHtml(
  data: string,
  format: RenderFormat,
  size: { width: number; height: number; baseline?: number },
  placement: Placement,
  tex: string,
  target: TargetFormat,
): string {
  const display = placement !== 'inline'
  const mime = format === 'svg' ? 'image/svg+xml' : 'image/png'
  const head = `<img src="data:${mime};base64,${data}" alt="${escapeAttr(tex)}"`
  const marker = `${RENDERED_MARKER}="formula"`
  const baseline = typeof size.baseline === 'number' && size.baseline > 0 ? size.baseline : 0
  let img: string
  if (target === 'docx') {
    const f = DOCX_EX_PX / PX_PER_EX
    let w = Math.max(1, Math.round(size.width * f))
    let h = Math.max(1, Math.round(size.height * f))
    if (w > DOCX_MAX_WIDTH) {
      h = Math.max(1, Math.round((h * DOCX_MAX_WIDTH) / w))
      w = DOCX_MAX_WIDTH
    }
    // Half-points, as Word's w:position takes it (1 px = 0.75 pt).
    const lower = display ? 0 : Math.round(baseline * f * 1.5)
    const ownLine = placement === 'in-paragraph' ? ` ${DOCX_OWN_LINE}` : ''
    img = `${head} width="${w}" height="${h}" style="width:${w}px;height:${h}px" ${marker}${lower > 0 ? ` data-docx-lower="${lower}"` : ''}${ownLine}>`
  } else if (display) {
    img = `${head} width="${size.width}" height="${size.height}" style="width:${exs(size.width)};height:auto;max-width:100%" ${marker}>`
  } else {
    const align = baseline > 0 ? `;vertical-align:-${exs(baseline)}` : ''
    img = `${head} width="${size.width}" height="${size.height}" style="width:${exs(size.width)};height:${exs(size.height)}${align}" ${marker}>`
  }
  if (placement === 'block') return `<p style="text-align:center">${img}</p>`
  if (placement === 'inline') return img
  // Display math inside a paragraph: a line of its own, the paragraph going
  // on after it, as pandoc writes it. Word ignores display:block, so there
  // it stands between two breaks, and the docx writer gives it a centred
  // paragraph of its own where it can (centreOwnLineFormulas).
  return target === 'docx' ? `<br>${img}<br>` : `<span style="display:block;text-align:center;margin:0.5em 0">${img}</span>`
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
