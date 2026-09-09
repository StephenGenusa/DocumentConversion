import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { ConversionError, type ConversionErrorCode } from '../core/errors'
import { uniqueName } from '../core/naming'
import { EXTENSIONS, type ReadContext, type SourceFormat, type TargetFormat, type WriteResult } from '../core/types'

/** Per-conversion cancellation registry, keyed by renderer-generated jobId. */
const jobs = new Map<string, AbortController>()

export function createJob(jobId: string): AbortSignal {
  const controller = new AbortController()
  jobs.set(jobId, controller)
  return controller.signal
}

export function cancelJob(jobId: string): void {
  jobs.get(jobId)?.abort()
}

export function finishJob(jobId: string): void {
  jobs.delete(jobId)
}

/**
 * Cancellation, surfaced to the IPC layer.
 *
 * It is a `ConversionError` so `main/index.ts` reports `code: 'cancelled'`
 * rather than the catch-all 'unexpected'. 'cancelled' is not yet a member of
 * `ConversionErrorCode` — that union lives in `core/errors.ts`, which this
 * change does not own; adding it there removes the cast below and nothing else.
 */
const CANCELLED: ConversionErrorCode = 'cancelled'

export class CancelledError extends ConversionError {
  constructor(message = 'Conversion was cancelled') {
    super(CANCELLED, message)
    this.name = 'CancelledError'
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError()
}

/**
 * Await `work`, but give up on it the moment `signal` aborts.
 *
 * Readers and writers are not themselves abortable — most are synchronous CPU
 * work behind a promise — so cancelling cannot stop what is already running.
 * What it has to do is stop the caller WAITING on it: `ReadContext.signal` was
 * threaded all the way down and then read by nobody outside the OCR and URL
 * paths, so Cancel on a slow document did nothing at all. The conversion ran to
 * completion and the file was written or copied anyway.
 *
 * The abandoned promise keeps a rejection handler attached, so work that fails
 * after the caller walked away does not surface as an unhandled rejection.
 */
export function untilCancelled<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) {
    void work.catch(() => {})
    return Promise.reject(new CancelledError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new CancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    const done = (): void => signal.removeEventListener('abort', onAbort)
    work.then(
      (value) => {
        done()
        resolve(value)
      },
      (err: unknown) => {
        done()
        reject(err)
      },
    )
  })
}

export interface BatchInput {
  bytes: Buffer
  filename?: string
  source: SourceFormat
  ocr: boolean
}

export interface BatchRow {
  filename: string
  status: 'saved' | 'error' | 'cancelled'
  path?: string
  message?: string
}

/** The conversion to run per input — normally `runConversion` bound to a target. */
export type BatchConvert<T> = (input: T, ctx: ReadContext) => Promise<WriteResult>

/** Strips any directory part and the extension; no filename -> "document". */
export function baseName(filename?: string): string {
  if (!filename) return 'document'
  const noPath = filename.split(/[\\/]/).pop() ?? filename
  return noPath.replace(/\.[^.]+$/, '') || 'document'
}

/**
 * Convert a batch of inputs into `outDir`, one at a time, and report a row per
 * input.
 *
 * A batch is not all-or-nothing: one input that cannot be read costs that one
 * file and nothing else, which is why every failure is caught per item rather
 * than escaping the loop. Cancellation is the other way round — it stops the
 * batch — but it is not an error either: the remaining inputs are reported as
 * 'cancelled', with no message to show the user, and the in-flight conversion
 * is discarded before it reaches the disk rather than left half-written.
 *
 * Output names never overwrite: an existing file (from a previous run, or from
 * two inputs whose names differ only by extension) pushes the new one to
 * `name-1`, `name-2`, and so on. Names are resolved immediately before each
 * write so parts of the same result cannot collide with each other.
 *
 * Generic over the item so the IPC handler can pass its base64 payloads
 * through and decode one at a time inside `convert`; asking for decoded bytes
 * up front would have held every input in memory at once, which is why the
 * handler kept its own copy of this loop for a while.
 */
export async function runBatch<T extends { filename?: string }>(
  inputs: T[],
  target: TargetFormat,
  outDir: string,
  ctx: ReadContext,
  convert: BatchConvert<T>,
): Promise<BatchRow[]> {
  const rows: BatchRow[] = []
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]
    const name = input.filename ?? `document-${i + 1}`
    if (ctx.signal?.aborted) {
      rows.push({ filename: name, status: 'cancelled' })
      continue
    }
    ctx.onProgress?.(`Converting ${name} (${i + 1} of ${inputs.length})`, (i / inputs.length) * 100)
    try {
      const out = await convert(input, ctx)
      // Re-check before writing: cancelling during a conversion must not leave
      // its output behind, and a converter that ignores the signal would.
      throwIfCancelled(ctx.signal)
      let first: string | undefined
      for (const part of out.parts) {
        const fname = uniqueName(baseName(input.filename) + part.suffix, EXTENSIONS[target], (n) =>
          existsSync(join(outDir, n)),
        )
        const path = join(outDir, fname)
        await writeFile(path, part.bytes)
        first ??= path
      }
      rows.push({ filename: name, status: 'saved', path: first })
    } catch (err) {
      if (ctx.signal?.aborted) rows.push({ filename: name, status: 'cancelled' })
      else rows.push({ filename: name, status: 'error', message: (err as Error).message })
    }
  }
  return rows
}
