import MarkdownIt from 'markdown-it'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import { full as emoji } from 'markdown-it-emoji'
import footnote from 'markdown-it-footnote'
import deflist from 'markdown-it-deflist'
import { safeLabel } from '../footnotes'
import { BRACED_PLAIN, diagramLanguage, mathClose, TEX_SHAPED } from '../rendered-blocks'
import { parseHTML } from 'linkedom'
import { sanitizeToHub } from '../allowlist'
import { inlineSvgElements } from '../svg-images'
import { notesToHub } from '../speaker-notes'
import { inlineLocalImages } from '../local-images'
import type { HubDocument, ReadContext, SourceInput } from '../types'

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
 * `![plan](data:image/svg+xml;base64,…)` is a picture, as the PNG, JPEG, GIF
 * and WebP ones markdown-it already accepts are. Its link check refused SVG,
 * so the picture arrived as its own source text, and the Markdown writer
 * writes every SVG image in exactly this form: an SVG picture written out
 * and read back was lost. Like any SVG image it is sanitized (B6) when the
 * document is read (convert.ts), and shown only as an <img>.
 */
const SVG_DATA_URI = /^data:image\/svg\+xml[;,]/i
/**
 * `![fig](file:///home/me/fig.png)` is a picture on disk too, read from there
 * like a relative path (local-images.ts). markdown-it refuses file: outright.
 * A link to one keeps its text: the hub allowlist takes file: off an href.
 */
const FILE_URL = /^file:/i
const validateLink = md.validateLink.bind(md)
md.validateLink = (url: string): boolean => SVG_DATA_URI.test(url.trim()) || FILE_URL.test(url.trim()) || validateLink(url)

/*
 * GitHub-flavored Markdown that markdown-it core does not read. Each one
 * produces markup the hub already has, so nothing here widens the allowlist,
 * and the Markdown writer turns each back into the same syntax.
 */

// `:tada:` -> 🎉, GitHub's full shortcode set. Emoticon shortcuts are OFF:
// GitHub leaves `:)` as typed, and a converter silently rewriting an author's
// punctuation into pictures is a fidelity loss, not a feature.
md.use(emoji, { shortcuts: {} })

const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || Number.isNaN(code)

/**
 * `~text~`: strikethrough with ONE tilde, as GitHub reads it. markdown-it
 * only knows `~~text~~`, and the Markdown writer used to emit the single form,
 * so a struck word written out and read back came back with its tildes.
 *
 * GitHub's flanking rule keeps prose safe: the struck text may not start or
 * end with whitespace, so "about ~5 and ~10 people" and "~/docs and ~/src"
 * stay as written. It must close on the same line, and a tilde that is half
 * of a `~~` is the other rule's business. Code spans and links inside are
 * stepped over whole, so a tilde in `code` never closes one.
 */
md.inline.ruler.after('strikethrough', 'single_tilde', (state: StateInline, silent: boolean) => {
  const start = state.pos
  const max = state.posMax
  const src = state.src
  if (src.charCodeAt(start) !== 0x7e || src.charCodeAt(start + 1) === 0x7e || src.charCodeAt(start - 1) === 0x7e) return false
  if (silent || start + 2 >= max || isSpace(src.charCodeAt(start + 1))) return false
  state.pos = start + 1
  let found = false
  while (state.pos < max) {
    if (src.charCodeAt(state.pos) === 0x7e) {
      found = true
      break
    }
    state.md.inline.skipToken(state)
  }
  const end = state.pos
  const inner = src.slice(start + 1, end)
  if (!found || inner === '' || inner.includes('\n') || isSpace(src.charCodeAt(end - 1)) || src.charCodeAt(end + 1) === 0x7e) {
    state.pos = start
    return false
  }
  state.posMax = end
  state.pos = start + 1
  state.push('s_open', 's', 1).markup = '~'
  state.md.inline.tokenize(state)
  state.push('s_close', 's', -1).markup = '~'
  state.pos = end + 1
  state.posMax = max
  return true
})

/**
 * `- [ ] todo` / `- [x] done` -> "☐ todo" / "☑ done".
 *
 * The hub has no checkbox (an <input> is a form control, not content), so the
 * state is kept as the ballot-box characters every output can show; the
 * Markdown writer turns a leading ☐/☑ back into `[ ]`/`[x]`. After text_join,
 * so `[ ]` (which the link rule splits at the bracket) is one text token.
 */
