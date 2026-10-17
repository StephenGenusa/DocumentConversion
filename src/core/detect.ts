import type { SourceFormat } from './types'
import type { HubFeatures } from './rendered-blocks'
import { codeFormatFromFilename, codeNameFromFilename } from './code-langs'
import { looksLikeSvg } from './readers/image'
import { isHeic, pictureMime, vectorMime } from './picture-types'
import { hasSqliteMagic } from './sqlite'
import { EXTENSION_FORMATS } from './extensions'

export type DetectResult =
  | {
      kind: 'ok'
      format: SourceFormat
      /** JSON that reads as a table of records (added by the main process). */
      jsonTable?: boolean
      /** A SQLite database's number of views (added by the main process). */
      viewCount?: number
      /** Diagrams and formulas it holds (added by the main process; features-hint.ts). */
      features?: HubFeatures
    }
  | { kind: 'archive' }
  | { kind: 'unsupported'; reason: string }

const ok = (format: SourceFormat): DetectResult => ({ kind: 'ok', format })
const archive = (): DetectResult => ({ kind: 'archive' })
const unsupported = (reason: string): DetectResult => ({ kind: 'unsupported', reason })


export function detectByExtension(filename: string): SourceFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim())
  if (!m) return null
  return EXTENSION_FORMATS.get(m[1].toLowerCase()) ?? null
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function hasMagic(bytes: Buffer, magic: number[]): boolean {
  if (bytes.length < magic.length) return false
  return magic.every((b, i) => bytes[i] === b)
}

/**
 * Magic-byte pass. Order matters: specific OOXML part names run before any
 * generic ZIP handling so xlsx/pptx are never mistaken for docx.
 */
export function sniffBinary(bytes: Buffer, filename?: string): DetectResult | null {
  if (hasSqliteMagic(bytes)) return ok('sqlite')
  if (pictureMime(bytes)) return ok('image')
  if (vectorMime(bytes)) return ok('metafile')
  if (isHeic(bytes)) return unsupported('HEIC pictures (as iPhones save them) cannot be read here; save it as JPEG first')
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '%PDF-') return ok('pdf')
  if (hasMagic(bytes, CFB_MAGIC)) {
    // Outlook .msg, legacy Excel and legacy Word are all CFB; the extension disambiguates them.
    if (filename && /\.msg$/i.test(filename.trim())) return ok('msg')
    if (filename && /\.xls[xmb]?$/i.test(filename.trim())) return ok('xlsx')
    // A Word 97 file saved with a .docx name is common; the bytes decide.
    if (filename && /\.docx?$/i.test(filename.trim())) return ok('doc')
    return unsupported('Legacy PowerPoint (.ppt) is not supported; other legacy Office files need their extension')
  }
  // An empty zip starts with the end-of-central-directory record, not a local
  // file header, but it is still an archive.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x05 && bytes[3] === 0x06) {
    return archive()
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    // ZIP entry names appear verbatim in local file headers; ODF containers
    // additionally store an uncompressed `mimetype` entry near the start.
    const names = bytes.toString('latin1')
    if (names.includes('mimetypeapplication/epub+zip') || names.includes('META-INF/container.xml')) return ok('epub')
    const odf = /mimetypeapplication\/vnd\.oasis\.opendocument\.([a-z]+)/.exec(names)
    if (odf) {
      if (odf[1] === 'spreadsheet') return ok('xlsx')
      if (odf[1] === 'text') return ok('odt')
      if (odf[1] === 'presentation') return ok('odp')
      return unsupported(`OpenDocument ${odf[1]} files are not supported`)
    }
    if (names.includes('xl/workbook.xml')) return ok('xlsx')
    if (names.includes('ppt/presentation.xml') || names.includes('ppt/slides/slide')) return ok('pptx')
    if (names.includes('word/document.xml')) return ok('docx')
    // Any other zip is an archive to expand into separate inputs.
    return archive()
  }
  const head = bytes.toString('utf8', 0, 512).trimStart()
  // RTF is a magic-byte format: an extensionless or misnamed one must not be
  // read as plain text, or its control words land in the output verbatim.
  if (head.startsWith('{\\rtf')) return ok('rtf')
  const lower = head.toLowerCase()
  if (lower.startsWith('<!doctype html') || lower.startsWith('<html')) return ok('html')
  // After html: a page is never an SVG, while an SVG's prolog can look like anything XML.
  if (looksLikeSvg(bytes)) return ok('svg')
  return null
}

