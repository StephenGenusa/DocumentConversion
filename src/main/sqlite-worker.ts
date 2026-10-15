import { parentPort, workerData } from 'worker_threads'
import { createRequire } from 'module'
import { sqliteCell } from './sqlite-cells'

/**
 * The SQLite engine thread (spec D13): sql.js, one database, opened from
 * bytes in memory. Started and stopped by sqlite-host.ts.
 *
 * It is a thread of its own because sql.js runs synchronously: a view that is
 * a recursive CTE or a huge cross join would otherwise hang the main process,
 * and sql.js has no `interrupt`. The host stops it by terminating the worker.
 *
 * Only these statements are run, and every name in them is quoted:
 *   SELECT … FROM sqlite_master          the schema
 *   PRAGMA table_info (pragma_table_info) a table's columns, name bound
 *   SELECT count(*) FROM "t"
 *   SELECT * FROM "t" [LIMIT n]
 */

interface SqlJsStatement {
  bind(values: unknown[]): boolean
  step(): boolean
  get(params?: null, opts?: { useBigInt?: boolean }): unknown[]
  free(): boolean
}
interface SqlJsDatabase {
  prepare(sql: string): SqlJsStatement
}
type InitSqlJs = (opts: { wasmBinary: Uint8Array }) => Promise<{ Database: new (bytes: Uint8Array) => SqlJsDatabase }>

interface Data {
  /** The vendored sql.js loader, resources/sqlite/sql-wasm.js. */
  loaderPath: string
  wasm: Uint8Array
  /** The database file's bytes. The file itself is never opened. */
  bytes: Uint8Array
}

export type Request =
  | { id: number; op: 'schema' }
  | { id: number; op: 'columns'; name: string }
  | { id: number; op: 'count'; name: string }
  | { id: number; op: 'cursor'; name: string; limit?: number }
  | { id: number; op: 'next'; cursor: number; n: number }
  | { id: number; op: 'free'; cursor: number }

export type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string }

/** An identifier as a SQL string of its own: `"` doubled, so no name can end it. */
export const quoteName = (name: string): string => `"${name.replace(/"/g, '""')}"`

const data = workerData as Data
// The loader is not bundled: it is the vendored copy, required where it lies.
const load = createRequire(__filename)(data.loaderPath) as InitSqlJs
const ready = load({ wasmBinary: data.wasm }).then((SQL) => new SQL.Database(data.bytes))

const cursors = new Map<number, SqlJsStatement>()
let nextCursor = 1

function all(db: SqlJsDatabase, sql: string, params: unknown[] = []): unknown[][] {
  const stmt = db.prepare(sql)
  try {
    if (params.length > 0) stmt.bind(params)
    const out: unknown[][] = []
    while (stmt.step()) out.push(stmt.get(null, { useBigInt: true }))
    return out
  } finally {
    stmt.free()
  }
}

function answer(db: SqlJsDatabase, req: Request): unknown {
  switch (req.op) {
    case 'schema':
      return all(db, 'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL').map(([type, name, sql]) => ({
        type: String(type),
        name: String(name),
        sql: String(sql),
      }))
    case 'columns':
      return all(db, 'SELECT name FROM pragma_table_info(?)', [req.name]).map(([name]) => String(name))
    case 'count':
      return Number(all(db, `SELECT count(*) FROM ${quoteName(req.name)}`)[0][0])
    case 'cursor': {
      const limit = req.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(req.limit))}` : ''
      const id = nextCursor++
      cursors.set(id, db.prepare(`SELECT * FROM ${quoteName(req.name)}${limit}`))
      return id
    }
    case 'next': {
      const stmt = cursors.get(req.cursor)
      if (!stmt) throw new Error('That query is no longer open')
      const rows: string[][] = []
      let done = false
      while (rows.length < req.n) {
        if (!stmt.step()) {
          done = true
          break
        }
        rows.push(stmt.get(null, { useBigInt: true }).map(sqliteCell))
      }
      if (done) {
        stmt.free()
        cursors.delete(req.cursor)
      }
      return { rows, done }
    }
    case 'free':
      cursors.get(req.cursor)?.free()
      cursors.delete(req.cursor)
      return null
  }
}

parentPort?.on('message', (req: Request) => {
  ready.then(
    (db) => {
      let reply: Reply
      try {
        reply = { id: req.id, ok: true, value: answer(db, req) }
      } catch (err) {
        reply = { id: req.id, ok: false, message: (err as Error).message ?? String(err) }
      }
      parentPort?.postMessage(reply)
    },
    (err: Error) => parentPort?.postMessage({ id: req.id, ok: false, message: `The SQLite engine did not start: ${err.message}` }),
  )
})