md.core.ruler.after('text_join', 'task_lists', (state: StateCore) => {
  const t = state.tokens
  for (let i = 2; i < t.length; i++) {
    if (t[i].type !== 'inline' || t[i - 1].type !== 'paragraph_open' || t[i - 2].type !== 'list_item_open') continue
    const first = t[i].children?.[0]
    if (!first || first.type !== 'text') continue
    const box = /^\[([ xX])\] /.exec(first.content)
    if (box) first.content = `${box[1] === ' ' ? '☐' : '☑'} ${first.content.slice(box[0].length)}`
  }
})

/*
 * Footnotes, in the hub's model (src/core/footnotes.ts): `[^smith2020]` keeps
 * its label so Markdown written back out says `[^smith2020]` again. Without
 * the plugin, markdown-it read `[^1]: text` as a LINK DEFINITION and the
 * note's text was gone.
 */
md.use(footnote)

/*
 * Definition lists, in the syntax pandoc, PHP Markdown Extra and kramdown
 * share and the Markdown writer writes: a term on a line of its own, each
 * definition after `:` (or pandoc's `~`) and a space, its later lines and
 * paragraphs indented. Without the plugin a glossary written out and read
 * back came back as paragraphs that began with a colon.
 *
 * The shape is narrow enough to leave prose alone: the term must be a
 * paragraph of ONE line (a `: ` line inside a longer paragraph continues it)
 * and the marker needs a space after it, so `:tada:`, `:1` and `~/docs` are
 * text. `~` is kept because pandoc writes it too; a one-line paragraph
 * followed by a line starting "~ " is about as rare in prose as one followed
 * by ": ", and either way every word arrives, only arranged as a list.
 * One thing the plugin takes that would lose a character: a list's first
 * marker with nothing after it ("Hello" then a line that is just `:`). The
 * first definition must have text on its marker's line, as the writer writes
 * it; later ones inside a list already begun are the plugin's to read.
 * The plugin uses `md` only to register its one rule (and for isSpace), so
 * it is handed a ruler that registers that rule behind the check.
 */
type BeforeArgs = Parameters<MarkdownIt['block']['ruler']['before']>
const firstMarkerHasText = (state: StateBlock, startLine: number): boolean => {
  const line = state.isEmpty(startLine + 1) ? startLine + 2 : startLine + 1
  return /^[:~][ \t]+\S/.test(state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]))
}
md.use((m: MarkdownIt) =>
  deflist({
    utils: m.utils,
    block: {
      ruler: {
        before: (at: string, name: string, rule: BeforeArgs[2], opts: BeforeArgs[3]) =>
          m.block.ruler.before(
            at,
            name,
            (state, startLine, endLine, silent) => (silent || firstMarkerHasText(state, startLine)) && rule(state, startLine, endLine, silent),
            opts,
          ),
      },
    },
  }),
)

// A tight definition (no blank line after its term) comes from the plugin
// with its paragraph hidden, so `<dd>text</dd>`. The hub form is the one
// Djot's renderer writes, every definition's text in a paragraph.
md.core.ruler.after('block', 'definition_paragraphs', (state: StateCore) => {
  // Only the definition's own paragraph: a tight list inside it stays tight.
  const dd: number[] = []
  for (const tok of state.tokens) {
    if (tok.type === 'dd_open') dd.push(tok.level + 1)
    else if (tok.type === 'dd_close') dd.pop()
    else if (tok.level === dd.at(-1) && (tok.type === 'paragraph_open' || tok.type === 'paragraph_close')) tok.hidden = false
  }
})

interface FootnoteEnv {
  footnotes?: { refs?: Record<string, number>; list?: { label?: string; count: number }[] }
  hubLabels?: Map<number, string>
  hubTaken?: Set<string>
}

