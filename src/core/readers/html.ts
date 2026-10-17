import { parseHTML } from 'linkedom'
import type { HubDocument, SourceInput } from '../types'
import { sanitizeToHub } from '../allowlist'
import { inlineSvgElements } from '../svg-images'
import { decodeTextBytes } from './txt'
import { tagForeignCodeBlocks } from '../code-language'
import { diagramLanguage, type DiagramLanguage } from '../rendered-blocks'

// linkedom's elements type as plain DOM Elements; named once so the helpers
// below can take one without every call site repeating the cast.
type DomElement = Element

/**
 * Class names that mean "in the DOM for a screen reader, painted nowhere".
 * Matching on a class name is a heuristic, so it is kept to idioms that are
 * named in a framework's own stylesheet and mean nothing else anywhere:
 *
 *   sr-only              Bootstrap 4, Tailwind
 *   visually-hidden      Bootstrap 5, GOV.UK Design System
 *   visuallyhidden       HTML5 Boilerplate
 *   screen-reader-text   WordPress core
 *   screen-reader-only   Foundation-era variant of the same name
 *   assistive-text       older WordPress themes
 *   element-invisible    Drupal 7
 *   ms-hidden            SharePoint chrome ("Currently selected")
 *   ms-cui-hidden        SharePoint ribbon ("Tab 1 of 3.")
 *
 * Matching is on the whole class token, never a substring: the same SharePoint
 * page carries `ms-dialogHidden` and `aspNetHidden`, which mean "hidden in a
 * dialog" and "ASP.NET form state" — neither is hidden text.
 *
 * The page's own <style> blocks are NOT read. Deciding visibility from CSS
 * needs a parser, the cascade and specificity, and even then the rules that
 * matter usually live in external stylesheets we will not fetch, so a partial
 * implementation would be right on some pages and wrong on others. The class
 * names above identify the idiom wherever its CSS happens to live.
 */
const VISUALLY_HIDDEN_CLASSES = new Set([
  'sr-only',
  'visually-hidden',
  'visuallyhidden',
  'screen-reader-text',
  'screen-reader-only',
  'assistive-text',
  'element-invisible',
  'ms-hidden',
  'ms-cui-hidden',
])

function hasVisuallyHiddenClass(el: DomElement): boolean {
  const cls = el.getAttribute('class')
  if (!cls) return false
  return cls.split(/\s+/).some((token) => VISUALLY_HIDDEN_CLASSES.has(token.toLowerCase()))
}

/**
 * The same visually-hidden recipe written inline instead of behind a class:
 * a one-pixel box with its content clipped or overflowing out of sight. The
 * 1px box is what makes it unambiguous — a plain `overflow:hidden` container
 * is ordinary layout.
 */
function isClipRectHidden(style: string): boolean {
  if (!style.includes('width:1px') || !style.includes('height:1px')) return false
  return style.includes('clip:rect(') || style.includes('clip-path:inset(') || style.includes('overflow:hidden')
}

/**
 * Hidden chrome is menus, tooltips, prefetch stubs and live regions: a label or
 * a sentence, never a section of the document. The one case where hidden markup
 * holds something the reader wants is a collapsed accordion or an inactive tab
 * panel, and that has the shape of a document — a heading, a table, or several
 * paragraphs. Shape rather than length, because the longest hidden run on the
 * SharePoint page is a 249-character screen-reader instruction about the Ribbon.
 */
function carriesDocumentContent(el: DomElement): boolean {
  // Self as well as descendants, for the print-only or alternate-view <table>
  // that is hidden as a whole.
  if (el.matches('table') || el.querySelector('h1,h2,h3,h4,h5,h6,table')) return true
  return el.querySelectorAll('p').length >= 2
}

/**
 * Remove content the browser never painted, so it cannot be concatenated onto
 * the visible text beside it. A saved SharePoint page read out as "Business and
 * Operations ServicesCurrently selected" and "BrowseTab 1 of 3." because the
 * accessibility span sits flush against the label with no separator; the same
 * silent gluing the project has been clearing elsewhere.
 *
 * Dropping rather than separating, for both tiers below, because none of this
 * is content: an accessibility annotation is a second rendering of a label the
 * sighted reader already has, and repeating it — separated or not — is noise.
 */
