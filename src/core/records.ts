import { getHeapStatistics } from 'node:v8'
import { ConversionError } from './errors'
import { escapeHtml } from './shell'

/**
 * Record sources (spec D, "Record limits"): files that are rows of records
 * rather than a document: JSON arrays, JSON Lines, vCard and SQLite.
 *
 *   printing (pdf, docx, html, epub, Kindle, slides, md, txt) and the editor
 *       at most PRINT_RECORD_LIMIT records per table, and the document says so
 *   exporting (csv, json, xlsx)
 *       every record, written straight from the source as RowSources, never
 *       as hub HTML: a million rows of <tr> would cost hundreds of megabytes
 *       only for the table writers to turn them back into rows
 */
export const PRINT_RECORD_LIMIT = 5000

/**
 * Memory (hostile-file protection). There is no size limit on a record
 * source (owner, 2026-10-17), but it is read whole: its text is one string
 * and its rows are held until written. Two things can run out, and neither
 * may take the app down with it:
 *
 *   the string limit    the engine cannot make a string over about 512
 *                       million characters; it throws, and tooLargeError
 *                       says so in words
 *   the heap            running out of JavaScript heap ends the process,
 *                       not just the conversion: 300 MB of tiny records
 *                       ({"a":1}, 38 million rows) once did. The record
 *                       readers ask every MEMORY_CHECK_EVERY rows whether
 *                       the heap is nearly full and stop with a sentence
 *                       if it is
 *
 * Measured in Electron's main process (a 4 GB heap): 300 MB of ordinary
 * records reads and exports in 2 to 8 s and 1.1 to 2.2 GB; 500 MB of tiny
 * records (63 million rows) in 33 s and 4.3 GB.
 */
export const MEMORY_CHECK_EVERY = 16_384

/** How full the heap may get, of its limit, before a record source is given up on. */
const HEAP_FULL = 0.85

export function heapNearlyFull(stats = getHeapStatistics()): boolean {
  return stats.used_heap_size > stats.heap_size_limit * HEAP_FULL
}

/** The check the readers make; an object so a test can stand in for a full heap. */
export const memory = { full: (): boolean => heapNearlyFull() }

/** Thrown by a record parser when memory.full() says the heap is nearly full. */
export class RecordsTooLarge extends Error {
  constructor() {
    super('The records need more memory than the app has')
    this.name = 'RecordsTooLarge'
  }
}

/** The longest string the engine can make, in characters (V8's String::kMaxLength). */
const MAX_STRING_CHARS = 2 ** 29 - 24

const stringTooLong = (err: unknown): boolean =>
  (err as { code?: string })?.code === 'ERR_STRING_TOO_LONG' || (err instanceof RangeError && /Invalid string length/.test(err.message))

/** A record file that ran out of memory or string, as the sentence the user sees; null for any other error. */
export function tooLargeError(name: string, err: unknown): ConversionError | null {
  if (err instanceof RecordsTooLarge) {
    return new ConversionError('read-failed', `${name} is too large to convert: its records need more memory than the app has.`)
  }
  if (stringTooLong(err)) {
    const most = MAX_STRING_CHARS.toLocaleString('en-US')
    return new ConversionError('read-failed', `${name} is too large to convert: it is more text than the app can hold at once (${most} characters).`)
  }
  return null
}

export interface RowSource {
  /** The table's name: a file name, a database table. */
  name: string
  header: string[]
  rows: AsyncIterable<string[]> | Iterable<string[]>
  /** How many rows there are, when known up front: for the progress line. */
  total?: number
  /**
   * Called once the writer is done with the sources, finished or not. A
   * database's rows are read lazily from a worker that holds it open.
   */
  close?: () => Promise<void> | void
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
  // A cell's line breaks (a contact's several phone numbers) stay line breaks.
  const cell = (v: string): string => escapeHtml(v).replace(/\n/g, '<br>')
  const body = rows.map((r) => `<tr>${header.map((_h, i) => `<td>${cell(r[i] ?? '')}</td>`).join('')}</tr>`).join('')
  const table = `<table>${head}<tbody>${body}</tbody></table>`
  return total > rows.length ? `${table}\n<p><em>${limitMessage(rows.length, total, noun)}</em></p>` : table
}