// The plugin builds its notes list from REFERENCES, so a definition nothing
// points at was dropped with no trace. Register those last, in the order they
// were written, before the plugin assembles the list.
md.core.ruler.before('footnote_tail', 'footnote_keep_unreferenced', (state: StateCore) => {
  const fn = (state.env as FootnoteEnv).footnotes
  if (!fn?.refs) return
  fn.list ??= []
  for (const key of Object.keys(fn.refs)) {
    if (fn.refs[key] !== -1) continue
    fn.refs[key] = fn.list.length
    fn.list.push({ label: key.slice(1), count: 0 })
  }
})

/** The hub label for note `id`: the author's, made safe; an inline ^[…] note gets one. */
function hubLabel(env: FootnoteEnv, id: number): string {
  env.hubLabels ??= new Map()
  env.hubTaken ??= new Set()
  let label = env.hubLabels.get(id)
  if (label === undefined) {
    label = safeLabel(env.footnotes?.list?.[id]?.label ?? `note-${id + 1}`, env.hubTaken)
    env.hubLabels.set(id, label)
  }
  return label
}

md.renderer.rules.footnote_ref = (tokens, idx, _o, env) =>
  `<sup data-fn="${hubLabel(env, tokens[idx].meta.id)}">${tokens[idx].meta.id + 1}</sup>`
md.renderer.rules.footnote_block_open = () => '<ol>\n'
md.renderer.rules.footnote_block_close = () => '</ol>\n'
md.renderer.rules.footnote_open = (tokens, idx, _o, env) => `<li data-fn="${hubLabel(env, tokens[idx].meta.id)}">`
md.renderer.rules.footnote_close = () => '</li>\n'
// The plugin's ↩ back-link: writers make their own, where the format links.
md.renderer.rules.footnote_anchor = () => ''

/**
 * ```` ```{r setup, echo=FALSE} ```` and ```` ```{.python} ````: the chunk and
 * attribute fences of R Markdown, Quarto and pandoc. The language is the
 * first word inside the braces; the chunk options are R's business, not the
 * document's. Without this the code was highlighted as the language "{r".
 */
md.core.ruler.after('block', 'chunk_fences', (state: StateCore) => {
  for (const tok of state.tokens) {
    if (tok.type !== 'fence') continue
    const chunk = /^\{\s*\.?([A-Za-z][\w+-]*)[^}]*\}/.exec(tok.info.trim())
    if (chunk) tok.info = chunk[1].toLowerCase()
    // `graphviz`, `gv` and `viz` are all Graphviz: the hub calls it `dot` (spec B1).
    const [lang, ...rest] = tok.info.trim().split(/\s+/)
    const diagram = diagramLanguage(lang)
    if (diagram) tok.info = [diagram, ...rest].join(' ')
  }
})

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i

/**
 * `> [!NOTE]` and its four siblings -> a quote whose first paragraph is a bold
 * "Note". The marker must be alone on the quote's first line, as on GitHub;
 * an unknown type stays a plain quote. Run on block tokens, before inline
 * parsing, so the label is ordinary `**Note**` and the rest of the paragraph
 * is parsed as the paragraph it now is.
 */
md.core.ruler.after('block', 'github_alerts', (state: StateCore) => {
  const t = state.tokens
  for (let i = 0; i + 2 < t.length; i++) {
    if (t[i].type !== 'blockquote_open' || t[i + 1].type !== 'paragraph_open' || t[i + 2].type !== 'inline') continue
    const marker = ALERT.exec(t[i + 2].content)
    if (!marker) continue
    const label = marker[1][0].toUpperCase() + marker[1].slice(1).toLowerCase()
    const para = t[i + 1]
    const open = new state.Token('paragraph_open', 'p', 1)
    const inline = new state.Token('inline', '', 0)
    const close = new state.Token('paragraph_close', 'p', -1)
    for (const tok of [open, inline, close]) {
      tok.block = true
      tok.level = para.level
      tok.map = para.map
    }
    inline.level = para.level + 1
    inline.content = `**${label}**`
    inline.children = []
    const rest = t[i + 2].content.slice(marker[0].length)
    if (rest.trim() === '') t.splice(i + 1, 3, open, inline, close)
    else {
      t[i + 2].content = rest
      t.splice(i + 1, 0, open, inline, close)
    }
  }
})