function stripHiddenContent(root: DomElement): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (!el.parentNode) continue // an ancestor already took this subtree with it
    const style = (el.getAttribute('style') ?? '').replace(/\s+/g, '').toLowerCase()

    // Tier one — the author's own declaration that the subtree is not content.
    // ARIA forbids aria-hidden="true" on material that is visible and
    // meaningful, so it marks decoration or something already hidden by other
    // means (here, the nav flyouts that only appear on hover). Screen-reader-
    // only text is by construction a duplicate or annotation of the visible
    // rendering. Both go whatever they contain.
    if (el.getAttribute('aria-hidden') === 'true' || hasVisuallyHiddenClass(el) || isClipRectHidden(style)) {
      el.remove()
      continue
    }

    // Tier two — hidden by CSS or by the hidden attribute. The browser drew
    // nothing, so neither should we, unless the subtree looks like real content
    // that merely starts collapsed. `hidden="until-found"` is always real
    // content: it exists so find-in-page can reveal it.
    const hiddenAttr = el.getAttribute('hidden')
    const hidden =
      (hiddenAttr !== null && hiddenAttr.toLowerCase() !== 'until-found') ||
      style.includes('display:none') ||
      style.includes('visibility:hidden')
    if (hidden && !carriesDocumentContent(el)) el.remove()
  }
}

/**
 * Only data: and http(s) images can ever resolve from a standalone local file.
 * A SourceInput is bytes plus a bare filename, so there is no base URL to
 * resolve a relative path against, and a root-relative
 * `/_layouts/15/images/spcommon.png?rev=43` is meaningless away from its
 * origin. The saved SharePoint page passed all seventeen of its images through
 * and rendered a row of broken-image icons and alt-text placeholders.
 *
 * This is the predicate the docx writer already applies for the same reason
 * (`dropUnresolvableImages`). Note that a sibling `_files/` directory does not
 * work today and is not being broken here: nothing in the pipeline resolves a
 * relative image path against the source file's directory.
 */
const RESOLVABLE_IMAGE_SRC = /^\s*(?:data|https?):/i

/**
 * The icon-plus-label control: `<a><img alt="Share"><span>Share</span></a>`.
 * The alt is there to voice the icon for a reader who cannot see it, and the
 * label right beside it already says the same word, so promoting the alt to
 * visible text prints "ShareShare". Only a link or a button counts as "beside
 * it" — that is where the idiom lives, and a wider container would start
 * swallowing alt text that happens to recur in a paragraph.
 */
function altRepeatsNeighboringLabel(img: DomElement, alt: string): boolean {
  const control = img.closest('a,button')
  if (!control) return false
  const label = (control.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return label.includes(alt.toLowerCase())
}

/**
 * Strip the src rather than the tag, and let sanitizeToHub apply its existing
 * rule for a src-less <img>: keep the alt text in a <span>, drop the element
 * when there is none. One place decides what a contentless image becomes.
 */
function dropUnresolvableImages(root: DomElement): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (RESOLVABLE_IMAGE_SRC.test(img.getAttribute('src') ?? '')) continue
    const alt = (img.getAttribute('alt') ?? '').trim()
    if (alt && altRepeatsNeighboringLabel(img, alt)) img.remove()
    else img.removeAttribute('src')
  }
}

/**
 * linkedom parses, it does not do HTML tree construction: markup that a browser
 * would foster into <body> is left as a sibling of an empty one, and a bare
 * fragment comes back mangled. So wrap anything that is not already a whole
 * document — a saved page has a <body>, a clipboard-ish fragment does not.
 */
function bodyOf(raw: string): DomElement | null {
  // Chromium's clipboard HTML on Linux opens with a bare `<meta charset>` even
  // before a whole document, and linkedom makes that meta the root, leaving
  // <body> empty: a PyCharm copy came back as nothing.
  const doc = raw.replace(/^\s*(?:<meta\b[^>]*>\s*)+(?=<(?:!doctype|html|head|body)\b)/i, '')
  const wrapped = /<body[\s>]/i.test(doc) ? doc : `<html><head></head><body>${doc}</body></html>`
  return (parseHTML(wrapped).document.body ?? null) as DomElement | null
}

/* ------------------------------------------------------------------ *
 * Diagrams and formulas as pages write them
 * ------------------------------------------------------------------ */

