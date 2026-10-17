import { SOURCE_FORMATS, TABLE_TARGETS, TARGET_FORMATS, type SourceFormat, type TargetFormat } from '../core/types'
import { PDF_PAGE_SIZES } from '../core/pdf-options'
import { SVG_TARGETS, type PictureFormat } from '../core/rendered-blocks'
import { PICTURE_TARGET_FORMATS } from '../core/pictures'
import { NO_FETCH_SOURCES } from '../core/remote-images'
import { isKnownLanguage } from '../ocr/languages'

export interface CliRequest {
  inputs: string[]
  to: TargetFormat
  out?: string
  from?: SourceFormat
  merge: boolean
  table?: number
  scale?: number
  page?: string
  /** JSON records as a table or as formatted text. */
  jsonAs?: 'table' | 'text'
  /** Transcripts without their times. */
  noTimestamps?: boolean
  /** SQLite: include each view's results. */
  sqliteViews?: boolean
  /** Where a new slide starts, for the revealjs target. */
  split?: 'auto' | 'hr' | 'h1' | 'h2'
  /** Diagrams as SVG or PNG, for the outputs that take SVG (spec B4). */
  diagrams?: 'svg' | 'png'
  /** The pdf or docx page's orientation; Automatic when not given. `--landscape` is `landscape`. */
  orientation?: 'auto' | 'portrait' | 'landscape'
  headerFooter: boolean
  /** No PDF header and footer, even if the settings file has them on. */
  noHeaderFooter?: boolean
  ocr: boolean
  noClobber: boolean
  headings: boolean
  /** What a picture the target can't hold becomes (settings: pictures.format). */
  pictures?: PictureFormat
  /** Leave web pictures unfetched (settings: web.fetchPictures off). */
  noFetch?: boolean
  /** Fetch web pictures, even if the settings file says not to (web.fetchPictures on). */
  fetch?: boolean
  /** Refuse intranet addresses for web pictures (settings: web.allowLocalNetwork off). */
  noLocalNetwork?: boolean
  /** Allow intranet addresses, even if the settings file refuses them (web.allowLocalNetwork on). */
  localNetwork?: boolean
  /** Plain code, not colored by language (settings: code.color off). */
  noCodeColor?: boolean
  /** Code colored by language, even if the settings file says plain (code.color on). */
  codeColor?: boolean
  /** The OCR language, with --ocr. */
  ocrLang?: string
  /** A settings file to start from, or `app` for the app's own. */
  settings?: string
}

export type ParseResult = { kind: 'ok'; req: CliRequest } | { kind: 'usage'; message: string }

export const USAGE = `usage: docconv convert <inputs...> --to <txt|md|docx|pdf|html|epub|revealjs|azw3|azw4|csv|json|xlsx>
  [--out <fileOrDir>]   output path (default: alongside a single input; REQUIRED for multiple inputs)
  [--from <format>]     override detection for ALL inputs
  [--merge]             combine all inputs into one document (--out is the output file)
  [--no-headings]       merge without per-source headings
  [--split <auto|hr|h1|h2>]  where a new slide starts (revealjs target)
  [--diagrams <svg|png>]  diagrams sharp (svg, default) or as images (png): pdf, html, revealjs, epub, azw4
  [--table N]           csv/json target: extract only table N
  [--scale X]           pdf zoom factor 0.1-2.0 (default 0.9)
  [--page <size>]       pdf and docx page size (Letter, A4, Legal, A3, Tabloid)
  [--orientation <auto|portrait|landscape>]  pdf and docx page orientation: auto (default) turns the
                        page for wide pictures and mostly-wide tables; portrait or landscape for every page
  [--landscape]         the same as --orientation landscape
  [--header-footer]     pdf header/footer with title, date, page numbers
  [--no-header-footer]  pdf without a header/footer, even if --settings turns it on
  [--ocr]               OCR scanned PDFs and images (English unless --ocr-lang)
  [--ocr-lang <code>]   with --ocr: the OCR language, e.g. deu (its pack must be installed in the app)
  [--pictures <auto|jpg|png>]  pictures the output can't hold: auto (default) keeps PNG for screenshots,
                        line art, scans and GIFs and makes photographs JPG; jpg or png for all (see-through ones stay PNG)
  [--no-fetch]          don't download web pictures; each is replaced by its description
  [--fetch]             download web pictures, even if --settings turns fetching off
  [--no-local-network]  don't download web pictures from intranet addresses (10.x, 192.168.x, http://intranet/)
  [--local-network]     allow intranet addresses, even if --settings refuses them
  [--no-code-color]     plain code, not colored by language: pdf, html, revealjs, epub, azw3, azw4, docx
  [--code-color]        code colored by language, even if --settings turns it off (same outputs)
  [--settings <file|app>]  start from a settings file, or the app's own (app); flags win over it
  [--json-as <table|text>]  JSON records: a table (default) or formatted JSON
  [--no-timestamps]     subtitles and transcripts without their times
  [--sqlite-views]      SQLite databases: include each view's results after the tables
  [--no-clobber]        fail instead of overwriting existing outputs
Without --settings the defaults are built in: the app's settings are never read.
A flag and its --no- opposite cannot be given together.
Exit codes: 0 all succeeded, 1 any failed, 2 bad usage.`