/**
 * Math, as tagged source (spec B1): `<code class="language-math">TEX</code>`
 * inline, `<pre><code class="language-math">TEX</code></pre>` for a `$$…$$`
 * that is a paragraph of its own, and `<code class="language-math
 * math-display">TEX</code>` for one in the middle of a sentence, which is
 * display math inside the paragraph, as pandoc reads it. TEX is the text between the
 * delimiters, byte for byte. Writers draw only spans a reader identified, so
 * the tag is what keeps a `$5 … $10` in a Word file from ever being drawn.
 *
 * This release draws math (spec B10 in
 * docs/superpowers/specs/2026-10-14-rendered-blocks-and-markdown-fidelity-design.md,
 * which replaces an earlier "not rendered" ruling that was never written
 * down). The hub still holds only the source, and why the source must reach
 * it unaltered is unchanged: markdown-it used to apply its own inline rules to
 * the TeX first. Measured over the corpus notebooks, 29 of 387 spans were
 * damaged:
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
 * mistaken for math. The content is escaped on render like any other text, so
 * a `<` inside a formula stays inert.
 *
 * `$$...$$` is always math — prose does not use it. A single `$` is only math
 * when the span actually looks like TeX, so "costs $5 for the **bold** plan and
 * $10" keeps its emphasis instead of being swallowed as a formula. The
 * Markdown writer applies the same test, so what it writes reads back the same.
 * Inline TeX that would not pass it is written as `${x+y}$`, and the braces
 * are taken off here (BRACED_PLAIN). A `\$` inside the TeX does not close it.
 */
md.inline.ruler.before('escape', 'math', (state, silent) => {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x24) return false
  const display = state.src.startsWith('$$', start)
  const delim = display ? '$$' : '$'
  const close = mathClose(state.src, start + delim.length, delim)
  if (close === -1) return false
  const content = state.src.slice(start + delim.length, close)
  if (content === '' || (!display && !TEX_SHAPED.test(content))) return false
  if (!silent) {
    const tok = state.push(display ? 'math_display' : 'math_inline', 'code', 0)
    tok.content = display ? content : (BRACED_PLAIN.exec(content)?.[1] ?? content)
    tok.markup = delim
  }
  state.pos = close + delim.length
  return true
})

const mathCode = (tex: string, cls = 'language-math'): string => `<code class="${cls}">${md.utils.escapeHtml(tex)}</code>`
md.renderer.rules.math_inline = (tokens, idx) => mathCode(tokens[idx].content)
// `$$…$$` within a sentence: display math, in the paragraph (pandoc's DisplayMath).
md.renderer.rules.math_display = (tokens, idx) => mathCode(tokens[idx].content, 'language-math math-display')
md.renderer.rules.math_block = (tokens, idx) => `<pre>${mathCode(tokens[idx].content)}</pre>\n`

/** A paragraph that is one `$$…$$` and nothing else is display math, not a paragraph. */
md.core.ruler.after('inline', 'display_math', (state: StateCore) => {
  const t = state.tokens
  for (let i = 0; i + 2 < t.length; i++) {
    const kids = t[i + 1].children
    if (t[i].type !== 'paragraph_open' || t[i + 2].type !== 'paragraph_close' || kids?.length !== 1 || kids[0].type !== 'math_display') continue
    const block = new state.Token('math_block', 'pre', 0)
    block.block = true
    block.content = kids[0].content
    block.markup = '$$'
    block.map = t[i].map
    block.level = t[i].level
    t.splice(i, 3, block)
  }
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
 * A SourceInput is bytes plus a bare filename, so without the folder it came
 * from (ReadContext.sourceDir, local-images.ts, which runs first) there is no
 * base to resolve `../../img/ods_stickers.jpg` against.
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

/** The lines a front-matter block may hold: anything else means it is not one. */
const FRONT_MATTER_LINE = /^(?:\s*|#.*|[A-Za-z0-9_][\w .-]*:(?:\s.*)?|[ \t].*|- .*)$/
const KEY_LINE = /^[A-Za-z0-9_][\w .-]*:/
const MAX_FRONT_MATTER_LINES = 200

/** A scalar YAML value: quotes removed and their escapes undone. Block scalars are not read. */
function yamlScalar(raw: string): string | undefined {
  const v = raw.trim()
  if (v === '' || v === '|' || v === '>' || /^[|>][+-]?\d*$/.test(v)) return undefined
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\])/g, '$1')
  return v.replace(/\s+#.*$/, '')
}

/**
 * YAML front matter, removed before markdown-it sees it.
 *
 * Unrecognized, markdown-it read the opening `---` as a rule and the last
 * `key: value` line plus the closing `---` as a setext heading, so a file's
 * metadata arrived as `<hr><h2>title: Hello\nauthor: me</h2>`.
 *
 * Recognized only when it cannot be anything else: the file's very first line
 * is `---`, a `---` or `...` closes it within 200 lines, at least one line is
 * `key: value`, and every line between is blank, a comment, `key: value`, an
 * indented continuation or a `- ` list item. A rule followed by prose fails
 * the last test and stays a rule. Only a scalar `title:` is read; there is no
 * YAML parser here, and everything else in the block is discarded.
 */
export function stripFrontMatter(text: string): { body: string; title?: string } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trimEnd() !== '---') return { body: text }
  let close = -1
  for (let i = 1; i < lines.length && i <= MAX_FRONT_MATTER_LINES; i++) {
    const line = lines[i].trimEnd()
    if (line === '---' || line === '...') {
      close = i
      break
    }
    if (!FRONT_MATTER_LINE.test(lines[i])) return { body: text }
  }
  const block = lines.slice(1, close)
  if (close < 0 || !block.some((l) => KEY_LINE.test(l))) return { body: text }
  const titleLine = block.find((l) => /^title:/.test(l))
  const title = titleLine === undefined ? undefined : yamlScalar(titleLine.slice('title:'.length))
  return { body: lines.slice(close + 1).join('\n'), ...(title ? { title } : {}) }
}