const MD_PATTERNS: RegExp[] = [
  /^#{1,6}\s+\S/m, // ATX heading
  /^\s*[-*+]\s+\S/m, // bullet list
  /^\s*\d+\.\s+\S/m, // ordered list
  /```/, // fenced code
  /\[[^\]]+\]\([^)]+\)/, // link/image
  /(\*\*|__)[^*_]+\1/, // bold
  /^\s*>\s+\S/m, // blockquote
  /^\s*\|.+\|\s*$/m, // table row
]

export function looksLikeMarkdown(text: string): boolean {
  return MD_PATTERNS.some((re) => re.test(text))
}

/**
 * File-only heuristic (never applied to pasted text — comma-laden prose is
 * common there): >= 2 non-empty lines, every line with the identical field
 * count >= 2 for one consistent delimiter.
 */
export function looksLikeCsv(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return false
  for (const delim of [',', ';', '\t']) {
    const counts = lines.map((l) => l.split(delim).length)
    if (counts[0] >= 2 && counts.every((c) => c === counts[0])) return true
  }
  return false
}

/**
 * RFC-5322 header block: >= 3 header lines before the first blank line,
 * including From: and at least one of To:/Subject:/Received: (requirement,
 * not example — bare key:value notes must not match).
 */
export function looksLikeEml(text: string): boolean {
  const lines = text.split(/\r?\n/)
  const headerLines: string[] = []
  for (const line of lines) {
    if (line.trim() === '') break
    headerLines.push(line)
  }
  const headers = headerLines.filter((l) => /^[A-Za-z][A-Za-z-]*:\s/.test(l))
  if (headers.length < 3) return false
  const hasFrom = headers.some((l) => /^From:/i.test(l))
  const hasOther = headers.some((l) => /^(To|Subject|Received):/i.test(l))
  return hasFrom && hasOther
}

/**
 * An mbox opens with a `From ` separator line and the message that follows
 * carries real RFC-5322 headers — both are required so prose beginning with
 * "From the desk of…" is not mistaken for an archive.
 */
export function looksLikeMbox(text: string): boolean {
  if (!/^From \S+/.test(text)) return false
  return /^From:\s*\S+/m.test(text) && /^(To|Subject|Date):\s*\S+/m.test(text)
}

/**
 * Notebook JSON, for files that arrive without the .ipynb extension. The check
 * is structural: a substring match would route any JSON whose string VALUES
 * mention cells/nbformat to the notebook reader.
 */
export function looksLikeNotebook(text: string): boolean {
  const head = text.trimStart()
  if (!head.startsWith('{')) return false
  if (!head.includes('"cells"') && !head.includes('"worksheets"')) return false
  try {
    const parsed = JSON.parse(head) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) return false
    if (parsed.nbformat === undefined) return false
    return Array.isArray(parsed.cells) || Array.isArray(parsed.worksheets)
  } catch {
    return false
  }
}

/**
 * The container each binary format arrives in. Formats sharing one are not
 * evidence against each other. A format absent here is text, where the
 * extension is always authoritative: text formats overlap by design (an .md
 * file is also valid .txt), so `looksLike…` is a guess, never a correction.
 */
const CONTAINER: Partial<Record<SourceFormat, 'zip' | 'cfb' | 'pdf' | 'image' | 'rtf' | 'sqlite'>> = {
  docx: 'zip',
  xlsx: 'zip',
  pptx: 'zip',
  epub: 'zip',
  odt: 'zip',
  odp: 'zip',
  // Compound File Binary: legacy Word and Excel, and Outlook .msg.
  doc: 'cfb',
  msg: 'cfb',
  pdf: 'pdf',
  // Pictures, raster or vector: PICTURES (below) chooses between them by their bytes.
  image: 'image',
  metafile: 'image',
  rtf: 'rtf',
  sqlite: 'sqlite',
}

/**
 * The part whose presence proves a zip really is this format. Deliberately the
 * same names `sniffBinary` looks for, read the same way.
 */
const ZIP_PART: Partial<Record<SourceFormat, RegExp>> = {
  docx: /word\/document\.xml/,
  xlsx: /xl\/workbook\.xml|mimetypeapplication\/vnd\.oasis\.opendocument\.spreadsheet/,
  pptx: /ppt\/presentation\.xml|ppt\/slides\/slide/,
  epub: /mimetypeapplication\/epub\+zip|META-INF\/container\.xml/,
  odt: /mimetypeapplication\/vnd\.oasis\.opendocument\.text/,
  odp: /mimetypeapplication\/vnd\.oasis\.opendocument\.presentation/,
}

/**
 * Do the bytes rule the extension OUT?
 *
 * One-sided, and that is the whole point. Content may correct an extension
 * that LIES — a Word 97 file saved as .docx is a CFB file and unzipping it
 * will never work — but it may not correct one that tells the truth, and the
 * old test could not tell those apart: it asked whether the two ANSWERS
 * differed, which is symmetric, so any sniff outranked any extension as soon
 * as both named a binary format.
 *
 * They differ harmlessly all the time. For the zip formats the sniff is a
 * substring scan for a part name over the whole file, and one OOXML container
 * legitimately carries another's parts: a Word document with a chart stores
 * the chart's workbook whole, `xl/workbook.xml` included, and that name is
 * looked for BEFORE `word/document.xml`. So a correctly named .docx sniffed as
 * a spreadsheet and went to the spreadsheet reader.
 *
 * The question asked here is about the extension alone. The container has to
 * be the one the extension needs, and — inside the zip family, where the
 * container proves nothing by itself — the part the extension names has to be
 * in there. Anything else the file also carries is not evidence against it.
 */
function rulesOutExtension(bytes: Buffer, byExtension: SourceFormat, sniffed: SourceFormat): boolean {
  const named = CONTAINER[byExtension]
  // The extension named a text format, or the sniff found no container at all
  // (an html sniff): nothing here can outrank the extension.
  if (!named || !CONTAINER[sniffed]) return false
  if (named !== CONTAINER[sniffed]) return true
  if (named !== 'zip') return false
  const part = ZIP_PART[byExtension]
  return part !== undefined && !part.test(bytes.toString('latin1'))
}

/** The picture formats: the bytes choose between them, whatever the name says. */
const PICTURES: ReadonlySet<SourceFormat> = new Set<SourceFormat>(['image', 'svg', 'metafile'])

/** `BEGIN:VCARD` on one of a file's first lines. */
export function looksLikeVcard(bytes: Buffer): boolean {
  const head = bytes.toString('utf8', 0, 1024).replace(/^\ufeff/, '').split(/\r?\n/).slice(0, 5)
  return head.some((l) => /^\s*BEGIN:VCARD\s*$/i.test(l))
}

export function detect(bytes: Buffer, filename?: string): DetectResult {
  // A SQLite database is what its first 16 bytes say, whatever its name
  // (.db, .sqlite3, an app's own extension, none), so this runs before any
  // extension is looked at. The magic ends in a NUL: no text file has it.
  if (hasSqliteMagic(bytes)) return ok('sqlite')
  if (filename) {
    // .zip is an acquisition method, not a SourceFormat, so it is matched here
    // rather than through the extension map (an empty zip has no PK\x03\x04).
    if (/\.zip$/i.test(filename.trim())) return archive()
    if (codeNameFromFilename(filename)) return ok('code')
    const byExt = detectByExtension(filename)
    if (byExt) {
      // The extension normally wins, but it can lie — a Word 97 file saved as
      // .docx used to be refused with a raw zip error. Believe the bytes only
      // where they rule the extension out; see `rulesOutExtension`.
      const sniffed = sniffBinary(bytes, filename)
      // An image's name says it is a picture; the bytes say whether a raster
      // one, an SVG or an EMF/WMF (a .png that is really an SVG, an .emf that is a PNG).
      if (sniffed?.kind === 'ok' && PICTURES.has(byExt) && PICTURES.has(sniffed.format)) return sniffed
      if (sniffed?.kind === 'ok' && sniffed.format !== byExt && rulesOutExtension(bytes, byExt, sniffed.format)) {
        return sniffed
      }
      // A .vcf that is not a vCard is a genomics Variant Call Format file:
      // tab-separated text, read as text rather than refused.
      if (byExt === 'vcard' && /\.vcf$/i.test(filename.trim()) && !looksLikeVcard(bytes)) return ok('txt')
      return ok(byExt)
    }
    if (codeFormatFromFilename(filename)) return ok('code')
  }
  const sniffed = sniffBinary(bytes, filename)
  if (sniffed) return sniffed
  const text = bytes.toString('utf8')
  if (/^BEGIN:VCALENDAR/im.test(text.slice(0, 512))) return ok('ics')
  if (looksLikeVcard(bytes)) return ok('vcard')
  if (/^\ufeff?WEBVTT(?:[ \t]|\r?\n|$)/.test(text)) return ok('subtitles')
  if (looksLikeNotebook(text)) return ok('ipynb')
  if (looksLikeMbox(text)) return ok('mbox')
  if (looksLikeEml(text)) return ok('eml')
  if (looksLikeMarkdown(text)) return ok('md')
  if (filename && looksLikeCsv(text)) return ok('csv')
  return ok('txt')
}
