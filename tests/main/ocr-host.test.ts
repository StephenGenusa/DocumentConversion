import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { ConversionError } from '../../src/core/errors'
import type { OcrPage } from '../../src/ocr/pipeline'

// Loading src/main pulls in every reader and writer; on a loaded machine that
// alone can outrun the 5s default before a test body starts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 60_000 })

/**
 * The OCR *host* under test, not the OCR pipeline.
 *
 * Everything here runs in-process: the only thing faked is the boundary the
 * host cannot reach from a unit test — Electron's `utilityProcess.fork` and the
 * child handle it hands back. `FakeChild` is a real `EventEmitter`, so the
 * 'message' / 'exit' / 'error' semantics the host relies on (including Node's
 * rule that an unhandled 'error' event throws) are the real ones, and the test
 * drives them deterministically instead of racing a real tesseract child.
 */
class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly posted: unknown[] = []
  kills = 0
  postMessage(msg: unknown): void {
    this.posted.push(msg)
  }
  kill(): boolean {
    this.kills++
    return true
  }
}

const children: FakeChild[] = []
const forkCalls: { modulePath: string; args?: string[]; opts?: Record<string, unknown> }[] = []

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getAppPath: () => process.cwd() },
  utilityProcess: {
    fork: (modulePath: string, args?: string[], opts?: Record<string, unknown>) => {
      forkCalls.push({ modulePath, args, opts })
      const child = new FakeChild()
      children.push(child)
      return child
    },
  },
}))

// ocr-host is imported dynamically so the 'electron' factory above runs after
// this module's own bindings exist (a static import would run it during
// hoisting, before `children` is initialised).
type OcrHost = typeof import('../../src/main/ocr-host')
async function host(): Promise<OcrHost> {
  return import('../../src/main/ocr-host')
}

const PAGE_A: OcrPage[] = [{ text: 'page from request A' }]
const PAGE_B: OcrPage[] = [{ text: 'page from request B' }]

// Load the module graph before the first test, so its cost is not charged to
// that test's timeout when the whole suite runs in parallel.
beforeAll(async () => {
  await host()
})

beforeEach(() => {
  children.length = 0
  forkCalls.length = 0
  // ocrLangDir() joins process.resourcesPath, which only exists under Electron.
  ;(process as unknown as { resourcesPath: string }).resourcesPath = process.cwd()
})

/** Wait for the host to have forked and attached its listeners. */
async function nextChild(): Promise<FakeChild> {
  for (let i = 0; i < 50 && children.length === 0; i++) await Promise.resolve()
  expect(children).toHaveLength(1)
  return children[0]
}

describe('runOcr — request/response protocol', () => {
  it('sends the work to the child and resolves with the pages it replies', async () => {
    const { runOcr } = await host()
    const stages: [string, number | undefined][] = []
    const pending = runOcr('image', Buffer.from('PNGBYTES'), {
      onProgress: (stage, percent) => stages.push([stage, percent]),
    })
    const child = await nextChild()

    // The request actually carries the bytes, not a reference to them: it
    // crosses a process boundary by structured clone.
    expect(child.posted).toHaveLength(1)
    const req = child.posted[0] as { kind: string; base64: string; langPath: string }
    expect(req.kind).toBe('image')
    expect(Buffer.from(req.base64, 'base64').toString()).toBe('PNGBYTES')
    expect(typeof req.langPath).toBe('string')

    child.emit('message', { type: 'progress', stage: 'Recognizing', percent: 40 })
    child.emit('message', { type: 'progress', percent: 90 })
    child.emit('message', { type: 'done', pages: PAGE_A })

    await expect(pending).resolves.toEqual(PAGE_A)
    expect(stages).toEqual([
      ['Recognizing', 40],
      ['OCR', 90],
    ])
    // A resolved request must not leave a child process behind.
    expect(child.kills).toBe(1)
  })

  it('rejects with the child-reported code when the child replies with an error', async () => {
    const { runOcr } = await host()
    const pending = runOcr('pdf', Buffer.from('%PDF'))
    const child = await nextChild()
    child.emit('message', { type: 'error', code: 'ocr-cancelled', message: 'OCR was cancelled' })

    await expect(pending).rejects.toThrow(ConversionError)
    await pending.catch((err: ConversionError) => {
      expect(err.code).toBe('ocr-cancelled')
      expect(err.message).toBe('OCR was cancelled')
    })
    expect(child.kills).toBe(1)
  })

  it('keeps two concurrent requests on their own children and replies', async () => {
    const { runOcr } = await host()
    const a = runOcr('image', Buffer.from('A'))
    const b = runOcr('pdf', Buffer.from('B'))
    for (let i = 0; i < 50 && children.length < 2; i++) await Promise.resolve()
    expect(children).toHaveLength(2)
    const [childA, childB] = children

    // Reply out of order: B first, then A.
    childB.emit('message', { type: 'done', pages: PAGE_B })
    childA.emit('message', { type: 'done', pages: PAGE_A })

    await expect(b).resolves.toEqual(PAGE_B)
    await expect(a).resolves.toEqual(PAGE_A)
    // ...and a reply on one child must never settle the other's promise.
    expect((childA.posted[0] as { kind: string }).kind).toBe('image')
    expect((childB.posted[0] as { kind: string }).kind).toBe('pdf')
  })
})

