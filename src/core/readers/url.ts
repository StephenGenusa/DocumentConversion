import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { guardedFetch, type GuardedFetchDeps } from '../net/guarded-fetch'
import { inlineImages, DEFAULT_INLINE_BUDGET } from '../inline-images'
import { sanitizeToHub } from '../allowlist'
import { MAX_SPAN } from '../table-grid'
import type { ReadContext } from '../types'

export interface UrlHtmlResult {
  kind: 'html'
  /** Sanitized hub HTML — safe to hand to the editor pane. */
  html: string
  title?: string
  sourceName: string
}

export interface UrlFileResult {
  kind: 'file'
  bytes: Buffer
  contentType: string
  filename: string
}

export type UrlLoadResult = UrlHtmlResult | UrlFileResult

// linkedom's document, named once so the table-rescue helpers below can take it
// without every call site repeating the cast Readability needs. Its elements type
// as plain DOM Elements; do NOT derive the element type from createElement, whose
// Electron overload resolves 'div' through <webview>.
type DomDocument = ReturnType<typeof parseHTML>['document']
type DomElement = Element

/** Blocks whose text is stable enough to anchor a rescued table against. */
const ANCHOR_TAGS = 'p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,dt,dd'
/** A table living in page furniture is furniture, whatever its shape. */
const FURNITURE = 'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"]'
/** Containers a <table> may not legally be inserted into as a sibling. */
const NOT_A_SIBLING_SLOT = new Set(['UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR'])
/** Enough of a table's text to identify it without being defeated by re-wrapping. */
const SIGNATURE_CHARS = 200

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/**
 * True only for a table with real tabular shape. This is the load-bearing guard:
 * pre-CSS pages frame the whole document in <table>, and re-attaching one of those
 * would drag the nav strip, the sidebar and a duplicate of the article back in.
 * A layout table is single-row, single-cell, ragged, or a wrapper around another
 * table; a data table has at least two rows, at least two columns, and the same
 * column count row after row.
 */
function isTabularShape(table: DomElement): boolean {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length < 2) return false
  const counts = rows.map((row) =>
    Array.from(row.querySelectorAll('td,th')).reduce((n, cell) => {
      const span = parseInt(cell.getAttribute('colspan') ?? '1', 10)
      return n + Math.min(Math.max(Number.isFinite(span) ? span : 1, 1), MAX_SPAN)
    }, 0),
  )
  // Modal column count, not the max: a spec table often ends with a full-width
  // "reserved" row, and one spanning row must not disqualify the whole table.
  const tally = new Map<number, number>()
  for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1)
  let modal = 0
  let modalHits = 0
  for (const [count, hits] of tally) {
    if (hits > modalHits || (hits === modalHits && count > modal)) {
      modal = count
      modalHits = hits
    }
  }
  if (modal < 2) return false
  return modalHits / counts.length >= 0.8
}

/**
 * A table worth putting back if Readability dropped it. Everything here is a
 * reason to leave a table out, because a false positive shows up as junk in the
 * user's document and a false negative only leaves the status quo.
 */
function isRescuableTable(table: DomElement): boolean {
  // Nested tables cut both ways: one inside another is layout scaffolding, and one
  // that *contains* another is the scaffold itself. Neither is a reference table.
  if (table.parentElement?.closest('table')) return false
  if (table.querySelector('table')) return false
  const role = norm(table.getAttribute('role')).toLowerCase()
  if (role === 'presentation' || role === 'none') return false
  // The explicit "this is not data" opt-outs authors and Readability both honour.
  if (table.getAttribute('datatable') === '0') return false
  if (table.parentElement?.closest(FURNITURE)) return false
  if (!isTabularShape(table)) return false
  const text = norm(table.textContent)
  if (text.length < 24) return false
  const filled = Array.from(table.querySelectorAll('td,th')).filter((c) => norm(c.textContent).length > 0)
  if (filled.length < 4) return false
  // A grid that is mostly link text is a navigation or index table, not a spec.
  const linkChars = Array.from(table.querySelectorAll('a')).reduce((n, a) => n + norm(a.textContent).length, 0)
  return linkChars / text.length <= 0.5
}

