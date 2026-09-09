import { compile } from 'html-to-text'
import type { HubDocument } from '../types'

interface ImgElement {
  attribs?: Record<string, string>
}
interface TextBuilder {
  addInline(text: string): void
}

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
  ],
})

export async function writeTxt(doc: HubDocument): Promise<Buffer> {
  return Buffer.from(toText(doc.html), 'utf8')
}