/**
 * A page that loads MathJax or KaTeX: only there is `\(…\)`, `\[…\]` or
 * `$$…$$` in its text a formula (those libraries' default delimiters).
 * Anywhere else a backslash and a parenthesis are prose: a Windows path, a
 * regular expression.
 */
export const MATH_LIBRARY =
  /<script\b[^>]*\bsrc\s*=\s*["']?[^"'>]*(?:mathjax|katex)[^>]*>|<script\b[^>]*>[^<]{0,4096}?\b(?:MathJax|renderMathInElement)\b/i

const classTokens = (el: DomElement): string[] => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

/** The diagram language a class token names, written bare (`mermaid`) or, on a `<pre>`, prefixed (`language-mermaid`, `lang-dot`). */
function diagramToken(token: string, isPre: boolean): DiagramLanguage | undefined {
  const prefixed = /^(?:language-|lang-)(.+)$/i.exec(token)
  if (prefixed) return isPre ? diagramLanguage(prefixed[1]) : undefined
  return (isPre ? PRE_BARE : DIV_BARE).has(token.toLowerCase()) ? diagramLanguage(token) : undefined
}

/**
 * A `<pre>` may name its diagram on itself or on the one `<code>` it holds;
 * `mermaid` and `graphviz` are enough there (mermaid.js's own `<pre
 * class="mermaid">`). A `<div>` only by mermaid.js's `<div
 * class="mermaid">`, holding text: a `div.graphviz` is Sphinx's drawn
 * picture, `dot` is any page's class for a dot, and a `div.language-mermaid`
 * is a highlighter's frame round its `<pre>` (and its Copy button).
 */
const PRE_BARE = new Set(['mermaid', 'graphviz'])
const DIV_BARE = new Set(['mermaid'])

/** Indentation common to every line, off; blank lines at either end, off. */
function dedent(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '').split('\n')
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length)
  const common = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(common)).join('\n')
}

function hubBlock(doc: Document, cls: string, text: string): DomElement {
  const pre = doc.createElement('pre')
  const code = doc.createElement('code')
  code.setAttribute('class', cls)
  code.textContent = text
  pre.appendChild(code)
  return pre as DomElement
}

/**
 * Diagrams as pages write them, in the hub's form (rendered-blocks.ts). A
 * block mermaid.js already drew holds a picture, not its source, and stays
 * as it is: the picture is read with the page's other pictures.
 */
function tagDiagramBlocks(root: DomElement): void {
  for (const el of Array.from(root.querySelectorAll('pre, div'))) {
    const isPre = el.tagName.toLowerCase() === 'pre'
    if (!root.contains(el) || (!isPre && el.parentElement?.closest('pre'))) continue
    const children = Array.from(el.children).filter((c) => c.tagName.toLowerCase() !== 'br')
    const code = isPre && children.length === 1 && children[0].tagName.toLowerCase() === 'code' ? children[0] : undefined
    const tokens = [...classTokens(el), ...(code ? classTokens(code) : [])]
    const lang = tokens.map((t) => diagramToken(t, isPre)).find(Boolean)
    if (!lang) continue
    if (el.hasAttribute('data-processed') || el.querySelector('svg, img, canvas')) continue
    if (!isPre && el.querySelector('pre, div, p, table, ul, ol, button')) continue
    const holder = code ?? el
    for (const br of Array.from(holder.querySelectorAll('br'))) br.replaceWith(el.ownerDocument.createTextNode('\n'))
    const text = holder.textContent ?? ''
    // A <pre> is the author's text as it is, but for the newline after its tag, which HTML drops.
    const source = isPre ? text.replace(/\r\n?/g, '\n').replace(/^\n/, '') : dedent(text)
    if (source.trim()) el.replaceWith(hubBlock(el.ownerDocument, `language-${lang}`, source))
  }
}

/** Where a formula stands in its parent: alone in a paragraph, or in a line of text. */
function placeFormula(el: DomElement, tex: string, display: boolean): void {
  const doc = el.ownerDocument
  const parent = el.parentElement
  const alone =
    parent !== null &&
    parent.tagName.toLowerCase() === 'p' &&
    Array.from(parent.childNodes).every((n) => n === el || (n.nodeType === 3 && !(n.textContent ?? '').trim()))
  const inLine = parent !== null && /^(?:p|span|a|em|strong|b|i|li|td|th|dd|dt|h[1-6]|blockquote|label|figcaption)$/i.test(parent.tagName)
  if (display && alone) {
    parent.replaceWith(hubBlock(doc, 'language-math', tex))
  } else if (display && !inLine) {
    el.replaceWith(hubBlock(doc, 'language-math', tex))
  } else {
    const code = doc.createElement('code')
    code.setAttribute('class', display ? 'language-math math-display' : 'language-math')
    code.textContent = tex
    el.replaceWith(code)
  }
}

