import hljs from 'highlight.js/lib/common'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import powershell from 'highlight.js/lib/languages/powershell'
import type { HubDocument, TargetFormat } from './types'

hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('powershell', powershell)

export interface ShellOptions {
  /** Target the shell is being rendered for — enables target-specific fidelity (e.g. code highlighting for pdf/html). */
  target?: TargetFormat
}

// Compact GitHub-light palette for hljs spans (kept inline: the shell must stay self-contained).
const HLJS_CSS = `
  .hljs-keyword, .hljs-selector-tag, .hljs-meta { color: #cf222e; }
  .hljs-title, .hljs-title.class_, .hljs-title.function_ { color: #8250df; }
  .hljs-string, .hljs-regexp, .hljs-attr { color: #0a3069; }
  .hljs-number, .hljs-literal { color: #0550ae; }
  .hljs-comment, .hljs-quote { color: #59636e; font-style: italic; }
  .hljs-built_in, .hljs-type { color: #953800; }
  .hljs-variable, .hljs-template-variable, .hljs-property { color: #24292f; }
  .hljs-section, .hljs-name { color: #0550ae; font-weight: 600; }
  .hljs-addition { background: #dafbe1; }
  .hljs-deletion { background: #ffebe9; }
`

/**
 * Notebook cells. A converted notebook used to be an undifferentiated dump:
 * the code and the thing it printed were the SAME grey box, with no execution
 * prompts and nothing marking where input ended and output began.
 *
 * The hub allowlist permits `class` on `pre`/`code` and no other attribute
 * anywhere — anything it passes must round-trip the TipTap editor losslessly —
 * so the reader tags each block with its role — `nb-in`, `nb-output` plus one
 * of `nb-result` / `nb-stream` / `nb-display` (`nb-stderr` for the warning
 * channel), or `nb-error` — and `nb-c<n>` for its prompt number. All the
 * drawing happens here.
 *
 * The gutter is padding INSIDE the block, and the prompt hangs back into it
 * with a negative margin equal to that padding, so nothing can reach the page
 * edge — printToPDF silently clips whatever does. `white-space: pre-wrap` is
 * inherited from the base `pre` rule and must stay: without it long lines are
 * clipped and lost.
 */
const NB_GUTTER = '5.4em'
const NB_CSS = `
  pre.nb-in, pre.nb-output, pre.nb-error {
    padding-left: ${NB_GUTTER};
    border-left: 4px solid transparent; border-radius: 0 6px 6px 0;
  }
  /* A cell reads as one unit: its outputs hug the code, the next cell breathes. */
  pre.nb-in { margin: 1.4em 0 0.3em; background: #f5f6fa; border-left-color: #4053b5; }
  pre.nb-output, pre.nb-error { margin: 0 0 0.3em; }
  pre.nb-output { background: #fcfcfd; border-left-color: #d4d4d8; }
  pre.nb-output.nb-result { background: #fbfbfd; border-left-color: #c2410c; }
  pre.nb-stream { color: #3f3f46; }
  pre.nb-output.nb-stderr { background: #fff8ed; border-left-color: #d97706; color: #7c2d12; }
  pre.nb-error { background: #fef2f2; border-left-color: #dc2626; color: #b91c1c; }
  /* The prompt lives in the gutter the padding reserved, never outside it. */
  pre.nb-in::before, pre.nb-output::before, pre.nb-error::before {
    display: inline-block; width: ${NB_GUTTER}; margin-left: -${NB_GUTTER};
    font-size: 0.85em; font-weight: 600; letter-spacing: -0.02em;
    color: #a1a1aa; white-space: pre; vertical-align: top;
  }
  pre.nb-in::before { content: "In [ ]:"; color: #4053b5; }
  pre.nb-output::before { content: ""; }
  pre.nb-output.nb-result::before { content: "Out[ ]:"; color: #c2410c; }
  pre.nb-error::before { content: "Error:"; color: #dc2626; }
  pre.nb-output.nb-stderr::before { content: "stderr"; color: #b45309; }
  /* A figure output. An img cannot carry a class — the allowlist permits the
     class attribute on pre/code and no other attribute anywhere — so it is
     selected by the alt text src/core/readers/ipynb.ts stamps on every figure
     it inlines. Keep the two in step.

     Without this a plot rendered full-bleed against the page margin while the
     text output beside it sat indented behind a coloured rule, so it read as a
     stray picture rather than as the cell's result. border-box is load-bearing:
     with the default content-box the gutter padding is ADDED to the 100% width
     and printToPDF clips whatever leaves the page.

     There is deliberately no ::before here. Generated content on a replaced
     element is not rendered, so an image cannot be given prompt TEXT at all
     within this contract — but Jupyter prompts display_data with nothing
     either, and every figure in the corpus notebooks is display_data. An
     execute_result figure, which Jupyter would prompt "Out[n]", would need a
     non-replaced wrapper allowed to carry a class. */
  img[alt="output image"] {
    display: block; box-sizing: border-box;
    margin: 0 0 0.3em; padding-left: ${NB_GUTTER};
    border-left: 4px solid #d4d4d8; background: #fcfcfd;
  }
`

