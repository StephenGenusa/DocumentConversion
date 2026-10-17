import type { SourceFormat } from './types'
import type { HubFeatures } from './rendered-blocks'
import { codeFormatFromFilename, codeNameFromFilename } from './code-langs'
import { looksLikeSvg } from './readers/image'
import { isHeic, pictureMime, pictureType, vectorMime } from './picture-types'
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

/**
 * Whether a name claims a text format: one with no binary container, a
 * picture name aside (an .svg holding a PNG is a picture by its name too),
 * or source code by its name or extension.
 */
function namedAsText(filename: string): boolean {
  if (codeNameFromFilename(filename)) return true
  const byExt = detectByExtension(filename)
  if (byExt) return !CONTAINER[byExt] && !PICTURES.has(byExt)
  return codeFormatFromFilename(filename)
}

/**
 * Bytes no text file has: a NUL, a control character other than the ones
 * text uses (tab, line ends, form feed, escape), or a byte sequence that is
 * not UTF-8, in the first 4 KiB. Every picture and binary document has one
 * of these within its header; a text file that merely starts with "GIF89a"
 * or "RIFF" has none.
 */
function hasBinaryBytes(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 4096)
  for (const b of head) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0b && b !== 0x0c && b !== 0x0d && b !== 0x1b) return true
    if (b === 0x7f) return true
  }
  try {
    // `stream` so a character cut off by the 4 KiB end is not taken for a bad one.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
    return false
  } catch {
    return true
  }
}

/**
 * A picture's structure past its signature, for the types whose signature
 * alone is short: the header that has to follow it.
 */
function pictureHeaderHolds(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/png':
      // The first chunk is always IHDR, 13 bytes long.
      return bytes.length >= 16 && bytes.readUInt32BE(8) === 13 && bytes.toString('latin1', 12, 16) === 'IHDR'
    case 'image/jpeg':
      // SOI is followed by a marker: FF then a marker code (APPn, DQT, SOF, DHT, COM...).
      return bytes.length >= 4 && bytes[3] >= 0xc0 && bytes[3] !== 0xff
    case 'image/webp':
      return bytes.length >= 16 && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('latin1', 12, 16))
    case 'image/tiff': {
      // The first directory: inside the file, with at least one entry.
      if (bytes.length < 10) return false
      const le = bytes[0] === 0x49
      const at = le ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4)
      if (at < 8 || at + 2 > bytes.length) return false
      return (le ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at)) > 0
    }
    case 'image/x-icon': {
      // The first directory entry: reserved byte 0, its data past the directory and inside the file.
      const count = bytes.readUInt16LE(4)
      if (count > 256 || bytes.length < 6 + 16 * count) return false
      const offset = bytes.readUInt32LE(18)
      return bytes[9] === 0 && offset >= 6 + 16 * count && offset < bytes.length
    }
    default:
      // GIF, BMP, AVIF, EMF, WMF: the signature check already reads past the magic.
      return true
  }
}

/**
 * The names of the streams and storages at the top of a Compound File
 * (legacy Word and Excel files, PowerPoint decks, Outlook .msg), read from its directory:
 * the header's sector size, its first FAT sectors, the directory chain, and
 * the root's children (its tree of siblings), so a workbook embedded in a
 * Word file does not name the file. Null when the structure does not hold.
 */
function cfbEntryNames(bytes: Buffer): Set<string> | null {
  if (bytes.length < 512 || !hasMagic(bytes, CFB_MAGIC)) return null
  const shift = bytes.readUInt16LE(0x1e)
  if (shift !== 9 && shift !== 12) return null
  const size = 1 << shift
  const sectorAt = (n: number): number => (n + 1) * size
  // The FAT sectors the header lists itself (109): enough for a file of ~7 MB
  // with 512-byte sectors; a directory further in is not followed.
  const fatSectors: number[] = []
  for (let i = 0; i < 109; i++) {
    const n = bytes.readUInt32LE(0x4c + i * 4)
    if (n >= 0xfffffffa) break
    fatSectors.push(n)
  }
  const perFat = size / 4
  const next = (n: number): number | null => {
    const fat = fatSectors[Math.floor(n / perFat)]
    if (fat === undefined) return null
    const at = sectorAt(fat) + (n % perFat) * 4
    return at + 4 <= bytes.length ? bytes.readUInt32LE(at) : null
  }
  // Every directory entry's offset in the file, in directory order.
  const entries: number[] = []
  const seen = new Set<number>()
  let sector: number | null = bytes.readUInt32LE(0x30)
  while (sector !== null && sector < 0xfffffffa && !seen.has(sector) && seen.size < 4096) {
    seen.add(sector)
    const start = sectorAt(sector)
    if (start + size > bytes.length) return null
    for (let at = start; at < start + size; at += 128) entries.push(at)
    sector = next(sector)
  }
  // The first entry is the root storage (type 5), whatever its name says
  // (Office writes "Root Entry"; SheetJS writes "R").
  if (entries.length === 0 || bytes[entries[0] + 66] !== 5) return null
  const names = new Set<string>()
  const visited = new Set<number>()
  const pending = [bytes.readUInt32LE(entries[0] + 76)]
  while (pending.length > 0) {
    const id = pending.pop()!
    // 0 is the root itself, never a child; NOSTREAM (0xFFFFFFFF) is past the end.
    if (id === 0 || id >= entries.length || visited.has(id)) continue
    visited.add(id)
    const at = entries[id]
    const length = bytes.readUInt16LE(at + 64)
    if (length < 2 || length > 64 || length % 2 !== 0 || ![1, 2].includes(bytes[at + 66])) return null
    names.add(bytes.toString('utf16le', at, at + length - 2))
    pending.push(bytes.readUInt32LE(at + 68), bytes.readUInt32LE(at + 72))
  }
  return names
}