/** A formula's TeX with the delimiters a page wrapped it in off, and whether they made it display math. */
function undelimited(text: string): { tex: string; display?: boolean } {
  const t = text.trim()
  const m = /^\\\(([\s\S]*)\\\)$/.exec(t) ?? /^\$(?!\$)([\s\S]*[^$])\$$/.exec(t)
  if (m) return { tex: m[1].trim(), display: false }
  const d = /^\\\[([\s\S]*)\\\]$/.exec(t) ?? /^\$\$([\s\S]*)\$\$$/.exec(t)
  if (d) return { tex: d[1].trim(), display: true }
  return { tex: t }
}

/**
 * Formulas as pages write them, in the hub's form:
 *
 *   <span class="math inline">\(x\)</span>    pandoc (--mathjax, --katex)
 *   <span class="math display">\[x\]</span>   pandoc, display
 *   <script type="math/tex">x</script>         MathJax 2's own; `; mode=display`
 *                                              too, the drawing MathJax put
 *                                              before it dropped
 *   <span class="katex">…<annotation encoding="application/x-tex">x</annotation>…
 *                                              KaTeX's drawing, which keeps
 *                                              the TeX (`katex-display` around it)
 *
 * A math span holding markup is pandoc's plain rendering (`<em>x</em>`),
 * which is not TeX: it stays as it is. A bare `class="math"` counts only
 * round delimited TeX.
 */
function tagFormulas(root: DomElement): void {
  for (const el of Array.from(root.querySelectorAll('script'))) {
    const type = (el.getAttribute('type') ?? '').toLowerCase()
    if (!/^math\/tex\b/.test(type)) continue
    for (let prev = el.previousElementSibling; prev && classTokens(prev).some((t) => /^MathJax/.test(t)); prev = el.previousElementSibling) prev.remove()
    const tex = (el.textContent ?? '').trim()
    if (tex) placeFormula(el, tex, /mode\s*=\s*display/.test(type))
    else el.remove()
  }
  for (const el of Array.from(root.querySelectorAll('.katex'))) {
    if (!root.contains(el)) continue
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim()
    if (!tex) continue
    const wrapper = el.parentElement && classTokens(el.parentElement).includes('katex-display') ? el.parentElement : undefined
    placeFormula(wrapper ?? el, tex, wrapper !== undefined)
  }
  for (const el of Array.from(root.querySelectorAll('span.math, div.math'))) {
    if (!root.contains(el) || el.closest('pre, code') || el.children.length > 0) continue
    const { tex, display } = undelimited(el.textContent ?? '')
    const tokens = classTokens(el)
    // pandoc's pair, or the author's delimiters: a page's own `class="math"` may be a subject's name.
    const pandoc = tokens.includes('inline') || tokens.includes('display')
    if (!tex || (display === undefined && !pandoc)) continue
    placeFormula(el, tex, display ?? (tokens.includes('display') || el.tagName.toLowerCase() === 'div'))
  }
}

/** Elements whose text MathJax and KaTeX leave alone, and so do we; and their own ignore classes. */
const NOT_MATH_TEXT = /^(?:pre|code|kbd|samp|tt|var|script|style|textarea|noscript|svg|math)$/i
const IGNORE_CLASS = /^(?:tex2jax_ignore|mathjax_ignore|katex|katex-display)$/i

/** `\(…\)`, `\[…\]` and `$$…$$`, not escaped, and never across a blank line. */
const TEXT_DELIMITED = /(?<!\\)(?:\\\(((?:(?!\n[ \t]*\n)[\s\S])+?)\\\)|\\\[((?:(?!\n[ \t]*\n)[\s\S])+?)\\\]|\$\$((?:(?!\n[ \t]*\n)[^$])+?)\$\$)/g

