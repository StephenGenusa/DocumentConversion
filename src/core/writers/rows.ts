import * as XLSX from 'xlsx'
import { ConversionError } from '../errors'
import { csvCell } from './csv'
import { keysFor, typed } from './json'
import type { RowSource } from '../records'
import type { TargetFormat, WritePart, WriteResult } from '../types'

/**
 * csv, json and xlsx straight from record sources (see records.ts), without
 * the hub. The same shapes the table writers make from a document's tables:
 * csv one file per source, json header-keyed objects with `typed` numbers,
 * xlsx one workbook with a sheet per source.
 */

/** Excel's hard limit per sheet, header included. */
export const XLSX_MAX_ROWS = 1_048_576

export interface RowWriteOptions {
  signal?: AbortSignal
  onProgress?: (stage: string, percent?: number) => void
  /** For tests: a smaller sheet limit than Excel's. */
  maxSheetRows?: number
}

async function* rowsOf(source: RowSource, opts: RowWriteOptions, index: number, count: number): AsyncGenerator<string[]> {
  let n = 0
  for await (const row of source.rows) {
    if (opts.signal?.aborted) throw new ConversionError('cancelled', 'Cancelled')
    yield row
    if (++n % 10_000 === 0) {
      const of = source.total !== undefined ? ` of ${source.total.toLocaleString('en-US')}` : ''
      opts.onProgress?.(`Table ${index + 1} of ${count}: ${n.toLocaleString('en-US')}${of} rows`)
    }
  }
}

function suffixFor(sources: RowSource[], i: number): string {
  if (sources.length === 1) return ''
  return `.${sources[i].name.replace(/[^\w.-]+/g, '_') || `table-${i + 1}`}`
}

/** Excel refuses a sheet name over 31 characters, with []:*?/\ in it, or used twice. */
function sheetNamer(): (name: string) => string {
  const used = new Set<string>()
  return (raw) => {
    const base = (raw.replace(/[[\]:*?/\\]/g, '_').trim() || 'Sheet').slice(0, 31)
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const tail = ` (${n})`
      name = base.slice(0, 31 - tail.length) + tail
    }
    used.add(name.toLowerCase())
    return name
  }
}

export async function writeRows(sources: RowSource[], target: TargetFormat, opts: RowWriteOptions = {}): Promise<WriteResult> {
  try {
    return await writeAll(sources, target, opts)
  } finally {
    // Whatever happened, a source holding something open lets go of it.
    for (const s of new Set(sources.map((x) => x.close))) await s?.()
  }
}

async function writeAll(sources: RowSource[], target: TargetFormat, opts: RowWriteOptions): Promise<WriteResult> {
  if (sources.length === 0) throw new ConversionError('no-tables', 'This document contains no tables to extract')
  if (target === 'csv') {
    const parts: WritePart[] = []
    for (let i = 0; i < sources.length; i++) {
      const lines: string[] = [sources[i].header.map(csvCell).join(',') + '\r\n']
      for await (const row of rowsOf(sources[i], opts, i, sources.length)) lines.push(row.map(csvCell).join(',') + '\r\n')
      parts.push({ suffix: suffixFor(sources, i), bytes: Buffer.from(lines.join(''), 'utf8') })
    }
    return { parts }
  }
  if (target === 'json') {
    const parts: WritePart[] = []
    for (let i = 0; i < sources.length; i++) {
      const keys = keysFor(sources[i].header, sources[i].header.length)
      const records: Record<string, string | number>[] = []
      for await (const row of rowsOf(sources[i], opts, i, sources.length)) {
        const record: Record<string, string | number> = {}
        keys.forEach((k, c) => (record[k] = typed(row[c] ?? '')))
        records.push(record)
      }
      parts.push({ suffix: suffixFor(sources, i), bytes: Buffer.from(`${JSON.stringify(records, null, 2)}\n`, 'utf8') })
    }
    return { parts }
  }
  if (target === 'xlsx') {
    const max = opts.maxSheetRows ?? XLSX_MAX_ROWS
    const wb = XLSX.utils.book_new()
    const name = sheetNamer()
    for (let i = 0; i < sources.length; i++) {
      const { header } = sources[i]
      let sheet: (string | number)[][] = [header]
      let part = 1
      const flush = (): void => {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), name(part === 1 ? sources[i].name : `${sources[i].name} (${part})`))
      }
      for await (const row of rowsOf(sources[i], opts, i, sources.length)) {
        if (sheet.length >= max) {
          // A table past Excel's sheet limit continues on "name (2)", header repeated.
          flush()
          part++
          sheet = [header]
        }
        // Numbers as numbers, as the hub path writes them (see `typed`).
        sheet.push(row.map(typed))
      }
      flush()
    }
    return { parts: [{ suffix: '', bytes: Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })) }] }
  }
  throw new ConversionError('unsupported', `${target} is not a table output`)
}
