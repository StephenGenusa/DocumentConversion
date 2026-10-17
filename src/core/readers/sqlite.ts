import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import { PRINT_RECORD_LIMIT, limitMessage, recordsTableHtml, type RowSource } from '../records'
import {
  SQLITE_ENCRYPTED_MESSAGE,
  SQLITE_NEEDS_DESKTOP,
  SqliteTimeoutError,
  isWalMode,
  type SqliteDatabase,
  type SqliteEngine,
  type SqliteObject,
} from '../sqlite'
import type { HubDocument, ReadContext } from '../types'
import type { Reader, RowReader } from './index'

/**
 * SQLite databases (spec D13). A record source: each user table, ordered by
 * name, is printed up to PRINT_RECORD_LIMIT rows and exported in full; views
 * follow the tables when "Include view results" is on.
 *
 * The engine itself is the main process's (see core/sqlite.ts), so these are
 * factories: the converter binds them to `ConverterDeps.sqlite`, and the
 * registry holds unbound ones that refuse.
 */

const baseName = (filename?: string): string => (filename ?? 'database.sqlite').split(/[\\/]/).pop() ?? 'database.sqlite'

/** SQLite reserves every name starting `sqlite_` (sqlite_sequence, sqlite_stat1, …). */
const internal = (name: string): boolean => /^sqlite_/i.test(name)

const byName = (a: SqliteObject, b: SqliteObject): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

const WAL_NOTICE =
  'This database is in WAL mode: its most recent changes may be only in the -wal file beside it, which is not read.'

function engineOf(engine: SqliteEngine | undefined): SqliteEngine {
  if (!engine) throw new ConversionError('read-failed', SQLITE_NEEDS_DESKTOP)
  return engine
}

const canceled = (err: unknown, ctx?: ReadContext): boolean =>
  ctx?.signal?.aborted === true || (err instanceof ConversionError && err.code === 'canceled')

/** The schema, or the one message for a file sql.js cannot open as a database. */
async function schemaOf(db: SqliteDatabase, ctx?: ReadContext): Promise<SqliteObject[]> {
  try {
    return (await db.schema()).filter((o) => !internal(o.name))
  } catch (err) {
    if (canceled(err, ctx)) throw err
    throw new ConversionError('read-failed', SQLITE_ENCRYPTED_MESSAGE)
  }
}

/** Tables by name, then (when included) views by name. */
function readable(objects: SqliteObject[], ctx?: ReadContext): SqliteObject[] {
  const tables = objects.filter((o) => o.type === 'table').sort(byName)
  const views = ctx?.sqliteViews ? objects.filter((o) => o.type === 'view').sort(byName) : []
  return [...tables, ...views]
}

/** What the page and the result say about a table or view that could not be read. */
function stoppedNotice(o: SqliteObject, err: unknown): { page: string; advice: string } {
  if (err instanceof SqliteTimeoutError) {
    return {
      page: `This view took longer than ${err.seconds} seconds and was stopped.`,
      advice: `The view "${o.name}" took longer than ${err.seconds} seconds and was stopped.`,
    }
  }
  const why = ((err as Error)?.message ?? String(err)).replace(/\.$/, '')
  return {
    page: `This ${o.type} could not be read: ${why}.`,
    advice: `The ${o.type} "${o.name}" could not be read: ${why}.`,
  }
}

async function collect(rows: AsyncIterable<string[]>): Promise<string[][]> {
  const out: string[][] = []
  for await (const row of rows) out.push(row)
  return out
}

