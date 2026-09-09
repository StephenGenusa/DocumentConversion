import type { SourceFormat } from './types'
import { codeFormatFromFilename } from './code-langs'
import { imageMime } from './readers/image'

export type DetectResult =
  | { kind: 'ok'; format: SourceFormat }
  | { kind: 'archive' }
  | { kind: 'unsupported'; reason: string }

const ok = (format: SourceFormat): DetectResult => ({ kind: 'ok', format })
const archive = (): DetectResult => ({ kind: 'archive' })
const unsupported = (reason: string): DetectResult => ({ kind: 'unsupported', reason })

/**
 * Extension → format. A Map, not an object literal: the key comes off a
 * filename, and a plain literal inherits `Object.prototype`, so a file called
 * `report.constructor` would look up a FUNCTION and `?? null` would keep it.
 */
const EXT_MAP = new Map<string, SourceFormat>(
  Object.entries({
    txt: 'txt',
    text: 'txt',
    md: 'md',
    markdown: 'md',
    docx: 'docx',
    pdf: 'pdf',
    html: 'html',
    htm: 'html',
    csv: 'csv',
    tsv: 'csv',
    xlsx: 'xlsx',
    // SheetJS reads legacy .xls and OpenDocument .ods with the same reader.
    xls: 'xlsx',
    ods: 'xlsx',
    odt: 'odt',
    odp: 'odp',
    ics: 'ics',
    ical: 'ics',
    adoc: 'asciidoc',
    asciidoc: 'asciidoc',
    asc: 'asciidoc',
    rst: 'rst',
    // mammoth reads macro-enabled Word documents like any other .docx.
    docm: 'docx',
    ipynb: 'ipynb',
    msg: 'msg',
    pptx: 'pptx',
    pptm: 'pptx',
    doc: 'doc',
    epub: 'epub',
    mbox: 'mbox',
    rtf: 'rtf',
    eml: 'eml',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
  } satisfies Record<string, SourceFormat>),
)

export function detectByExtension(filename: string): SourceFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim())
  if (!m) return null
  return EXT_MAP.get(m[1].toLowerCase()) ?? null
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
  if (imageMime(bytes)) return ok('image')
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
const CONTAINER: Partial<Record<SourceFormat, 'zip' | 'cfb' | 'pdf' | 'image' | 'rtf'>> = {
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
  image: 'image',
  rtf: 'rtf',
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

export function detect(bytes: Buffer, filename?: string): DetectResult {
  if (filename) {
    // .zip is an acquisition method, not a SourceFormat, so it is matched here
    // rather than through the extension map (an empty zip has no PK\x03\x04).
    if (/\.zip$/i.test(filename.trim())) return archive()
    const byExt = detectByExtension(filename)
    if (byExt) {
      // The extension normally wins, but it can lie — a Word 97 file saved as
      // .docx used to be refused with a raw zip error. Believe the bytes only
      // where they rule the extension out; see `rulesOutExtension`.
      const sniffed = sniffBinary(bytes, filename)
      if (sniffed?.kind === 'ok' && sniffed.format !== byExt && rulesOutExtension(bytes, byExt, sniffed.format)) {
        return sniffed
      }
      return ok(byExt)
    }
    if (codeFormatFromFilename(filename)) return ok('code')
  }
  const sniffed = sniffBinary(bytes, filename)
  if (sniffed) return sniffed
  const text = bytes.toString('utf8')
  if (/^BEGIN:VCALENDAR/im.test(text.slice(0, 512))) return ok('ics')
  if (looksLikeNotebook(text)) return ok('ipynb')
  if (looksLikeMbox(text)) return ok('mbox')
  if (looksLikeEml(text)) return ok('eml')
  if (looksLikeMarkdown(text)) return ok('md')
  if (filename && looksLikeCsv(text)) return ok('csv')
  return ok('txt')
}
