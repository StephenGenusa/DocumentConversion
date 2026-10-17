import { getReader } from './readers'
import { docxHasEquations } from './readers/docx'
import { decodeTextBytes } from './readers/txt'
import { MATH_LIBRARY } from './readers/html'
import { hubFeatures, type HubFeatures } from './rendered-blocks'
import type { SourceFormat } from './types'

/*
 * What an input holds that a writer may draw, known when it is added (spec
 * 2a, V1). The edit pane's read sets `features` too, but a file never opened
 * there would otherwise have none, and the Diagrams choice could not know to
 * show. Main sends this with the other add-time hints (jsonTable, viewCount).
 */

/** The text formats whose readers write diagram or formula blocks (spec B2). */
const HINT_SOURCES: ReadonlySet<SourceFormat> = new Set<SourceFormat>([
  'md',
  'ipynb',
  'asciidoc',
  'rst',
  'djot',
  'textile',
  'html',
])

/** Up to this size the input is read whole by its reader; past it, scanned (see scanFeatures). */
export const FEATURES_HINT_MAX_BYTES = 2 * 1024 * 1024

/**
 * How long a large input's hint may take. Adding a file waits for it, so a
 * scan that runs out says nothing rather than holding the window up; the
 * pane's read still sets the features when the file is opened.
 */
export const FEATURES_SCAN_BUDGET_MS = 1000

/**
 * The input's features, read by its own reader, or undefined when the format
 * has none to report, a large input's scan ran out of time, or it cannot be
 * read. Only the reader runs: nothing is fetched (remote images are resolved
 * by Converter.read, not here).
 */
