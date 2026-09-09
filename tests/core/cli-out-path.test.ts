import { describe, it, expect } from 'vitest'
import { resolveOutPath } from '../../src/cli/out-path'

/**
 * Where `--out` actually puts the file.
 *
 * The rule that was there stripped the extension off `--out` unconditionally
 * and appended the target's own, so `--out report.dat --to pdf` wrote
 * `report.pdf` and the file the caller named never appeared. A script that
 * converts and then reads back the path it asked for simply fails, with a
 * "no such file" that points nowhere near the cause.
 *
 * `--out` naming a DIRECTORY is different and stays as it was: there is no
 * filename in it to honour, so one is derived from the input.
 */
const ext = '.pdf'

describe('resolveOutPath', () => {
  it('writes alongside the input when --out is absent', () => {
    expect(resolveOutPath({ inputPath: '/docs/report.md', suffix: '', ext })).toBe('/docs/report.pdf')
  })

  it('honours an explicit filename exactly, even when the extension differs', () => {
    // This is the bug: the caller asked for report.dat and got report.pdf.
    expect(
      resolveOutPath({ out: '/tmp/report.dat', inputPath: '/docs/a.md', suffix: '', ext }),
    ).toBe('/tmp/report.dat')
  })

  it('leaves a matching extension alone rather than doubling it', () => {
    expect(resolveOutPath({ out: '/tmp/report.pdf', inputPath: '/docs/a.md', suffix: '', ext })).toBe(
      '/tmp/report.pdf',
    )
  })

  it('adds the target extension when the caller gave none', () => {
    // `--out report --to pdf` plainly means report.pdf; there is nothing to honour.
    expect(resolveOutPath({ out: '/tmp/report', inputPath: '/docs/a.md', suffix: '', ext })).toBe(
      '/tmp/report.pdf',
    )
  })

  it('does not mangle a name that merely contains dots', () => {
    // The old rule turned archive.tar.gz into archive.tar.pdf.
    expect(
      resolveOutPath({ out: '/tmp/archive.tar.gz', inputPath: '/docs/a.md', suffix: '', ext }),
    ).toBe('/tmp/archive.tar.gz')
    expect(resolveOutPath({ out: '/tmp/report.v2.pdf', inputPath: '/docs/a.md', suffix: '', ext })).toBe(
      '/tmp/report.v2.pdf',
    )
  })

  it('derives a name from the input when --out is a directory', () => {
    expect(
      resolveOutPath({ out: '/outdir', outIsDir: true, inputPath: '/docs/report.md', suffix: '', ext }),
    ).toBe('/outdir/report.pdf')
  })

  it('inserts a multi-part suffix BEFORE the caller’s extension', () => {
    // Three tables to csv must not become report.csv.table-2.
    expect(
      resolveOutPath({ out: '/tmp/report.csv', inputPath: '/docs/a.md', suffix: '.table-2', ext: '.csv' }),
    ).toBe('/tmp/report.table-2.csv')
  })

  it('appends the target extension after a suffix when the caller gave no extension', () => {
    expect(
      resolveOutPath({ out: '/tmp/report', inputPath: '/docs/a.md', suffix: '.table-2', ext: '.csv' }),
    ).toBe('/tmp/report.table-2.csv')
  })

  it('suffixes a directory output the same way', () => {
    expect(
      resolveOutPath({ out: '/outdir', outIsDir: true, inputPath: '/docs/a.md', suffix: '.table-2', ext: '.csv' }),
    ).toBe('/outdir/a.table-2.csv')
  })
})
