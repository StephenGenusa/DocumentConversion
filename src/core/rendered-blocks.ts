import type { TargetFormat } from './types'

/**
 * Diagrams and formulas in the hub (spec B1): tagged source, never a drawing.
 *
 *   <pre><code class="language-mermaid">SOURCE</code></pre>
 *   <pre><code class="language-dot">SOURCE</code></pre>
 *   <pre><code class="language-math">TEX</code></pre>     display math
 *   <code class="language-math">TEX</code>                inline math
 *
 * The source is the text between the author's delimiters, byte for byte.
 * Math is wrapped rather than left as `$…$` text so that writers draw only
 * what a reader positively identified: a `$5 … $10` in a Word file or a .txt
 * can never become a formula.
 */

/** The diagram languages, as the hub names them. */
export const DIAGRAM_LANGUAGES = ['mermaid', 'dot'] as const
export type DiagramLanguage = (typeof DIAGRAM_LANGUAGES)[number]

/** Every name an author may give a Graphviz block, normalised to `dot`. */
const ALIASES = new Map<string, DiagramLanguage>([
  ['mermaid', 'mermaid'],
  ['dot', 'dot'],
  ['graphviz', 'dot'],
  ['gv', 'dot'],
  ['viz', 'dot'],
])

/** The hub's name for a diagram language, or undefined when it is not one. */
export function diagramLanguage(name: string | undefined | null): DiagramLanguage | undefined {
  return name ? ALIASES.get(name.trim().toLowerCase()) : undefined
}

/**
 * A single-`$` span is math in Markdown only when it looks like TeX, so
 * "costs $5 for the **bold** plan and $10" stays prose. The reader and the
 * Markdown writer share it, so what one writes the other reads back alike.
 */
export const TEX_SHAPED = /[\\{}^_]/

/** What a document holds that a writer may draw. Readers report it; the input card keeps it. */
export interface HubFeatures {
  diagrams: boolean
  math: boolean
}

const DIAGRAM_BLOCK = /<pre><code class="language-(?:mermaid|dot)">/
const MATH = /<code class="language-math">/

export function hubFeatures(html: string): HubFeatures {
  return { diagrams: DIAGRAM_BLOCK.test(html), math: MATH.test(html) }
}

// ---------------------------------------------------------------------------
// Drawing blocks in output (spec B3, B5, B7). The types live here, where the
// renderer can import them; the drawing pass is draw-blocks.ts and the host
// is src/main/render-host.ts.
// ---------------------------------------------------------------------------

/**
 * What the render host draws. `svg` is not a hub block: it is an SVG image a
 * document already carries, which the host only rasterises, for the targets
 * that cannot show SVG (spec D10, svg-images.ts). `picture` is a raster
 * image the document carries, decoded and re-encoded as PNG or JPEG for a
 * target that cannot store its format or its size (Kindle,
 * kindle-pictures.ts): decoding happens in the host's sandboxed page, never
 * in the main process. The editor asks for neither.
 */
export type RenderKind = BlockKind | 'svg' | 'picture'
/** The kinds a hub block is drawn as: what the editor and draw-blocks.ts ask for. */
export type BlockKind = 'mermaid' | 'dot' | 'math'
export type RenderFormat = 'png' | 'svg'

/**
 * The targets that take an SVG picture (spec B3): the choice applies there,
 * and is SVG unless PNG is asked for. azw4 is a PDF inside, so it follows
 * the pdf choice. Word is always PNG: html-to-docx would store an SVG as
 * media Word cannot show, which is also why every SVG image a document
 * carries gets a PNG copy for Word (svg-images.ts). Kindle (azw3) is PNG
 * always too: a KF8 image record holds JPEG, PNG or GIF.
 */
export const SVG_TARGETS: ReadonlySet<TargetFormat> = new Set(['pdf', 'html', 'revealjs', 'epub', 'azw4'])

/** The format `target` draws in, given the choice made (ConvertOptions.renderedFormat). */
export function renderedFormatFor(target: TargetFormat, chosen?: RenderFormat): RenderFormat {
  return SVG_TARGETS.has(target) && chosen !== 'png' ? 'svg' : 'png'
}

export interface RenderRequest {
  kind: RenderKind
  /** The block's source, byte for byte. */
  source: string
  /** Display (a block of its own) or inline (math only). */
  display: boolean
  format: RenderFormat
  /**
   * `picture` only: the largest the answer may be, in bytes. The host keeps
   * PNG for a picture with transparency, JPEG otherwise, lowering JPEG
   * quality and then the size until it fits. `format` is ignored.
   */
  fit?: { maxBytes: number }
}

/**
 * A drawing, or why there is none. Sizes are CSS px (1ex = 8px). A PNG is
 * drawn at twice that size, so it stays sharp when printed or zoomed (a
 * `picture`'s size is its pixels, as re-encoded). `png` and `jpeg` (a
 * `picture` only) are base64 without a data: prefix; `svg` is markup the
 * host has already sanitised (svg-sanitize.ts). `baseline` (inline math only) is how far the
 * text baseline sits above the picture's bottom edge, in px: the picture is
 * lowered by that much to sit on the line.
 */
export type RenderResult =
  | { png?: string; svg?: string; jpeg?: string; width: number; height: number; baseline?: number }
  | { error: string }

export interface RenderBlocksOptions {
  signal?: AbortSignal
  /** How long each block may take to draw, once the engine starts on it. */
  timeoutMs: number
}

/**
 * The render host, as core sees it (ConverterDeps.renderBlocks): one result
 * per request, in order. A request that fails answers `{ error }`; the
 * promise rejects only when the signal is aborted.
 */
export type RenderBlocks = (requests: RenderRequest[], opts: RenderBlocksOptions) => Promise<RenderResult[]>

/**
 * The kinds an engine draws. Conversions draw these and keep the rest as
 * source; the editor draws these and shows the rest as source. All three
 * hub kinds are drawn: Mermaid diagrams, Graphviz (viz-js) and TeX (MathJax).
 */
export const DRAWN_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(['mermaid', 'dot', 'math'])

/** The largest source drawn, by the host and by the editor's IPC alike (spec B11). */
export const MAX_SOURCE_BYTES = 100 * 1024

/**
 * The largest SVG image rasterised (spec D10). Pictures are larger than
 * diagram sources: an illustration exported from a drawing program runs to
 * megabytes, and it is the file itself, not a few lines of text.
 */
export const MAX_SVG_IMAGE_BYTES = 5 * 1024 * 1024

/** The largest raster picture re-encoded (kind `picture`), in bytes before base64. */
export const MAX_PICTURE_BYTES = 30 * 1024 * 1024

/**
 * Whether a document with these features has something a conversion draws:
 * what the Diagrams and formulas choice is shown for (spec 2a, V1).
 * Diagrams are Mermaid and Graphviz alike; formulas are TeX.
 */
export function drawsSomething(features: HubFeatures | undefined): boolean {
  if (!features) return false
  return features.diagrams || (features.math && DRAWN_KINDS.has('math'))
}