/** The printing reader: schema, then each table (and view) up to the limit. */
export function sqliteReader(engine?: SqliteEngine): Reader {
  return async (src, ctx) => {
    const sqlite = engineOf(engine)
    const name = baseName(src.filename)
    const wal = isWalMode(src.bytes)
    if (wal) ctx?.onAdvice?.('sqlite-wal', WAL_NOTICE)
    const db = await sqlite.open(src.bytes, { purpose: 'print', signal: ctx?.signal })
    try {
      const objects = await schemaOf(db, ctx)
      const parts = [`<h1>${escapeHtml(name)}</h1>`]
      if (wal) parts.push(`<p><em>${WAL_NOTICE}</em></p>`)
      const schema = objects.map((o) => o.sql.trim().replace(/;*$/, ';')).join('\n\n')
      if (schema) parts.push('<h2>Schema</h2>', `<pre><code class="language-sql">${escapeHtml(schema)}</code></pre>`)
      let limited = false
      for (const o of readable(objects, ctx)) {
        const view = o.type === 'view'
        parts.push(`<h2>${escapeHtml(o.name)}</h2>`)
        try {
          const header = await db.columns(o.name)
          const total = await db.count(o.name, { view })
          const rows = await collect(db.rows(o.name, { limit: PRINT_RECORD_LIMIT, view }))
          if (total > rows.length) {
            limited = true
            ctx?.onAdvice?.(
              'records-limited',
              `"${o.name}": ${limitMessage(rows.length, total, 'rows')} Export to CSV, JSON or Excel for every row.`,
            )
          }
          parts.push(recordsTableHtml(header, rows, total, 'rows'))
        } catch (err) {
          if (canceled(err, ctx)) throw err
          // The rest of the database still comes out: this one shows what it is.
          const notice = stoppedNotice(o, err)
          ctx?.onAdvice?.('sqlite-stopped', notice.advice)
          parts.push(`<p><em>${escapeHtml(notice.page)}</em></p>`, `<pre><code class="language-sql">${escapeHtml(o.sql)}</code></pre>`)
        }
      }
      const hub: HubDocument = { html: parts.join('\n'), title: name }
      if (limited) hub.limited = true
      return hub
    } finally {
      await db.close()
    }
  }
}

/**
 * The export reader: every row of every table (and view), as row sources the
 * table writers read lazily, batch by batch. The database stays open until
 * the writer is done with them; each source's `close` frees it.
 */
export function sqliteRowReader(engine?: SqliteEngine): RowReader {
  return async (src, ctx) => {
    const sqlite = engineOf(engine)
    if (isWalMode(src.bytes)) ctx?.onAdvice?.('sqlite-wal', WAL_NOTICE)
    const db = await sqlite.open(src.bytes, { purpose: 'export', signal: ctx?.signal })
    const close = (): Promise<void> => db.close()
    const sources: RowSource[] = []
    try {
      for (const o of readable(await schemaOf(db, ctx), ctx)) {
        const view = o.type === 'view'
        let header: string[]
        // Counted for the progress line only. A view is not: counting one
        // runs the whole query a second time.
        let total: number | undefined
        try {
          header = await db.columns(o.name)
          if (!view) total = await db.count(o.name)
        } catch (err) {
          if (canceled(err, ctx)) throw err
          ctx?.onAdvice?.('sqlite-stopped', stoppedNotice(o, err).advice)
          continue
        }
        sources.push({ name: o.name, header, rows: rowsOf(db, o, ctx), close, ...(total !== undefined ? { total } : {}) })
      }
    } catch (err) {
      await close()
      throw err
    }
    if (sources.length === 0) await close()
    return sources
  }
}

/**
 * One table's or view's rows. A view stopped at the time limit (or failing)
 * ends its file with the rows read so far and says so; the other files are
 * still written. A table failing midway is a failed read.
 */
async function* rowsOf(db: SqliteDatabase, o: SqliteObject, ctx?: ReadContext): AsyncGenerator<string[]> {
  const view = o.type === 'view'
  try {
    yield* db.rows(o.name, { view })
  } catch (err) {
    if (canceled(err, ctx) || !view) throw err
    ctx?.onAdvice?.('sqlite-stopped', `${stoppedNotice(o, err).advice} Its file has only the rows read before then.`)
  }
}
