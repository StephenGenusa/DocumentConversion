import { escapeHtml } from '../shell'
import { scanElements } from '../ooxml'
import { appendOdfList, loadOdfContent, odfText, type ListRun } from './odf-common'
import type { HubDocument, SourceInput } from '../types'

/**
 * One ODF table row as its cells, honouring repeated/covered cells.
 *
 * Each cell is returned as ready HTML (escaped text, plus any nested table as
 * real <table> markup) rather than plain text, because a cell may hold a
 * table. Structural walks here are `scanElements`, never lazy regexes: a lazy
 * match closes on the FIRST matching close tag, which is the wrong one the
 * moment anything nests — a footnote's <text:p> inside a cell's <text:p>, or a
 * nested table's cell inside the outer cell. The first lost the rest of a
 * cell; the second lost the rest of the ROW and fused the outer cell's text
 * with the inner table's first cell.
 */
export function odfRowCells(rowXml: string): string[] {
  const cells: string[] = []
  for (const cell of scanElements(rowXml, ['table:table-cell', 'table:covered-table-cell'])) {
    const attrs = /^<[^\s>]+([^>]*)>/.exec(cell.xml)?.[1] ?? ''
    const pieces: string[] = []
    for (const block of scanElements(cell.inner, ['text:p', 'text:h', 'text:list', 'table:table'])) {
      if (block.name === 'table:table') {
        const nested = renderOdfTable(block.inner)
        if (nested) pieces.push(nested)
        continue
      }
      // A list inside a cell: its items' text, in order.
      const text = odfText(block.inner)
      if (text) pieces.push(escapeHtml(text))
    }
    const html = pieces.join(' ')
    const repeat = Math.min(1000, Math.max(1, Number(/number-columns-repeated="(\d+)"/.exec(attrs)?.[1] ?? 1)))
    for (let i = 0; i < repeat; i++) cells.push(html)
  }
  // Trailing repeated blanks pad ODF rows out to the sheet width; drop them.
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  return cells
}

export function renderOdfTable(tableXml: string): string | null {
  const headerRows: string[][] = []
  const bodyRows: string[][] = []
  for (const block of scanElements(tableXml, ['table:table-header-rows', 'table:table-row'])) {
    if (block.name === 'table:table-header-rows') {
      for (const row of scanElements(block.inner, ['table:table-row'])) headerRows.push(odfRowCells(row.inner))
    } else {
      bodyRows.push(odfRowCells(block.inner))
    }
  }
  const all = [...headerRows, ...bodyRows]
  if (all.every((row) => row.every((cell) => cell === ''))) return null

  const cellsHtml = (row: string[], tag: string): string => row.map((c) => `<${tag}>${c}</${tag}>`).join('')
  const thead =
    headerRows.length > 0 ? `<thead>${headerRows.map((r) => `<tr>${cellsHtml(r, 'th')}</tr>`).join('')}</thead>` : ''
  const tbody = `<tbody>${bodyRows.map((r) => `<tr>${cellsHtml(r, 'td')}</tr>`).join('')}</tbody>`
  return `<table>${thead}${tbody}</table>`
}

/**
 * OpenDocument text. Content-focused like the rest of the app: headings,
 * paragraphs, lists and tables survive; styling and page layout do not.
 */
export async function readOdt(src: SourceInput): Promise<HubDocument> {
  const xml = await loadOdfContent(src.bytes, 'text document')
  const body = /<office:text\b[^>]*>([\s\S]*)<\/office:text>/.exec(xml)?.[1] ?? xml
  const parts: string[] = []
  let title: string | undefined

  // Walk headings, paragraphs, lists and tables in document order. Tables and
  // lists are matched here so their inner paragraphs are consumed with them —
  // otherwise the same scan sweeps them up as loose top-level paragraphs. The
  // scan must honour nesting: a lazy regex closes an outer <text:list> on its
  // first nested </text:list>.
  let lastList: ListRun = null
  for (const block of scanElements(body, ['text:h', 'text:p', 'text:list', 'table:table'])) {
    if (block.name === 'table:table') {
      lastList = null
      const table = renderOdfTable(block.inner)
      if (table) parts.push(table)
      continue
    }
    if (block.name === 'text:list') {
      lastList = appendOdfList(parts, block.xml, block.inner, lastList)
      continue
    }
    lastList = null
    const text = odfText(block.inner)
    if (text === '') continue
    if (block.name === 'text:h') {
      const level = Math.min(6, Math.max(1, Number(/<text:h\b[^>]*\boutline-level="(\d+)"/.exec(block.xml)?.[1] ?? 1)))
      title ??= text
      parts.push(`<h${level}>${escapeHtml(text)}</h${level}>`)
    } else {
      parts.push(`<p>${escapeHtml(text)}</p>`)
    }
  }

  return { html: parts.join('\n'), title: title ?? src.filename?.split(/[\\/]/).pop() }
}