export async function featuresHint(bytes: Buffer, format: SourceFormat, filename?: string): Promise<HubFeatures | undefined> {
  const deadline = performance.now() + FEATURES_SCAN_BUDGET_MS
  // A Word file's equations become formulas (spec B12). Converting the whole
  // file just to learn that would be slow, so its parts are only searched,
  // whatever its size.
  if (format === 'docx') {
    const math = await docxHasEquations(bytes, deadline)
    return math === undefined ? undefined : { diagrams: false, math }
  }
  if (!HINT_SOURCES.has(format)) return undefined
  try {
    if (bytes.length > FEATURES_HINT_MAX_BYTES) return await scanFeatures(bytes, format, deadline)
    const hub = await getReader(format)({ bytes, filename })
    return hubFeatures(hub.html)
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * Large inputs
 * ------------------------------------------------------------------ */

/**
 * How each text format is scanned: where a diagram or formula may start
 * (`candidates`, generous — the reader decides), and the lines that open and
 * close a fenced block (`fence`, its first group the delimiter), so a window
 * inside one starts at its opening: a `$x^2$` in a code fence is code, and a
 * `[mermaid]` takes the listing below it.
 */
interface Scan {
  candidates: RegExp
  fence?: RegExp
  /** Whether `close` closes a block opened by `open` (both the fence's delimiter). */
  closes?: (open: string, close: string) => boolean
  /** Whether a block opened by `open` is shown as written, so a formula's marks in it are not one. */
  literal?: (open: string) => boolean
  /** The reader the excerpt goes to, when not the format's own. */
  readAs?: SourceFormat
}

/** A fenced block: its opening line's start, its closing line's end. */
interface Fence {
  start: number
  end: number
  literal: boolean
}

/**
 * A candidate that names a diagram (a fence, a directive, a class); any
 * other is a formula's: one that starts with `$` or names math or stem,
 * `$\dot{x}$` included.
 */
const isDiagramCandidate = (match: string): boolean =>
  /mermaid|graphviz|digraph|graph::|\b(?:dot|gv|viz)\b/i.test(match) && !/^\$|math|stem/i.test(match)

/** Markdown and Djot fences: three or more backticks or tildes; the close is the same mark, at least as long. */
const MD_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/gm
const mdCloses = (open: string, close: string): boolean => close[0] === open[0] && close.length >= open.length

/**
 * In Markdown: a fence named as a diagram or `math`, `$$`, and a `$…$` on
 * one line holding TeX's marks (TEX_SHAPED: `$5 and $10` is prose).
 */
const MD_CANDIDATES = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*\{?[ \t]*[.=]?(?:mermaid|dot|graphviz|gv|viz|math)\b|\$\$|\$(?=\S)[^$\n]*[\\{}^_][^$\n]*\$/gim

/**
 * In HTML: a block named as a diagram or math (the hub's `language-X`,
 * mermaid.js's `class="mermaid"`, pandoc's `class="math …"`), MathJax's
 * script and KaTeX's drawing (readers/html.ts). In a page that loads MathJax
 * or KaTeX, also its delimiters in the text (HTML_DELIMITED).
 */
const HTML_CANDIDATES =
  /\blanguage-(?:mermaid|dot|graphviz|gv|math)\b|\bclass=["']?(?:[^"'>]*\s)?(?:mermaid|graphviz|math|katex)\b|\bmath\/tex\b/gi
const HTML_DELIMITED = new RegExp(`${HTML_CANDIDATES.source}|\\\\[([]|\\$\\$`, 'gi')

const SCANS: Partial<Record<SourceFormat, Scan>> = {
  md: { candidates: MD_CANDIDATES, fence: MD_FENCE, closes: mdCloses, literal: () => true },
  ipynb: { candidates: MD_CANDIDATES, fence: MD_FENCE, closes: mdCloses, literal: () => true, readAs: 'md' },
  djot: {
    candidates: /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*=?(?:mermaid|dot|graphviz|gv|viz|math)\b|\$\$?`/gim,
    fence: MD_FENCE,
    closes: mdCloses,
    literal: () => true,
  },
  asciidoc: {
    candidates: /^\[(?:mermaid|graphviz|dot|source,[ \t]*(?:mermaid|graphviz|dot)|latexmath|stem)\b|latexmath:\[|stem:\[/gim,
    // A delimited block closes with the very line that opened it.
    fence: /^(-{4,}|\.{4,}|\+{4,}|={4,}|\*{4,}|_{4,}|\/{4,})[ \t]*$/gm,
    closes: (open, close) => open === close,
    // Listing, literal and passthrough blocks; an example or sidebar block's content is read.
    literal: (open) => /^[-.+]/.test(open),
  },
  rst: { candidates: /^[ \t]*\.\.[ \t]+(?:mermaid|math|graphviz|digraph|graph)::|:math:`/gim },
  textile: { candidates: /language-(?:mermaid|dot|math)\b|^bc\.?\(language-(?:mermaid|dot)\)/gim },
  html: { candidates: HTML_CANDIDATES },
}

/** Where an HTML window may end: the element its text is in closes. */
const HTML_CLOSE = /<\/(?:code|pre|div|span|script|p)>/gi

/** A window's reach either side of its candidate, when no block boundary comes sooner. */
const BEFORE = 4 * 1024
const AFTER = 16 * 1024
/** The most of a fenced block a window takes. */
const FENCE_MAX = 64 * 1024
/** What one read of the excerpt may hold, and how many windows go into it. */
const EXCERPT_MAX = 1024 * 1024
const WINDOWS_PER_READ = 64

/**
 * A large input's features, from its own reader run on excerpts: the
 * windows around each place a diagram or formula may start. The text is
 * searched once; the reader sees at most EXCERPT_MAX at a time, in rounds,
 * until both are found, the candidates run out, or the budget does.
 */
async function scanFeatures(bytes: Buffer, format: SourceFormat, deadline: number): Promise<HubFeatures | undefined> {
  const scan = SCANS[format]
  if (!scan) return undefined
  const text = format === 'ipynb' ? notebookMarkdown(bytes) : decodeTextBytes(bytes)
  if (text === undefined) return undefined
  const fences = scan.fence ? fenceRanges(text, scan) : []
  // A page's math library makes its delimiters math (readers/html.ts): each
  // excerpt carries the script that loads it.
  const library = format === 'html' ? MATH_LIBRARY.exec(text)?.[0] : undefined
  // A formula's mark in a code block is code; a fence's own line is the candidate, not in it.
  const candidates = [...text.matchAll(library ? HTML_DELIMITED : scan.candidates)]
    .map((m) => ({ at: m.index, diagram: isDiagramCandidate(m[0]) }))
    .filter(({ at, diagram }) => {
      if (diagram) return true
      const fence = fenceAt(fences, at)
      return !fence || !fence.literal || fence.start === at
    })
  // asciidoctor resolves `stem:[…]` by the header's `:stem:` (asciidoc.ts):
  // each excerpt carries the header's attribute lines.
  const header = format === 'asciidoc' ? headerAttributes(text) : library ? `${library}</script>\n` : ''
  const found: HubFeatures = { diagrams: false, math: false }
  const reader = getReader(scan.readAs ?? format)
  let next = 0
  const wanted = (i: number): boolean => (candidates[i].diagram ? !found.diagrams : !found.math)
  while (next < candidates.length) {
    if (performance.now() > deadline) return found.diagrams || found.math ? found : undefined
    const windows: Array<[number, number]> = []
    let size = 0
    for (; next < candidates.length && windows.length < WINDOWS_PER_READ && size < EXCERPT_MAX; next++) {
      // Once one kind is found, only the other's candidates are read.
      if (!wanted(next)) continue
      const w = windowAt(text, candidates[next].at, fences, format)
      const last = windows[windows.length - 1]
      if (last && w[0] <= last[1]) {
        size += Math.max(0, w[1] - last[1])
        last[1] = Math.max(last[1], w[1])
      } else {
        windows.push(w)
        size += w[1] - w[0]
      }
    }
    if (windows.length === 0) break
    const excerpt = header + windows.map(([a, b]) => text.slice(a, b)).join(format === 'html' ? '\n' : '\n\n')
    const read = hubFeatures((await reader({ bytes: Buffer.from(excerpt, 'utf8') })).html)
    found.diagrams ||= read.diagrams
    found.math ||= read.math
    if (found.diagrams && found.math) return found
  }
  return found
}

/** Every fenced block, in order. */
function fenceRanges(text: string, scan: Scan): Fence[] {
  const ranges: Fence[] = []
  let open: { at: number; mark: string } | undefined
  for (const m of text.matchAll(scan.fence!)) {
    const mark = m[1]
    if (!open) open = { at: m.index, mark }
    else if (scan.closes!(open.mark, mark)) {
      const end = text.indexOf('\n', m.index)
      ranges.push({ start: open.at, end: end < 0 ? text.length : end, literal: scan.literal?.(open.mark) ?? false })
      open = undefined
    }
  }
  // An unclosed fence runs to the end, as Markdown reads it.
  if (open) ranges.push({ start: open.at, end: text.length, literal: scan.literal?.(open.mark) ?? false })
  return ranges
}

/** The fenced block holding `pos`, if one does. */
function fenceAt(fences: Fence[], pos: number): Fence | undefined {
  let lo = 0
  let hi = fences.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (fences[mid].end < pos) lo = mid + 1
    else if (fences[mid].start > pos) hi = mid - 1
    else return fences[mid]
  }
  return undefined
}

/**
 * The stretch of text a candidate is read in: the fenced block it is in,
 * else its paragraph (to the blank lines either side, within BEFORE and
 * AFTER) and any fenced block that opens in it — a `[mermaid]` line's
 * listing. An rst directive takes its indented body, blank lines and all;
 * an HTML one the element it names and its `<pre>`.
 */
function windowAt(text: string, pos: number, fences: Fence[], format: SourceFormat): [number, number] {
  if (format === 'html') {
    const tag = text.lastIndexOf('<', pos)
    const pre = text.lastIndexOf('<pre', tag)
    const start = pre >= 0 && tag - pre < 512 && !text.slice(pre, tag).includes('</pre') ? pre : Math.max(0, tag)
    // To the first closing tag a diagram's or formula's text can end at.
    HTML_CLOSE.lastIndex = pos
    const close = HTML_CLOSE.exec(text)
    const end = !close || close.index - pos > FENCE_MAX ? Math.min(text.length, pos + AFTER) : close.index + close[0].length
    const after = /^\s*<\/pre>/.exec(text.slice(end, end + 64))
    return [start, after ? end + after[0].length : end]
  }
  const inFence = fenceAt(fences, pos)
  if (inFence) return [attributeLinesBefore(text, inFence.start), Math.min(inFence.end, inFence.start + FENCE_MAX)]
  const blank = text.lastIndexOf('\n\n', pos)
  let start = blank < 0 || pos - blank > BEFORE ? Math.max(0, text.lastIndexOf('\n', Math.max(0, pos - BEFORE)) + 1) : blank + 2
  const before = fenceAt(fences, start)
  if (before) start = before.end
  if (format === 'rst' && /^[ \t]*\.\./.test(text.slice(pos, pos + 8))) return [start, directiveEnd(text, pos)]
  const nextBlank = text.indexOf('\n\n', pos)
  let end = nextBlank < 0 || nextBlank - pos > AFTER ? Math.min(text.length, pos + AFTER) : nextBlank
  // A fenced block that opens in the paragraph is taken whole: `[mermaid]`
  // over its listing has no blank line between, but the listing may.
  for (let i = firstFenceFrom(fences, start); i < fences.length && fences[i].start <= end; i++) {
    end = Math.max(end, Math.min(fences[i].end, fences[i].start + FENCE_MAX))
  }
  return [start, end]
}

/** The index of the first fenced block that opens at or after `pos`. */
function firstFenceFrom(fences: Fence[], pos: number): number {
  let lo = 0
  let hi = fences.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (fences[mid].start < pos) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Back over a block's attribute and title lines (`[source,mermaid]`, `.Title`), up to three. */
function attributeLinesBefore(text: string, at: number): number {
  let start = at
  for (let i = 0; i < 3 && start > 0; i++) {
    const prev = text.lastIndexOf('\n', start - 2) + 1
    if (!/^[[.][^\n]*\n$/.test(text.slice(prev, start))) break
    start = prev
  }
  return start
}

/** Where an rst directive's indented body ends: the first line at the margin after it. */
function directiveEnd(text: string, pos: number): number {
  const lineEnd = text.indexOf('\n', pos)
  if (lineEnd < 0) return text.length
  const margin = /\n(?=\S)/g
  margin.lastIndex = lineEnd
  const end = margin.exec(text)?.index ?? text.length
  return Math.min(end, pos + FENCE_MAX)
}

/** An AsciiDoc document's header attributes (`:stem: latexmath`), from before its first blank line. */
function headerAttributes(text: string): string {
  const head = text.slice(0, Math.min(text.length, 64 * 1024)).split(/\n\s*\n/, 1)[0]
  const lines = head.split('\n').filter((l) => /^:[\w-]+:/.test(l))
  return lines.length ? `${lines.join('\n')}\n\n` : ''
}

/**
 * A notebook's Markdown cells, one after the other: where its diagrams and
 * formulas are (readers/ipynb.ts). A large notebook is large for its
 * outputs, which are skipped.
 */
function notebookMarkdown(bytes: Buffer): string | undefined {
  type Cell = { cell_type?: string; source?: string | string[] }
  let nb: { cells?: Cell[]; worksheets?: { cells?: Cell[] }[] }
  try {
    nb = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  const cells = Array.isArray(nb.cells) ? nb.cells : (nb.worksheets ?? []).flatMap((s) => s.cells ?? [])
  return cells
    .filter((c) => c.cell_type === 'markdown')
    .map((c) => (Array.isArray(c.source) ? c.source.join('') : (c.source ?? '')))
    .join('\n\n')
}
