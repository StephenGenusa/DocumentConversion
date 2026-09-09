import { sanitizeToHub } from '../allowlist'
import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import { readMarkdown, stripUnresolvableImageSrc } from './md'
import type { HubDocument, SourceInput } from '../types'

interface NotebookOutput {
  output_type?: string
  name?: string
  text?: string | string[]
  data?: Record<string, unknown>
  traceback?: string[]
  ename?: string
  evalue?: string
  /** execute_result repeats the prompt number its cell was given. */
  execution_count?: number | null
  /** nbformat 3 called it prompt_number. */
  prompt_number?: number | null
}

interface NotebookCell {
  cell_type?: string
  source?: string | string[]
  /** nbformat 3 named the code-cell source "input". */
  input?: string | string[]
  outputs?: NotebookOutput[]
  /** null for a cell that has never been run. */
  execution_count?: number | null
  prompt_number?: number | null
}

interface Notebook {
  cells?: NotebookCell[]
  /** nbformat 3 and earlier nested cells inside worksheets. */
  worksheets?: { cells?: NotebookCell[] }[]
  nbformat?: number
  metadata?: {
    language_info?: { name?: string }
    kernelspec?: { language?: string }
  }
}

/** Notebook `source`/`text` fields are either a string or an array of lines. */
function joinSource(source: string | string[] | undefined): string {
  if (Array.isArray(source)) return source.join('')
  return source ?? ''
}

/** Tracebacks carry terminal colour codes; strip both real ESC sequences and bare ones. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b?\[[0-9;]*m/g, '')
}

/**
 * escapeHtml() is for TEXT: it handles `&`, `<` and `>` and leaves quotes
 * alone, which is correct between tags and wrong inside an attribute. Every
 * value below comes out of the notebook JSON — the kernel language name, a
 * figure's base64 — and any of them may hold a `"` that would close the
 * attribute early and let the rest be parsed as markup.
 */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

function preBlock(text: string, className?: string): string {
  const cls = className ? ` class="${escapeAttr(className)}"` : ''
  return `<pre${cls}>${escapeHtml(text.replace(/\s+$/, ''))}</pre>`
}

/**
 * Classes are the ONLY hook a notebook gets. The hub allowlist permits `class`
 * on `pre` and `code` and no other attribute anywhere, because everything the
 * sanitizer passes has to round-trip the TipTap editor losslessly — so the
 * role of a block (input / result / stream / error) and its prompt number both
 * ride here, and the shell turns them into a gutter and colours. A cell that
 * was never run has no count and gets no count class: the shell prints the
 * empty `In [ ]:` prompt Jupyter shows rather than inventing a number.
 */
function countClass(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? ` nb-c${n}` : ''
}

/**
 * The alt text stamped on every figure this reader inlines. It is the only
 * attribute an `<img>` may carry that the shell can select on, so it doubles as
 * the "this is a cell output" marker; see the emit site below.
 */
const FIGURE_ALT = 'output image'

/**
 * The text/plain matplotlib (and friends) ship beside a figure: a repr of the
 * figure object, not a result. `<Figure size 640x480 with 1 Axes>`,
 * `<matplotlib.axes._subplots.AxesSubplot at 0x7f...>`, `<AxesSubplot:...>`,
 * `<seaborn.axisgrid.FacetGrid ...>`, `<IPython.core.display.Image object>`.
 */
const FIGURE_PLACEHOLDER = /^<(Figure\b|matplotlib\.|Axes\w*[:\s>]|seaborn\.|IPython\.|plotly\.|PIL\.|bokeh\.).*>$/

/**
 * The figure in a mime bundle as a data URI, or null when it has none. PNG
 * first, then JPEG, then SVG — a bundle may carry more than one and they are
 * the same picture. PNG and JPEG arrive base64-encoded; SVG arrives as markup,
 * which is base64-encoded here so the allowlist sees a plain `data:` image and
 * nothing inside the SVG is ever parsed as document HTML.
 */
function figureDataUri(data: Record<string, unknown>): string | null {
  for (const mime of ['image/png', 'image/jpeg']) {
    const b64 = mimeText(data[mime]).replace(/\s+/g, '')
    if (b64) return `data:${mime};base64,${b64}`
  }
  const svg = mimeText(data['image/svg+xml']).trim()
  if (svg) return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  return null
}

function executionCount(o: { execution_count?: number | null; prompt_number?: number | null }): number | null {
  return o.execution_count ?? o.prompt_number ?? null
}

/** A mime-bundle value is a "multiline_string": a string OR an array of lines. */
function mimeText(value: unknown): string {
  return typeof value === 'string' || Array.isArray(value) ? joinSource(value as string | string[]) : ''
}

