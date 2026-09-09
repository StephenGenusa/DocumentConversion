import { describe, it, expect } from 'vitest'
import { readRst } from '../../src/core/readers/rst'

const src = (text: string) => ({ bytes: Buffer.from(text, 'utf8'), filename: 'perf.rst' })

/**
 * An ordinary large reference manual: a great many small tables of both
 * syntaxes. Nothing hostile about it — this is the shape that hung the main
 * process, because every rule line copied the whole remainder of the document
 * into a candidate block, and every lifted table then re-scanned the whole
 * rendered document to splice itself back in.
 */
function manyTables(sections: number): string {
  const out: string[] = []
  for (let i = 0; i < sections; i++) {
    // Fixed-width ids: a table whose cells outgrow its rule is ragged, and the
    // reader is right to decline it, which would make this measure nothing.
    const n = String(i).padStart(4, '0')
    out.push('=====  =====', `a${n}  b${n}`, '=====  =====', '')
    out.push('+-------+-------+', `| a${n} | b${n} |`, '+-------+-------+', '')
  }
  return out.join('\n')
}

/**
 * A grid-table block holding one long line — a runaway cell, a pasted URL.
 * `padBlock` padded EVERY line out to the longest one before the parse began,
 * so the cost was lines x longest-line rather than the size of the source.
 * Both arguments scale together: 4x the source, 16x the padded block.
 */
function longLineGrid(rows: number, width: number): string {
  const out = ['+------+------+']
  for (let i = 0; i < rows; i++) out.push('| a    | b    |')
  out.push(`| ${'x'.repeat(width)} |`)
  out.push('+------+------+', '')
  return out.join('\n')
}

/**
 * Rule lines whose only closing rule is at the far end of the document. Every
 * one of them opens a candidate table, and each candidate used to claim
 * everything up to that closing rule. Crafted rather than ordinary, but the
 * same hang, and the same shape a runaway `====` in a hand-written manual
 * would produce.
 */
function unclosedRules(sections: number): string {
  const out: string[] = []
  for (let i = 0; i < sections; i++) {
    const n = String(i).padStart(4, '0')
    out.push('=====  =====', `a${n}  b${n}`, '')
  }
  out.push('=====  =====', '')
  return out.join('\n')
}

async function bestOf3(text: string): Promise<number> {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    await readRst(src(text))
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

const kb = (text: string): number => Math.round(Buffer.byteLength(text) / 1024)
const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)}MB`

/**
 * These are scaling assertions, not budgets: they compare the reader against
 * itself at two sizes, so a machine running several suites at once slows both
 * measurements and the ratio survives. An absolute millisecond budget does not.
 */
describe('readRst scales with document size', () => {
  /**
   * R5 (and the table-splice pass behind it). Quadratic cost shows up as the
   * per-byte cost rising with the size: 4x the input must not cost more than
   * 8x the time. Quadratic is 16x; this measured 10.9x before the fix, with
   * the third-party parser's linear share flattering it.
   */
  it('costs no more than ~8x for 4x the tables', async () => {
    const small = manyTables(800)
    const large = manyTables(3_200)
    const t1 = await bestOf3(small)
    const t2 = await bestOf3(large)
    console.log(`R5: ${kb(small)}KB ${t1.toFixed(0)}ms -> ${kb(large)}KB ${t2.toFixed(0)}ms (${(t2 / t1).toFixed(1)}x)`)
    expect(t2).toBeLessThan(t1 * 8)
  }, 300_000)

  /** Cheap insurance that the speed does not come from skipping tables. */
  it('still lifts every table in a large document', async () => {
    const html = (await readRst(src(manyTables(800)))).html
    expect((html.match(/<table>/g) ?? []).length).toBe(1_600)
    expect(html).not.toContain('=====')
    expect(html).not.toContain('+-------+')
    expect(html).toContain('<td>a0799</td><td>b0799</td>')
  }, 300_000)

  /**
   * R5 again, from the other side: a candidate whose closing rule is nowhere
   * near it must not drag the whole document into its block either.
   */
  it('costs no more than ~8x for 4x of rule lines that never close', async () => {
    const small = unclosedRules(1_000)
    const large = unclosedRules(4_000)
    const t1 = await bestOf3(small)
    const t2 = await bestOf3(large)
    console.log(`R5b: ${kb(small)}KB ${t1.toFixed(0)}ms -> ${kb(large)}KB ${t2.toFixed(0)}ms (${(t2 / t1).toFixed(1)}x)`)
    expect(t2).toBeLessThan(t1 * 8)
    expect((await readRst(src(small))).html).toContain('a0999')
  }, 300_000)

  /**
   * R7. Peak memory, at two sizes four times apart: the same allowance has to
   * hold at both, so a peak that follows lines x longest-line (16x here, and
   * ~2,250x the source at the sizes that OOM-killed the process) breaks it
   * while a peak that follows the source does not.
   *
   * maxRSS is the process high-water mark, so the delta is the growth this
   * one call caused. It can only ever be understated by a peak an earlier
   * test already reached, never overstated, so this cannot flake upwards.
   * Time is the wrong instrument here: padding is cheap to do and expensive
   * to hold, and the pre-fix run was only 5x slower where it was 12x fatter.
   */
  it('does not amplify one long line into hundreds of megabytes', async () => {
    for (const [rows, width] of [
      [3_500, 6_000],
      [14_000, 24_000],
    ]) {
      const text = longLineGrid(rows, width)
      const bytes = Buffer.byteLength(text)
      const before = process.resourceUsage().maxRSS
      await readRst(src(text))
      const growth = (process.resourceUsage().maxRSS - before) * 1024
      console.log(`R7 RSS: ${kb(text)}KB input, peak growth ${mb(growth)} (${(growth / bytes).toFixed(0)}x)`)
      expect(growth).toBeLessThan(32 * 1024 * 1024 + bytes * 10)
    }
  }, 300_000)
})

describe('readRst still refuses what it cannot read', () => {
  it('leaves a block with one over-long line as text, not a table', async () => {
    const html = (await readRst(src(longLineGrid(3, 200)))).html
    expect(html).not.toContain('<table>')
    expect(html).toContain('x'.repeat(200))
  })

  it('does not expand a marker that a cell of its own spells out', async () => {
    const html = (
      await readRst(
        src(`====  ==================
a     XRSTHUBTABLE0ENDX
====  ==================
`),
      )
    ).html
    expect((html.match(/<table>/g) ?? []).length).toBe(1)
    expect(html).toContain('XRSTHUBTABLE0ENDX')
  })
})