const usage = (message: string): ParseResult => ({ kind: 'usage', message: `${message}\n\n${USAGE}` })

/**
 * Which targets or inputs a flag is for (spec 2a, the command-line side of
 * "show only what applies"). A STRICT flag that cannot apply is a usage
 * error, exit 2. The flags that predate this rule are not strict: they have
 * always been ignored when they do not apply, and a script that passes one
 * anyway must keep working.
 */
export interface FlagScope {
  flag: string
  targets?: readonly TargetFormat[]
  inputs?: readonly SourceFormat[]
  /** Inputs it does nothing for: an error only when every input is one. */
  notInputs?: readonly SourceFormat[]
  /** Why, for `notInputs`. */
  because?: string
  strict: boolean
}

/** The outputs that color code by language (and so the ones --code-color and --no-code-color change). */
export const CODE_COLOR_TARGETS: readonly TargetFormat[] = ['pdf', 'html', 'revealjs', 'epub', 'azw3', 'azw4', 'docx']

const NEVER_FETCH = [...NO_FETCH_SOURCES]

export const FLAG_SCOPES: FlagScope[] = [
  { flag: '--table', targets: ['csv', 'json'], strict: false },
  { flag: '--split', targets: ['revealjs'], strict: false },
  { flag: '--scale', targets: ['pdf'], strict: false },
  // The paper is Word's too (writers/docx.ts wordPages).
  { flag: '--page', targets: ['pdf', 'docx'], strict: false },
  { flag: '--landscape', targets: ['pdf', 'docx'], strict: false },
  { flag: '--header-footer', targets: ['pdf'], strict: false },
  // Flags from 1.4 on are strict.
  // Word's page turns as the PDF's does (writers/docx.ts wordPages).
  { flag: '--orientation', targets: ['pdf', 'docx'], strict: true },
  { flag: '--json-as', inputs: ['json'], strict: true },
  { flag: '--no-timestamps', inputs: ['subtitles'], strict: true },
  { flag: '--sqlite-views', inputs: ['sqlite'], strict: true },
  // Word (and Kindle AZW3) are always PNG; md and txt keep the source.
  { flag: '--diagrams', targets: [...SVG_TARGETS], strict: true },
  // Settings spec 5.7: one flag per setting.
  { flag: '--pictures', targets: PICTURE_TARGET_FORMATS, strict: true },
  // Each on/off pair shares a scope: --fetch turns on only what --no-fetch turns off.
  { flag: '--no-fetch', notInputs: NEVER_FETCH, because: 'they never fetch web pictures', strict: true },
  { flag: '--fetch', notInputs: NEVER_FETCH, because: 'they never fetch web pictures', strict: true },
  { flag: '--no-local-network', notInputs: NEVER_FETCH, because: 'they never fetch web pictures', strict: true },
  { flag: '--local-network', notInputs: NEVER_FETCH, because: 'they never fetch web pictures', strict: true },
  { flag: '--no-code-color', targets: CODE_COLOR_TARGETS, strict: true },
  { flag: '--code-color', targets: CODE_COLOR_TARGETS, strict: true },
  // The opposite of the legacy --header-footer, and new, so strict.
  { flag: '--no-header-footer', targets: ['pdf'], strict: true },
  { flag: '--ocr-lang', inputs: ['image', 'pdf'], strict: true },
]