/**
 * Where the table sat in the source: the nearest preceding block of real prose.
 * Matching on text rather than on nodes is what survives Readability rewriting
 * the article's element structure out from under us.
 */
function anchorTextFor(table: DomElement, order: DomElement[], at: Map<DomElement, number>): string | undefined {
  const index = at.get(table)
  if (index === undefined) return undefined
  for (let i = index - 1; i >= 0; i--) {
    const el = order[i]
    if (!el.matches(ANCHOR_TAGS)) continue
    if (el.closest('table')) continue // text inside another table won't be in the article either
    const text = norm(el.textContent)
    if (text.length >= 40) return text
  }
  return undefined
}

/** The article node holding that same prose, and a slot a <table> may sit in. */
function insertionPoint(articleRoot: DomElement, anchor: string): DomElement | undefined {
  const blocks = Array.from(articleRoot.querySelectorAll(ANCHOR_TAGS))
  const head = anchor.slice(0, 60)
  const match =
    blocks.find((b) => norm(b.textContent) === anchor) ?? blocks.find((b) => norm(b.textContent).startsWith(head))
  if (!match) return undefined
  let node = match
  while (node.parentElement && node.parentElement !== articleRoot && NOT_A_SIBLING_SLOT.has(node.parentElement.tagName))
    node = node.parentElement
  return node
}

/**
 * Readability scores by text density, so a page whose payload is a reference
 * table — short cells, no prose — loses the table and keeps the surrounding
 * chatter. The raw-body fallback never fires for that case, because the article
 * it returned looks perfectly plausible. So diff the two: any table with real
 * tabular shape that the source has and the article does not gets put back where
 * it stood. We re-attach rather than fall back to the whole raw body, because the
 * fallback would also restore the nav, sidebar, ads and footer that Readability
 * correctly removed — trading one kind of damage for a larger one.
 *
 * Returns the article HTML unchanged, character for character, when nothing was
 * lost; only a page that actually needs the rescue is re-serialized.
 */
function rescueDroppedTables(articleHtml: string, sourceDoc: DomDocument): string {
  const tables = Array.from(sourceDoc.querySelectorAll('table')).filter(isRescuableTable)
  if (tables.length === 0) return articleHtml

  const { document: articleDoc } = parseHTML(`<html><body>${articleHtml}</body></html>`)
  const articleRoot = articleDoc.querySelector('body') as DomElement
  const articleText = norm(articleRoot.textContent)
  // Identify by a slice of text: Readability keeps cell text verbatim even when it
  // rewrites the markup around it. Two identical tables on one page collapse to one
  // signature, which errs toward leaving the second out rather than duplicating it.
  const missing = tables.filter((t) => !articleText.includes(norm(t.textContent).slice(0, SIGNATURE_CHARS)))
  if (missing.length === 0) return articleHtml

  // Source document order, indexed once: the anchor walk below runs per table.
  const order = Array.from(sourceDoc.querySelectorAll('*'))
  const at = new Map<DomElement, number>(order.map((el, i) => [el, i]))

  for (const table of missing) {
    const holder = articleDoc.createElement('div')
    // The rescued markup is attacker-controlled page content and is NOT trusted
    // here; like every other branch of extractArticle it is sanitized by loadUrl.
    holder.innerHTML = table.outerHTML
    const node = holder.firstElementChild
    if (!node) continue
    const anchor = anchorTextFor(table, order, at)
    const target = anchor ? insertionPoint(articleRoot, anchor) : undefined
    // No anchor text survived in the article: append, so the data is present even
    // when we cannot prove where it belongs.
    if (target) target.after(node)
    else articleRoot.append(node)
  }
  return articleRoot.innerHTML
}

