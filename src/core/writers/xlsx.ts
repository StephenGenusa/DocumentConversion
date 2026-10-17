import { ConversionError } from '../errors'
import { extractTables } from './csv'
import { sheetNamer, writeTable } from './rows'
import { XlsxBook } from './xlsx-stream'
import type { ConvertOptions, HubDocument, WriteResult } from '../types'

/**
 * Table extraction as a workbook: one sheet per table, so a multi-table
 * document stays a single file (unlike csv/json, which write one file each).
 * A table past Excel's sheet limit continues on "Table 1 (2)", its first row
 * repeated, as a record source's does (rows.ts).
 */
export async function writeXlsx(doc: HubDocument, _opts?: ConvertOptions): Promise<WriteResult> {
  const tables = extractTables(doc.html)
  if (tables.length === 0) {
    throw new ConversionError('no-tables', 'This document contains no tables to extract')
  }
  const book = new XlsxBook()
  const name = sheetNamer()
  for (const [i, rows] of tables.entries()) {
    // Let go of each table once written: only the workbook is kept.
    tables[i] = []
    await writeTable(book, name, `Table ${i + 1}`, rows[0], rows.slice(1))
  }
  return { parts: [{ suffix: '', bytes: await book.end() }] }
}
