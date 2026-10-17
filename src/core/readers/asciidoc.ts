import { ConversionError } from '../errors'
import { sanitizeToHub } from '../allowlist'
import type { HubDocument, SourceInput } from '../types'
import { escapeHtml } from '../shell'
import { diagramLanguage } from '../rendered-blocks'

/** The parts of an asciidoctor node the hub converter reads. */
interface AdocNode {
  getStyle(): string | undefined
  getSource(): string
  getAttribute(name: string): unknown
  getTitle(): string | undefined | Promise<string | undefined>
  getType(): string
  getText(): string | Promise<string>
}

type Html5Converter = new (...args: never[]) => {
  convert_listing(node: AdocNode): Promise<string>
  convert_literal(node: AdocNode): Promise<string>
  convert_stem(node: AdocNode): Promise<string>
  convert_inline_quoted(node: AdocNode): Promise<string>
}

/**
 * asciidoctor's own HTML, except for diagrams and formulas, which it writes as
 * delimited text for a browser script (`\(x\)`, `\[x\]`) or as a plain
 * listing. These come out in the hub's tagged form instead (spec B1):
 *
 *   [mermaid] / [graphviz] on a listing or literal block, and a source block
 *   whose language is one of those (graphviz normalized to dot)
 *   latexmath:[…] and a [latexmath] block; stem:[…] and [stem] only under
 *   `:stem: latexmath`, since asciidoctor resolves the stem type itself
 *
 * AsciiMath (asciidoctor's default stem) is not read as math: no engine here
 * draws it.
 */
function hubConverter(Base: Html5Converter): Html5Converter {
  const diagram = async (node: AdocNode, lang: string): Promise<string> => {
    const title = await node.getTitle()
    return `${title ? `<p>${title}</p>\n` : ''}<pre><code class="language-${lang}">${escapeHtml(node.getSource())}</code></pre>\n`
  }
  const diagramOf = (node: AdocNode): string | undefined => {
    const style = node.getStyle()
    return diagramLanguage(style === 'source' ? String(node.getAttribute('language') ?? '') : style)
  }
  return class extends Base {
    async convert_listing(node: AdocNode): Promise<string> {
      const lang = diagramOf(node)
      return lang ? diagram(node, lang) : super.convert_listing(node)
    }
    async convert_literal(node: AdocNode): Promise<string> {
      const lang = diagramOf(node)
      return lang ? diagram(node, lang) : super.convert_literal(node)
    }
    async convert_stem(node: AdocNode): Promise<string> {
      return node.getStyle() === 'latexmath' ? diagram(node, 'math') : super.convert_stem(node)
    }
    async convert_inline_quoted(node: AdocNode): Promise<string> {
      // The text has had asciidoctor's special-character substitution, so it
      // is already escaped for HTML.
      return node.getType() === 'latexmath' ? `<code class="language-math">${await node.getText()}</code>` : super.convert_inline_quoted(node)
    }
  }
}

export async function readAsciidoc(src: SourceInput): Promise<HubDocument> {
  const text = src.bytes.toString('utf8').replace(/^﻿/, '')
  let html: string
  try {
    const asciidoctor = await import('asciidoctor')
    const converter = hubConverter(asciidoctor.Html5Converter as unknown as Html5Converter)
    // A converter for this call only: registering one would change asciidoctor for every caller.
    html = String(await asciidoctor.convert(text, { safe: 'safe', standalone: false, converter } as Parameters<typeof asciidoctor.convert>[1]))
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

