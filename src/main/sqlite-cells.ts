/**
 * A SQLite value as text, the way the reader prints and exports it (spec D13):
 * integers exact, REAL as SQLite itself prints it, NULL empty, a BLOB as its
 * size. Runs inside the sqlite worker, so it imports nothing.
 */

/**
 * REAL as SQLite writes it as text (`CAST(x AS TEXT)`, the sqlite3 shell):
 * printf's `%!.15g`. Fifteen significant digits, so 0.1 + 0.2 is `0.3`; the
 * `!` keeps a decimal point, so 1.0 is `1.0`, not JavaScript's `1`; and an
 * exponent has at least two digits, `1.0e-07`. Checked against sql.js's own
 * CAST in tests/main/sqlite-host.test.ts.
 */
export function sqliteReal(n: number): string {
  // SQLite stores NaN as NULL, so it never arrives as a REAL; be safe anyway.
  if (Number.isNaN(n)) return ''
  if (!Number.isFinite(n)) return n > 0 ? 'Inf' : '-Inf'
  if (n === 0) return '0.0'
  // The exponent after rounding to 15 digits decides the form, as in %g.
  const [mantissa, e] = n.toExponential(14).split('e')
  const exp = Number(e)
  if (exp < -4 || exp >= 15) {
    const m = mantissa.replace(/0+$/, '').replace(/\.$/, '.0')
    const digits = String(Math.abs(exp)).padStart(2, '0')
    return `${m}e${exp < 0 ? '-' : '+'}${digits}`
  }
  const fixed = n.toFixed(14 - exp)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '.0') : `${fixed}.0`
}

/** `[blob 1.2 KB]`: what a BLOB is, without its bytes. */
export function blobLabel(length: number): string {
  const size =
    length < 1024
      ? `${length} B`
      : length < 1024 * 1024
        ? `${(length / 1024).toFixed(1)} KB`
        : `${(length / 1024 / 1024).toFixed(1)} MB`
  return `[blob ${size}]`
}

/** One cell from sql.js's `get(null, { useBigInt: true })`. */
export function sqliteCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  // useBigInt: every INTEGER arrives as a bigint, so 2^63 - 1 stays exact.
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return sqliteReal(value)
  if (value instanceof Uint8Array) return blobLabel(value.length)
  return String(value)
}
