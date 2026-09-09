import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { HubDocument, ReadContext, SourceInput } from '../../src/core/types'
import type { MergeItem } from '../../src/main/conversion'

// Loading src/main pulls in every reader and writer; on a loaded machine that
// alone can outrun the 5s default before a test body starts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 60_000 })

/**
 * `mergeToTarget` — the merge orchestration in the main process, as opposed to
 * `mergeHubDocuments`, the pure concatenation it delegates to (covered in
 * tests/core/merge.test.ts).
 *
 * Real readers, real writers, real pdf-lib. Electron is stubbed because merging
 * TO pdf from pdf inputs never renders anything, and the non-pdf targets never
 * touch a BrowserWindow.
 */
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => { throw new Error('OCR is not on the path under test') } },
}))

/** A gate in front of the txt reader, so a merge can be stopped mid-way. */
interface Gate {
  entered: Promise<void>
  markEntered: () => void
  held: Promise<void>
  release: () => void
  reads: string[]
}

function makeGate(): Gate {
  let markEntered = (): void => {}
  let release = (): void => {}
  const entered = new Promise<void>((r) => (markEntered = r))
  const held = new Promise<void>((r) => (release = r))
  return { entered, markEntered, held, release, reads: [] }
}

let gate = makeGate()
/** Which read number the gate holds on; Infinity means "never hold". */
let holdAtRead = Infinity

vi.mock('../../src/core/readers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/readers')>()
  return {
    ...actual,
    getReader: (format: string) => {
      const real = actual.getReader(format as never)
      if (format !== 'txt') return real
      return async (src: SourceInput, ctx?: ReadContext): Promise<HubDocument> => {
        gate.reads.push(src.filename ?? '(unnamed)')
        if (gate.reads.length === holdAtRead) {
          gate.markEntered()
          await gate.held
        }
        return real(src, ctx)
      }
    },
  }
})

type Conversion = typeof import('../../src/main/conversion')
async function conversion(): Promise<Conversion> {
  return import('../../src/main/conversion')
}

// Load the module graph before the first test, so its cost is not charged to
// that test's timeout when the whole suite runs in parallel.
beforeAll(async () => {
  await conversion()
})

beforeEach(() => {
  gate = makeGate()
  holdAtRead = Infinity
})

function txtItem(name: string, body: string): MergeItem {
  return { bytes: Buffer.from(body, 'utf8'), filename: name, source: 'txt', ocr: false }
}

async function textPdf(text: string, pages = 1): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    pdf.addPage([300, 200]).drawText(`${text} p${i + 1}`, { x: 30, y: 100, size: 14, font })
  }
  return Buffer.from(await pdf.save())
}

describe('mergeToTarget — document targets', () => {
  it('reads every input in order and concatenates them into one document', async () => {
    const { mergeToTarget } = await conversion()
    const out = await mergeToTarget(
      [txtItem('a.txt', 'Alpha body'), txtItem('b.txt', 'Beta body'), txtItem('c.txt', 'Gamma body')],
      'html',
      {},
      false,
      {},
    )
    const html = out.parts[0].bytes.toString('utf8')
    expect(gate.reads).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(html.indexOf('Alpha body')).toBeLessThan(html.indexOf('Beta body'))
    expect(html.indexOf('Beta body')).toBeLessThan(html.indexOf('Gamma body'))
  })

  it('reports per-file progress naming the file and its position', async () => {
    const { mergeToTarget } = await conversion()
    const stages: string[] = []
    await mergeToTarget([txtItem('a.txt', 'A'), txtItem('b.txt', 'B')], 'md', {}, false, {
      onProgress: (stage) => stages.push(stage),
    })
    expect(stages).toEqual(['Reading a.txt (1 of 2)', 'Reading b.txt (2 of 2)'])
  })

  it('falls back to a positional name when an input has no filename', async () => {
    const { mergeToTarget } = await conversion()
    const stages: string[] = []
    await mergeToTarget(
      [{ bytes: Buffer.from('A', 'utf8'), source: 'txt', ocr: false }],
      'md',
      {},
      false,
      { onProgress: (stage) => stages.push(stage) },
    )
    expect(stages).toEqual(['Reading document 1 (1 of 1)'])
  })

  it('adds a source heading per fragment when headings are on', async () => {
    const { mergeToTarget } = await conversion()
    const out = await mergeToTarget([txtItem('a.txt', 'A'), txtItem('b.txt', 'B')], 'html', {}, true, {})
    const html = out.parts[0].bytes.toString('utf8')
    expect(html).toContain('a.txt')
    expect(html).toContain('b.txt')
  })

  it('refuses an empty merge', async () => {
    const { mergeToTarget } = await conversion()
    await expect(mergeToTarget([], 'md', {}, false, {})).rejects.toThrow(/Nothing to merge/)
    await mergeToTarget([], 'md', {}, false, {}).catch((e: { code: string }) =>
      expect(e.code).toBe('merge-empty'),
    )
  })

  it('fails the whole merge — with no partial document — when one input cannot be read', async () => {
    const { mergeToTarget } = await conversion()
    const bad: MergeItem = { bytes: Buffer.from('{}'), filename: 'b.json', source: 'json', ocr: false }
    const settled = await mergeToTarget([txtItem('a.txt', 'A'), bad, txtItem('c.txt', 'C')], 'md', {}, false, {})
      .then((value) => ({ kind: 'resolved' as const, value }))
      .catch((err: { code?: string; message: string }) => ({ kind: 'rejected' as const, err }))

    expect(settled.kind).toBe('rejected')
    if (settled.kind === 'rejected') expect(settled.err.code).toBe('read-failed')
    // A merge is one document: it stops at the bad input rather than quietly
    // producing a shorter one.
    expect(gate.reads).toEqual(['a.txt'])
  })
})

