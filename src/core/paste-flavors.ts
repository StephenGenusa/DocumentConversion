/**
 * Choosing between the two flavors a copy puts on the clipboard.
 *
 * Copying text almost always yields both a `text/plain` and a `text/html`
 * flavor, and which one is the better copy depends on where it came from:
 *
 *   - Word, Teams, Outlook and a rendered web page put real markup in the HTML
 *     flavor. It carries formatting the plain flavor has already lost, so it
 *     must win — that is what "pasting keeps formatting" means.
 *   - A chat window, a text editor or a terminal put the SAME characters in
 *     both. The HTML flavor is only the plain text wrapped for whitespace
 *     (`<span style="white-space:pre-wrap">` in Chrome, a `<div>` per line
 *     elsewhere), so it carries nothing extra — and preferring it throws away
 *     the one useful thing about the plain flavor, which is that it can still
 *     be read as markdown.
 *
 * Taking the HTML flavor unconditionally is what made pasted markdown arrive as
 * literal `|` and `#` characters: the markdown never reached its reader.
 */

/**
 * Tags that mean the HTML flavor is carrying structure of its own rather than
 * wrapping plain text.
 *
 * `span`, `div`, `br`, `meta`, `html`, `head`, `body` and `font` are absent on
 * purpose — those are exactly what a whitespace wrapper is built from. `pre`
 * and `code` ARE here: a copied code block is formatted content, and re-reading
 * its indentation as markdown would mangle it. So is `svg`: a copied drawing's
 * plain flavor is only its labels.
 */
const FORMATTING_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'blockquote', 'pre', 'code', 'hr',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'mark',
  'a', 'img', 'svg',
]

/**
 * Matches an opening tag only — `<table ...>` or `<table>`, never the text
 * "&lt;table&gt;" a user copied out of a document about HTML.
 */
const FORMATTING_TAG_RE = new RegExp(`<(?:${FORMATTING_TAGS.join('|')})(?:\\s[^>]*)?/?>`, 'i')

export function looksLikeFormattedHtml(html: string): boolean {
  return FORMATTING_TAG_RE.test(html)
}

/**
 * A fenced code block: an opening fence and its closing one, or an opening
 * fence that names its language (an answer cut off before it closes). Markdown's
 * own syntax, which code itself almost never contains.
 */
const FENCED_BLOCK = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1|^ {0,3}(?:`{3,}|~{3,})[\w+#.-]+[ \t]*$/m

export function hasFencedCodeBlock(text: string): boolean {
  return FENCED_BLOCK.test(text)
}

/**
 * Markdown's constructs, each counted once. A `#` line alone is a shell or
 * Python comment as often as a heading, and one bullet is any note, so it
 * takes two different ones to call text markdown.
 */
const MARKDOWN_CONSTRUCTS: RegExp[] = [
  /^#{1,6}[ \t]+\S/m, // heading
  /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/m, // list item
  /\[[^\]\n]+\]\((?:https?:|mailto:|[./#])[^)\s]*\)/, // link or picture
  /\*\*[^*\s][^*\n]*\*\*/, // bold
  /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*\|/m, // table separator row
  /^>[ \t]/m, // quote
]

/**
 * Text that is markdown beyond reasonable doubt: it has a fenced code block, or
 * two different markdown constructs. Stricter than detect's looksLikeMarkdown,
 * which one `# comment` satisfies, because what it decides is costlier to get
 * wrong: a copied script read as markdown loses its indentation.
 */
export function clearlyMarkdown(text: string): boolean {
  if (hasFencedCodeBlock(text)) return true
  return MARKDOWN_CONSTRUCTS.filter((re) => re.test(text)).length >= 2
}

/**
 * HTML that is one `<pre>` and nothing formatted besides: how an IDE's rich
 * copy and a browser showing a raw .md file put text on the clipboard. A code
 * block copied from a page has its `<code>`, and a page has more than a `<pre>`.
 */
function onlyOnePre(html: string): boolean {
  if ((html.match(/<pre\b/gi) ?? []).length !== 1 || /<code\b/i.test(html)) return false
  return !looksLikeFormattedHtml(html.replace(/<\/?pre\b[^>]*>/gi, ''))
}

/**
 * Whether a paste should be taken from its HTML flavor.
 *
 * The plain flavor is preferred only when there is one AND the HTML adds
 * nothing to it, so rich content keeps every bit of its formatting. A lone
 * `<pre>` round markdown adds only colors, and taken as HTML the whole
 * document became one code block, so there the markdown is read.
 */
export function shouldUseHtmlFlavor(html: string, plain: string): boolean {
  if (!html.trim()) return false
  if (!plain.trim()) return true
  if (!looksLikeFormattedHtml(html)) return false
  return !(onlyOnePre(html) && clearlyMarkdown(plain))
}