function renderOutputs(outputs: NotebookOutput[], cellCount: number | null): string {
  const parts: string[] = []
  for (const out of outputs) {
    if (out.output_type === 'stream') {
      const text = joinSource(out.text)
      // stderr is a warning channel, not a result: it gets its own mark so the
      // shell can tint it instead of drawing it as another anonymous grey box.
      const stderr = out.name === 'stderr' ? ' nb-stderr' : ''
      if (text.trim()) parts.push(preBlock(text, `nb-output nb-stream${stderr}`))
      continue
    }
    if (out.output_type === 'error') {
      const trace = (out.traceback ?? []).map(stripAnsi).join('\n')
      const fallback = [out.ename, out.evalue].filter(Boolean).join(': ')
      parts.push(preBlock(trace.trim() || fallback, 'nb-error'))
      continue
    }
    // execute_result / display_data
    const data = out.data ?? {}
    const figure = figureDataUri(data)
    const hasImage = figure !== null
    if (hasImage) {
      // A figure is the one output that cannot be tagged: the hub allowlist
      // permits `class` on `pre`/`code` and no other attribute anywhere, and
      // `img` is not among them. So the alt — which IS permitted — carries the
      // marker, and the shell selects on it (`img[alt="output image"]`) to give
      // a figure the same gutter and rule as the text outputs beside it.
      // Keep this string and src/core/shell.ts's selector in step.
      parts.push(`<img src="${escapeAttr(figure)}" alt="${FIGURE_ALT}">`)
    }
    // A mime bundle carries the SAME value at several richnesses. A pandas
    // DataFrame ships a real <table> as text/html and an ASCII grid as
    // text/plain; taking the fallback threw the only machine-readable table in
    // the corpus away, so ipynb -> csv/json/xlsx answered "no-tables" on
    // notebooks that plainly had one. Prefer the rich form, and emit only one
    // of the two — both would duplicate every value.
    //
    // Notebook HTML is untrusted input like any other source, and this one
    // arrives wrapped in a <style scoped> block, so it goes through the hub
    // allowlist rather than straight into the document.
    // An html output can reference an image by relative path exactly as a
    // markdown cell can, and it is no more resolvable here than there.
    const rich = mimeText(data['text/html'])
    const clean = rich.trim() ? sanitizeToHub(stripUnresolvableImageSrc(rich)) : ''
    if (clean.trim()) {
      parts.push(clean)
      continue
    }
    const text = mimeText(data['text/plain'])
    if (!text.trim()) continue
    // text/plain is the fallback for whatever richer form the bundle carries,
    // so once the image is on the page its placeholder must not be: matplotlib
    // ships "<Figure size 1080x1080 with 2 Axes>" beside every figure, and
    // printing both put that caption under every plot in the corpus. A repr
    // that is NOT that placeholder — `array([...])` next to its plot — is real
    // output and stays.
    if (hasImage && FIGURE_PLACEHOLDER.test(text.trim())) continue
    // Jupyter prompts an execute_result "Out[n]" — with the cell's number when
    // the output does not repeat one — and prompts display_data with nothing.
    if (out.output_type === 'display_data') {
      parts.push(preBlock(text, 'nb-output nb-display'))
      continue
    }
    parts.push(preBlock(text, `nb-output nb-result${countClass(executionCount(out) ?? cellCount)}`))
  }
  return parts.join('\n')
}

export async function readIpynb(src: SourceInput): Promise<HubDocument> {
  let nb: Notebook
  try {
    nb = JSON.parse(src.bytes.toString('utf8')) as Notebook
  } catch (err) {
    throw new ConversionError('read-failed', `Could not parse notebook JSON: ${(err as Error).message}`)
  }
  // nbformat 4 keeps cells at the top level; 3 and earlier nest them in worksheets.
  const cells = Array.isArray(nb.cells)
    ? nb.cells
    : (nb.worksheets ?? []).flatMap((sheet) => sheet.cells ?? [])
  if (cells.length === 0 && nb.nbformat === undefined) {
    throw new ConversionError('read-failed', 'Not a Jupyter notebook (missing cells/nbformat)')
  }

  const language = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? 'plaintext'
  const sections: string[] = []
  for (const cell of cells) {
    const source = joinSource(cell.source ?? cell.input)
    if (cell.cell_type === 'markdown') {
      if (source.trim()) sections.push((await readMarkdown({ bytes: Buffer.from(source, 'utf8') })).html)
      continue
    }
    if (cell.cell_type === 'code') {
      const count = executionCount(cell)
      if (source.trim()) {
        const cls = `nb-in${countClass(count)}`
        sections.push(
          `<pre class="${escapeAttr(cls)}">` +
            `<code class="language-${escapeAttr(language)}">${escapeHtml(source)}</code></pre>`,
        )
      }
      const outputs = renderOutputs(cell.outputs ?? [], count)
      if (outputs) sections.push(outputs)
      continue
    }
    // raw cells and anything unknown: keep the text verbatim
    if (source.trim()) sections.push(preBlock(source))
  }

  const name = src.filename?.split(/[\\/]/).pop()
  return { html: sections.join('\n'), title: name, language }
}
