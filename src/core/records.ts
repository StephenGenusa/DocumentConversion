import { escapeHtml } from './shell'

/**
 * Record sources (spec D, "Record limits"): files that are rows of records
 * rather than a document. JSON arrays and JSON Lines today; SQLite and vCard
 * follow the same rule.
 *
 *   printing (pdf, docx, html, epub, Kindle, slides, md, txt) and the editor
 *       at most PRINT_RECORD_LIMIT records per table, and the document says so
 *   exporting (csv, json, xlsx)
 *       every record, written straight from the source as RowSources, never
 *       as hub HTML: a million rows of <tr> would cost hundreds of megabytes
 *       only for the table writers to turn them back into rows
 */
export const PRINT_RECORD_LIMIT = 5000

/** Bigger than this and a record source is refused: its bytes are held in memory. */
export const MAX_RECORD_SOURCE_BYTES = 200 * 1024 * 1024

export interface RowSource {
  /** The table's name: a file name, a database table. */
  name: string
  header: string[]
  rows: AsyncIterable<string[]> | Iterable<string[]>
}

const fmt = (n: number): string => n.toLocaleString('en-US')

/** "Showing the first 5,000 of 48,213 records." */
export function limitMessage(shown: number, total: number, noun = 'records'): string {
  return `Showing the first ${fmt(shown)} of ${fmt(total)} ${noun}.`
}

/**
 * One table of records for printing, with a line under it when it was cut
 * short, so the printed page itself says it is not the whole table.
 */
export function recordsTableHtml(header: string[], rows: string[][], total: number, noun = 'records'): string {
  const head = `<thead><tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`
  const body = rows.map((r) => `<tr>${header.map((_h, i) => `<td>${escapeHtml(r[i] ?? '')}</td>`).join('')}</tr>`).join('')
  const table = `<table>${head}<tbody>${body}</tbody></table>`
  return total > rows.length ? `${table}\n<p><em>${limitMessage(rows.length, total, noun)}</em></p>` : table
}
