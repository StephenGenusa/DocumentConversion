import { describe, it, expect } from 'vitest'
import { sanitizeSvg } from '../../src/core/svg-sanitize'
import { prepareSvgForRaster, sanitizeSvgImages, svgDataUri } from '../../src/core/svg-images'

/** An SVG of `bytes` or so: a plan of small colored squares, as large-pictures.test.ts draws. */
function bigSvg(bytes: number): string {
  const parts: string[] = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const r = `<rect x="${(i * 7) % 2000}" y="${Math.floor(i / 285) % 1500}" width="6" height="6" fill="#${((i * 7919) & 0xffffff).toString(16).padStart(6, '0')}"/>`
    parts.push(r)
    size += r.length
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1500" viewBox="0 0 2000 1500">${parts.join('')}</svg>`
}

const forget = (): void => (globalThis as unknown as Record<symbol, Map<string, unknown>>)[Symbol.for('docconversion.svg-sanitize.known-clean')]?.clear()

/**
 * The best time of each job over `rounds`, the jobs taken in turn within a
 * round, after one untimed warm-up of each: a slow spell lands on both sides
 * of the ratio, and the best of several drops the rounds a burst landed in
 * (writer-md-perf.test.ts says why: no fixed budgets).
 */
function bestInTurn(jobs: Array<() => unknown>, rounds = 5): number[] {
  for (const job of jobs) job()
  const best = jobs.map(() => Infinity)
  for (let r = 0; r < rounds; r++) {
    for (let j = 0; j < jobs.length; j++) {
      const t0 = performance.now()
      jobs[j]()
      best[j] = Math.min(best[j], performance.now() - t0)
    }
  }
  return best
}

const MB = 1024 * 1024

describe('SVG sanitizing performance', () => {
  /**
   * The sanitizer reads an SVG in one streaming pass. Four 1 MB SVGs are
   * timed against one 4 MB SVG: the same time when the cost is linear, four
   * times it when quadratic; the bound, 2x, sits between.
   */
  it('scales close to linearly with the size of the SVG', () => {
    const small = bigSvg(1 * MB)
    const large = bigSvg(4 * MB)
    const [smallMs, largeMs] = bestInTurn([
      () => {
        for (let i = 0; i < 4; i++) {
          forget()
          sanitizeSvg(small)
        }
      },
      () => {
        forget()
        sanitizeSvg(large)
      },
    ])
    expect(largeMs / smallMs, `4 MB ${largeMs.toFixed(0)} ms, 4 x 1 MB ${smallMs.toFixed(0)} ms`).toBeLessThan(2)
  }, 120_000)

  /**
   * A 12 MB SVG was read in full five times between the reader and the
   * render host (owner's large-pictures numbers: 9 s, 1.1-1.3 GB in main).
   * One cleaned once is not read again: cleaning it again where it is
   * written, and sizing it for drawing, cost a hash, not a read. Timed
   * against reading it once; the bound, a third, is far above the hash
   * (about a twentieth) and far below a second read (1x).
   */
  it('does not read a clean SVG again where it is written and sized for drawing', () => {
    const svg = bigSvg(4 * MB)
    const clean = sanitizeSvg(svg)!
    const html = `<p><img src="${svgDataUri(clean)}" alt="Plan"></p>`
    const [readMs, againMs] = bestInTurn([
      () => {
        forget()
        sanitizeSvg(svg)
      },
      () => {
        sanitizeSvg(clean)
        prepareSvgForRaster(clean, { maxWidth: 624, maxHeight: 864 })
      },
    ])
    // Where the write path starts: the hub's SVG <img>, cleaned again, as given.
    expect(sanitizeSvgImages(html)).toBe(html)
    expect(againMs / readMs, `again ${againMs.toFixed(0)} ms, one read ${readMs.toFixed(0)} ms`).toBeLessThan(1 / 3)
  }, 120_000)
})