const CALLOUT = /\.callout-(note|tip|important|warning|caution)\b/i

/**
 * Quarto's `:::` divs, for .qmd and .Rmd files. A callout
 * (`::: {.callout-warning}`) becomes the GitHub alert of the same name, so it
 * reads, prints and writes back the same way an alert does; any other div
 * (columns, margins, panels) is layout, so its fence lines go and its content
 * stays. Fenced code is passed through untouched.
 */
export function quartoDivs(text: string): string {
  const out: string[] = []
  const open: boolean[] = [] // true for a callout
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const tick = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (!fence) {
      const opener = /^:{3,}\s*(\{[^}]*\}|[\w.-]+)\s*$/.exec(line)
      if (opener) {
        const callout = CALLOUT.exec(opener[1])
        if (callout) out.push(`${'> '.repeat(open.filter(Boolean).length)}> [!${callout[1].toUpperCase()}]`)
        open.push(!!callout)
        continue
      }
      if (/^:{3,}\s*$/.test(line) && open.length > 0) {
        open.pop()
        continue
      }
    }
    if (tick) fence = fence ? (tick[0] === fence[0] && tick.length >= fence.length ? null : fence) : tick
    const depth = open.filter(Boolean).length
    out.push(depth === 0 ? line : `${'> '.repeat(depth)}${line}`.trimEnd())
  }
  return out.join('\n')
}

export interface MarkdownOptions {
  /**
   * Read a leading YAML block as front matter. On for a whole file or a paste;
   * off for a notebook cell, where a leading `---` is an author's rule.
   */
  frontMatter?: boolean
}

export async function readMarkdown(src: SourceInput, ctx?: ReadContext, opts: MarkdownOptions = {}): Promise<HubDocument> {
  const text = src.bytes.toString('utf8').replace(/^\uFEFF/, '')
  const { body: unfenced, title } = opts.frontMatter === false ? { body: text } : stripFrontMatter(text)
  const body = /\.(rmd|qmd)$/i.test(src.filename ?? '') ? quartoDivs(unfenced) : unfenced
  // Inline HTML may draw an SVG; it becomes an SVG image, as in a page.
  // Pictures by path are read from the document's folder first; only what
  // that leaves unresolved is stripped.
  const html = stripUnresolvableImageSrc(await inlineLocalImages(inlineSvgElements(md.render(body, {})), ctx))
  // Notes are lifted BEFORE sanitizing: the sanitizer drops comments, so a
  // `<!-- notes: ... -->` left until after it would simply be gone.
  return { html: escapeQuotesInText(sanitizeToHub(notesToHub(html))), ...(title ? { title } : {}) }
}
