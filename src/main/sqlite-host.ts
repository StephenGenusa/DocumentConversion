import { Worker, type ResourceLimits } from 'worker_threads'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ConversionError } from '../core/errors'
import { SqliteTimeoutError, type SqliteDatabase, type SqliteEngine, type SqliteObject } from '../core/sqlite'
import type { Reply, Request } from './sqlite-worker'

/**
 * The SQLite host (spec D13): sql.js in a `worker_threads` Worker, one worker
 * per open database. Modeled on ocr-host.ts: the engine lives outside the
 * main thread, and stopping it means ending that thread.
 *
 *   a view over its time limit   the worker is terminated, the call rejects
 *                                with SqliteTimeoutError, and the next call
 *                                starts a fresh worker on the same bytes.
 *                                The limit is the engine time the view has
 *                                used in all, its count and every batch of
 *                                rows: an endless view (a recursive CTE with
 *                                no end) returns each batch quickly, forever
 *   Cancel (the job's signal)    the worker is terminated, every call rejects
 *                                as canceled, and the database is closed
 *   memory                       capped by the worker's resourceLimits
 *
 * The bytes stay here for the life of the database so a replacement worker
 * can open them again; the file they came from is never opened by either side.
 */

/** Engine time each view may use, in milliseconds. */
export interface SqliteTimeouts {
  /** Printing (and the editor). */
  print: number
  /** csv, json and xlsx. */
  export: number
}

export interface SqliteHostOptions {
  /** The built worker script. Defaults to the one beside this file in out/main. */
  workerPath?: string
  /** Where sql-wasm.js and sql-wasm.wasm are. Defaults to resources/sqlite. */
  assetDir?: string
  /** Tests use small ones. */
  timeouts?: SqliteTimeouts
  resourceLimits?: ResourceLimits
}

export interface SqliteHost extends SqliteEngine {
  readonly timeouts: SqliteTimeouts
  /** How many views a database has, for the input card (0 when it cannot be read). */
  viewCount(bytes: Buffer): Promise<number>
}

export const DEFAULT_TIMEOUTS: SqliteTimeouts = { print: 10_000, export: 60_000 }

/** JS heap per worker. sql.js's own memory is wasm memory, which this does not count. */
const DEFAULT_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 }

const BATCH = 1000

/**
 * A packaged path inside app.asar, moved to app.asar.unpacked. The worker
 * script and the vendored engine are unpacked (electron-builder.yml): a
 * Worker is started by Node from a real file, and sql.js's loader is
 * required by the worker, where Electron's asar reading is not promised.
 */
const unpacked = (p: string): string => p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')

/** resources/sqlite, wherever this run keeps it (see ocrLangDir for why several roots). */
export function sqliteAssetDir(): string {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, 'app.asar.unpacked', 'resources', 'sqlite')] : []),
    unpacked(join(__dirname, '..', '..', 'resources', 'sqlite')),
    join(process.cwd(), 'resources', 'sqlite'),
  ]
  return candidates.find((dir) => existsSync(join(dir, 'sql-wasm.wasm'))) ?? candidates[0]
}

export function createSqliteHost(opts: SqliteHostOptions = {}): SqliteHost {
  const timeouts = opts.timeouts ?? DEFAULT_TIMEOUTS
  const workerPath = opts.workerPath ?? unpacked(join(__dirname, 'sqlite-worker.js'))
  let assets: { loaderPath: string; wasm: Uint8Array } | undefined
  const assetsOf = (): { loaderPath: string; wasm: Uint8Array } => {
    if (!assets) {
      const dir = opts.assetDir ?? sqliteAssetDir()
      assets = { loaderPath: join(dir, 'sql-wasm.js'), wasm: new Uint8Array(readFileSync(join(dir, 'sql-wasm.wasm'))) }
    }
    return assets
  }

  const host: SqliteHost = {
    timeouts,
    async open(bytes, { purpose, signal }) {
      if (signal?.aborted) throw new ConversionError('canceled', 'Canceled')
      return new Session(
        { workerPath, ...assetsOf(), bytes: new Uint8Array(bytes), resourceLimits: opts.resourceLimits ?? DEFAULT_LIMITS },
        purpose === 'print' ? timeouts.print : timeouts.export,
        signal,
      )
    },
    async viewCount(bytes) {
      let db: SqliteDatabase | undefined
      try {
        db = await host.open(bytes, { purpose: 'print' })
        return (await db.schema()).filter((o) => o.type === 'view').length
      } catch {
        return 0
      } finally {
        await db?.close()
      }
    },
  }
  return host
}

