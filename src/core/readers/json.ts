import { escapeHtml } from '../shell'
import { readRecords, reindentJson } from '../json-tokens'
import { PRINT_RECORD_LIMIT, limitMessage, recordsTableHtml, tooLargeError, type RowSource } from '../records'
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
  return src.bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

/** `read`, with a file too large for memory (see records.ts) said in words. */
async function sized<T>(src: SourceInput, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (err) {
    throw tooLargeError(baseName(src.filename), err) ?? err
  }
}

export function readJson(src: SourceInput, ctx?: ReadContext): Promise<HubDocument> {
  return sized(src, () => readJsonWhole(src, ctx))
}

async function readJsonWhole(src: SourceInput, ctx?: ReadContext): Promise<HubDocument> {
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
  // Only the lines shown are kept; the rest are counted.
  const shown: { line: string; n: number }[] = []
  let count = 0
  for (let at = 0, n = 1; at <= text.length; n++) {
    const end = text.indexOf('\n', at)
    const stop = end === -1 ? text.length : end
    if (text.slice(at, stop).trim() !== '' && ++count <= PRINT_RECORD_LIMIT) shown.push({ line: text.slice(at, stop), n })
    if (end === -1) break
    at = end + 1
  }
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
  const limited = count > shown.length
  if (limited) ctx?.onAdvice?.('records-limited', limitMessage(shown.length, count))
  const note = limited ? `\n<p><em>${limitMessage(shown.length, count)}</em></p>` : ''
  return { html: `<h1>${escapeHtml(name)}</h1>\n${blocks.join('\n')}${note}`, title: name, ...(limited ? { limited: true } : {}) }
}

/** Every record, for csv/json/xlsx export; null when the file is not records (or the user chose text). */
export function readJsonRows(src: SourceInput, ctx?: ReadContext): Promise<RowSource[] | null> {
  return sized(src, async () => {
    if (ctx?.jsonAs === 'text') return null
    const recs = readRecords(textOf(src), { lines: isLines(src.filename) })
    if (!recs) return null
    return [{ name: baseName(src.filename).replace(/\.[^.]+$/, ''), header: recs.header, rows: recs.rows }]
  })
}

/** Whether a file would read as a table, for showing the Table / Formatted JSON choice. */
export function jsonIsTable(bytes: Buffer, filename?: string): boolean {
  // A file too large to read whole offers no choice; converting it says why.
  try {
    return readRecords(bytes.toString('utf8').replace(/^﻿/, ''), { lines: isLines(filename) }) !== null
  } catch {
    return false
  }
}
