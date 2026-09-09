import { ConversionError } from '../errors'
import { tableGrid } from '../table-grid'
import type { ConvertOptions, HubDocument, WriteResult } from '../types'

/**
 * Every <table> as rows×cells with spans expanded, nested tables kept
 * separate, and empty layout tables dropped. See src/core/table-grid.ts.
 *
 * Data exports repeat a rowspan's value down the rows it covers: a merged
 * category label belongs on every row it applies to, or filtering the export
 * silently loses it.
 */
export const extractTables = (html: string): string[][][] => tableGrid(html, { fillRowspan: true })

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function toCsv(rows: string[][]): Buffer {
  return Buffer.from(rows.map((r) => r.map(csvCell).join(',') + '\r\n').join(''), 'utf8')
}

export async function writeCsv(doc: HubDocument, _opts?: ConvertOptions): Promise<WriteResult> {
  const tables = extractTables(doc.html)
  if (tables.length === 0) {
    throw new ConversionError('no-tables', 'This document contains no tables to extract')
  }
  if (tables.length === 1) return { parts: [{ suffix: '', bytes: toCsv(tables[0]) }] }
  return { parts: tables.map((t, i) => ({ suffix: `.table-${i + 1}`, bytes: toCsv(t) })) }
}