interface Spawn {
  workerPath: string
  loaderPath: string
  wasm: Uint8Array
  bytes: Uint8Array
  resourceLimits: ResourceLimits
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

type Call = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

class Session implements SqliteDatabase {
  private worker: Worker | undefined
  /** Bumped whenever a worker is replaced: a cursor belongs to one worker. */
  private generation = 0
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private closed = false
  /** Engine time each view has used so far, against `viewMs`. */
  private readonly used = new Map<string, number>()
  private readonly onAbort = (): void => {
    this.stop(new ConversionError('canceled', 'Canceled'))
    this.closed = true
  }

  constructor(
    private readonly spawn: Spawn,
    private readonly viewMs: number,
    private readonly signal?: AbortSignal,
  ) {
    signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  private start(): Worker {
    const { workerPath, resourceLimits, ...workerData } = this.spawn
    const worker = new Worker(workerPath, { workerData, resourceLimits })
    const generation = this.generation
    worker.on('message', (reply: Reply) => {
      const p = this.pending.get(reply.id)
      if (!p) return
      this.pending.delete(reply.id)
      clearTimeout(p.timer)
      if (reply.ok) p.resolve(reply.value)
      else p.reject(new Error(reply.message))
    })
    // A worker that dies (out of memory under resourceLimits, a crash) fails
    // what was asked of it; the next call starts another. Without an 'error'
    // listener the EventEmitter would throw it into the main process instead.
    const died = (why: string): void => {
      if (this.generation !== generation) return
      this.stop(new Error(why))
    }
    worker.on('error', (err) => died(`The SQLite engine stopped: ${err.message}`))
    worker.on('exit', (code) => died(`The SQLite engine stopped unexpectedly (code ${code})`))
    return worker
  }

  /** Ends the current worker, failing everything asked of it with `err`. */
  private stop(err: unknown): void {
    const worker = this.worker
    this.worker = undefined
    this.generation++
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    void worker?.terminate()
  }

  private call<T>(req: Call, view?: string): Promise<T> {
    if (this.signal?.aborted) return Promise.reject(new ConversionError('canceled', 'Canceled'))
    if (this.closed) return Promise.reject(new Error('The database is closed'))
    const left = view !== undefined ? this.viewMs - (this.used.get(view) ?? 0) : Infinity
    if (view !== undefined && left <= 0) {
      this.stop(new Error('The SQLite engine was restarted'))
      return Promise.reject(new SqliteTimeoutError(view, this.viewMs / 1000))
    }
    this.worker ??= this.start()
    const id = this.nextId++
    const started = Date.now()
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject }
      if (view !== undefined) {
        const spent = (): void => void this.used.set(view, (this.used.get(view) ?? 0) + Date.now() - started)
        p.resolve = (v) => {
          spent()
          resolve(v as T)
        }
        p.reject = (err) => {
          spent()
          reject(err)
        }
        p.timer = setTimeout(() => {
          this.pending.delete(id)
          this.used.set(view, this.viewMs)
          reject(new SqliteTimeoutError(view, this.viewMs / 1000))
          // The worker is busy in the view: the only way out is to end it.
          this.stop(new Error('The SQLite engine was restarted'))
        }, left)
      }
      this.pending.set(id, p)
      this.worker!.postMessage({ ...req, id })
    })
  }

  schema(): Promise<SqliteObject[]> {
    return this.call({ op: 'schema' })
  }

  columns(name: string): Promise<string[]> {
    return this.call({ op: 'columns', name })
  }

  count(name: string, opts?: { view?: boolean }): Promise<number> {
    return this.call({ op: 'count', name }, opts?.view ? name : undefined)
  }

  async *rows(name: string, opts?: { limit?: number; view?: boolean }): AsyncGenerator<string[]> {
    const view = opts?.view ? name : undefined
    const cursor = await this.call<number>({ op: 'cursor', name, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) }, view)
    const generation = this.generation
    let done = false
    try {
      while (!done) {
        const batch = await this.call<{ rows: string[][]; done: boolean }>({ op: 'next', cursor, n: BATCH }, view)
        done = batch.done
        yield* batch.rows
      }
    } finally {
      // Stopped early (a writer failed, a limit): free the statement, if the
      // worker holding it is still the one running.
      if (!done && !this.closed && this.generation === generation) await this.call({ op: 'free', cursor }).catch(() => {})
    }
  }

  async close(): Promise<void> {
    if (this.closed && !this.worker) return
    this.closed = true
    this.signal?.removeEventListener('abort', this.onAbort)
    this.stop(new Error('The database is closed'))
  }
}
