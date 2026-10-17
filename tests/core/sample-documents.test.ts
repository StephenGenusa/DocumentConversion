import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildSamples, SAMPLES_DIR } from '../../scripts/samples/build-samples.mjs'
import * as TEXT from '../../scripts/samples/sample-text.mjs'
import { readMarkdown } from '../../src/core/readers/md'
import { hubFeatures } from '../../src/core/rendered-blocks'

vi.mock('electron', () => ({}))
const { SAMPLES, readSample } = await import('../../src/main/samples')

type Built = { file: string; bytes: Buffer }

/*
 * The sample documents (Help → Sample Documents) are built by
 * scripts/samples/build-samples.mjs and committed under resources/samples.
 * The build must give the same bytes every run, at any time, and what is
 * committed must be what it builds now.
 */
describe('the sample documents', () => {
  it('build the same bytes every time, at any time', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-01T10:00:00Z'))
    const first: Built[] = buildSamples()
    vi.setSystemTime(new Date('2027-01-17T21:13:58Z'))
    const second: Built[] = buildSamples()
    vi.useRealTimers()
    expect(second.map((s) => s.file)).toEqual(first.map((s) => s.file))
    second.forEach((s, i) => expect(s.bytes.equals(first[i].bytes), s.file).toBe(true))
  })

  it('are committed as the generator builds them now', () => {
    const built: Built[] = buildSamples()
    expect(readdirSync(SAMPLES_DIR).sort()).toEqual(built.map((s) => s.file).sort())
    for (const s of built) expect(readFileSync(join(SAMPLES_DIR, s.file)).equals(s.bytes), `${s.file}: run node scripts/samples/build-samples.mjs`).toBe(true)
  })

  it('are the ones the menu offers, in its order and under its names', async () => {
    const order: string[] = TEXT.SAMPLE_ORDER
    const byId: Record<string, { file: string; menu: string }> = {
      engineering: TEXT.SAMPLE_ENGINEERING,
      software: TEXT.SAMPLE_SOFTWARE,
      lab: TEXT.SAMPLE_LAB,
      meeting: TEXT.SAMPLE_MEETING,
      architecture: TEXT.SAMPLE_ARCHITECTURE,
    }
    expect(SAMPLES.map((s) => s.id)).toEqual(order)
    for (const s of SAMPLES) {
      expect(s.file).toBe(byId[s.id].file)
      expect(s.menu).toBe(byId[s.id].menu)
    }
    const svg = await readSample('architecture', SAMPLES_DIR)
    expect(svg.filename).toBe('Architecture Diagram.svg')
    expect((await readSample('lab', SAMPLES_DIR)).filename).toBe('Lab Report.md')
  })

  it('hold the diagrams and formulas they are there to show', async () => {
    const read = async (file: string): Promise<string> => (await readMarkdown({ bytes: readFileSync(join(SAMPLES_DIR, file)), filename: file })).html
    const eng = await read(TEXT.SAMPLE_ENGINEERING.file)
    expect(eng).toContain('<code class="language-dot">')
    expect(eng).toMatch(/\\SI\{/)
    expect(eng).toContain('colspan="2"')
    expect(eng).toContain('<dl>')
    expect(eng).toMatch(/<img src="data:image\/svg\+xml;base64,/)
    const sw = await read(TEXT.SAMPLE_SOFTWARE.file)
    for (const kind of ['sequenceDiagram', 'classDiagram', 'stateDiagram-v2']) expect(sw).toContain(kind)
    for (const lang of ['python', 'typescript', 'sql', 'json', 'yaml']) expect(sw).toContain(`language-${lang}`)
    const lab = await read(TEXT.SAMPLE_LAB.file)
    expect(hubFeatures(lab)).toEqual({ diagrams: true, math: true })
    expect(lab).toContain('language-math math-display')
    expect(lab).toContain('\\newcommand{\\kobs}')
    expect(lab).toMatch(/<img src="data:image\/png;base64,/)
    const meeting = await read(TEXT.SAMPLE_MEETING.file)
    expect(meeting).toContain('gantt')
    expect(meeting).toContain('mindmap')
    expect(meeting).toContain('☐')
    // Every callout on the floor plan names an action item.
    for (const [i, label] of (TEXT.SAMPLE_MEETING.plan.callouts as string[]).entries()) expect(meeting).toContain(`${i + 1}. ${label}.`)
    // No place the generator was to fill is left.
    for (const html of [eng, sw, lab, meeting]) expect(html).not.toMatch(/\{\{[A-Z]/)
  })
})
