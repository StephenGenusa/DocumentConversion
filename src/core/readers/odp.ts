import { escapeHtml } from '../shell'
import { scanElements } from '../ooxml'
import { appendOdfList, loadOdfContent, odfText, type ListRun } from './odf-common'
import { renderOdfTable } from './odt'
import type { HubDocument, SourceInput } from '../types'

/**
 * OpenDocument presentation: one section per slide, first line as its title.
 * Tables are rendered as tables (reusing the odt renderer) and their cell
 * paragraphs are removed from the text scan so they do not also appear as
 * loose lines. A slide's `<text:list>` becomes a real list — flattened into
 * loose paragraphs it reads nothing like the deck.
 */
export async function readOdp(src: SourceInput): Promise<HubDocument> {
  const xml = await loadOdfContent(src.bytes, 'presentation')
  const sections: string[] = []
  for (const page of xml.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)) {
    const pageXml = page[1]
    const tables: string[] = []
    // Pull tables out first; whatever remains is the slide's running text.
    const withoutTables = pageXml.replace(/<table:table\b[^>]*>[\s\S]*?<\/table:table>/g, (tableXml) => {
      const rendered = renderOdfTable(tableXml)
      if (rendered) tables.push(rendered)
      return ''
    })
    const parts: string[] = []
    let title: string | undefined
    let lastList: ListRun = null
    for (const block of scanElements(withoutTables, ['text:h', 'text:p', 'text:list'])) {
      if (block.name === 'text:list') {
        lastList = appendOdfList(parts, block.xml, block.inner, lastList)
        continue
      }
      lastList = null
      const text = odfText(block.inner)
      if (text === '') continue
      // The slide's first line of text is its title, as before.
      if (title === undefined && parts.length === 0) {
        title = text
        continue
      }
      parts.push(`<p>${escapeHtml(text)}</p>`)
    }
    if (parts.length === 0 && title === undefined && tables.length === 0) continue
    if (title !== undefined) parts.unshift(`<h2>${escapeHtml(title)}</h2>`)
    parts.push(...tables)
    sections.push(parts.join('\n'))
  }
  return { html: sections.join('\n'), title: src.filename?.split(/[\\/]/).pop() }
}
