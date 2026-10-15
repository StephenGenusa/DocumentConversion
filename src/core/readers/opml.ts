import { Parser } from 'htmlparser2'
import { escapeHtml } from '../shell'
import { codeListing } from './code'
import { decodeTextBytes } from './txt'
import type { HubDocument, ReadContext, SourceInput } from '../types'

/**
 * OPML outlines (spec D9): feed lists, and outliner exports.
 *
 * `head > title` is the title; each `outline` is a list item, its children a
 * nested list. An outline's text is `text`, else `title`, and is shown as
 * text even when it holds markup, as most readers do. The item links to
 * `htmlUrl`, else `url`, else the feed (`xmlUrl`), and only to a web or mail
 * address. Outliners keep a note in `_note`, shown under the item.
 *
 * Read with the streaming parser, not a DOM, so a deep outline cannot
 * overflow the stack: nesting is a counter here, never recursion.
 */

const LINKABLE = /^(https?:|mailto:)/i

export async function readOpml(src: SourceInput, ctx?: ReadContext): Promise<HubDocument> {
  const name = (src.filename ?? 'outline.opml').split(/[\\/]/).pop() ?? 'outline.opml'
  const text = decodeTextBytes(src.bytes)
  const out: string[] = []
  // Per open outline: whether its child list has been opened yet.
  const open: boolean[] = []
  let sawOpml = false
  let inHead = false
  let inTitle = false
  let title = ''
  let items = 0

  const parser = new Parser(
    {
      onopentag(tag, attrs) {
        const t = tag.toLowerCase()
        if (t === 'opml') sawOpml = true
        else if (t === 'head') inHead = true
        else if (t === 'title' && inHead) inTitle = true
        else if (t === 'outline' && sawOpml) {
          if (open.length === 0) {
            if (items === 0) out.push('<ul>')
          } else if (!open[open.length - 1]) {
            out.push('<ul>')
            open[open.length - 1] = true
          }
          items++
          const label = escapeHtml(attrs.text ?? attrs.title ?? '')
          const href = [attrs.htmlUrl, attrs.url, attrs.xmlUrl].find((u) => u !== undefined && LINKABLE.test(u.trim()))
          const item = href ? `<a href="${escapeHtml(href.trim())}">${label}</a>` : label
          const note = attrs._note ? `<br><em>${escapeHtml(attrs._note).replace(/\r?\n/g, '<br>')}</em>` : ''
          out.push(`<li>${item}${note}`)
          open.push(false)
        }
      },
      ontext(data) {
        if (inTitle) title += data
      },
      onclosetag(tag) {
        const t = tag.toLowerCase()
        if (t === 'head') inHead = false
        else if (t === 'title') inTitle = false
        else if (t === 'outline' && open.length > 0) {
          if (open.pop()) out.push('</ul>')
          out.push('</li>')
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  )
  parser.write(text)
  parser.end()

  if (!sawOpml) return codeListing(name, text, 'xml', ctx)
  if (items > 0) out.push('</ul>')
  const heading = title.trim() || name
  return { html: `<h1>${escapeHtml(heading)}</h1>\n${out.join('')}`, title: heading }
}
