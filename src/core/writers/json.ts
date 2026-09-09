import { ConversionError } from '../errors'
import { looksLikeHeader } from '../readers/csv'
import { extractTables } from './csv'
import type { ConvertOptions, HubDocument, WriteResult } from '../types'

/**
 * Table extraction as JSON: header-keyed row objects when the first row looks
 * like a header, otherwise arrays of cells. One file per table, matching the
 * csv writer, so `--table N` and the saved-file naming behave identically.
 */
/**
 * Emit numbers as numbers so the output is usable without re-parsing — but
 * only when the text round-trips exactly, so identifiers like "0302" or
 * "1.50" keep the form the document gave them.
 */
function typed(value: string): string | number {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 15) return value
  const n = Number(trimmed)
  return Number.isFinite(n) && String(n) === trimmed ? n : value
}

/**
 * The key each column would be given: the header cell, or a positional name
 * when the header left it blank.
 */
function keysFor(header: string[], width: number): string[] {
  const keys: string[] = []
  for (let i = 0; i < width; i++) keys.push(header[i] || `column${i + 1}`)
  return keys
}

/**
 * A header row may name two columns the same thing — "Q1 | Q2 | Q1" in a
 * report that repeats a quarter, a spreadsheet with two "Notes" columns, or a
 * blank cell whose positional name happens to match a real one. An object
 * cannot hold both: the second value overwrites the first and a whole column
 * leaves the file with nothing said about it. That is the silent loss this
 * project treats as the worst outcome.
 *
 * The alternative remedies are to invent names ("Q1", "Q1 (2)") or to stop
 * keying the table at all. Invented names are a guess: nothing in the document
 * says the second Q1 is a second anything, and a consumer reading "Q1 (2)"
 * cannot tell whether the converter or the author wrote it. Arrays state only
 * what the document states — every cell, every header, in the order they were
 * written — so the degradation is visible in the output and loses nothing. The
 * header row is kept as the first array so the names travel with the data,
 * exactly as the csv writer keeps them.
 *
 * Only the offending table degrades; a sibling table with clean headers in the
 * same document still gets objects.
 */
function hasDuplicateKeys(rows: string[][]): boolean {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const keys = keysFor(rows[0], width)
  return new Set(keys).size !== keys.length
}

function tableToJson(rows: string[][]): unknown[] {
  if (rows.length === 0) return []
  if (!looksLikeHeader(rows) || hasDuplicateKeys(rows)) return rows.map((row) => row.map(typed))
  const [header, ...body] = rows
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const keys = keysFor(header, width)
  return body.map((row) => {
    const record: Record<string, string | number> = {}
    // Cells beyond the header width are still data; dropping them would lose
    // content that the csv writer keeps for the very same document.
    keys.forEach((key, i) => {
      record[key] = typed(row[i] ?? '')
    })
    return record
  })
}

export async function writeJson(doc: HubDocument, _opts?: ConvertOptions): Promise<WriteResult> {
  const tables = extractTables(doc.html)
  if (tables.length === 0) {
    throw new ConversionError('no-tables', 'This document contains no tables to extract')
  }
  const toBytes = (rows: string[][]): Buffer =>
    Buffer.from(`${JSON.stringify(tableToJson(rows), null, 2)}\n`, 'utf8')
  if (tables.length === 1) return { parts: [{ suffix: '', bytes: toBytes(tables[0]) }] }
  return { parts: tables.map((t, i) => ({ suffix: `.table-${i + 1}`, bytes: toBytes(t) })) }
}
