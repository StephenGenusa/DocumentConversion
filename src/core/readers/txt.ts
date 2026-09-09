import * as iconv from 'iconv-lite'
import { MAX_TABLE_CELLS, looksLikeHeader, rowsToHtmlTable } from './csv'
import type { HubDocument, SourceInput } from '../types'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ------------------------------------------------------------------ *
 * Charset detection
 *
 * A SourceInput is bytes, and `bytes.toString('utf8')` is a guess that is
 * wrong for two whole families of real documents: a Windows-1252 memo comes
 * through with a replacement character wherever a curly quote or an em dash
 * was, and a UTF-16 export comes through as its letters separated by NULs.
 *
 * It lives beside the .txt reader because that is the smallest reader that
 * needs it; the html reader imports it rather than keeping a second copy, and
 * passes in whatever the document declares about itself.
 * ------------------------------------------------------------------ */

/** A byte order mark is the one statement about encoding that cannot be wrong. */
function bomEncoding(bytes: Buffer): { encoding: string; offset: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf8', offset: 3 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf16le', offset: 2 }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf16be', offset: 2 }
  return null
}

/**
 * UTF-16 without a BOM, which Windows exports produce often enough to matter.
 * Western text in UTF-16 is half NUL bytes, all on the same parity of index,
 * and a NUL is legal UTF-8 — so without this test such a file would pass the
 * UTF-8 check below and decode to its letters interleaved with NULs.
 */
function bomlessUtf16(bytes: Buffer): string | null {
  const sample = bytes.subarray(0, 1024)
  if (sample.length < 16) return null
  let even = 0
  let odd = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== 0) continue
    if (i % 2 === 0) even++
    else odd++
  }
  const nuls = even + odd
  if (nuls * 5 < sample.length) return null // fewer than a fifth: not UTF-16
  // One parity carries the Latin characters' zero high bytes. The other is not
  // necessarily empty: U+4E00 (一) has a zero LOW byte, so a line that opens
  // with CJK text puts a few NULs on the wrong side. Demand dominance, not
  // absence — a single-byte or UTF-8 file has no parity pattern at all.
  if (odd >= 8 * even) return 'utf16le' // NULs are the high bytes, which come second
  if (even >= 8 * odd) return 'utf16be'
  return null
}

/**
 * Decode bytes to text. In order: a byte order mark, a BOM-less UTF-16 shape,
 * UTF-8 when the bytes really are valid UTF-8, whatever the document declared
 * about itself, and Windows-1252 as the last resort — it is the de facto
 * encoding of legacy Western text and, having a meaning for all 256 values, it
 * can never fail.
 *
 * Valid UTF-8 outranks the declaration on purpose. A UTF-8 page whose
 * `<meta charset="windows-1252">` lies is routine on legacy sites, and honouring
 * the lie produced `CafÃ© â€” â€œqâ€` where the old `toString('utf8')` was right.
 * Single-byte text is almost never valid multi-byte UTF-8 by accident, so when
 * the two witnesses disagree the bytes are the better one. Valid UTF-8 comes
 * out identical to the old `toString('utf8')`, so nothing that already decoded
 * correctly decodes differently now.
 *
 * The strict decode doubles as the validity test rather than running a separate
 * pass: these files reach 10 MB and there is no reason to build the string
 * twice.
 */
export function decodeTextBytes(bytes: Buffer, declared?: string): string {
  const bom = bomEncoding(bytes)
  if (bom) return iconv.decode(bytes.subarray(bom.offset), bom.encoding)

  const utf16 = bomlessUtf16(bytes)
  if (utf16) return iconv.decode(bytes, utf16)

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Not UTF-8: the declaration is now the only witness.
  }

  const named = declared?.trim().toLowerCase()
  if (named && named !== 'utf-8' && named !== 'utf8' && iconv.encodingExists(named)) {
    return iconv.decode(bytes, named)
  }
  return iconv.decode(bytes, 'win1252')
}

/* ------------------------------------------------------------------ *
 * Tab-delimited tables
 *
 * A .txt whose lines are tab-separated with a consistent column count is
 * a real table (someone pasted a spreadsheet, or a report generator
 * emitted TSV without the extension), and converting it to prose throws
 * the structure away.
 *
 * The hazard is that a .txt holding source code is tab-rich too, and
 * this project's core value is zero false positives on table detection.
 * So every test below is a VETO and the order is cheapest-first: a block
 * becomes a table only when it survives all of them, and a real table
 * that gets left as a paragraph is a far cheaper mistake than a makefile
 * shredded into columns.
 *
 * Only tab delimiting is inferred. Space-aligned fixed-width columns are
 * deliberately NOT detected: indented code and aligned prose are
 * indistinguishable from columns without semantics, and guessing there
 * is where the false positives live.
 * ------------------------------------------------------------------ */

/**
 * A tab with real text in front of it is a cell boundary; a tab at the start
 * of a line is indentation. Same test as `isCellLine` in the .doc reader, and
 * it is the single most important guard here — it is what rejects a makefile
 * recipe and a tab-indented Python module, both of which otherwise pass every
 * structural count below.
 */
function isCellLine(line: string): boolean {
  const tab = line.indexOf('\t')
  return tab > 0 && line.slice(0, tab).trim() !== ''
}

/**
 * Syntax that source code is full of and tabular data has no reason to carry.
 * This is the last line of defence after the structural tests: tab-aligned
 * declarations ("int\tcount;") and two statements separated by a tab keep
 * their text in front of the tab, so `isCellLine` waves them through.
 *
 * Deliberately trigger-happy — a data cell that happens to contain "->" or a
 * trailing semicolon costs us one table, while a mis-detected source file
 * costs us the guarantee.
 */
const CODE_TELL =
  /[{};]\s*$|\)\s*:\s*$|=>|->|::|\/\/|\/\*|\*\/|\$\(|\$\{|<\?|\?>|^#(?:include|define|pragma|!)|(?:^|[\s(])(?:def|class|func|function|import|export|return|elif|endif|typedef|struct|namespace|void|public|private|protected|static|const|let|var|require|printf|println|echo)[\s(:]/

/**
 * Read a blank-line-delimited block as a tab-separated grid, or decline.
 *
 * Requires: two or more lines; every line the same number of fields; two or
 * more fields per line; every line's first field real text rather than
 * indentation; and no line carrying a source-code tell.
 */
function tabDelimitedRows(block: string): string[][] | null {
  const lines = block.split('\n').filter((l) => l.trim() !== '')
  if (lines.length < 2) return null
  const rows: string[][] = []
  let width = 0
  for (const line of lines) {
    if (!isCellLine(line) || CODE_TELL.test(line)) return null
    const fields = line.replace(/\s+$/, '').split('\t')
    if (fields.length < 2) return null
    if (width === 0) width = fields.length
    else if (fields.length !== width) return null
    rows.push(fields.map((f) => f.trim()))
  }
  // Same per-table budget the csv reader enforces. Here it is a veto rather
  // than an error: an oversized block is still perfectly good plain text.
  if (rows.length * width > MAX_TABLE_CELLS) return null
  return rows
}

export async function readTxt(src: SourceInput): Promise<HubDocument> {
  const text = decodeTextBytes(src.bytes).replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim().length > 0)
  const html = blocks
    .map((b) => {
      const rows = tabDelimitedRows(b)
      return rows ? rowsToHtmlTable(rows, looksLikeHeader(rows)) : `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`
    })
    .join('\n')
  return { html: html || '<p></p>' }
}
