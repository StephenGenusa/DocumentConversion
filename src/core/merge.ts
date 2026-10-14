import { ConversionError } from './errors'
import { escapeHtml } from './shell'
import { prefixCollidingLabels } from './footnotes'
import type { HubDocument } from './types'

const PAGE_BREAK = '<div style="page-break-after: always"></div>'

/**
 * Concatenate hub documents in list order: optional per-source heading, page
 * break between fragments (printToPDF honors it; html-to-docx maps it to a
 * page break). Pure — the UI/CLI decide order and headings.
 */
export function mergeHubDocuments(docs: HubDocument[], opts: { headings: boolean }): HubDocument {
  if (docs.length === 0) throw new ConversionError('merge-empty', 'Nothing to merge')
  // Two sources may both have a `[^1]`; each keeps its own note.
  const labels = new Set<string>()
  const fragments = docs.map((d, i) => {
    const heading = opts.headings ? `<h1 class="doc-title">${escapeHtml(d.sourceName ?? 'Untitled')}</h1>\n` : ''
    return heading + prefixCollidingLabels(d.html, labels, `s${i + 1}.`)
  })
  return {
    html: fragments.join(`\n${PAGE_BREAK}\n`),
    title: docs[0].title ?? docs[0].sourceName,
    sourceName: docs[0].sourceName,
  }
}
