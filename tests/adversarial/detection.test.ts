/**
 * ADVERSARIAL detection / archive tests.
 *
 * Every expectation in this file is derived ONLY from the written specs:
 *   - docs/superpowers/specs/2026-08-31-io-expansion-design.md  (§2.5, F17 refs)
 *   - docs/superpowers/specs/2026-08-31-format-additions-design.md   (F13–F17)
 *   - docs/superpowers/specs/2026-08-31-format-additions-2-design.md (F18–F22)
 *   - docs/superpowers/specs/2026-07-12-docconversion-design.md      (§3 base rules)
 *
 * The controlling text is §2.5 "Detection: ordered rules", first match wins:
 *   1. Extension pass
 *   2. Magic-byte pass (PNG/JPEG/GIF/WebP -> image; %PDF- -> pdf; CFB; ZIP part
 *      names in the order xl/workbook.xml, ppt/presentation.xml,
 *      word/document.xml; {\rtf; <!doctype html>/<html)
 *   3. Text heuristics (eml, markdown, csv [file-only], txt fallback)
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'

import {
  detect,
  detectByExtension,
  sniffBinary,
  looksLikeMarkdown,
  looksLikeCsv,
  looksLikeEml,
  looksLikeMbox,
  looksLikeNotebook,
} from '../../src/core/detect'
import {
  expandZipArchive,
  isUnsafeArchivePath,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_ENTRY_BYTES,
} from '../../src/core/zip-expand'
import { resolveExport } from '../../src/core/interop'

// ---------------------------------------------------------------- fixtures

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8')

/** PDF: %PDF- magic (§2.5 rule 2). */
const PDF_BYTES = utf8('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')

/** PNG 8-byte signature. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x11),
])
/** JPEG SOI + APP0. */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  utf8('JFIF\0'),
  Buffer.alloc(64, 0x22),
])
const GIF_BYTES = Buffer.concat([utf8('GIF89a'), Buffer.alloc(64, 0x33)])
const webp = (): Buffer => {
  const b = Buffer.alloc(64, 0x44)
  utf8('RIFF').copy(b, 0)
  b.writeUInt32LE(56, 4)
  utf8('WEBP').copy(b, 8)
  utf8('VP8 ').copy(b, 12)
  return b
}
const WEBP_BYTES = webp()
/** RIFF container that is NOT WebP — a .wav. Must not be claimed as image. */
const WAV_BYTES = (() => {
  const b = Buffer.alloc(64, 0x55)
  utf8('RIFF').copy(b, 0)
  b.writeUInt32LE(56, 4)
  utf8('WAVEfmt ').copy(b, 8)
  return b
})()

/** CFB / OLE2 compound-file magic (§2.5 rule 2). */
const CFB_BYTES = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(512, 0x00),
])

const RTF_BYTES = utf8('{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Arial;}}\\f0 Hello\\par}')

type ZipSpec = Record<string, string | Buffer>

/** Build a zip. `mimetype` is stored (STORE) as ODF/EPUB require. */
async function makeZip(entries: ZipSpec): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content, {
      compression: name === 'mimetype' ? 'STORE' : 'DEFLATE',
    })
  }
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
}