/** Which Compound File this is, by the streams it holds; null when none this app knows. */
function cfbKind(bytes: Buffer): 'doc' | 'xls' | 'msg' | 'ppt' | null {
  const names = cfbEntryNames(bytes)
  if (!names) return null
  if (names.has('WordDocument')) return 'doc'
  if (names.has('Workbook') || names.has('Book')) return 'xls'
  if (names.has('PowerPoint Document')) return 'ppt'
  if ([...names].some((n) => n.startsWith('__substg1.0_') || n === '__properties_version1.0')) return 'msg'
  return null
}

/** The zip formats a text name may give way to (an archive does not: see `unmistakablyBinary`). */
const ZIP_DOCUMENTS: ReadonlySet<SourceFormat> = new Set<SourceFormat>(['docx', 'xlsx', 'pptx', 'epub', 'odt', 'odp'])

/** A zip's end-of-central-directory record, in the last 64 KiB (its comment's limit) and a bit. */
function hasZipEnd(bytes: Buffer): boolean {
  const from = Math.max(0, bytes.length - 65_557)
  return bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), bytes.length - 22) >= from
}

/**
 * What a file named as text really is, when its bytes say so beyond doubt
 * (owner, 2026-10-17): a picture, a PDF, an Office or OpenDocument file, an
 * EPUB, a legacy Office or Outlook file. Null for anything that could be
 * text, which keeps its name.
 *
 * Beyond doubt means the whole signature and the structure behind it, never a
 * magic prefix alone: a picture also needs its header (pictureHeaderHolds)
 * and bytes no text has (hasBinaryBytes), so notes starting "GIF89a" or
 * "BM" stay notes; a zip needs its end record and the part that names the
 * format; a Compound File needs a directory naming its streams; a PDF needs
 * binary bytes or its `%%EOF` at the end. Formats that are text themselves
 * (SVG, HTML, RTF) are left to the name: a .txt of SVG markup is source to read.
 * A plain zip named .txt is not expanded either: nothing says it was meant to be.
 */
export function unmistakablyBinary(bytes: Buffer): DetectResult | null {
  const picture = pictureMime(bytes)
  if (picture) return pictureHeaderHolds(bytes, picture) && hasBinaryBytes(bytes) ? ok('image') : null
  if (vectorMime(bytes)) return hasBinaryBytes(bytes) ? ok('metafile') : null
  if (/^%PDF-\d\.\d/.test(bytes.toString('latin1', 0, 8))) {
    const tail = bytes.toString('latin1', Math.max(0, bytes.length - 2048))
    return hasBinaryBytes(bytes) || tail.includes('%%EOF') ? ok('pdf') : null
  }
  if (hasMagic(bytes, CFB_MAGIC)) {
    const kind = cfbKind(bytes)
    if (kind === 'ppt') return unsupported('Legacy PowerPoint (.ppt) is not supported')
    if (kind === 'xls') return ok('xlsx')
    return kind ? ok(kind) : null
  }
  if (bytes.length >= 30 && bytes.toString('latin1', 0, 4) === 'PK\x03\x04' && hasZipEnd(bytes)) {
    const sniffed = sniffBinary(bytes)
    return sniffed?.kind === 'ok' && ZIP_DOCUMENTS.has(sniffed.format) ? sniffed : null
  }
  return null
}

const PICTURE_NAMES: Record<string, string> = {
  'image/png': 'a PNG picture',
  'image/jpeg': 'a JPEG picture',
  'image/gif': 'a GIF picture',
  'image/webp': 'a WebP picture',
  'image/bmp': 'a BMP picture',
  'image/avif': 'an AVIF picture',
  'image/x-icon': 'an icon (ICO) picture',
  'image/tiff': 'a TIFF picture',
  'image/x-emf': 'an EMF drawing',
  'image/x-wmf': 'a WMF drawing',
}

const DOCUMENT_NAMES: Partial<Record<SourceFormat, string>> = {
  pdf: 'a PDF document',
  docx: 'a Word document',
  xlsx: 'a spreadsheet',
  pptx: 'a PowerPoint presentation',
  epub: 'an EPUB e-book',
  odt: 'an OpenDocument text',
  odp: 'an OpenDocument presentation',
  doc: 'a Word 97-2003 document',
  msg: 'an Outlook message',
}

/**
 * The notice for a file named as text but read by its contents: "This file
 * is named .txt but is a TIFF picture; read as a picture." Null when the
 * name and the reading agree, or the reading was not the bytes' doing.
 */
export function misnamedNotice(bytes: Buffer, filename: string | undefined, format: SourceFormat): string | null {
  if (!filename || !namedAsText(filename)) return null
  const found = unmistakablyBinary(bytes)
  if (found?.kind !== 'ok' || found.format !== format) return null
  const ext = /\.([^.\\/]+)$/.exec(filename.trim())?.[1]
  const named = ext ? `named .${ext.toLowerCase()}` : `named ${(filename.split(/[\\/]/).pop() ?? filename).trim()}`
  const type = pictureType(bytes)
  const what = type ? PICTURE_NAMES[type] : DOCUMENT_NAMES[format]
  if (!what) return null
  return `This file is ${named} but is ${what}; read as ${type ? 'a picture' : 'one'}.`
}

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
    // A text name on a file that is beyond doubt a picture or a binary
    // document: the bytes win (see `unmistakablyBinary`).
    const binary = namedAsText(filename) ? unmistakablyBinary(bytes) : null
    if (binary) return binary
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
