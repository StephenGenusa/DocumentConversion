import { parseHTML } from 'linkedom'
import type { HubDocument, SourceInput } from '../types'
import { sanitizeToHub } from '../allowlist'
import { decodeTextBytes } from './txt'

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
function altRepeatsNeighbouringLabel(img: DomElement, alt: string): boolean {
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
    if (alt && altRepeatsNeighbouringLabel(img, alt)) img.remove()
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
  const wrapped = /<body[\s>]/i.test(raw) ? raw : `<html><head></head><body>${raw}</body></html>`
  return (parseHTML(wrapped).document.body ?? null) as DomElement | null
}

function prepare(raw: string): string {
  try {
    const root = bodyOf(raw)
    if (!root) return raw
    stripHiddenContent(root)
    dropUnresolvableImages(root)
    return root.innerHTML
  } catch {
    // A page linkedom cannot parse must still convert; the sanitizer below is
    // the safety net either way.
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
  const clean = sanitizeToHub(prepare(raw))
  const h1Match = /<h1[^>]*>([^<]*)<\/h1>/i.exec(clean)
  const title = (titleMatch?.[1] || h1Match?.[1] || '').trim() || undefined
  return { html: clean, title }
}
