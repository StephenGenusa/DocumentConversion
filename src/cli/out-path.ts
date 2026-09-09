import { basename, dirname, extname, join, resolve } from 'node:path'

/**
 * Where one output part is written.
 *
 * The rule this replaces stripped the extension from `--out` unconditionally
 * and appended the target's own, so `--out report.dat --to pdf` wrote
 * `report.pdf`. The file the caller named never appeared, nothing said so, and
 * a script that converts and then reads back the path it asked for fails with
 * a "no such file" pointing nowhere near the cause.
 *
 * The rule now:
 *
 *   --out names a directory   derive the name from the input, as before -
 *                             there is no filename in it to honour
 *   --out has an extension    honour it exactly. The caller chose it; a
 *                             converter has no business overriding it
 *   --out has none            append the target's, because `--out report
 *                             --to pdf` plainly means report.pdf
 *   no --out                  alongside the input, as before
 *
 * Multi-part outputs (csv and json write one file per table) insert their
 * suffix BEFORE the extension, so three tables give report.table-2.csv rather
 * than report.csv.table-2.
 */
export interface OutPathInput {
  /** The `--out` value, if given. */
  out?: string
  /** Whether that value names a directory. */
  outIsDir?: boolean
  /** The input file this part came from. */
  inputPath: string
  /** '' for the primary file, '.table-2' and so on for the rest. */
  suffix: string
  /** The target format's canonical extension, e.g. '.pdf'. */
  ext: string
}

export function resolveOutPath({ out, outIsDir, inputPath, suffix, ext }: OutPathInput): string {
  const stem = basename(inputPath).replace(/\.[^.\\/]+$/, '')

  if (out === undefined) {
    return join(dirname(resolve(inputPath)), `${stem}${suffix}${ext}`)
  }
  if (outIsDir) {
    return join(out, `${stem}${suffix}${ext}`)
  }

  // `extname` returns '' for a dotless name, and only the LAST extension for
  // `archive.tar.gz` — which is what we want to keep, not to strip.
  const given = extname(out)
  if (given === '') return `${out}${suffix}${ext}`
  return `${out.slice(0, -given.length)}${suffix}${given}`
}
