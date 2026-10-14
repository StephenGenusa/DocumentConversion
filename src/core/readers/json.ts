import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import { readRecords, reindentJson } from '../json-tokens'
import { MAX_RECORD_SOURCE_BYTES, PRINT_RECORD_LIMIT, limitMessage, recordsTableHtml, type RowSource } from '../records'
import { codeListing } from './code'
import type { HubDocument, ReadContext, SourceInput } from '../types'

/**
 * JSON and JSON Lines (spec D6, D7).
 *
 * An array of flat records reads as a TABLE: the shape the json writer
 * produces, and what csv and xlsx export want. Anything else, or any file when
 * the user chose "Formatted JSON", is a code listing, re-indented if it was
 * minified. A record table is printed up to PRINT_RECORD_LIMIT rows; exported
 * (readJsonRows), it is every row.
 */

const isLines = (filename?: string): boolean => /\.(jsonl|ndjson)$/i.test(filename ?? '')
const baseName = (filename?: string): string => (filename ?? 'data.json').split(/[\\/]/).pop() ?? 'data.json'

function textOf(src: SourceInput): string {
  if (src.bytes.length > MAX_RECORD_SOURCE_BYTES) {
    const mb = (src.bytes.length / 1024 / 1024).toFixed(0)
    throw new ConversionError('read-failed', `${baseName(src.filename)} is ${mb} MB, over the 200 MB limit for record files.`)
  }
  return src.bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

export async function readJson(src: SourceInput, ctx?: ReadContext): Promise<HubDocument> {
  const name = baseName(src.filename)
  const text = textOf(src)
  const lines = isLines(src.filename)
  if (ctx?.jsonAs !== 'text') {
    const recs = readRecords(text, { lines })
    if (recs) {
      const shown = recs.rows.slice(0, PRINT_RECORD_LIMIT)
      const limited = recs.rows.length > shown.length
      if (limited) {
        ctx?.onAdvice?.('records-limited', `${limitMessage(shown.length, recs.rows.length)} Export to CSV, JSON or Excel for every record.`)
      }
      return {
        html: `<h1>${escapeHtml(name)}</h1>\n${recordsTableHtml(recs.header, shown, recs.rows.length)}`,
        title: name,
        ...(limited ? { limited: true } : {}),
      }
    }
  }
  if (!lines) return codeListing(name, text, 'json', ctx)
  return jsonLinesListing(name, text, ctx)
}

/** One block per record, re-indented; a line that is not JSON is kept as written. */
function jsonLinesListing(name: string, text: string, ctx?: ReadContext): HubDocument {
  const records = text.split('\n').map((l, i) => ({ line: l, n: i + 1 })).filter((r) => r.line.trim() !== '')
  const shown = records.slice(0, PRINT_RECORD_LIMIT)
  const bad: number[] = []
  const blocks = shown.map(({ line, n }) => {
    const pretty = reindentJson(line)
    if (pretty === null) bad.push(n)
    return `<pre><code class="language-json">${escapeHtml(pretty ?? line)}</code></pre>`
  })
  if (bad.length > 0) {
    const where = bad.length === 1 ? `line ${bad[0]}` : `lines ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}`
    ctx?.onAdvice?.('record-error', `${where[0].toUpperCase()}${where.slice(1)} ${bad.length === 1 ? 'is' : 'are'} not JSON and ${bad.length === 1 ? 'is' : 'are'} shown as written.`)
  }
  const limited = records.length > shown.length
  if (limited) ctx?.onAdvice?.('records-limited', limitMessage(shown.length, records.length))
  const note = limited ? `\n<p><em>${limitMessage(shown.length, records.length)}</em></p>` : ''
  return { html: `<h1>${escapeHtml(name)}</h1>\n${blocks.join('\n')}${note}`, title: name, ...(limited ? { limited: true } : {}) }
}

/** Every record, for csv/json/xlsx export; null when the file is not records (or the user chose text). */
export async function readJsonRows(src: SourceInput, ctx?: ReadContext): Promise<RowSource[] | null> {
  if (ctx?.jsonAs === 'text') return null
  const recs = readRecords(textOf(src), { lines: isLines(src.filename) })
  if (!recs) return null
  return [{ name: baseName(src.filename).replace(/\.[^.]+$/, ''), header: recs.header, rows: recs.rows }]
}

/** Whether a file would read as a table, for showing the Table / Formatted JSON choice. */
export function jsonIsTable(bytes: Buffer, filename?: string): boolean {
  if (bytes.length > MAX_RECORD_SOURCE_BYTES) return false
  return readRecords(bytes.toString('utf8').replace(/^﻿/, ''), { lines: isLines(filename) }) !== null
}
