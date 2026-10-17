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

/**
 * The best time of each job over `rounds`, the jobs taken in turn within a
 * round, after one untimed warm-up of each.
 *
 * These tests compare two timings, never one against a fixed budget: other
 * suites running at once slow everything, and an absolute "under 3 s" (or
 * a small and a large run timed one after the other, a burst of load landing
 * on only one of them) is what made this file flaky. Interleaved, a slow
 * spell lands on both sides of the ratio; the best of several drops the
 * rounds a burst landed in.
 */
async function bestInTurn(jobs: Array<() => Promise<unknown>>, rounds = 5): Promise<number[]> {
  for (const job of jobs) await job()
  const best = jobs.map(() => Infinity)
  for (let r = 0; r < rounds; r++) {
    for (let j = 0; j < jobs.length; j++) {
      const t0 = performance.now()
      await jobs[j]()
      best[j] = Math.min(best[j], performance.now() - t0)
    }
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
   *
   * Quadratic cost shows up as the time rising with the square of the row
   * count. Four 4k-row sheets are timed against one 16k-row sheet: the same
   * rows, so the same time when the cost is linear and four times it when
   * quadratic. The bound, 2x, sits between the two. Both sides doing the same
   * work for the same time is what keeps load from favoring either: a short
   * run is likelier to fit in a quiet moment than a long one.
   */
  it('scales close to linearly with row count', async () => {
    const small = sheetHtml(4_000)
    const large = sheetHtml(16_000)
    const [smallMs, largeMs] = await bestInTurn([
      async () => {
        for (let i = 0; i < 4; i++) await writeMarkdown({ html: small })
      },
      () => writeMarkdown({ html: large }),
    ])
    expect(largeMs / smallMs, `16k rows ${largeMs.toFixed(0)} ms, 4 x 4k rows ${smallMs.toFixed(0)} ms`).toBeLessThan(2)
  }, 300_000)

  /**
   * The html writer is the "same content, no turndown" control: a constant
   * slowdown the scaling test cannot see. It finishes in single-digit
   * milliseconds, so each of its timings is the average of 20 runs, well
   * clear of the timer's resolution. The bound stays far below the ~1600x
   * this measured before the fix (8s against 5ms).
   */
  it('stays within a small multiple of the html writer', async () => {
    const html = sheetHtml(20_000)
    const [htmlMs, mdMs] = await bestInTurn([
      async () => {
        for (let i = 0; i < 20; i++) await writeHtml({ html })
      },
      () => writeMarkdown({ html }),
    ])
    expect(mdMs / (htmlMs / 20), `md ${mdMs.toFixed(0)} ms, html ${(htmlMs / 20).toFixed(1)} ms`).toBeLessThan(800)
  }, 300_000)

  /**
   * A table put back where its placeholder was, in a document holding a
   * picture: the picture's data URI is one line of hundreds of thousands of
   * characters, and searching the whole text for placeholders was quadratic
   * in that line's length (15 s for a 240 KB photograph beside one table).
   */
  it('puts tables back in linear time beside a long data URI', async () => {
    const picture = `<p><img alt="photo" src="data:image/png;base64,${'A'.repeat(300_000)}"></p>`
    const table = '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'
    const t0 = performance.now()
    const md = (await writeMarkdown({ html: table + picture })).toString('utf8')
    const ms = performance.now() - t0
    expect(md).toContain('| a |')
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(1_500)
  })
})

