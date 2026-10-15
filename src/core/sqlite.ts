/**
 * The SQLite engine contract (spec D13), between core's reader and the
 * main-process host that runs sql.js.
 *
 * The engine is not in core. Loading a wasm file and starting a
 * `worker_threads` Worker are Node-side, and `src/core` imports no `node:fs`
 * (the browser build relies on that). So the reader is handed an engine
 * through `ConverterDeps.sqlite` and only turns its answers into hub HTML or
 * row sources. Without one, a database is refused: "SQLite databases need
 * the desktop app".
 *
 * The engine runs only the reader's own read statements: `sqlite_master`,
 * `PRAGMA table_info`, `SELECT count(*)` and `SELECT *` (with `LIMIT` when
 * printing). It never runs SQL taken from the file, except as a view's own
 * definition when that view is selected.
 */

/** The first 16 bytes of every SQLite 3 database file. */
const MAGIC = 'SQLite format 3\0'

export function hasSqliteMagic(bytes: Buffer): boolean {
  return bytes.length >= MAGIC.length && bytes.toString('latin1', 0, MAGIC.length) === MAGIC
}

/**
 * A database in WAL mode: header bytes 18 and 19 (the file format write and
 * read versions) are 2. Recent changes may then live only in the `-wal` file
 * beside it, which is not read.
 */
export function isWalMode(bytes: Buffer): boolean {
  return hasSqliteMagic(bytes) && bytes.length >= 20 && (bytes[18] === 2 || bytes[19] === 2)
}

export const SQLITE_NEEDS_DESKTOP = 'SQLite databases need the desktop app'
export const SQLITE_ENCRYPTED_MESSAGE = 'This database is encrypted or not a SQLite database.'

/** One row of `sqlite_master` that has SQL (automatic indexes have none). */
export interface SqliteObject {
  type: 'table' | 'view' | 'index' | 'trigger'
  name: string
  sql: string
}

/** One open database. Every answer is plain data: it crossed a thread. */
export interface SqliteDatabase {
  /** `sqlite_master`, in its own order (creation order). Rejects when the file is not a database. */
  schema(): Promise<SqliteObject[]>
  /** The column names, from `PRAGMA table_info`. */
  columns(name: string): Promise<string[]>
  /** `SELECT count(*)`. `view` puts it under the view time limit. */
  count(name: string, opts?: { view?: boolean }): Promise<number>
  /**
   * `SELECT *`, each cell already text: integers exact, REAL as SQLite prints
   * it, NULL empty, a BLOB as `[blob 1.2 KB]`. Fetched in batches of 1,000.
   */
  rows(name: string, opts?: { limit?: number; view?: boolean }): AsyncIterable<string[]>
  /** Frees the database. Safe to call more than once. */
  close(): Promise<void>
}

export interface SqliteEngine {
  /**
   * Open a database from its bytes, in memory. The file it came from is never
   * opened, so it cannot be written and no `-wal`/`-journal` file appears.
   * `purpose` picks the view time limit (10 s printing, 60 s table outputs);
   * `signal` stops everything at once.
   */
  open(bytes: Buffer, opts: { purpose: 'print' | 'export'; signal?: AbortSignal }): Promise<SqliteDatabase>
}

/** A view stopped at the time limit. The worker running it was replaced. */
export class SqliteTimeoutError extends Error {
  constructor(
    public readonly view: string,
    public readonly seconds: number,
  ) {
    super(`The view "${view}" took longer than ${seconds} seconds and was stopped.`)
    this.name = 'SqliteTimeoutError'
  }
}
