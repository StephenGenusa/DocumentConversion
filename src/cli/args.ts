import { SOURCE_FORMATS, TABLE_TARGETS, TARGET_FORMATS, type SourceFormat, type TargetFormat } from '../core/types'
import { PDF_PAGE_SIZES } from '../core/pdf-options'

export interface CliRequest {
  inputs: string[]
  to: TargetFormat
  out?: string
  from?: SourceFormat
  merge: boolean
  table?: number
  scale?: number
  page?: string
  /** Where a new slide starts, for the revealjs target. */
  split?: 'auto' | 'hr' | 'h1' | 'h2'
  landscape: boolean
  headerFooter: boolean
  ocr: boolean
  noClobber: boolean
  headings: boolean
}

export type ParseResult = { kind: 'ok'; req: CliRequest } | { kind: 'usage'; message: string }

export const USAGE = `usage: docconv convert <inputs...> --to <txt|md|docx|pdf|html|epub|revealjs|azw3|azw4|csv|json|xlsx>
  [--out <fileOrDir>]   output path (default: alongside a single input; REQUIRED for multiple inputs)
  [--from <format>]     override detection for ALL inputs
  [--merge]             combine all inputs into one document (--out is the output file)
  [--no-headings]       merge without per-source headings
  [--split <auto|hr|h1|h2>]  where a new slide starts (revealjs target)
  [--table N]           csv/json target: extract only table N
  [--scale X]           pdf zoom factor 0.1-2.0
  [--page <size>]       pdf page size (Letter, A4, Legal, A3, Tabloid)
  [--landscape]         pdf landscape orientation
  [--header-footer]     pdf header/footer with title, date, page numbers
  [--ocr]               OCR scanned PDFs and images (English)
  [--no-clobber]        fail instead of overwriting existing outputs
Exit codes: 0 all succeeded, 1 any failed, 2 bad usage.`

const usage = (message: string): ParseResult => ({ kind: 'usage', message: `${message}\n\n${USAGE}` })

export function parseArgs(argv: string[]): ParseResult {
  const req: CliRequest = {
    inputs: [],
    to: 'pdf',
    merge: false,
    landscape: false,
    headerFooter: false,
    ocr: false,
    noClobber: false,
    headings: true,
  }
  let toSeen = false

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
      case '--merge':
        req.merge = true
        break
      case '--no-headings':
        req.headings = false
        break
      case '--landscape':
        req.landscape = true
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
        return usage(`Unknown flag: ${arg}`)
    }
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