/** Delimited formulas in the page's text, for a page that loads a math library (MATH_LIBRARY). */
function tagDelimitedFormulas(root: DomElement): void {
  const doc = root.ownerDocument
  const visit = (node: DomElement): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) {
        const el = child as DomElement
        if (NOT_MATH_TEXT.test(el.tagName) || classTokens(el).some((t) => IGNORE_CLASS.test(t))) continue
        visit(el)
        continue
      }
      if (child.nodeType !== 3) continue
      const text = child.textContent ?? ''
      if (text.search(TEXT_DELIMITED) < 0) continue
      const parts: Array<Node | { tex: string; display: boolean }> = []
      let last = 0
      for (const m of text.matchAll(TEXT_DELIMITED)) {
        const tex = (m[1] ?? m[2] ?? m[3]).trim()
        if (!tex) continue
        if (m.index > last) parts.push(doc.createTextNode(text.slice(last, m.index)))
        parts.push({ tex, display: m[1] === undefined })
        last = m.index + m[0].length
      }
      if (last < text.length) parts.push(doc.createTextNode(text.slice(last)))
      const placeholders: Array<[DomElement, string, boolean]> = []
      const nodes = parts.map((p) => {
        if ('nodeType' in p) return p
        const marker = doc.createElement('span') as DomElement
        placeholders.push([marker, p.tex, p.display])
        return marker
      })
      for (const n of nodes) node.insertBefore(n, child)
      child.remove()
      for (const [marker, tex, display] of placeholders) placeFormula(marker, tex, display)
    }
  }
  visit(root)
}

/**
 * Diagrams and formulas, read the way the page's own scripts would have
 * read them. `delimiters`: the page loads a math library (MATH_LIBRARY), so
 * delimited text is math too.
 */
function tagDrawnBlocks(root: DomElement, delimiters: boolean): void {
  tagDiagramBlocks(root)
  tagFormulas(root)
  if (delimiters) tagDelimitedFormulas(root)
}

function prepare(raw: string): string {
  try {
    const root = bodyOf(raw)
    if (!root) return raw
    stripHiddenContent(root)
    dropUnresolvableImages(root)
    tagDrawnBlocks(root, MATH_LIBRARY.test(raw))
    tagForeignCodeBlocks(root, { keepMarkup: true })
    return root.innerHTML
  } catch {
    // A page linkedom cannot parse must still convert; the sanitizer below is
    // the safety net either way.
    return raw
  }
}

/**
 * Pasted HTML with its code blocks given the hub's `language-X` wherever the
 * page named a language its own way (see code-language.ts), and its diagrams
 * and formulas in the hub's form. Only that: a paste is not a saved page, and
 * the rest of `prepare` is about saved pages. A copy carries no scripts, so
 * delimited text is never read as math here: a page that loaded MathJax had
 * already drawn it.
 */
export function tagPastedCodeBlocks(raw: string): string {
  if (!/<pre[\s>]|mermaid|\bmath\b|katex/i.test(raw)) return raw
  try {
    const root = bodyOf(raw)
    if (!root) return raw
    tagDrawnBlocks(root, false)
    tagForeignCodeBlocks(root)
    return root.innerHTML
  } catch {
    return raw
  }
}

/**
 * What the page says its own encoding is, from either the HTML5 `<meta charset>`
 * or the legacy `<meta http-equiv="Content-Type">`. The declaration is ASCII in
 * every encoding this matters for, so reading the head as latin1 finds it
 * without having to know the answer first; the spec's 1024-byte window is the
 * same reason browsers do it this way. A byte order mark still outranks it —
 * see `decodeTextBytes` — because the bytes cannot be what the meta claims if a
 * BOM says otherwise.
 */
function declaredCharset(bytes: Buffer): string | undefined {
  const head = bytes.subarray(0, 1024).toString('latin1')
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:().-]+)/i.exec(head)
  return meta?.[1]
}

export async function readHtml(src: SourceInput): Promise<HubDocument> {
  const raw = decodeTextBytes(src.bytes, declaredCharset(src.bytes))
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(raw)
  // An SVG drawn in the page becomes an SVG image (svg-images.ts) before
  // anything else reads the markup: an HTML parser would lower-case its names.
  const clean = sanitizeToHub(prepare(inlineSvgElements(raw)))
  const h1Match = /<h1[^>]*>([^<]*)<\/h1>/i.exec(clean)
  const title = (titleMatch?.[1] || h1Match?.[1] || '').trim() || undefined
  return { html: clean, title }
}
