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
