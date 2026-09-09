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
 * its indentation as markdown would mangle it.
 */
const FORMATTING_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'blockquote', 'pre', 'code', 'hr',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'mark',
  'a', 'img',
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
 * Whether a paste should be taken from its HTML flavor.
 *
 * The plain flavor is preferred only when there is one AND the HTML adds
 * nothing to it, so rich content keeps every bit of its formatting.
 */
export function shouldUseHtmlFlavor(html: string, plain: string): boolean {
  if (!html.trim()) return false
  if (!plain.trim()) return true
  return looksLikeFormattedHtml(html)
}
