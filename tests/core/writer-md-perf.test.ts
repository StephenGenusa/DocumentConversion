import { describe, it, expect } from 'vitest'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeHtml } from '../../src/core/writers/html'

function sheetHtml(rows: number): string {
  const parts = [
    '<h2>Sheet1</h2><table><thead><tr>',
    '<th>Item</th><th>Qty</th><th>Price</th><th>Region</th><th>Notes</th>',
    '</tr></thead><tbody>',
  ]
  for (let r = 0; r < rows; r++) {
    parts.push(
      `<tr><td>Item ${r}</td><td>${r}</td><td>${r * 1.5}</td><td>Region ${r % 7}</td><td>note text ${r} here</td></tr>`,
    )
  }
  parts.push('</tbody></table>')
  return parts.join('')
}

async function bestOf3(fn: () => Promise<unknown>): Promise<number> {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    await fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe('writeMarkdown performance', () => {
  /**
   * turndown builds its output by repeatedly re-flattening the accumulated
   * string (`join` indexes into it character by character), so handing it a
   * whole spreadsheet was quadratic in the output size: a 20k-row sheet took
   * ~8s and 60k rows took ~20s, against ~5ms for the same content to html.
   * The writer renders pipe tables itself now and only hands turndown the
   * prose around them, which is linear.
   */
  it('converts a 20k-row sheet in well under the old quadratic time', async () => {
    const html = sheetHtml(20_000)
    const best = await bestOf3(() => writeMarkdown({ html }))
    // Pre-fix: ~8000 ms. Post-fix: a few hundred ms. The budget is deliberately
    // loose so a machine running other test suites in parallel does not flake.
    expect(best).toBeLessThan(3000)
  }, 300_000)

  /**
   * Quadratic cost shows up as the per-row cost rising with the row count.
   * 4x the rows must not cost more than 8x the time.
   */
  it('scales close to linearly with row count', async () => {
    const small = await bestOf3(() => writeMarkdown({ html: sheetHtml(4_000) }))
    const large = await bestOf3(() => writeMarkdown({ html: sheetHtml(16_000) }))
    expect(large).toBeLessThan(small * 8)
  }, 300_000)

  /**
   * The html writer is the "same content, no turndown" control.
   *
   * The denominator is the fragile half: writeHtml finishes in single-digit
   * milliseconds, so it is measured against the timer's own resolution, and
   * the `Math.max(..., 1)` floor means a fast machine can report 1ms and swing
   * the ratio several-fold on its own. Averaging the control over enough
   * iterations to take real time removes that, and the bound stays far below
   * the ~1600x this measured before the fix (8s against 5ms) while leaving
   * room for a machine running other suites in parallel — an earlier 400
   * flaked at 459 for exactly that reason, with nothing wrong with the code.
   */
  it('stays within a small multiple of the html writer', async () => {
    const html = sheetHtml(20_000)
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) await writeHtml({ html })
    const htmlMs = (performance.now() - t0) / 20
    const mdMs = await bestOf3(() => writeMarkdown({ html }))
    expect(mdMs / htmlMs).toBeLessThan(800)
  }, 300_000)
})
