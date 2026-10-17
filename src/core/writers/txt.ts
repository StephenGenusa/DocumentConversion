import { compile } from 'html-to-text'
import type { HubDocument } from '../types'
import { footnotesForOutput } from '../footnotes'

interface ImgElement {
  attribs?: Record<string, string>
}
interface TextBuilder {
  addInline(text: string): void
  openBlock(options: { leadingLineBreaks?: number; reservedLineLength?: number }): void
  closeBlock(options: { trailingLineBreaks?: number; blockTransform?: (text: string) => string }): void
}
type Walk = (nodes: unknown, builder: TextBuilder) => void

/** A definition's lines indented under its term, as a glossary is set. */
const DEFINITION_INDENT = '    '

const toText = compile({
  wordwrap: false,
  formatters: {
    /**
     * Plain text can't hold an image, and an embedded one's src is a data URI:
     * the default formatter wrote hundreds of kilobytes of base64 into the
     * file (one 180,000-character line for a single email). Keep the alt text.
     */
    imageAlt: (elem: unknown, _walk: unknown, builder: unknown) => {
      const alt = (elem as ImgElement).attribs?.alt?.trim()
      if (alt) (builder as TextBuilder).addInline(`[${alt}]`)
    },
    definition: (elem: unknown, walk: unknown, builder: unknown) => {
      const b = builder as TextBuilder
      b.openBlock({ leadingLineBreaks: 1, reservedLineLength: DEFINITION_INDENT.length })
      ;(walk as Walk)((elem as { children: unknown }).children, b)
      b.closeBlock({
        trailingLineBreaks: 1,
        blockTransform: (text) => text.split('\n').map((l) => (l ? DEFINITION_INDENT + l : l)).join('\n'),
      })
    },
  },
  selectors: [
    // Without this, html-to-text concatenates cells ("FromAlice", "Widget3").
    //
    // maxColumnWidth is NOT redundant with `wordwrap: false` above. This entry
    // merges with html-to-text's built-in `table` selector, which ships
    // maxColumnWidth: 60, and a table cell's InlineTextBuilder resolves its
    // width as `maxColumnWidth || options.wordwrap || MAX_VALUE` - so the
    // per-column 60 wins over the document-wide "do not wrap". That folded any
    // attachment name longer than 60 characters inside its own cell, leaving
    // the size column beside the first fragment and the tail of the name alone
    // on the next line, which reads as two attachments instead of one.
    //
    // 255 rather than unlimited: it is the longest name a Windows/NTFS path
    // component can hold, so no attachment name can ever be split, while a
    // genuine paragraph-in-a-cell (email banners and layout tables are full of
    // them) still wraps instead of padding every other row in its column out to
    // thousands of characters. Measured on four corpus .eml files, 255 and
    // unlimited render byte-identically, so the bound costs nothing real here.
    { selector: 'table', format: 'dataTable', options: { maxColumnWidth: 255 } },
    { selector: 'img', format: 'imageAlt' },
    // A term on its line, its definition indented below, a blank line before the next term.
    { selector: 'dl', format: 'block', options: { leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    { selector: 'dt', format: 'block', options: { leadingLineBreaks: 2, trailingLineBreaks: 1 } },
    { selector: 'dd', format: 'definition' },
    // Its first paragraph starts on the line after the term, not a blank one below.
    { selector: 'dd > p:first-child', format: 'block', options: { leadingLineBreaks: 1, trailingLineBreaks: 2 } },
  ],
})

/**
 * Formulas (spec B1) as their source with the delimiters Markdown uses:
 * `$TEX$` in the line, `$$TEX$$` as a block and where display math stands
 * in a sentence. Diagrams are code blocks already
 * and print as their source.
 */
function mathAsText(html: string): string {
  if (!html.includes('language-math')) return html
  return html
    .replace(/<pre><code class="language-math">([\s\S]*?)<\/code><\/pre>/g, '<pre>$$$$$1$$$$</pre>')
    .replace(/<code class="language-math math-display">([\s\S]*?)<\/code>/g, '$$$$$1$$$$')
    .replace(/<code class="language-math">([\s\S]*?)<\/code>/g, '$$$1$$')
}

/**
 * A code block prints as its text. A link inside one (a page's code linking a
 * name to its docs) would otherwise have its address run into the code beside
 * it, so its tags go and its text stays. (html-to-text's selectors cannot say
 * "an `a` inside a `pre`".)
 */
function codeLinksAsText(html: string): string {
  if (!html.includes('<pre')) return html
  return html.replace(/<pre\b[\s\S]*?<\/pre>/g, (block) => block.replace(/<a\b[^>]*>|<\/a>/g, ''))
}

export async function writeTxt(doc: HubDocument): Promise<Buffer> {
  return Buffer.from(toText(codeLinksAsText(mathAsText(footnotesForOutput(doc.html, 'text')))), 'utf8')
}
