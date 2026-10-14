import { ConversionError } from '../errors'
import { sanitizeToHub } from '../allowlist'
import type { HubDocument, SourceInput } from '../types'

export async function readAsciidoc(src: SourceInput): Promise<HubDocument> {
  const text = src.bytes.toString('utf8').replace(/^﻿/, '')
  let html: string
  try {
    const asciidoctor = await import('asciidoctor')
    html = String(await asciidoctor.convert(text, { safe: 'safe', standalone: false }))
  } catch (err) {
    throw new ConversionError('read-failed', `Could not convert AsciiDoc: ${(err as Error).message}`)
  }
  // The document title (= Title) is a header attribute, not part of the body.
  const title = /^=\s+(.+)$/m.exec(text)?.[1]?.trim()
  return { html: sanitizeToHub(asciidocNotesToHub(html)), title: title || src.filename?.split(/[\\/]/).pop() }
}

/**
 * asciidoctor's footnotes in the hub's model (src/core/footnotes.ts).
 *
 * It writes each reference as `<sup class="footnote">[<a href="#_footnotedef_N">N</a>]</sup>`
 * (`footnoteref` for a reuse of a named one) and every note in one trailing
 * `<div id="footnotes">`, each opening with a back-link and "N. ". The hub
 * keeps neither internal links nor that div, so the notes came out as loose
 * text after a rule. Note N gets label `N`; asciidoctor's markup is fixed, so
 * matching it is exact.
 */
export function asciidocNotesToHub(html: string): string {
  const at = html.indexOf('<div id="footnotes">')
  if (at < 0) return html
  const refs = html
    .slice(0, at)
    .replace(/<sup class="footnote(?:ref)?"[^>]*>\[<a\b[^>]*href="#_footnotedef_(\d+)"[^>]*>\d+<\/a>\]<\/sup>/g, '<sup data-fn="$1">$1</sup>')
  const notes = [...html.slice(at).matchAll(/<div class="footnote" id="_footnotedef_(\d+)">\s*<a href="#_footnoteref_\d+">\d+<\/a>\.\s*([\s\S]*?)\s*<\/div>/g)]
  if (notes.length === 0) return refs
  return refs + '<ol>' + notes.map(([, n, body]) => `<li data-fn="${n}"><p>${body}</p></li>`).join('') + '</ol>'
}