describe('mergeToTarget — pdf target', () => {
  it('passes pdf inputs through page-for-page and reports them as added, not rendered', async () => {
    const { mergeToTarget } = await conversion()
    const stages: string[] = []
    const items: MergeItem[] = [
      { bytes: await textPdf('alpha', 2), filename: 'a.pdf', source: 'pdf', ocr: false },
      { bytes: await textPdf('beta', 1), filename: 'b.pdf', source: 'pdf', ocr: false },
    ]
    const out = await mergeToTarget(items, 'pdf', {}, false, { onProgress: (s) => stages.push(s) })

    expect(stages).toEqual(['Adding a.pdf (1 of 2)', 'Adding b.pdf (2 of 2)'])
    const merged = await PDFDocument.load(out.parts[0].bytes)
    expect(merged.getPageCount()).toBe(3)
    // No reader ran: a scanned PDF must merge without ever being interpreted.
    expect(gate.reads).toEqual([])
  })

  it('names the offending input when a pdf in the merge is corrupt', async () => {
    const { mergeToTarget } = await conversion()
    await expect(
      mergeToTarget(
        [
          { bytes: await textPdf('alpha'), filename: 'a.pdf', source: 'pdf', ocr: false },
          { bytes: Buffer.from('not a pdf'), filename: 'broken.pdf', source: 'pdf', ocr: false },
        ],
        'pdf',
        {},
        false,
        {},
      ),
    ).rejects.toThrow(/broken\.pdf/)
  })
})

describe('mergeToTarget — cancellation', () => {
  it('stops mid-merge and produces nothing when the job is cancelled', async () => {
    const { mergeToTarget } = await conversion()
    holdAtRead = 2
    const controller = new AbortController()
    const pending = mergeToTarget(
      [txtItem('a.txt', 'A'), txtItem('b.txt', 'B'), txtItem('c.txt', 'C')],
      'md',
      {},
      false,
      { signal: controller.signal },
    )
    await gate.entered
    controller.abort()

    await expect(pending).rejects.toThrow(/cancel/i)
    await pending.catch((err: { code?: string }) => expect(err.code).toBe('cancelled'))
    // The third input was never even started.
    expect(gate.reads).toEqual(['a.txt', 'b.txt'])
  })

  it('does not begin a merge whose signal is already aborted', async () => {
    const { mergeToTarget } = await conversion()
    const controller = new AbortController()
    controller.abort()
    await expect(
      mergeToTarget([txtItem('a.txt', 'A')], 'md', {}, false, { signal: controller.signal }),
    ).rejects.toThrow(/cancel/i)
    expect(gate.reads).toEqual([])
  })

  it('cancels a pdf merge between its inputs', async () => {
    const { mergeToTarget } = await conversion()
    const controller = new AbortController()
    const stages: string[] = []
    const items: MergeItem[] = [
      { bytes: await textPdf('alpha'), filename: 'a.pdf', source: 'pdf', ocr: false },
      { bytes: await textPdf('beta'), filename: 'b.pdf', source: 'pdf', ocr: false },
    ]
    await expect(
      mergeToTarget(items, 'pdf', {}, false, {
        signal: controller.signal,
        onProgress: (s) => {
          stages.push(s)
          if (s.startsWith('Adding a.pdf')) controller.abort()
        },
      }),
    ).rejects.toThrow(/cancel/i)
    expect(stages).toEqual(['Adding a.pdf (1 of 2)'])
  })
})
