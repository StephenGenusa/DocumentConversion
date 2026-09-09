import { ConversionError } from './errors'
import { escapeHtml } from './shell'
import type { HubDocument } from './types'

const PAGE_BREAK = '<div style="page-break-after: always"></div>'

/**
 * Concatenate hub documents in list order: optional per-source heading, page
 * break between fragments (printToPDF honors it; html-to-docx maps it to a
 * page break). Pure — the UI/CLI decide order and headings.
 */
export function mergeHubDocuments(docs: HubDocument[], opts: { headings: boolean }): HubDocument {
  if (docs.length === 0) throw new ConversionError('merge-empty', 'Nothing to merge')
  const fragments = docs.map((d) => {
    const heading = opts.headings ? `<h1 class="doc-title">${escapeHtml(d.sourceName ?? 'Untitled')}</h1>\n` : ''
    return heading + d.html
  })
  return {
    html: fragments.join(`\n${PAGE_BREAK}\n`),
    title: docs[0].title ?? docs[0].sourceName,
    sourceName: docs[0].sourceName,
  }
}
