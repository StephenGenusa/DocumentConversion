/**
 * The README's tour: the screenshots in docs/screenshots, in the order a
 * person meets them, as one animated GIF (docs/screenshots/tour.gif) that
 * holds each screen for four seconds and then starts over.
 *
 *   npm run screenshots        makes the PNGs, then this GIF
 *   npm run screenshots:gif    only this GIF, from the PNGs already there
 *
 * The pictures have different sizes (the app at 1040 x 700, 1040 x 860 and
 * 1040 x 1160, pages at 816 x 1056, slides at 960 x 700, the narrow window at
 * 560 x 480). Each is fitted inside one 1040 x 860 frame, shrunk if it is
 * larger (never enlarged, never stretched) and centered on a neutral gray, so
 * the narrow window looks narrow and every page is shown whole.
 *
 * ImageMagick (`convert`) does the work: each frame gets its own 256-color
 * palette, without dithering (flat interface colors and text stay clean), and
 * `-layers OptimizePlus` stores only what changes between frames.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SHOTS_DIR = join(ROOT, 'docs', 'screenshots')
export const TOUR = 'tour.gif'

/** The frame every picture is fitted into, and what is around it. */
const FRAME = [1040, 860]
const BACKGROUND = '#d9dce1'
/** Hundredths of a second per screen. */
const HOLD = 400

/**
 * The story: the start screen and its sample menu, each sample in the editor,
 * the editing tools, Settings and the conversion choices, then what comes out
 * (PDF, Word, EPUB, slides), and last the window at its smallest.
 */
export const TOUR_ORDER = [
  'app-start',
  'app-sample-menu',
  'app-design-note',
  'app-software-spec',
  'app-lab-report',
  'app-meeting-summary',
  'app-diagram-editing',
  'app-formula',
  'app-code-language',
  'app-settings',
  'app-convert',
  'pdf-design-note-inner',
  'pdf-software-spec-inner',
  'pdf-lab-report-inner',
  'pdf-meeting-summary-inner',
  'pdf-architecture',
  'word-software-spec',
  'word-meeting-summary',
  'epub-lab-report',
  'slides-design-note',
  'slides-software-spec',
  'slides-meeting-summary',
  'app-narrow',
]

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' })
  if (res.error) throw new Error(`${cmd}: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${cmd} failed: ${res.stderr.slice(0, 600)}`)
}

/** Builds docs/screenshots/tour.gif from the PNGs in `dir`; returns its path and size. */
export function makeTour(dir = SHOTS_DIR) {
  const missing = TOUR_ORDER.filter((n) => !existsSync(join(dir, `${n}.png`)))
  if (missing.length) throw new Error(`tour: missing ${missing.map((n) => `${n}.png`).join(', ')} (run npm run screenshots)`)
  if (spawnSync('convert', ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('tour: ImageMagick (convert) is not installed')
  const work = mkdtempSync(join(tmpdir(), 'docconv-tour-'))
  try {
    const size = `${FRAME[0]}x${FRAME[1]}`
    const frames = TOUR_ORDER.map((name, i) => {
      const out = join(work, `${String(i).padStart(2, '0')}.png`)
      // `>`: shrink to fit only; -extent pads to the frame, centered.
      run('convert', [join(dir, `${name}.png`), '-resize', `${size}>`, '-background', BACKGROUND, '-gravity', 'center', '-extent', size, out])
      return out
    })
    const gif = join(work, TOUR)
    run('convert', ['-delay', String(HOLD), '-loop', '0', ...frames, '-dither', 'None', '-colors', '256', '-layers', 'OptimizePlus', gif])
    const target = join(dir, TOUR)
    rmSync(target, { force: true })
    try {
      renameSync(gif, target)
    } catch {
      // A temp folder on another file system: copy instead.
      run('cp', [gif, target])
    }
    return { file: target, bytes: statSync(target).size, frames: frames.length }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { file, bytes, frames } = makeTour()
    console.log(`${frames} screens, ${HOLD / 100} s each: ${file} (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