describe('runOcr — child lifecycle', () => {
  it('rejects rather than hanging when the child exits without replying', async () => {
    const { runOcr } = await host()
    const pending = runOcr('pdf', Buffer.from('%PDF'))
    const child = await nextChild()
    child.emit('exit', 1)

    await expect(pending).rejects.toThrow(/exited unexpectedly \(code 1\)/)
    await pending.catch((err: ConversionError) => expect(err.code).toBe('ocr-failed'))
  })

  it('surfaces the child stderr line that explains the crash', async () => {
    const { runOcr } = await host()
    const pending = runOcr('pdf', Buffer.from('%PDF'))
    const child = await nextChild()
    child.stderr.emit('data', Buffer.from('some/stack/frame.js:12\nError: cannot find eng.traineddata\n    at x\n'))
    child.emit('exit', 1)

    await expect(pending).rejects.toThrow(/cannot find eng\.traineddata/)
  })

  it('rejects — and does not crash the main process — on a V8 fatal error from the child', async () => {
    const { runOcr } = await host()
    const pending = runOcr('pdf', Buffer.from('%PDF'))
    const child = await nextChild()

    // Electron's UtilityProcess emits 'error' for a non-continuable V8 error.
    // A UtilityProcess is a NodeEventEmitter, so if the host never listens for
    // 'error' this emit THROWS out of Electron's own dispatch and takes the
    // whole main process down with it.
    expect(() => child.emit('error', 'FatalError', 'ocr-entry.js:1', '<report>')).not.toThrow()

    await expect(pending).rejects.toThrow(ConversionError)
    await pending.catch((err: ConversionError) => {
      expect(err.code).toBe('ocr-failed')
      expect(err.message).toMatch(/FatalError/)
    })
    expect(child.kills).toBe(1)
  })

  it('ignores an exit that arrives after a successful reply', async () => {
    const { runOcr } = await host()
    const pending = runOcr('image', Buffer.from('A'))
    const child = await nextChild()
    child.emit('message', { type: 'done', pages: PAGE_A })
    await expect(pending).resolves.toEqual(PAGE_A)
    // kill() makes the child exit; that must not turn a success into a failure
    // or produce a second, unhandled settlement.
    expect(() => child.emit('exit', 0)).not.toThrow()
    await expect(pending).resolves.toEqual(PAGE_A)
  })
})

describe('runOcr — cancellation', () => {
  it('rejects without forking when the signal is already aborted', async () => {
    const { runOcr } = await host()
    const controller = new AbortController()
    controller.abort()
    await expect(runOcr('pdf', Buffer.from('%PDF'), { signal: controller.signal })).rejects.toThrow(
      /cancelled/i,
    )
    expect(forkCalls).toHaveLength(0)
  })

  it('kills a hung child and rejects when cancelled mid-request', async () => {
    const { runOcr } = await host()
    const controller = new AbortController()
    // This child never replies and never exits — the hang case.
    const pending = runOcr('pdf', Buffer.from('%PDF'), { signal: controller.signal })
    const child = await nextChild()
    expect(child.kills).toBe(0)

    controller.abort()

    await expect(pending).rejects.toThrow(ConversionError)
    await pending.catch((err: ConversionError) => expect(err.code).toBe('ocr-cancelled'))
    expect(child.kills).toBe(1)
  })

  it('does not re-settle when the signal aborts after the request finished', async () => {
    const { runOcr } = await host()
    const controller = new AbortController()
    const pending = runOcr('image', Buffer.from('A'), { signal: controller.signal })
    const child = await nextChild()
    child.emit('message', { type: 'done', pages: PAGE_A })
    await expect(pending).resolves.toEqual(PAGE_A)

    controller.abort()
    await expect(pending).resolves.toEqual(PAGE_A)
    // The child was killed once, on success — not again by the late abort.
    expect(child.kills).toBe(1)
  })

  // A settled request must let go of the signal. The signal belongs to the JOB,
  // not the request — one job can run several OCR calls — so a listener left
  // behind keeps the finished request's closure (child handle and its buffered
  // stderr) reachable for as long as the job lives.
  it.each([
    ['a successful reply', (c: FakeChild) => c.emit('message', { type: 'done', pages: PAGE_A })],
    ['an error reply', (c: FakeChild) => c.emit('message', { type: 'error', message: 'no' })],
    ['an unexpected exit', (c: FakeChild) => c.emit('exit', 1)],
    ['a V8 fatal error', (c: FakeChild) => c.emit('error', 'FatalError', 'x.js:1', '<report>')],
  ])('detaches its abort listener after %s', async (_label, finish) => {
    const { runOcr } = await host()
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = runOcr('pdf', Buffer.from('%PDF'), { signal: controller.signal }).catch(
      (err: Error) => err,
    )
    const child = await nextChild()
    finish(child)
    await pending

    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