/** The usage message for the first strict flag that cannot apply, or null. */
export function checkFlagScope(
  flags: string[],
  target: TargetFormat,
  inputFormats: SourceFormat[],
  scopes: FlagScope[] = FLAG_SCOPES,
): string | null {
  for (const scope of scopes) {
    if (!scope.strict || !flags.includes(scope.flag)) continue
    if (scope.targets && !scope.targets.includes(target)) {
      return `${scope.flag} applies only to ${scope.targets.join(', ')} output, not ${target}`
    }
    if (scope.inputs && !inputFormats.some((f) => scope.inputs!.includes(f))) {
      return `${scope.flag} applies only to ${scope.inputs.join(', ')} input, and no input is one`
    }
    if (scope.notInputs && inputFormats.every((f) => scope.notInputs!.includes(f))) {
      return `${scope.flag} does not apply to ${scope.notInputs.join(', ')} input (${scope.because}), and every input is one`
    }
  }
  return null
}

export function parseArgs(argv: string[]): ParseResult {
  const req: CliRequest = {
    inputs: [],
    to: 'pdf',
    merge: false,
    headerFooter: false,
    ocr: false,
    noClobber: false,
    headings: true,
  }
  let toSeen = false
  let landscapeFlag = false
  let orientationFlag = false

  const takeValue = (_flag: string, i: number): string | null => (i + 1 < argv.length ? argv[i + 1] : null)

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      req.inputs.push(arg)
      continue
    }
    switch (arg) {
      case '--to': {
        const v = takeValue(arg, i++)
        if (!v || !TARGET_FORMATS.includes(v as TargetFormat)) return usage(`--to must be one of ${TARGET_FORMATS.join(', ')}`)
        req.to = v as TargetFormat
        toSeen = true
        break
      }
      case '--out': {
        const v = takeValue(arg, i++)
        if (!v) return usage('--out needs a path')
        req.out = v
        break
      }
      case '--from': {
        const v = takeValue(arg, i++)
        if (!v || !SOURCE_FORMATS.includes(v as SourceFormat)) return usage(`--from must be one of ${SOURCE_FORMATS.join(', ')}`)
        req.from = v as SourceFormat
        break
      }
      case '--table': {
        const v = takeValue(arg, i++)
        const n = v ? parseInt(v, 10) : NaN
        if (!Number.isInteger(n) || n < 1 || String(n) !== v) return usage('--table needs a positive integer')
        req.table = n
        break
      }
      case '--scale': {
        const v = takeValue(arg, i++)
        const n = v ? Number(v) : NaN
        // Reject rather than silently clamp: --scale 9 quietly producing 2.0
        // output looks like the flag worked.
        if (!Number.isFinite(n)) return usage('--scale needs a number')
        if (n < 0.1 || n > 2) return usage(`--scale must be between 0.1 and 2.0 (got ${v})`)
        req.scale = n
        break
      }
      case '--page': {
        const v = takeValue(arg, i++)
        if (!v) return usage('--page needs a size')
        const match = PDF_PAGE_SIZES.find((size) => size.toLowerCase() === v.toLowerCase())
        if (!match) return usage(`--page must be one of ${PDF_PAGE_SIZES.join(', ')} (got ${v})`)
        req.page = match
        break
      }
      case '--split': {
        const v = takeValue(arg, i++)
        if (!v) return usage('--split needs a rule')
        const rules = ['auto', 'hr', 'h1', 'h2'] as const
        const match = rules.find((r) => r === v.toLowerCase())
        if (!match) return usage(`--split must be one of ${rules.join(', ')} (got ${v})`)
        req.split = match
        break
      }
      case '--orientation': {
        const v = takeValue(arg, i++)
        const choices = ['auto', 'portrait', 'landscape'] as const
        const match = choices.find((c) => c === v?.toLowerCase())
        if (!match) return usage(`--orientation must be one of ${choices.join(', ')}${v ? ` (got ${v})` : ''}`)
        req.orientation = match
        orientationFlag = true
        break
      }
      case '--json-as': {
        const v = takeValue(arg, i)
        if (v !== 'table' && v !== 'text') return usage('--json-as needs table or text')
        req.jsonAs = v
        i++
        break
      }
      case '--diagrams': {
        const v = takeValue(arg, i++)
        if (v !== 'svg' && v !== 'png') return usage('--diagrams needs svg or png')
        req.diagrams = v
        break
      }
      case '--pictures': {
        const v = takeValue(arg, i++)
        const formats: Record<string, PictureFormat> = { auto: 'auto', jpg: 'jpeg', jpeg: 'jpeg', png: 'png' }
        const format = v ? formats[v.toLowerCase()] : undefined
        if (!format) return usage('--pictures needs auto, jpg or png')
        req.pictures = format
        break
      }
      case '--ocr-lang': {
        const v = takeValue(arg, i++)
        if (!v) return usage('--ocr-lang needs a language code')
        if (!isKnownLanguage(v)) return usage(`--ocr-lang: ${v} is not an OCR language this app knows`)
        req.ocrLang = v
        break
      }
      case '--settings': {
        const v = takeValue(arg, i++)
        if (!v) return usage('--settings needs a settings file, or app')
        req.settings = v
        break
      }
      case '--no-fetch':
        req.noFetch = true
        break
      case '--fetch':
        req.fetch = true
        break
      case '--no-local-network':
        req.noLocalNetwork = true
        break
      case '--local-network':
        req.localNetwork = true
        break
      case '--no-code-color':
        req.noCodeColor = true
        break
      case '--code-color':
        req.codeColor = true
        break
      case '--no-header-footer':
        req.noHeaderFooter = true
        break
      case '--no-timestamps':
        req.noTimestamps = true
        break
      case '--sqlite-views':
        req.sqliteViews = true
        break
      case '--merge':
        req.merge = true
        break
      case '--no-headings':
        req.headings = false
        break
      case '--landscape':
        landscapeFlag = true
        break
      case '--header-footer':
        req.headerFooter = true
        break
      case '--ocr':
        req.ocr = true
        break
      case '--no-clobber':
        req.noClobber = true
        break
      default:
        // Chromium's own switch (it takes only the `=` form): the profile, and
        // so the userData folder that `--settings app` reads. Electron acts on it.
        if (arg.startsWith('--user-data-dir=')) break
        return usage(`Unknown flag: ${arg}`)
    }
  }

  if (req.ocrLang && !req.ocr) return usage('--ocr-lang needs --ocr')
  // --landscape is the older spelling of --orientation landscape: both at once would be a guess.
  if (landscapeFlag && orientationFlag) return usage('--landscape and --orientation both set the orientation: give one')
  if (landscapeFlag) req.orientation = 'landscape'
  // A flag and its --no- opposite: which one wins would be a guess.
  const opposites: [string, boolean | undefined, boolean | undefined][] = [
    ['fetch', req.fetch, req.noFetch],
    ['local-network', req.localNetwork, req.noLocalNetwork],
    ['code-color', req.codeColor, req.noCodeColor],
    ['header-footer', req.headerFooter, req.noHeaderFooter],
  ]
  for (const [name, on, off] of opposites) {
    if (on && off) return usage(`--${name} and --no-${name} are opposites: give one`)
  }
  if (req.noFetch && (req.noLocalNetwork || req.localNetwork)) {
    const flag = req.noLocalNetwork ? '--no-local-network' : '--local-network'
    return usage(`${flag} does nothing with --no-fetch: no web picture is fetched at all`)
  }
  if (req.inputs.length === 0) return usage('No inputs given')
  if (!toSeen) return usage('--to is required')
  if (req.inputs.length > 1 && !req.out) {
    return usage(req.merge ? '--merge needs --out <file>' : 'Multiple inputs need --out <directory>')
  }
  if (req.merge && TABLE_TARGETS.includes(req.to)) {
    return usage(`Merge cannot target ${req.to} — table extraction is a per-file operation, use batch`)
  }
  return { kind: 'ok', req }
}