/**
 * Execution counts are per cell, so their prompts cannot be a static rule.
 * Emit one `content` rule per number actually present in the document; the
 * two-class selector outranks the empty `In [ ]:` / `Out[ ]:` defaults above.
 */
function notebookPromptCss(html: string): string {
  const counts = new Set<string>()
  for (const m of html.matchAll(/class="[^"]*\bnb-c(\d+)\b/g)) counts.add(m[1])
  const rules: string[] = []
  for (const n of [...counts].sort((a, b) => Number(a) - Number(b))) {
    rules.push(`  pre.nb-in.nb-c${n}::before { content: "In [${n}]:"; }`)
    rules.push(`  pre.nb-output.nb-result.nb-c${n}::before { content: "Out[${n}]:"; }`)
  }
  return rules.join('\n')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&')
}

function highlightCodeBlocks(html: string): { html: string; any: boolean } {
  let any = false
  const out = html.replace(/<code class="language-([\w+-]+)">([\s\S]*?)<\/code>/g, (match, lang, body) => {
    if (!hljs.getLanguage(lang)) return match
    const { value } = hljs.highlight(decodeEntities(body), { language: lang })
    any = true
    return `<code class="language-${lang} hljs">${value}</code>`
  })
  return { html: out, any }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const BASE_CSS = `
  :root { color-scheme: light; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.55; color: #1a1a1a; max-width: 46rem;
    margin: 2.5rem auto; padding: 0 1.5rem;
  }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.5em; }
  h1 { font-size: 1.9rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.25rem; }
  p { margin: 0 0 1em; }
  code, pre { font-family: "SFMono-Regular", Consolas, monospace; }
  /* pre-wrap is load-bearing: with overflow alone, printToPDF CLIPS every
     line that runs past the page edge and silently drops the rest. */
  /* Monospace at the prose size prints far larger than it reads: a listing
     took roughly a third more page than it needed, and long lines wrapped
     that would otherwise have fit. Set below the body size, not above the
     minimum legible one. */
  pre {
    background: #f4f4f5; padding: 1em; border-radius: 6px;
    white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
    font-size: 0.72em; line-height: 1.45;
  }
  code { background: #f4f4f5; padding: 0.15em 0.35em; border-radius: 4px; font-size: 0.88em; }
  /* Inline code inside a <pre> would compound the two reductions. */
  pre code { font-size: inherit; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0 0 1em; padding: 0.2em 1em; border-left: 4px solid #d4d4d8; color: #52525b; }
  table { border-collapse: collapse; margin: 0 0 1em; }
  th, td { border: 1px solid #d4d4d8; padding: 0.4em 0.7em; }
  /* Wide tables must wrap, never run off the page: printToPDF clips whatever
     overflows, so a 12-column table silently lost its right-hand columns. */
  table { width: 100%; table-layout: fixed; }
  th, td { overflow-wrap: anywhere; word-break: break-word; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  /* An image taller than the page cannot be placed on it, so the renderer
     pushes it to the next page and leaves the current one BLANK — an epub
     whose 1450x2320 cover scaled to 1177px tall produced an empty first page
     and then split the cover across the two after it. Bounding the height as
     well as the width makes any single image fit one page; with only max-*
     constraints the aspect ratio is preserved, so nothing is distorted.
     Viewport units resolve against the page box in paged media. */
  img {
    max-width: 100%;
    max-height: 92vh;
    break-inside: avoid;
  }
  ul, ol { margin: 0 0 1em 1.4em; }
`

export function renderDocumentShell(doc: HubDocument, opts?: ShellOptions): string {
  const title = escapeHtml(doc.title?.trim() || 'Document')
  let body = doc.html
  let css = BASE_CSS
  // The reading-width cage is right for prose and wrong for data: a wide
  // table needs the whole page, and anything past the edge is clipped away.
  if (body.includes('<table')) css += '\n  body { max-width: none; }\n'
  // Notebook cell styling costs nothing on a document that has no cells. A
  // figure carries no class, so it is matched on its alt: a cell whose only
  // output is a plot would otherwise leave the block unstyled.
  if (/class="nb-|alt="output image"/.test(body)) css += NB_CSS + notebookPromptCss(body) + '\n'
  if (opts?.target === 'pdf' || opts?.target === 'html') {
    const highlighted = highlightCodeBlocks(body)
    if (highlighted.any) {
      body = highlighted.html
      css += HLJS_CSS
    }
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`
}
