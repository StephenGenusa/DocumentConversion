import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import type { HubDocument, ReadContext, SourceInput } from '../../src/core/types'

// Loading src/main pulls in every reader and writer; on a loaded machine that
// alone can outrun the 5s default before a test body starts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 60_000 })

/**
 * Cancel mid-conversion.
 *
 * Nothing here fakes the conversion: the real txt reader and the real md/html
 * writers run. The only thing injected is a *gate* in front of one reader, so
 * a conversion can be held at a known point and cancelled there deterministically
 * — the same shape as a slow PDF or a large workbook, without the seconds.
 */
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => { throw new Error('OCR is not on the path under test') } },
}))

interface Gate {
  /** Resolves once the gated reader has been entered. */
  entered: Promise<void>
  markEntered: () => void
  /** The gated reader waits on this before doing any real work. */
  held: Promise<void>
  release: () => void
  /** Make the gated read fail after release, to model a reader that dies late. */
  failAfterRelease: boolean
  /**
   * Run just before the gated reader RETURNS, so the abort lands as the read
   * completes rather than while it is held. There is no true async gap between
   * read and write to land in — the code between them is synchronous — so this
   * is as late as an abort can arrive and still be "during the read".
   */
  beforeReturn?: () => void
  reads: string[]
}

function makeGate(): Gate {
  let markEntered = (): void => {}
  let release = (): void => {}
  const entered = new Promise<void>((r) => (markEntered = r))
  const held = new Promise<void>((r) => (release = r))
  return { entered, markEntered, held, release, failAfterRelease: false, reads: [] }
}

let gate = makeGate()

vi.mock('../../src/core/readers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/readers')>()
  return {
    ...actual,
    getReader: (format: string) => {
      const real = actual.getReader(format as never)
      if (format !== 'txt') return real
      return async (src: SourceInput, ctx?: ReadContext): Promise<HubDocument> => {
        gate.reads.push(src.filename ?? '(unnamed)')
        gate.markEntered()
        await gate.held
        if (gate.failAfterRelease) throw new Error('reader died after the caller walked away')
        const hub = await real(src, ctx)
        gate.beforeReturn?.()
        return hub
      }
    },
  }
})

type Conversion = typeof import('../../src/main/conversion')
async function conversion(): Promise<Conversion> {
  return import('../../src/main/conversion')
}

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => void unhandled.push(reason)

// Load the module graph before the first test, so its cost is not charged to
// that test's timeout when the whole suite runs in parallel.
beforeAll(async () => {
  gate.release()
  await conversion()
})

beforeEach(() => {
  gate = makeGate()
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
})

const TXT = Buffer.from('One paragraph.\n\nAnother paragraph.\n', 'utf8')

