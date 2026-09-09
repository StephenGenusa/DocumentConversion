import MarkdownIt from 'markdown-it'
import { parseHTML } from 'linkedom'
import { sanitizeToHub } from '../allowlist'
import { notesToHub } from '../speaker-notes'
import type { HubDocument, SourceInput } from '../types'

// typographer is off deliberately: this is a converter, and silently rewriting
// an author's straight quotes to curly ones loses fidelity (notebooks and
// technical prose quote literals constantly).
//
// html is ON: inline HTML is part of the markdown spec and real documents lean
// on it. With it off, `<img src='...' width=70%>` in a notebook markdown cell
// rendered as VISIBLE TEXT and the picture never appeared; `<center>` and
// `<spoiler title="...">` leaked the same way. Markdown is untrusted input, so
// everything it produces goes through the hub allowlist — which also drops the
// tags the hub has no model for (center, spoiler, details) while keeping their
// text, instead of printing their angle brackets at the reader.
const md = new MarkdownIt({ html: true, linkify: true, typographer: false })

/**
 * Hand a math span through untouched.
 *
 * TeX is deliberately NOT rendered here (see the ruling in docs/superpowers/
 * specs: a real engine cannot survive the hub allowlist, and a partial Unicode
 * transform silently changes formulas). But "not rendered" was not the same as
 * "left alone" — markdown-it applied its own inline rules to the source first,
 * so what reached the reader was already damaged. Measured over the corpus
 * notebooks, 29 of 387 spans:
 *
 *   `\left\{`  ->  `\left{`     backslash escaping ate the escape
 *   `\\`       ->  `\`          a display-math line break vanished
 *   `$e_{i} = y_{i} - \hat{y}_{i}$ ... $p_{i} = ...$`
 *              ->  `\hat{y}<em>{i}$ ... $p</em>{i}`
 *
 * — the last being two subscripts pairing as emphasis ACROSS a formula
 * boundary, which breaks both formulas and the prose between them. That is
 * corruption of content, not a rendering choice.
 *
 * An inline rule rather than a pre-pass over the source, because markdown-it
 * runs inline rules only in inline contexts: a `$` in a fenced or indented code
 * block is handled by the block parser and never reaches this, so a shell
 * prompt (`$ pip install ...`, which the corpus does contain) cannot be
 * mistaken for math. Emitting a `text` token also means the content is escaped
 * on render like any other text, so a `<` inside a formula stays inert.
 *
 * `$$...$$` is always math — prose does not use it. A single `$` is only math
 * when the span actually looks like TeX, so "costs $5 for the **bold** plan and
 * $10" keeps its emphasis instead of being swallowed as a formula.
 */
const TEX_SHAPED = /[\\{}^_]/

md.inline.ruler.before('escape', 'math', (state, silent) => {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x24) return false
  const display = state.src.startsWith('$$', start)
  const delim = display ? '$$' : '$'
  const close = state.src.indexOf(delim, start + delim.length)
  if (close === -1) return false
  const content = state.src.slice(start + delim.length, close)
  if (content === '' || (!display && !TEX_SHAPED.test(content))) return false
  if (!silent) state.push('text', '', 0).content = delim + content + delim
  state.pos = close + delim.length
  return true
})

/**
 * Put back the one thing sanitizing changes about markdown-it's own output.
 *
 * sanitize-html decodes `&quot;` in TEXT to a bare `"` (it leaves `&amp;`,
 * `&lt;` and `&gt;` alone). That is valid html, but markdown-it escapes it and
 * the rest of the pipeline was built on markdown-it's escaping, so a document
 * with no raw html in it must come out exactly as it did before. Decoding is
 * doing real security work in attributes — `javas&#99;ript:` is only caught
 * because the parser decodes it — so it stays on, and this fixes up after it.
 *
 * Safe on sanitizer OUTPUT specifically: every `<` and `>` in text is already
 * escaped, so `<` here always opens a tag, and inside a tag `>` and `"` only
 * ever appear as the tag's own delimiters (attribute values keep `&gt;` and
 * `&quot;` escaped).
 */
function escapeQuotesInText(html: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const lt = html.indexOf('<', i)
    if (lt === -1) return out + html.slice(i).replace(/"/g, '&quot;')
    out += html.slice(i, lt).replace(/"/g, '&quot;')
    const gt = html.indexOf('>', lt)
    if (gt === -1) return out + html.slice(lt)
    out += html.slice(lt, gt + 1)
    i = gt + 1
  }
}

/**
 * Only data: and http(s) images can ever resolve from a standalone document.
 * A SourceInput is bytes plus a bare filename, so there is no base URL to
 * resolve `../../img/ods_stickers.jpg` against, and a root-relative
 * `/_layouts/15/images/spcommon.png` is meaningless away from its origin.
 *
 * This is the same predicate `src/core/readers/html.ts` applies for the same
 * reason (and the docx writer before it). It is repeated rather than shared
 * because the hub allowlist is the only module those readers have in common
 * and it is a contract, not a utility shelf.
 */
const RESOLVABLE_IMAGE_SRC = /^\s*(?:data|https?):/i

/**
 * Strip the src rather than the tag, and let `sanitizeToHub` apply its existing
 * rule for a src-less `<img>`: keep the alt text in a `<span>`, drop the element
 * when there is none. One place decides what a contentless image becomes.
 *
 * Parsing is skipped entirely — and the string returned untouched — unless
 * there is an image to fix, so a document with no images (nearly all of them,
 * and every markdown cell of a notebook) is byte-for-byte what it was before.
 */
export function stripUnresolvableImageSrc(html: string): string {
  if (!/<img\b/i.test(html)) return html
  try {
    // linkedom parses, it does not do HTML tree construction, so a bare
    // fragment has to be wrapped in a document before it will come back whole.
    const body = parseHTML(`<html><head></head><body>${html}</body></html>`).document.body
    if (!body) return html
    let changed = false
    for (const img of Array.from(body.querySelectorAll('img'))) {
      if (RESOLVABLE_IMAGE_SRC.test(img.getAttribute('src') ?? '')) continue
      img.removeAttribute('src')
      changed = true
    }
    return changed ? body.innerHTML : html
  } catch {
    // A fragment linkedom cannot parse must still convert; the sanitizer is
    // the safety net either way.
    return html
  }
}

export async function readMarkdown(src: SourceInput): Promise<HubDocument> {
  const html = stripUnresolvableImageSrc(md.render(src.bytes.toString('utf8')))
  // Notes are lifted BEFORE sanitising: the sanitiser drops comments, so a
  // `<!-- notes: ... -->` left until after it would simply be gone.
  return { html: escapeQuotesInText(sanitizeToHub(notesToHub(html))) }
}