const CT = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`

const docxParts = (): ZipSpec => ({
  '[Content_Types].xml': CT,
  '_rels/.rels': '<Relationships/>',
  'word/document.xml': '<w:document><w:body/></w:document>',
})
const xlsxParts = (): ZipSpec => ({
  '[Content_Types].xml': CT,
  '_rels/.rels': '<Relationships/>',
  'xl/workbook.xml': '<workbook><sheets/></workbook>',
})
const pptxParts = (): ZipSpec => ({
  '[Content_Types].xml': CT,
  '_rels/.rels': '<Relationships/>',
  'ppt/presentation.xml': '<p:presentation/>',
  'ppt/slides/slide1.xml': '<p:sld/>',
})

const okFormat = (r: unknown): string | undefined =>
  r && (r as { kind: string }).kind === 'ok' ? (r as { format: string }).format : undefined

// ============================================================= 1. PRECEDENCE
// §2.5: "Rules run in this exact order (first match wins)" with the extension
// pass as rule 1. So a known extension must beat contradicting magic bytes.

describe('§2.5 rule 1 beats rule 2: extension wins over magic bytes', () => {
  it('PDF bytes named notes.md detect as md (extension pass first)', () => {
    expect(detect(PDF_BYTES, 'notes.md')).toEqual({ kind: 'ok', format: 'md' })
  })

  it('PNG bytes named data.csv detect as csv (extension pass first)', () => {
    expect(detect(PNG_BYTES, 'data.csv')).toEqual({ kind: 'ok', format: 'csv' })
  })

  it('RTF bytes named notes.txt detect as txt (extension pass first)', () => {
    expect(detect(RTF_BYTES, 'notes.txt')).toEqual({ kind: 'ok', format: 'txt' })
  })

  it('a docx zip named notes.txt detects as txt (extension pass first)', async () => {
    const bytes = await makeZip(docxParts())
    expect(detect(bytes, 'notes.txt')).toEqual({ kind: 'ok', format: 'txt' })
  })

  it('HTML text named readme.md detects as md (extension pass first)', () => {
    expect(detect(utf8('<!doctype html><html><body>hi</body></html>'), 'readme.md')).toEqual({
      kind: 'ok',
      format: 'md',
    })
  })

  it('plain prose named report.pdf detects as pdf (extension pass first)', () => {
    expect(detect(utf8('Just some prose, nothing binary here.\n'), 'report.pdf')).toEqual({
      kind: 'ok',
      format: 'pdf',
    })
  })
})

// ================================================= 2. EXTENSION PASS DETAILS

/**
 * The rule-1 contract belongs to detect(): "known extensions map directly".
 * Neutral prose bytes carry no magic and no strong heuristic, so whatever
 * detect() returns here came from the extension pass alone.
 */
const NEUTRAL = utf8('hello world\nthis is ordinary prose\n')
const byExt = (name: string): unknown => detect(NEUTRAL, name)

describe('§2.5 rule 1: extension pass (through detect())', () => {
  it('is case-insensitive for .MD', () => {
    expect(byExt('NOTES.MD')).toEqual({ kind: 'ok', format: 'md' })
  })
  it('is case-insensitive for .PDF', () => {
    expect(byExt('REPORT.PDF')).toEqual({ kind: 'ok', format: 'pdf' })
  })
  it('is case-insensitive for .CSV', () => {
    expect(byExt('DATA.CSV')).toEqual({ kind: 'ok', format: 'csv' })
  })
  it('maps .markdown to md (base spec §3)', () => {
    expect(byExt('a.markdown')).toEqual({ kind: 'ok', format: 'md' })
  })
  it('maps .htm to html (base spec §3)', () => {
    expect(byExt('a.htm')).toEqual({ kind: 'ok', format: 'html' })
  })
  it('maps .tsv to csv — .tsv is a listed known extension, and no tsv SourceFormat exists', () => {
    expect(byExt('a.tsv')).toEqual({ kind: 'ok', format: 'csv' })
  })
  it('maps .eml (§2.5 rule 1 list)', () => {
    expect(byExt('a.eml')).toEqual({ kind: 'ok', format: 'eml' })
  })
  it('maps .msg (§2.5 rule 1 list: ".msg" is named as a directly-mapped extension)', () => {
    expect(byExt('a.msg')).toEqual({ kind: 'ok', format: 'msg' })
  })
  it('maps .rtf (§2.5 rule 1 list)', () => {
    expect(byExt('a.rtf')).toEqual({ kind: 'ok', format: 'rtf' })
  })
  it('maps .ipynb to ipynb (F13)', () => {
    expect(byExt('nb.ipynb')).toEqual({ kind: 'ok', format: 'ipynb' })
  })
  it('maps .ods to xlsx (F15: ".ods extension -> xlsx")', () => {
    expect(byExt('sheet.ods')).toEqual({ kind: 'ok', format: 'xlsx' })
  })
  it('maps .docm to docx (F16: "extension mapping docm -> docx")', () => {
    expect(byExt('macro.docm')).toEqual({ kind: 'ok', format: 'docx' })
  })
  it('maps .pptx / .pptm to pptx (F18 lists both)', () => {
    expect(byExt('deck.pptx')).toEqual({ kind: 'ok', format: 'pptx' })
    expect(byExt('deck.pptm')).toEqual({ kind: 'ok', format: 'pptx' })
  })
  it('maps .epub to epub (F20)', () => {
    expect(byExt('book.epub')).toEqual({ kind: 'ok', format: 'epub' })
  })
  it('maps .mbox to mbox (F21)', () => {
    expect(byExt('mail.mbox')).toEqual({ kind: 'ok', format: 'mbox' })
  })
  it('maps .doc to doc (F19: "Detection: .doc extension")', () => {
    expect(byExt('letter.doc')).toEqual({ kind: 'ok', format: 'doc' })
  })
  it('maps code-allowlist extensions to code (F7)', () => {
    for (const name of ['a.ts', 'a.py', 'a.rs', 'a.ps1', 'a.yaml', 'a.sql'])
      expect([name, okFormat(detect(NEUTRAL, name))]).toEqual([name, 'code'])
  })
  it('maps uppercase code extensions to code (F7 allowlist, case-insensitive)', () => {
    expect(byExt('SCRIPT.PY')).toEqual({ kind: 'ok', format: 'code' })
  })
  it('maps Dockerfile and Makefile by filename (F7)', () => {
    expect(byExt('Dockerfile')).toEqual({ kind: 'ok', format: 'code' })
    expect(byExt('Makefile')).toEqual({ kind: 'ok', format: 'code' })
  })
  it('does NOT map .html/.htm to code — F7 says they keep routing to the html reader', () => {
    expect(byExt('page.html')).toEqual({ kind: 'ok', format: 'html' })
  })
  it('uses the LAST dot for multi-dot names', () => {
    expect(detectByExtension('my.file.name.csv')).toBe('csv')
  })
  it('returns null for an unknown extension', () => {
    expect(detectByExtension('archive.tar.gz')).toBeNull()
  })
  it('returns null for a bare name with no extension', () => {
    expect(detectByExtension('README')).toBeNull()
  })
  it('handles a POSIX directory path', () => {
    expect(detectByExtension('/home/me/docs/notes.md')).toBe('md')
  })
  it('handles a Windows directory path', () => {
    expect(detectByExtension('C:\\Users\\me\\Documents\\notes.md')).toBe('md')
  })
  it('handles a Windows path whose DIRECTORY contains a dot', () => {
    expect(detectByExtension('C:\\Users\\me\\v1.2\\notes.md')).toBe('md')
  })
  it('does not treat a directory-only dot as the file extension', () => {
    // "release.v2/README" has no file extension at all.
    expect(detectByExtension('release.v2/README')).toBeNull()
  })
  it('tolerates trailing whitespace in a filename', () => {
    expect(detectByExtension('notes.md ')).toBe('md')
  })
  it('treats a dotfile as having no extension, not an extension of "gitignore"', () => {
    expect(detectByExtension('.gitignore')).not.toBe('code')
  })
})

// =============================================== 3. MAGIC BYTES (rule 2)

describe('§2.5 rule 2: image magic', () => {
  it('PNG magic with no filename -> image', () => {
    expect(detect(PNG_BYTES)).toEqual({ kind: 'ok', format: 'image' })
  })
  it('JPEG magic with no filename -> image', () => {
    expect(detect(JPEG_BYTES)).toEqual({ kind: 'ok', format: 'image' })
  })
  it('GIF magic with no filename -> image', () => {
    expect(detect(GIF_BYTES)).toEqual({ kind: 'ok', format: 'image' })
  })
  it('WebP (RIFF....WEBP) with no filename -> image', () => {
    expect(detect(WEBP_BYTES)).toEqual({ kind: 'ok', format: 'image' })
  })
  it('a RIFF/WAVE file is NOT an image (RIFF alone must not match the WebP rule)', () => {
    expect(okFormat(detect(WAV_BYTES))).not.toBe('image')
  })
})

describe('§2.5 rule 2: pdf / rtf / html magic', () => {
  it('%PDF- with no filename -> pdf', () => {
    expect(detect(PDF_BYTES)).toEqual({ kind: 'ok', format: 'pdf' })
  })
  it('{\\rtf with no filename -> rtf', () => {
    expect(detect(RTF_BYTES)).toEqual({ kind: 'ok', format: 'rtf' })
  })
  it('leading <!doctype html> -> html (case-insensitive)', () => {
    expect(detect(utf8('<!DOCTYPE HTML>\n<body>x</body>'))).toEqual({ kind: 'ok', format: 'html' })
  })
  it('leading <html -> html', () => {
    expect(detect(utf8('<html><body>x</body></html>'))).toEqual({ kind: 'ok', format: 'html' })
  })
  it('leading whitespace/newlines before <html still detect html', () => {
    expect(detect(utf8('\n\n   <html><body>x</body></html>'))).toEqual({
      kind: 'ok',
      format: 'html',
    })
  })
  it('markdown that MENTIONS <html> later is NOT html (the rule is a LEADING match)', () => {
    const md = '# Escaping tags\n\nUse the `<html>` element to open a document.\n\n- one\n- two\n'
    expect(okFormat(detect(utf8(md)))).not.toBe('html')
  })
  it('a %PDF- marker that is not at the start does not make it a pdf', () => {
    expect(okFormat(detect(utf8('This document explains the %PDF-1.7 header format.\n')))).not.toBe(
      'pdf',
    )
  })
})

describe('§2.5 rule 2: CFB disambiguation (+F14 .xls, +F19 .doc)', () => {
  it('CFB with NO filename -> unsupported (legacy Office)', () => {
    const r = detect(CFB_BYTES)
    expect(r.kind).toBe('unsupported')
  })
  it('the unsupported reason names the legacy Office situation', () => {
    const r = detect(CFB_BYTES) as { kind: 'unsupported'; reason: string }
    expect(r.reason.toLowerCase()).toMatch(/legacy|\.doc|\.xls|office/)
  })
  it('CFB with an unrelated extension -> unsupported', () => {
    expect(detect(CFB_BYTES, 'blob.bin').kind).toBe('unsupported')
  })
  it('CFB + .msg -> msg', () => {
    expect(detect(CFB_BYTES, 'mail.msg')).toEqual({ kind: 'ok', format: 'msg' })
  })
  it('CFB + .xls -> xlsx (F14)', () => {
    expect(detect(CFB_BYTES, 'book.xls')).toEqual({ kind: 'ok', format: 'xlsx' })
  })
  it('CFB + .doc -> doc (F19)', () => {
    expect(detect(CFB_BYTES, 'letter.doc')).toEqual({ kind: 'ok', format: 'doc' })
  })
  it('CFB + .ppt -> unsupported (legacy .ppt is explicitly out of scope, F-round-2)', () => {
    expect(detect(CFB_BYTES, 'deck.ppt').kind).toBe('unsupported')
  })
  it('treats .xls as an extension-pass mapping, ahead of any content sniff', () => {
    // RULING: F14's wording implied the magic pass owned .xls, contradicting
    // rule 1's "first match wins". The extension pass owns it, like every
    // other known extension; a mislabelled file then fails in the reader with
    // a format-specific error rather than being silently read as something
    // else. Recorded in the round-3 spec addendum.
    expect(okFormat(detect(utf8('a,b\n1,2\n'), 'book.xls'))).toBe('xlsx')
  })
})

// ============================== 4. ZIP CONTAINER DISAMBIGUATION (rule 2)

describe('§2.5 rule 2: OOXML zip part-name order (xl -> ppt -> word)', () => {
  it('xl/workbook.xml -> xlsx', async () => {
    expect(detect(await makeZip(xlsxParts()))).toEqual({ kind: 'ok', format: 'xlsx' })
  })
  it('word/document.xml -> docx', async () => {
    expect(detect(await makeZip(docxParts()))).toEqual({ kind: 'ok', format: 'docx' })
  })
  it('ppt/presentation.xml -> pptx (F18 replaces the old unsupported rejection)', async () => {
    expect(detect(await makeZip(pptxParts()))).toEqual({ kind: 'ok', format: 'pptx' })
  })
  it('word FIRST in the zip but xl also present -> xlsx (rule order, not byte order)', async () => {
    const bytes = await makeZip({
      ...docxParts(),
      'xl/workbook.xml': '<workbook/>',
    })
    expect(detect(bytes)).toEqual({ kind: 'ok', format: 'xlsx' })
  })
  it('word FIRST but ppt also present -> pptx (ppt rule precedes word rule)', async () => {
    const bytes = await makeZip({
      ...docxParts(),
      'ppt/presentation.xml': '<p:presentation/>',
    })
    expect(detect(bytes)).toEqual({ kind: 'ok', format: 'pptx' })
  })
  it('ppt FIRST but xl also present -> xlsx (xl rule precedes ppt rule)', async () => {
    const bytes = await makeZip({
      ...pptxParts(),
      'xl/workbook.xml': '<workbook/>',
    })
    expect(detect(bytes)).toEqual({ kind: 'ok', format: 'xlsx' })
  })
  it('[Content_Types].xml alone must NOT decide the format (§2.5: that check is removed)', async () => {
    const bytes = await makeZip({ '[Content_Types].xml': CT, 'notes/readme.txt': 'hi' })
    expect(okFormat(detect(bytes))).not.toBe('docx')
  })
  it('a docm-shaped zip (word/document.xml, no extension) -> docx (F16)', async () => {
    const bytes = await makeZip({
      ...docxParts(),
      'word/vbaProject.bin': 'MACRO',
    })
    expect(detect(bytes)).toEqual({ kind: 'ok', format: 'docx' })
  })
})

describe('F15: ODF mimetype sniff', () => {
  it('opendocument.spreadsheet mimetype -> xlsx', async () => {
    const bytes = await makeZip({
      mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
      'content.xml': '<office:document-content/>',
      'META-INF/manifest.xml': '<manifest/>',
    })
    expect(detect(bytes)).toEqual({ kind: 'ok', format: 'xlsx' })
  })
  // Superseded: odt and odp gained readers after the specs this suite was
  // written against (see the round-3 addendum).
  it('opendocument.text mimetype -> odt', async () => {
    const bytes = await makeZip({
      mimetype: 'application/vnd.oasis.opendocument.text',
      'content.xml': '<office:document-content/>',
    })
    expect(detect(bytes)).toEqual({ kind: 'ok', format: 'odt' })
  })
  it('opendocument.presentation mimetype -> odp', async () => {
    const bytes = await makeZip({
      mimetype: 'application/vnd.oasis.opendocument.presentation',
      'content.xml': '<office:document-content/>',
    })
    expect(detect(bytes)).toEqual({ kind: 'ok', format: 'odp' })
  })
  it('an OpenDocument type with no reader is still reported clearly', async () => {
    const bytes = await makeZip({
      mimetype: 'application/vnd.oasis.opendocument.graphics',
      'content.xml': '<office:document-content/>',
    })
    const r = detect(bytes)
    expect(r.kind).toBe('unsupported')
    expect((r as { reason: string }).reason.toLowerCase()).toContain('graphics')
  })
})

describe('F20: EPUB detection', () => {
  it('the uncompressed application/epub+zip mimetype entry -> epub', async () => {
    const bytes = await makeZip({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': '<container/>',
      'OEBPS/content.opf': '<package/>',
    })
    expect(detect(bytes)).toEqual({ kind: 'ok', format: 'epub' })
  })
  it('META-INF/container.xml alone (no mimetype entry) -> epub', async () => {
    const bytes = await makeZip({
      'META-INF/container.xml':
        '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      'OEBPS/content.opf': '<package/>',
      'OEBPS/ch1.xhtml': '<html><body>one</body></html>',
    })
    expect(detect(bytes)).toEqual({ kind: 'ok', format: 'epub' })
  })
})

describe('F17: zip containers that are not documents -> { kind: "archive" }', () => {
  it('a plain zip of text files -> archive', async () => {
    const bytes = await makeZip({ 'a.md': '# hi', 'b.txt': 'plain' })
    expect(detect(bytes)).toEqual({ kind: 'archive' })
  })
  it('an EMPTY zip -> archive (its magic is the PK\\x05\\x06 EOCD record)', async () => {
    const bytes = Buffer.from(await new JSZip().generateAsync({ type: 'nodebuffer' }))
    expect(detect(bytes)).toEqual({ kind: 'archive' })
  })
  it('an EMPTY zip named empty.zip -> archive', async () => {
    const bytes = Buffer.from(await new JSZip().generateAsync({ type: 'nodebuffer' }))
    expect(detect(bytes, 'empty.zip')).toEqual({ kind: 'archive' })
  })
  it('a zip named stuff.zip -> archive', async () => {
    const bytes = await makeZip({ 'a.md': '# hi' })
    expect(detect(bytes, 'stuff.zip')).toEqual({ kind: 'archive' })
  })
  it('a zip named STUFF.ZIP -> archive (case-insensitive)', async () => {
    const bytes = await makeZip({ 'a.md': '# hi' })
    expect(detect(bytes, 'STUFF.ZIP')).toEqual({ kind: 'archive' })
  })
  it('a TRUNCATED zip still has ZIP magic and is not a document -> archive', async () => {
    const full = await makeZip({ 'a.md': '# hi', 'b.txt': 'plain' })
    const truncated = full.subarray(0, Math.floor(full.length / 2))
    expect(detect(truncated)).toEqual({ kind: 'archive' })
  })
  it('the old "Unrecognized ZIP-based file" rejection is gone (F17 replaces it)', async () => {
    const bytes = await makeZip({ 'a.md': '# hi' })
    expect(detect(bytes).kind).not.toBe('unsupported')
  })
})

// ================================================ 5. TEXT HEURISTICS (rule 3)

describe('§2.5 rule 3: eml heuristic', () => {
  it('From + To + Subject before a blank line -> eml', () => {
    const s = 'From: a@example.com\nTo: b@example.com\nSubject: Hello\n\nBody text.\n'
    expect(looksLikeEml(s)).toBe(true)
  })
  it('From + Received + Date -> eml (Received is an accepted companion)', () => {
    const s =
      'Received: from mx.example.com by mail.example.com\nFrom: a@example.com\nDate: Mon, 1 Jan 2024 00:00:00 +0000\n\nBody.\n'
    expect(looksLikeEml(s)).toBe(true)
  })
  it('REJECTS 3+ header-shaped lines with NO From: (a config file)', () => {
    const s = 'Host: localhost\nPort: 8080\nUser: admin\nTimeout: 30\n\nnot mail\n'
    expect(looksLikeEml(s)).toBe(false)
  })
  it('REJECTS an HTTP response header block (no From:)', () => {
    const s =
      'HTTP/1.1 200 OK\nContent-Type: text/html\nServer: nginx\nDate: Mon, 1 Jan 2024 00:00:00 GMT\n\n<html></html>\n'
    expect(looksLikeEml(s)).toBe(false)
  })
  it('REJECTS YAML front matter (no From:)', () => {
    const s = '---\ntitle: My Post\nauthor: Alice\ndate: 2024-01-01\n---\n\nBody.\n'
    expect(looksLikeEml(s)).toBe(false)
  })
  it('REJECTS From: with fewer than 3 header lines', () => {
    const s = 'From: a@example.com\nTo: b@example.com\n\nBody.\n'
    expect(looksLikeEml(s)).toBe(false)
  })
  it('REJECTS From: plus 2 unrelated headers (none of To/Subject/Received)', () => {
    const s = 'From: a@example.com\nX-Mailer: thing\nX-Priority: 3\n\nBody.\n'
    expect(looksLikeEml(s)).toBe(false)
  })
  it('REJECTS headers that appear only AFTER the first blank line', () => {
    const s = '\nFrom: a@example.com\nTo: b@example.com\nSubject: Hi\n\nBody.\n'
    expect(looksLikeEml(s)).toBe(false)
  })
  it('REJECTS prose containing colons', () => {
    const s = 'Note: remember this\nAlso: and this\nFinally: that\n\nDone.\n'
    expect(looksLikeEml(s)).toBe(false)
  })
  it('detect() routes header text with no filename to eml (heuristic is not file-only)', () => {
    const s = 'From: a@example.com\nTo: b@example.com\nSubject: Hello\n\nBody text.\n'
    expect(detect(utf8(s))).toEqual({ kind: 'ok', format: 'eml' })
  })
})

describe('F21: mbox heuristic', () => {
  it('a From_ separator plus real RFC-5322 headers -> mbox', () => {
    const s =
      'From alice@example.com Mon Jan  1 00:00:00 2024\n' +
      'From: alice@example.com\nTo: bob@example.com\nSubject: Hi\n\nBody.\n'
    expect(looksLikeMbox(s)).toBe(true)
  })
  it('REJECTS prose that merely begins "From the desk of…" (F21 names this case)', () => {
    const s = 'From the desk of the CEO\n\nWe are pleased to announce the quarterly results.\n'
    expect(looksLikeMbox(s)).toBe(false)
  })
  it('REJECTS a From_ line with no following headers', () => {
    const s = 'From alice@example.com Mon Jan  1 00:00:00 2024\n\nJust a body, no headers.\n'
    expect(looksLikeMbox(s)).toBe(false)
  })
  it('REJECTS plain eml headers with no From_ separator line', () => {
    const s = 'From: alice@example.com\nTo: bob@example.com\nSubject: Hi\n\nBody.\n'
    expect(looksLikeMbox(s)).toBe(false)
  })
  it('detect() classifies real mbox text as mbox, not eml', () => {
    const s =
      'From alice@example.com Mon Jan  1 00:00:00 2024\n' +
      'From: alice@example.com\nTo: bob@example.com\nSubject: Hi\n\nBody.\n'
    expect(detect(utf8(s), 'inbox')).toEqual({ kind: 'ok', format: 'mbox' })
  })
})

describe('F13: notebook sniff', () => {
  it('JSON with cells and nbformat KEYS -> notebook', () => {
    const nb = JSON.stringify({
      cells: [{ cell_type: 'code', source: ['print(1)'], outputs: [] }],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5,
    })
    expect(looksLikeNotebook(nb)).toBe(true)
  })
  it('REJECTS JSON where "cells" and "nbformat" are string VALUES, not keys', () => {
    const j = JSON.stringify({ topic: 'cells', standard: 'nbformat', body: 'a glossary entry' })
    expect(looksLikeNotebook(j)).toBe(false)
  })
  it('detect() must not route an unrelated extensionless JSON file to ipynb', () => {
    const j = JSON.stringify({ topic: 'cells', standard: 'nbformat', body: 'a glossary entry' })
    expect(okFormat(detect(utf8(j), 'glossary'))).not.toBe('ipynb')
  })
  it('REJECTS prose that merely mentions cells and nbformat', () => {
    const s = 'The notebook format stores cells in a list and records nbformat at the top level.\n'
    expect(looksLikeNotebook(s)).toBe(false)
  })
  it('REJECTS JSON with cells but no nbformat', () => {
    expect(looksLikeNotebook(JSON.stringify({ cells: [] }))).toBe(false)
  })
  it('REJECTS JSON with nbformat but no cells', () => {
    expect(looksLikeNotebook(JSON.stringify({ nbformat: 4 }))).toBe(false)
  })
  it('detect() routes extensionless notebook JSON to ipynb (F13)', () => {
    const nb = Buffer.from(
      JSON.stringify({
        cells: [{ cell_type: 'markdown', source: ['# Hi'] }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    )
    expect(detect(nb)).toEqual({ kind: 'ok', format: 'ipynb' })
  })
})

describe('§2.5 rule 3: csv heuristic is FILE-ONLY', () => {
  it('looksLikeCsv accepts a consistent 2-column comma table', () => {
    expect(looksLikeCsv('name,age\nalice,30\nbob,41\n')).toBe(true)
  })
  it('looksLikeCsv accepts semicolon delimiters', () => {
    expect(looksLikeCsv('name;age\nalice;30\n')).toBe(true)
  })
  it('looksLikeCsv accepts tab delimiters', () => {
    expect(looksLikeCsv('name\tage\nalice\t30\n')).toBe(true)
  })
  it('looksLikeCsv REJECTS inconsistent field counts', () => {
    expect(looksLikeCsv('a,b\n1,2,3\n')).toBe(false)
  })
  it('looksLikeCsv REJECTS a single column (needs field count >= 2)', () => {
    expect(looksLikeCsv('alpha\nbeta\ngamma\n')).toBe(false)
  })
  it('looksLikeCsv REJECTS a single row (needs >= 2 non-empty lines)', () => {
    expect(looksLikeCsv('name,age\n')).toBe(false)
  })
  it('looksLikeCsv REJECTS empty input', () => {
    expect(looksLikeCsv('')).toBe(false)
  })
  it('looksLikeCsv REJECTS mixed delimiters (one CONSISTENT delimiter required)', () => {
    expect(looksLikeCsv('a,b\n1;2\n')).toBe(false)
  })

  it('detect() with NO filename NEVER returns csv, even for perfect csv text', () => {
    // §2.5: "only when the input has a .csv/.tsv extension OR arrived as a file
    // (never for pasted text...)"
    expect(okFormat(detect(utf8('name,age\nalice,30\nbob,41\n')))).not.toBe('csv')
  })
  it('detect() with NO filename never returns csv for comma prose either', () => {
    expect(okFormat(detect(utf8('Hello, world\nGoodbye, world\n')))).not.toBe('csv')
  })
  it('detect() WITH an extensionless filename does apply the csv heuristic', () => {
    expect(detect(utf8('name,age\nalice,30\nbob,41\n'), 'export')).toEqual({
      kind: 'ok',
      format: 'csv',
    })
  })
  it('markdown is checked BEFORE csv: a comma-y markdown list stays md', () => {
    const s = '- apples, pears\n- plums, figs\n'
    expect(detect(utf8(s), 'list')).toEqual({ kind: 'ok', format: 'md' })
  })
  it('a markdown pipe table in a file is md, not csv', () => {
    const s = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    expect(detect(utf8(s), 'table')).toEqual({ kind: 'ok', format: 'md' })
  })
})

describe('§2.5 rule 3: markdown heuristic and txt fallback', () => {
  it('plain prose -> txt', () => {
    expect(detect(utf8('Hello world. This is a plain sentence.\n'))).toEqual({
      kind: 'ok',
      format: 'txt',
    })
  })
  it('ATX headings + list -> md', () => {
    expect(looksLikeMarkdown('# Title\n\n- one\n- two\n')).toBe(true)
  })
  it('a single sentence is not markdown', () => {
    expect(looksLikeMarkdown('Hello world.')).toBe(false)
  })
})

// ================================================= 6. DEGENERATE INPUTS

describe('degenerate buffers', () => {
  it('an EMPTY buffer falls back to txt', () => {
    expect(detect(Buffer.alloc(0))).toEqual({ kind: 'ok', format: 'txt' })
  })
  it('an EMPTY buffer with a .md filename is md (extension pass runs first)', () => {
    expect(detect(Buffer.alloc(0), 'empty.md')).toEqual({ kind: 'ok', format: 'md' })
  })
  it('a 1-byte buffer falls back to txt', () => {
    expect(detect(Buffer.from('x'))).toEqual({ kind: 'ok', format: 'txt' })
  })
  it('a UTF-8 BOM alone falls back to txt', () => {
    expect(detect(Buffer.from([0xef, 0xbb, 0xbf]))).toEqual({ kind: 'ok', format: 'txt' })
  })
  it('a UTF-8 BOM followed by markdown still detects md (BOM must not defeat the heuristic)', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('# Title\n\n- a\n- b\n')])
    expect(detect(bytes)).toEqual({ kind: 'ok', format: 'md' })
  })
  it('UTF-16LE text does not crash and yields a usable result', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('# Title\n\n- a\n- b\n', 'utf16le'),
    ])
    const r = detect(bytes)
    expect(r.kind).toBe('ok')
  })
  it('random binary garbage does not crash and never claims a document format', () => {
    const bytes = Buffer.alloc(256)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 97 + 13) & 0xff
    const r = detect(bytes)
    expect(['ok', 'unsupported', 'archive']).toContain(r.kind)
    expect(okFormat(r)).not.toBe('pdf')
    expect(okFormat(r)).not.toBe('docx')
  })
  it('a lone "PK" (2 bytes, not the full PK\\x03\\x04 signature) is not an archive', () => {
    expect(detect(Buffer.from('PK')).kind).not.toBe('archive')
  })
})

describe('sniffBinary contract (returns null when no magic rule matches)', () => {
  it('returns null for plain text', () => {
    expect(sniffBinary(utf8('just words here\n'))).toBeNull()
  })
  it('returns null for an empty buffer', () => {
    expect(sniffBinary(Buffer.alloc(0))).toBeNull()
  })
  it('returns a DetectResult for PDF magic', () => {
    expect(sniffBinary(PDF_BYTES)).toEqual({ kind: 'ok', format: 'pdf' })
  })
  it('returns unsupported for CFB with no filename', () => {
    expect(sniffBinary(CFB_BYTES)?.kind).toBe('unsupported')
  })
})

// ==================================================== 7. F17 expandZipArchive

describe('F17 expandZipArchive: caps match the spec', () => {
  it('MAX_ARCHIVE_ENTRIES is 100', () => {
    expect(MAX_ARCHIVE_ENTRIES).toBe(100)
  })
  it('MAX_ARCHIVE_ENTRY_BYTES is 50 MB', () => {
    expect(MAX_ARCHIVE_ENTRY_BYTES).toBe(50 * 1024 * 1024)
  })
})

describe('F17 expandZipArchive: skip rules', () => {
  it('returns file entries with their bytes', async () => {
    const bytes = await makeZip({ 'a.md': '# hi', 'b.txt': 'plain' })
    const out = await expandZipArchive(bytes)
    expect(out.map((e) => e.filename).sort()).toEqual(['a.md', 'b.txt'])
    expect(out.find((e) => e.filename === 'a.md')!.bytes.toString('utf8')).toBe('# hi')
  })

  it('skips DIRECTORY entries but keeps the one file inside them', async () => {
    const zip = new JSZip()
    zip.folder('sub')!.file('a.md', '# hi')
    const bytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const out = await expandZipArchive(bytes)
    expect(out).toHaveLength(1)
    expect(out.every((e) => !e.filename.endsWith('/'))).toBe(true)
    expect(out[0]!.bytes.toString('utf8')).toBe('# hi')
  })

  it('flattens in-archive paths to basenames (zip-slip defence)', async () => {
    // RULING: entries are addressed by basename so no archive path can steer
    // an output location; collisions are disambiguated instead (next test).
    const zip = new JSZip()
    zip.folder('sub')!.file('a.md', '# hi')
    const bytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const out = await expandZipArchive(bytes)
    expect(out.map((e) => e.filename)).toEqual(['a.md'])
  })

  it('keeps same-named files in different directories distinguishable', async () => {
    const bytes = await makeZip({ 'a/notes.md': '# A', 'b/notes.md': '# B' })
    const out = await expandZipArchive(bytes)
    expect(out).toHaveLength(2)
    expect(new Set(out.map((e) => e.filename)).size).toBe(2)
  })

  it('skips __MACOSX/ entries', async () => {
    const bytes = await makeZip({
      'a.md': '# hi',
      '__MACOSX/._a.md': 'resource fork junk',
      '__MACOSX/sub/._b.md': 'more junk',
    })
    const out = await expandZipArchive(bytes)
    expect(out.map((e) => e.filename)).toEqual(['a.md'])
  })

  it('skips root dotfiles', async () => {
    const bytes = await makeZip({ 'a.md': '# hi', '.DS_Store': 'junk', '.gitignore': 'node_modules' })
    const out = await expandZipArchive(bytes)
    expect(out.map((e) => e.filename)).toEqual(['a.md'])
  })

  it('skips dotfiles nested in a subdirectory too (they are still hidden files)', async () => {
    const bytes = await makeZip({ 'sub/a.md': '# hi', 'sub/.DS_Store': 'junk' })
    const out = await expandZipArchive(bytes)
    expect(out).toHaveLength(1)
    expect(out[0]!.bytes.toString('utf8')).toBe('# hi')
  })

  it('skips entries inside a dot-DIRECTORY (e.g. .git/)', async () => {
    const bytes = await makeZip({ 'a.md': '# hi', '.git/config': '[core]' })
    const out = await expandZipArchive(bytes)
    expect(out.map((e) => e.filename)).toEqual(['a.md'])
  })

  it('does NOT recurse into a nested archive — the inner zip is returned as one file entry', async () => {
    const inner = await makeZip({ 'inner.md': '# inner', 'inner2.txt': 'x' })
    const outer = await makeZip({ 'outer.md': '# outer', 'nested.zip': inner })
    const out = await expandZipArchive(outer)
    expect(out.map((e) => e.filename).sort()).toEqual(['nested.zip', 'outer.md'])
    // it must be the archive bytes verbatim, not its expansion
    const nested = out.find((e) => e.filename === 'nested.zip')!
    expect(nested.bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(out.some((e) => e.filename.includes('inner.md'))).toBe(false)
  })

  it('an EMPTY zip expands to no entries', async () => {
    const bytes = Buffer.from(await new JSZip().generateAsync({ type: 'nodebuffer' }))
    expect(await expandZipArchive(bytes)).toEqual([])
  })

  /*
   * S3. A traversing entry name must be REFUSED, not flattened to a basename:
   * the name travels on into the writers, and `C:\Windows\x` reduced to `x` is
   * a name the archive never contained.
   *
   * The obvious form of this test is worthless twice over. Asserting a property
   * of each RETURNED name ("no name contains '..'") cannot fail once the bad
   * entries are gone — and cannot fail either if they were never there, which
   * is the case for a `../x` fixture, because JSZip resolves "../" out of an
   * entry name as it loads the archive. So: the assertions below are on the
   * whole returned list, which pins the count, and the fixtures use the forms
   * that really do reach the guard.
   */
  it('refuses a backslash traversal, which a "/"-only splitter reads as one basename', async () => {
    // Zip names are nominally '/'-separated, but the format does not forbid a
    // backslash and Windows tools write them; JSZip passes them through
    // untouched. Split on '/' alone and `sub\..\..\evil.md` is a single
    // "basename" that sails through every check and out into the writers.
    const bytes = await makeZip({
      'safe.md': '# safe',
      'sub\\..\\..\\evil.md': '# evil',
      '..\\evil2.md': '# evil2',
    })
    const out = await expandZipArchive(bytes)
    // Not "no name contains ..": the entries themselves must be gone.
    expect(out.map((e) => e.filename)).toEqual(['safe.md'])
    expect(out[0].bytes.toString('utf8')).toBe('# safe')
  })

  it('refuses an absolute, UNC or drive-rooted entry name outright', async () => {
    const bytes = await makeZip({
      'safe.md': '# safe',
      '/etc/passwd': 'root:x:0:0',
      'C:\\Windows\\evil.md': '# evil',
      'C:relative.md': '# drive-relative',
      '\\\\server\\share\\evil.md': '# unc',
    })
    const out = await expandZipArchive(bytes)
    expect(out.map((e) => e.filename)).toEqual(['safe.md'])
  })

  it('a "/"-separated ../ name is resolved to a root basename by JSZip before the guard sees it', async () => {
    // Recorded so the next reader does not mistake the harmless result for
    // proof that the guard ran: it did not. JSZip's own resolution is what
    // made these safe, and it only handles the '/' spelling.
    const out = await expandZipArchive(
      await makeZip({ 'safe.md': '# safe', '../evil.md': '# evil', 'sub/../../evil2.md': '# evil2' }),
    )
    expect(out.map((e) => e.filename).sort()).toEqual(['evil.md', 'evil2.md', 'safe.md'])
    // The guard would have refused them had they arrived intact.
    expect(isUnsafeArchivePath('../evil.md')).toBe(true)
    expect(isUnsafeArchivePath('sub/../../evil2.md')).toBe(true)
  })

  it('isUnsafeArchivePath judges the name, not the shape JSZip happens to write', () => {
    for (const unsafe of [
      '../evil.md',
      '..\\evil.md',
      'sub/../../evil.md',
      'sub\\..\\..\\evil.md',
      './evil.md',
      'a/./b/evil.md',
      '/etc/passwd',
      '\\\\server\\share\\evil.md',
      '\\windows\\evil.md',
      'C:\\Windows\\evil.md',
      'c:/windows/evil.md',
      'C:relative.md',
    ]) {
      expect(isUnsafeArchivePath(unsafe), unsafe).toBe(true)
    }
    for (const safe of [
      'a.md',
      'sub/a.md',
      'sub\\a.md',
      'deep/sub/dir/a.md',
      '..a.md', // a filename that merely starts with dots is not a climb
      'a..b/c.md',
      'C.md',
      'notes/C-notes.md',
    ]) {
      expect(isUnsafeArchivePath(safe), safe).toBe(false)
    }
  })

  it('rejects a corrupt/truncated zip rather than returning partial garbage', async () => {
    const full = await makeZip({ 'a.md': '# hi', 'b.txt': 'plain' })
    const truncated = full.subarray(0, Math.floor(full.length / 2))
    await expect(expandZipArchive(truncated)).rejects.toBeTruthy()
  })
})

describe('F17 expandZipArchive: 100-entry cap', () => {
  it('returns all 100 entries for a 100-entry zip', async () => {
    const spec: ZipSpec = {}
    for (let i = 0; i < 100; i++) spec[`f${String(i).padStart(3, '0')}.md`] = `# ${i}`
    const out = await expandZipArchive(await makeZip(spec))
    expect(out).toHaveLength(100)
  }, 60000)

  it('stops at 100 entries for a 101-entry zip', async () => {
    const spec: ZipSpec = {}
    for (let i = 0; i < 101; i++) spec[`f${String(i).padStart(3, '0')}.md`] = `# ${i}`
    const out = await expandZipArchive(await makeZip(spec))
    expect(out).toHaveLength(100)
  }, 60000)

  it('the 100 counted entries are real files, not skipped junk', async () => {
    // 100 real files plus 20 __MACOSX/ entries: the cap counts kept entries,
    // so all 100 real files must survive.
    const spec: ZipSpec = {}
    for (let i = 0; i < 20; i++) spec[`__MACOSX/._j${i}.md`] = 'junk'
    for (let i = 0; i < 100; i++) spec[`f${String(i).padStart(3, '0')}.md`] = `# ${i}`
    const out = await expandZipArchive(await makeZip(spec))
    expect(out).toHaveLength(100)
    expect(out.every((e) => !e.filename.startsWith('__MACOSX/'))).toBe(true)
  }, 60000)
})