describe('runConversion cancellation', () => {
  it('converts normally when nothing cancels it', async () => {
    const { runConversion } = await conversion()
    gate.release()
    const out = await runConversion(TXT, 'a.txt', 'txt', 'md', {}, {})
    expect(out.parts[0].bytes.toString('utf8')).toContain('One paragraph.')
  })

  it('rejects while the reader is still blocked, instead of waiting it out', async () => {
    const { runConversion } = await conversion()
    const controller = new AbortController()
    const pending = runConversion(TXT, 'a.txt', 'txt', 'md', {}, { signal: controller.signal })
    await gate.entered

    controller.abort()

    // The gate is deliberately NEVER released: if cancellation only took effect
    // after the read returned, this would hang until the test timed out.
    await expect(pending).rejects.toThrow(/cancel/i)
    await pending.catch((err: { code?: string }) => expect(err.code).toBe('cancelled'))
  })

  it('produces no output when cancelled: it rejects rather than resolving with a WriteResult', async () => {
    const { runConversion } = await conversion()
    const controller = new AbortController()
    const pending = runConversion(TXT, 'a.txt', 'txt', 'html', {}, { signal: controller.signal })
    await gate.entered
    controller.abort()

    const settled = await pending.then(
      (value) => ({ kind: 'resolved' as const, value }),
      (err: Error) => ({ kind: 'rejected' as const, err }),
    )
    expect(settled.kind).toBe('rejected')
  })

  it('rejects when the abort lands as the read completes', async () => {
    const { runConversion } = await conversion()
    const controller = new AbortController()
    gate.beforeReturn = () => controller.abort()
    gate.release()
    await expect(runConversion(TXT, 'a.txt', 'txt', 'md', {}, { signal: controller.signal })).rejects.toThrow(/cancel/i)
  })

  it('never starts reading when the signal is already aborted', async () => {
    const { runConversion } = await conversion()
    const controller = new AbortController()
    controller.abort()
    await expect(runConversion(TXT, 'a.txt', 'txt', 'md', {}, { signal: controller.signal })).rejects.toThrow(
      /cancel/i,
    )
    expect(gate.reads).toHaveLength(0)
  })

  it('cancels the pdf-to-pdf copy path too, before it touches the bytes', async () => {
    const { runConversion } = await conversion()
    const controller = new AbortController()
    controller.abort()
    // Not a real PDF: if the fast path ran at all, pdf-lib would fail with a
    // parse error rather than a cancellation.
    await expect(
      runConversion(Buffer.from('not a pdf'), 'a.pdf', 'pdf', 'pdf', {}, { signal: controller.signal }),
    ).rejects.toThrow(/cancel/i)
  })

  it('does not raise an unhandled rejection when the abandoned read fails later', async () => {
    const { runConversion } = await conversion()
    gate.failAfterRelease = true
    const controller = new AbortController()
    const pending = runConversion(TXT, 'a.txt', 'txt', 'md', {}, { signal: controller.signal })
    await gate.entered
    controller.abort()
    await expect(pending).rejects.toThrow(/cancel/i)

    // The caller has walked away, but the read is still running; when it fails
    // there is no longer anyone awaiting it.
    gate.release()
    await new Promise((r) => setTimeout(r, 50))
    expect(unhandled).toEqual([])
  })
})

/**
 * "Copy as HTML" wants two clipboard flavours, rich and plain. It used to run
 * two whole conversions to get them — the second with an EMPTY context, so a
 * cancel during it was ignored, the clipboard was overwritten, and the reply
 * said "copied". One read, two writes, one signal.
 */
describe('clipboardFlavors', () => {
  it('reads the source once', async () => {
    const { clipboardFlavors } = await conversion()
    gate.release()
    const out = await clipboardFlavors(TXT, 'a.txt', 'txt', {}, {})
    expect(out.html).toContain('<p>One paragraph.</p>')
    expect(out.text).toContain('One paragraph.')
    expect(out.text).not.toContain('<p>')
    expect(gate.reads).toEqual(['a.txt'])
  })

  it('rejects while the read is blocked', async () => {
    const { clipboardFlavors } = await conversion()
    const controller = new AbortController()
    const pending = clipboardFlavors(TXT, 'a.txt', 'txt', {}, { signal: controller.signal })
    await gate.entered
    controller.abort()
    await expect(pending).rejects.toThrow(/cancel/i)
  })

  it('rejects when the abort lands as the read completes', async () => {
    const { clipboardFlavors } = await conversion()
    const controller = new AbortController()
    gate.beforeReturn = () => controller.abort()
    gate.release()
    // The old code ran the second (txt) conversion with an empty context, so a
    // cancel arriving this late was ignored and the clipboard overwritten.
    await expect(clipboardFlavors(TXT, 'a.txt', 'txt', {}, { signal: controller.signal })).rejects.toThrow(/cancel/i)
  })
})

describe('readForConversion cancellation', () => {
  it('rejects a blocked read once the signal aborts', async () => {
    const { readForConversion } = await conversion()
    const controller = new AbortController()
    const pending = readForConversion(TXT, 'a.txt', 'txt', false, { signal: controller.signal })
    await gate.entered
    controller.abort()
    await expect(pending).rejects.toThrow(/cancel/i)
  })

  it('reads normally without a signal', async () => {
    const { readForConversion } = await conversion()
    gate.release()
    const hub = await readForConversion(TXT, 'a.txt', 'txt', false, {})
    expect(hub.html).toContain('One paragraph.')
    expect(hub.sourceName).toBe('a.txt')
  })
})
