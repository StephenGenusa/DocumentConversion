import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readRtf } from '../../src/core/readers/rtf'
import { tableGrid } from '../../src/core/table-grid'

/**
 * SUPERSEDED (2026-08-31): this suite used to record "tables/lists degrade to
 * paragraphs" as the reader's fidelity and asserted the degraded text
 * `Stage | Owner`. @iarna/rtf-to-html still has no table model, but the reader
 * now segments `\trowd ... \cell ... \row` regions out of the RTF, parses them
 * itself and emits real <table> markup, so the hub carries the table through to
 * every writer instead of flattening it. The old expectations are kept below as
 * negative assertions — the " | " separator must NOT come back.
 *
 * Lists still degrade to paragraphs; that part of the recorded fidelity stands.
 */
describe('readRtf (paragraphs + inline formatting + real tables; lists still degrade)', () => {
  it('converts the WordPad fixture with formatting and a real table', async () => {
    const bytes = await readFile(join(__dirname, '../fixtures/sample.rtf'))
    const hub = await readRtf({ bytes, filename: 'sample.rtf' })
    expect(hub.html).toContain('Project Charter')
    expect(hub.html).toContain('<strong>conversion pipeline</strong>')
    expect(hub.html).toContain('<em>quality gates</em>')

    // Was: expect(hub.html).toContain('Stage | Owner') — the table is real now.
    expect(hub.html).toContain('<table')
    expect(tableGrid(hub.html)).toEqual([
      [
        ['Stage', 'Owner'],
        ['Readers', 'Alice'],
      ],
    ])
    expect(hub.html).not.toContain('Stage | Owner')
    expect(hub.html).not.toContain('Readers | Alice')
    // The bug the old " | " separator existed to prevent must stay prevented.
    expect(hub.html).not.toContain('StageOwner')
    expect(hub.html).not.toContain('ReadersAlice')
  })

  it('keeps the prose around the table in document order', async () => {
    const bytes = await readFile(join(__dirname, '../fixtures/sample.rtf'))
    const { html } = await readRtf({ bytes })
    expect(html).toContain('First checklist item')
    expect(html).toContain('Second checklist item')
    expect(html).toContain('End of charter.')
    expect(html.indexOf('conversion pipeline')).toBeLessThan(html.indexOf('<table'))
    expect(html.indexOf('<table')).toBeLessThan(html.indexOf('End of charter.'))
  })

  it('promotes large-font strong paragraphs to headings', async () => {
    const bytes = await readFile(join(__dirname, '../fixtures/sample.rtf'))
    const hub = await readRtf({ bytes })
    expect(hub.html).toMatch(/<h2>.*Project Charter.*<\/h2>/)
    expect(hub.title).toBe('Project Charter')
  })

  it('rejects non-rtf bytes with rtf-parse-failed', async () => {
    await expect(readRtf({ bytes: Buffer.from('not rtf at all') })).rejects.toMatchObject({
      code: 'rtf-parse-failed',
    })
  })
})
