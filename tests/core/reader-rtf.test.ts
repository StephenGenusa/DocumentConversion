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

/**
 * Word writes character formatting as groups, `{\b bold}`, not as toggles
 * (`\b bold\b0`). rtf-parser restyled every span with its PARENT group's style
 * when the group closed, so all of it was lost: bold, italic, underline,
 * superscript. The fixture above uses toggles, which is why this went unseen.
 */
describe('readRtf keeps formatting set inside a group', () => {
  it('keeps bold, italic and underline from {\\b …} groups', async () => {
    const rtf = '{\\rtf1\\ansi plain {\\b bold} {\\i italic} {\\ul under} {\\b\\i both} after\\par}'
    const html = (await readRtf({ bytes: Buffer.from(rtf), filename: 'g.rtf' })).html
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<u>under</u>')
    expect(html).toMatch(/<(em|strong)><(em|strong)>both<\/(em|strong)><\/(em|strong)>/)
    expect(html).toMatch(/after/)
    expect(html).not.toContain('<strong>plain')
    expect(html).not.toContain('after</strong>')
  })

  it('keeps nested groups, and lets the outer formatting resume after them', async () => {
    const rtf = '{\\rtf1\\ansi {\\b outer {\\i inner} again} done\\par}'
    const html = (await readRtf({ bytes: Buffer.from(rtf), filename: 'g.rtf' })).html
    expect(html).toContain('<strong>outer </strong>')
    expect(html).toMatch(/<em><strong>inner<\/strong><\/em>|<strong><em>inner<\/em><\/strong>/)
    expect(html).toContain('<strong> again</strong>')
    expect(html).not.toContain('<strong> done')
  })
})

/**
 * rtf-parser collects a paragraph's spans when it meets `\par`, so text after
 * the last one was never collected: a file that does not end in `\par` lost
 * its last paragraph, and a one-line file lost everything.
 */
describe('readRtf keeps a last paragraph with no closing \\par', () => {
  it('keeps the text after the last \\par', async () => {
    const rtf = '{\\rtf1\\ansi First line\\par Last {\\b line}}'
    const html = (await readRtf({ bytes: Buffer.from(rtf), filename: 'g.rtf' })).html
    expect(html).toContain('<p>First line</p>')
    expect(html).toMatch(/<p>Last <strong>line<\/strong><\/p>/)
  })

  it('keeps a file that has no \\par at all', async () => {
    const html = (await readRtf({ bytes: Buffer.from('{\\rtf1 Only words}'), filename: 'g.rtf' })).html
    expect(html).toContain('<p>Only words</p>')
  })
})