describe('F17 expandZipArchive: 50 MB per-entry cap', () => {
  it('keeps an entry exactly at the cap and skips one over it', async () => {
    const CAP = 50 * 1024 * 1024
    const zip = new JSZip()
    zip.file('small.md', '# small')
    zip.file('at-cap.bin', Buffer.alloc(CAP, 0x41), { compression: 'STORE' })
    zip.file('over-cap.bin', Buffer.alloc(CAP + 1, 0x42), { compression: 'STORE' })
    const bytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))

    const out = await expandZipArchive(bytes)
    const names = out.map((e) => e.filename).sort()
    // spec: "entries over 50 MB" are skipped -> exactly 50 MB is not "over"
    expect(names).toEqual(['at-cap.bin', 'small.md'])
  }, 300000)
})

// ============================================================ 8. interop

/**
 * No spec text covers interop. Observed contract: resolveExport returns the
 * MODULE LAYER that exposes `member` as a function (not the member itself).
 */
describe('resolveExport (ESM/CJS interop helper — no spec text; contract inferred)', () => {
  type Mod = Record<string, () => string>
  const a = (): string => 'a'
  const b = (): string => 'b'

  it('resolves a direct named export layer', () => {
    expect(resolveExport<Mod>({ foo: a }, 'foo').foo).toBe(a)
  })
  it('unwraps a CJS default wrapper', () => {
    expect(resolveExport<Mod>({ default: { foo: a } }, 'foo').foo).toBe(a)
  })
  it('unwraps a doubly-wrapped default (default.default)', () => {
    expect(resolveExport<Mod>({ default: { default: { foo: a } } }, 'foo').foo).toBe(a)
  })
  it('prefers the direct named export over the default wrapper', () => {
    expect(resolveExport<Mod>({ default: { foo: b }, foo: a }, 'foo').foo).toBe(a)
  })
  it('throws for a missing member rather than returning undefined', () => {
    expect(() => resolveExport<unknown>({ foo: a }, 'bar')).toThrow()
  })
  it('throws for a null module rather than crashing on property access', () => {
    expect(() => resolveExport<unknown>(null, 'foo')).toThrow()
  })
  it('throws when the member exists but is not callable', () => {
    expect(() => resolveExport<unknown>({ foo: 'not a function' }, 'foo')).toThrow()
  })
})
