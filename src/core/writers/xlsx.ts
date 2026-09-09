import * as XLSX from 'xlsx'
import { ConversionError } from '../errors'
import { extractTables } from './csv'
import type { ConvertOptions, HubDocument, WriteResult } from '../types'

/**
 * Table extraction as a workbook: one sheet per table, so a multi-table
 * document stays a single file (unlike csv/json, which write one file each).
 */
export async function writeXlsx(doc: HubDocument, _opts?: ConvertOptions): Promise<WriteResult> {
  const tables = extractTables(doc.html)
  if (tables.length === 0) {
    throw new ConversionError('no-tables', 'This document contains no tables to extract')
  }
  const wb = XLSX.utils.book_new()
  tables.forEach((rows, i) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), `Table ${i + 1}`)
  })
  const bytes = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  return { parts: [{ suffix: '', bytes }] }
}
