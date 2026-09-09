import { app, utilityProcess } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { ConversionError } from '../core/errors'
import { langPathFor } from './ocr-packs'
import type { OcrPage } from '../ocr/pipeline'
import type { ReadContext } from '../core/types'

/**
 * Locate the offline OCR language data.
 *
 * Packaged, it sits beside the app in resourcesPath. In development
 * `app.getAppPath()` points at out/main (the entry's directory), not the
 * project root, so that path alone resolved to out/main/resources/ocr and OCR
 * failed with ENOENT — only in dev, which is why it went unnoticed.
 */
export function ocrLangDir(): string {
  const candidates = [
    join(process.resourcesPath, 'ocr'),
    join(app.getAppPath(), 'resources', 'ocr'),
    join(__dirname, '..', '..', 'resources', 'ocr'),
    join(process.cwd(), 'resources', 'ocr'),
  ]
  return candidates.find((dir) => existsSync(join(dir, 'eng.traineddata.gz'))) ?? candidates[0]
}

interface OcrMessage {
  type: 'progress' | 'done' | 'error'
  stage?: string
  percent?: number
  pages?: OcrPage[]
  code?: string
  message?: string
}

/**
 * Run OCR in a utilityProcess; cancel = kill(). Resolves to one entry per
 * page, each carrying text and — when the page laid out as a table — a grid.
 * Plain data only: it crosses a process boundary by structured clone.
 */
export function runOcr(
  kind: 'pdf' | 'image',
  bytes: Buffer,
  ctx?: ReadContext,
  language?: string,
): Promise<OcrPage[]> {
  return new Promise((resolve, reject) => {
    if (ctx?.signal?.aborted) {
      reject(new ConversionError('ocr-cancelled', 'OCR was cancelled'))
      return
    }
    // Pipe the child's stderr: without it a crash surfaced only as
    // "exited unexpectedly (code 1)" with no way to tell why.
    const child = utilityProcess.fork(join(__dirname, 'ocr-entry.js'), [], {
      serviceName: 'docconversion-ocr',
      stdio: 'pipe',
    })
    let childError = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      childError += chunk.toString()
    })
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      ctx?.signal?.removeEventListener('abort', onAbort)
      fn()
      child.kill()
    }
    const onAbort = (): void => finish(() => reject(new ConversionError('ocr-cancelled', 'OCR was cancelled')))
    ctx?.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('message', (msg: OcrMessage) => {
      if (msg.type === 'progress') ctx?.onProgress?.(msg.stage ?? 'OCR', msg.percent)
      else if (msg.type === 'done') finish(() => resolve(msg.pages ?? []))
      else if (msg.type === 'error') {
        finish(() =>
          reject(
            new ConversionError(
              (msg.code as ConstructorParameters<typeof ConversionError>[0]) ?? 'ocr-failed',
              msg.message ?? 'OCR failed',
            ),
          ),
        )
      }
    })
    // Keep the message line, not the stack frames beneath it.
    const stderrDetail = (): string => {
      const line = childError.trim().split('\n').find((l) => /error|cannot|failed/i.test(l)) ?? ''
      const trimmed = line.trim().slice(0, 300)
      return trimmed ? `: ${trimmed}` : ''
    }
    const fail = (message: string): void => finish(() => reject(new ConversionError('ocr-failed', message)))

    /**
     * A non-continuable V8 error inside the child.
     *
     * `UtilityProcess` is a Node `EventEmitter`, and an 'error' event with no
     * listener THROWS out of the emitter. With nothing listening here, an OCR
     * child crashing on a fatal V8 error raised an uncaught exception in the
     * main process and took the whole app down instead of failing one
     * conversion. Electron documents that 'exit' always follows, but settling
     * here keeps the promise from hanging if it does not.
     */
    child.on('error', (type, location) => fail(`OCR process crashed (${type} at ${location})${stderrDetail()}`))
    // Routed through finish() so the abort listener is detached: the signal
    // belongs to the job, which outlives this one request.
    child.on('exit', (code) => fail(`OCR process exited unexpectedly (code ${code})${stderrDetail()}`))
    child.postMessage({
      kind,
      base64: bytes.toString('base64'),
      // The directory depends on the language: bundled English lives in the
      // installation, a downloaded pack in userData.
      ...(language
        ? { langPath: langPathFor(language).dir, gzip: langPathFor(language).gzip }
        : { langPath: ocrLangDir(), gzip: true }),
      language,
    })
  })
}
