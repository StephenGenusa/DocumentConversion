import { describe, it, expect } from 'vitest'
import { readRtf, segmentTables, extractTables } from '../../src/core/readers/rtf'

const doc = (body: string): { bytes: Buffer } => ({
  bytes: Buffer.from(String.raw`{\rtf1\ansi ${body}}`, 'latin1'),
})

const TABLE = String.raw`\trowd\cellx2000\cellx4000 Alpha\cell Beta\cell\row `

/**
 * The table pre-pass is wrapped in a catch so a latent bug costs only a
 * document's table structure, never the whole document. That fallback is
 * deliberate. What was wrong is that it caught EVERYTHING, including faults
 * that mean this reader is broken rather than that the input is unreadable.
 *
 * Not hypothetical: it is exactly how R9 reached the independent review. A
 * `\toString` control word made SYMBOL_WORDS return a function, `.trim()` threw
 * a TypeError, this catch ate it, and every table in the document silently
 * became prose with no error anywhere. A loud crash became invisible data
 * degradation.
 *
 * Note extractTables never throws deliberately — a region it cannot read
 * confidently is left in the stream, not reported — so in practice every throw
 * out of it is a bug here.
 */
describe('rtf table pre-pass error handling', () => {
  it('renders a table when nothing goes wrong', async () => {
    const { html } = await readRtf(doc(TABLE))
    expect(html).toContain('<table')
    expect(html).toContain('Alpha')
  })

  it('leaves a region it cannot read in the stream rather than throwing', () => {
    // The documented contract: declining is a return value, not an exception.
    const orphan = String.raw`\trowd\cellx2000 Orphan\cell `
    expect(() => extractTables(orphan)).not.toThrow()
    expect(extractTables(orphan).tables).toEqual([])
  })

  it('rethrows a programming error instead of swallowing it', () => {
    expect(() =>
      segmentTables('x', () => {
        throw new TypeError('cw.trim is not a function')
      }),
    ).toThrow(TypeError)

    expect(() =>
      segmentTables('x', () => {
        throw new RangeError('Invalid array length')
      }),
    ).toThrow(RangeError)
  })

  it('still falls back to prose for any other fault', () => {
    const out = segmentTables('body text', () => {
      throw new Error('some region was unreadable')
    })
    // The document survives, tables dropped — the behaviour worth keeping.
    expect(out).toEqual({ rtf: 'body text', tables: [] })
  })

  it('passes the real extractor through untouched by default', () => {
    expect(segmentTables(TABLE)).toEqual(extractTables(TABLE))
  })
})
