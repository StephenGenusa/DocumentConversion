import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Loading src/main pulls in every reader and writer; on a loaded machine that
// alone can outrun the 5s default before a test body starts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 60_000 })

/**
 * Batch orchestration: the loop behind `app:convert-batch`.
 *
 * Everything is real except Electron itself — a real temp output directory, the
 * real converter, real files on disk. What is asserted is what a user would see
 * afterwards: which files exist, what is in them, what the results table says.
 */
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => { throw new Error('OCR is not on the path under test') } },
}))

type Jobs = typeof import('../../src/main/jobs')
type Conversion = typeof import('../../src/main/conversion')

async function mods(): Promise<{ jobs: Jobs; conversion: Conversion }> {
  return { jobs: await import('../../src/main/jobs'), conversion: await import('../../src/main/conversion') }
}

let outDir = ''

// Load the module graph before the first test, so its cost is not charged to
// that test's timeout when the whole suite runs in parallel.
beforeAll(async () => {
  await mods()
})

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'docconv-batch-'))
})

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true })
})

function txt(name: string, body: string): { bytes: Buffer; filename: string; source: 'txt'; ocr: boolean } {
  return { bytes: Buffer.from(body, 'utf8'), filename: name, source: 'txt', ocr: false }
}

describe('runBatch', () => {
  it('converts every input in sequence and writes one output file each', async () => {
    const { jobs, conversion } = await mods()
    const rows = await jobs.runBatch(
      [txt('a.txt', 'Alpha body'), txt('b.txt', 'Beta body'), txt('c.txt', 'Gamma body')],
      'md',
      outDir,
      {},
      (input, ctx) => conversion.runConversion(input.bytes, input.filename, input.source, 'md', {}, ctx),
    )

    expect(rows.map((r) => [r.filename, r.status])).toEqual([
      ['a.txt', 'saved'],
      ['b.txt', 'saved'],
      ['c.txt', 'saved'],
    ])
    expect((await readdir(outDir)).sort()).toEqual(['a.md', 'b.md', 'c.md'])
    expect(await readFile(join(outDir, 'b.md'), 'utf8')).toContain('Beta body')
    expect(rows[0].path).toBe(join(outDir, 'a.md'))
  })

  it('reports progress per file, naming the file and its position', async () => {
    const { jobs, conversion } = await mods()
    const seen: [string, number | undefined][] = []
    await jobs.runBatch(
      [txt('a.txt', 'A'), txt('b.txt', 'B'), txt('c.txt', 'C')],
      'md',
      outDir,
      { onProgress: (stage, percent) => seen.push([stage, percent]) },
      (input, ctx) => conversion.runConversion(input.bytes, input.filename, input.source, 'md', {}, ctx),
    )
    expect(seen).toEqual([
      ['Converting a.txt (1 of 3)', (0 / 3) * 100],
      ['Converting b.txt (2 of 3)', (1 / 3) * 100],
      ['Converting c.txt (3 of 3)', (2 / 3) * 100],
    ])
  })

  it('names an input with no filename by its position', async () => {
    const { jobs, conversion } = await mods()
    const rows = await jobs.runBatch(
      [{ bytes: Buffer.from('A', 'utf8'), source: 'txt', ocr: false }],
      'md',
      outDir,
      {},
      (input, ctx) => conversion.runConversion(input.bytes, input.filename, input.source, 'md', {}, ctx),
    )
    expect(rows[0].filename).toBe('document-1')
    expect(await readdir(outDir)).toEqual(['document.md'])
  })

  it('keeps going after one input fails, and records why', async () => {
    const { jobs, conversion } = await mods()
    const bad = { bytes: Buffer.from('{}'), filename: 'b.json', source: 'json' as const, ocr: false }
    const rows = await jobs.runBatch(
      [txt('a.txt', 'Alpha'), bad, txt('c.txt', 'Gamma')],
      'md',
      outDir,
      {},
      (input, ctx) => conversion.runConversion(input.bytes, input.filename, input.source, 'md', {}, ctx),
    )

    expect(rows.map((r) => r.status)).toEqual(['saved', 'error', 'saved'])
    expect(rows[1].message).toBeTruthy()
    expect(rows[1].path).toBeUndefined()
    // The failure costs one file, not the batch.
    expect((await readdir(outDir)).sort()).toEqual(['a.md', 'c.md'])
  })

  it('never overwrites: an existing output and a repeated input name both get a suffix', async () => {
    const { jobs, conversion } = await mods()
    await writeFile(join(outDir, 'a.md'), 'PRE-EXISTING', 'utf8')
    const rows = await jobs.runBatch(
      [txt('a.txt', 'First body'), txt('a.txt', 'Second body')],
      'md',
      outDir,
      {},
      (input, ctx) => conversion.runConversion(input.bytes, input.filename, input.source, 'md', {}, ctx),
    )

    expect(rows.every((r) => r.status === 'saved')).toBe(true)
    expect((await readdir(outDir)).sort()).toEqual(['a-1.md', 'a-2.md', 'a.md'])
    expect(await readFile(join(outDir, 'a.md'), 'utf8')).toBe('PRE-EXISTING')
    expect(await readFile(join(outDir, 'a-1.md'), 'utf8')).toContain('First body')
    expect(await readFile(join(outDir, 'a-2.md'), 'utf8')).toContain('Second body')
    expect(rows[0].path).toBe(join(outDir, 'a-1.md'))
  })

  it('writes every part of a multi-part result and reports the first', async () => {
    const { jobs, conversion } = await mods()
    const twoTables = Buffer.from(
      '<table><tr><td>a1</td><td>a2</td></tr></table><p>gap</p><table><tr><td>b1</td><td>b2</td></tr></table>',
      'utf8',
    )
    const rows = await jobs.runBatch(
      [{ bytes: twoTables, filename: 'sheet.html', source: 'html', ocr: false }],
      'csv',
      outDir,
      {},
      (input, ctx) => conversion.runConversion(input.bytes, input.filename, input.source, 'csv', {}, ctx),
    )

    expect(rows[0].status).toBe('saved')
    expect((await readdir(outDir)).sort()).toEqual(['sheet.table-1.csv', 'sheet.table-2.csv'])
    expect(rows[0].path).toBe(join(outDir, 'sheet.table-1.csv'))
  })

  it('returns no rows for an empty batch', async () => {
    const { jobs, conversion } = await mods()
    const rows = await jobs.runBatch([], 'md', outDir, {}, (input, ctx) =>
      conversion.runConversion(input.bytes, input.filename, input.source, 'md', {}, ctx),
    )
    expect(rows).toEqual([])
  })
})

