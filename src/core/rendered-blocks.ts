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

/** What the render host draws. */
export type RenderKind = 'mermaid' | 'dot' | 'math'
export type RenderFormat = 'png' | 'svg'

export interface RenderRequest {
  kind: RenderKind
  /** The block's source, byte for byte. */
  source: string
  /** Display (a block of its own) or inline (math only). */
  display: boolean
  format: RenderFormat
}

/**
 * A drawing, or why there is none. Sizes are CSS px (1ex = 8px). A PNG is
 * drawn at twice that size, so it stays sharp when printed or zoomed. `png`
 * is base64 without a data: prefix; `svg` is markup the host has already
 * sanitised (svg-sanitize.ts). `baseline` (inline math only) is how far the
 * text baseline sits above the picture's bottom edge, in px: the picture is
 * lowered by that much to sit on the line.
 */
export type RenderResult =
  | { png?: string; svg?: string; width: number; height: number; baseline?: number }
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
 * The kinds an engine draws so far. Conversions draw these and keep the rest
 * as source; the editor draws these and shows the rest as source. Graphviz
 * (dot) joins with its engine (step 17), math with MathJax (step 18).
 */
export const DRAWN_KINDS: ReadonlySet<RenderKind> = new Set<RenderKind>(['mermaid'])

/** The largest source drawn, by the host and by the editor's IPC alike (spec B11). */
export const MAX_SOURCE_BYTES = 100 * 1024