/**
 * Point every link at something that will still work once the page is a file.
 *
 * Readability keeps an href exactly as the page wrote it, so `/spec/part2` and
 * `../rel/x` reached the hub still relative and then resolved against wherever
 * the OUTPUT happened to sit — the converter's own temporary directory. Unlike
 * the epub case, where no base exists and the dead link has to go, here the
 * page's own URL is known and the link can simply be repaired.
 *
 * A fragment is left alone: it addresses this document, which is the one thing
 * that survives the conversion. An unusable base means the link cannot be made
 * to work, so it is unwrapped to its text rather than left pointing somewhere
 * arbitrary.
 */
function absolutizeLinks(html: string, base: string): string {
  if (!html.includes('<a')) return html
  return html.replace(/<a\b[^>]*>/gi, (tag) => {
    const href = /\bhref="([^"]*)"/i.exec(tag)?.[1]
    if (href === undefined || href.startsWith('#')) return tag
    try {
      return tag.replace(/\bhref="[^"]*"/i, `href="${new URL(href, base).href}"`)
    } catch {
      // Neither the href nor the base resolves: drop the attribute, and let
      // sanitizeToHub's own rules deal with an <a> that no longer has one.
      return tag.replace(/\s*\bhref="[^"]*"/i, '')
    }
  })
}

/** An <a> with nothing to point at carries only its text. */
function unwrapDeadLinks(html: string): string {
  return html.replace(/<a\b(?![^>]*\bhref=)[^>]*>([\s\S]*?)<\/a>/gi, '$1')
}

/** Readability article extraction with a raw-body fallback. */
export function extractArticle(pageHtml: string, url: string): { html: string; title?: string } {
  const { document } = parseHTML(pageHtml)
  const title = document.querySelector('title')?.textContent?.trim() || undefined
  // Links are repaired last, so both the article and the raw-body fallback get
  // it, and so a rescued table's own links are covered too.
  const withLinks = (html: string): string => unwrapDeadLinks(absolutizeLinks(html, url))
  try {
    // Readability mutates its document — parse a fresh copy for it.
    const { document: copy } = parseHTML(pageHtml)
    const article = new Readability(copy as unknown as Document, { charThreshold: 250 }).parse()
    if (article?.content && article.content.replace(/<[^>]+>/g, '').trim().length > 0) {
      return {
        html: withLinks(rescueDroppedTables(article.content, document)),
        title: article.title?.trim() || title,
      }
    }
  } catch {
    // fall through to the raw body
  }
  const body = document.querySelector('body')
  return { html: withLinks(body ? body.innerHTML : pageHtml), title }
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    return last || u.hostname
  } catch {
    return 'download'
  }
}

/**
 * Acquisition method, not a format: fetches a URL through the guarded
 * fetcher; HTML pages are article-extracted, image-inlined (same guarded
 * fetcher — image URLs are attacker-controlled page content) and sanitized;
 * anything else comes back as file bytes for normal detection.
 */
export async function loadUrl(url: string, deps: GuardedFetchDeps, ctx?: ReadContext): Promise<UrlLoadResult> {
  ctx?.onProgress?.('Fetching page')
  const page = await guardedFetch(url, deps, { signal: ctx?.signal })
  const type = page.contentType.split(';')[0].trim().toLowerCase()
  if (type !== 'text/html' && type !== 'application/xhtml+xml') {
    return { kind: 'file', bytes: page.bytes, contentType: type, filename: filenameFromUrl(page.finalUrl) }
  }
  ctx?.onProgress?.('Extracting article')
  const { html, title } = extractArticle(page.bytes.toString('utf8'), page.finalUrl)
  const inlined = await inlineImages(
    html,
    page.finalUrl,
    async (imgUrl) => {
      const res = await guardedFetch(imgUrl, deps, {
        signal: ctx?.signal,
        maxBytes: DEFAULT_INLINE_BUDGET.maxPerImage,
      })
      return { bytes: res.bytes, contentType: res.contentType }
    },
    DEFAULT_INLINE_BUDGET,
    ctx?.onProgress,
  )
  return { kind: 'html', html: sanitizeToHub(inlined), title, sourceName: url }
}