describe('runBatch cancellation', () => {
  it('leaves no output for the cancelled file or the ones after it', async () => {
    const { jobs, conversion } = await mods()
    const controller = new AbortController()
    const rows = await jobs.runBatch(
      [txt('a.txt', 'Alpha'), txt('b.txt', 'Beta'), txt('c.txt', 'Gamma')],
      'md',
      outDir,
      {
        signal: controller.signal,
        // Cancel exactly as b is picked up: it has been announced to the user
        // and not yet converted — the moment a real Cancel click lands.
        onProgress: (stage) => {
          if (stage.startsWith('Converting b.txt')) controller.abort()
        },
      },
      (input, ctx) => conversion.runConversion(input.bytes, input.filename, input.source, 'md', {}, ctx),
    )

    expect(rows.map((r) => [r.filename, r.status])).toEqual([
      ['a.txt', 'saved'],
      ['b.txt', 'cancelled'],
      ['c.txt', 'cancelled'],
    ])
    // The in-flight conversion is discarded, not written half-way.
    expect(await readdir(outDir)).toEqual(['a.md'])
    // A cancelled row is not an error row: it carries no message to show.
    expect(rows[1].message).toBeUndefined()
    expect(rows[2].message).toBeUndefined()
  })

  it('marks every file cancelled when the batch is cancelled before it starts', async () => {
    const { jobs, conversion } = await mods()
    const controller = new AbortController()
    controller.abort()
    const rows = await jobs.runBatch(
      [txt('a.txt', 'Alpha'), txt('b.txt', 'Beta')],
      'md',
      outDir,
      { signal: controller.signal },
      (input, ctx) => conversion.runConversion(input.bytes, input.filename, input.source, 'md', {}, ctx),
    )
    expect(rows.map((r) => r.status)).toEqual(['cancelled', 'cancelled'])
    expect(await readdir(outDir)).toEqual([])
  })
})

describe('job registry', () => {
  it('hands out a live signal and aborts it by id', async () => {
    const { jobs } = await mods()
    const signal = jobs.createJob('job-1')
    expect(signal.aborted).toBe(false)
    jobs.cancelJob('job-1')
    expect(signal.aborted).toBe(true)
  })

  it('keeps jobs independent', async () => {
    const { jobs } = await mods()
    const a = jobs.createJob('job-a')
    const b = jobs.createJob('job-b')
    jobs.cancelJob('job-a')
    expect(a.aborted).toBe(true)
    expect(b.aborted).toBe(false)
  })

  it('ignores a cancel for an unknown or already-finished job', async () => {
    const { jobs } = await mods()
    expect(() => jobs.cancelJob('never-existed')).not.toThrow()
    const signal = jobs.createJob('job-done')
    jobs.finishJob('job-done')
    // The renderer can send Cancel after the reply has already gone out.
    expect(() => jobs.cancelJob('job-done')).not.toThrow()
    expect(signal.aborted).toBe(false)
  })
})
