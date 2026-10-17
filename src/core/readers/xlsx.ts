import * as XLSX from 'xlsx'
import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import { rowsToHtmlTable, looksLikeHeader, trimTrailingEmpty, MAX_TABLE_CELLS, type CellMerge, type RichCell } from './csv'
import { odsCellFormatting, type OdsFormatting } from './ods-format'
import { odfFormattedHtml, odfMarkedHtml, odfMarkedText, odfMarkedUniformBits } from './odf-common'
import type { HubDocument, SourceInput } from '../types'

/**
 * One reader serves .xlsx, .xls, .xlsm, .xlsb and .ods, so convert.ts's generic
 * "Could not read xlsx" names the wrong format for four of them. Report the
 * extension the user actually picked.
 */
function formatLabel(filename?: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(filename ?? '')
  return ext ? `.${ext[1].toLowerCase()}` : 'spreadsheet'
}

/**
 * The xlsx library signals encryption by message, not by error type: BIFF
 * throws "File is password-protected" / "Password is incorrect", ECMA-376
 * throws the same, and a zip-encrypted book throws "Unsupported ZIP
 * encryption". All of them mean the same thing to the user.
 */
function isPasswordProtected(message: string): boolean {
  return /password|encrypt/i.test(message)
}

export async function readXlsx(src: SourceInput): Promise<HubDocument> {
  const label = formatLabel(src.filename)
  try {
    return buildDocument(src)
  } catch (err) {
    if (err instanceof ConversionError) throw err
    const message = (err as Error)?.message ?? String(err)
    if (isPasswordProtected(message)) {
      throw new ConversionError(
        'read-failed',
        `This ${label} file is password-protected, so its contents cannot be read. ` +
          'Remove the password in the program that created the file, save it again, then convert it. ' +
          'In Excel that is File > Info > Protect Workbook > Encrypt with Password.',
      )
    }
    throw new ConversionError('read-failed', `Could not read this ${label} file: ${message}`)
  }
}

/** Top-left cell of the sheet's used range; `sheet_to_json` indexes from here, not from A1. */
function usedRangeOrigin(ws: XLSX.WorkSheet): { r: number; c: number } {
  const ref = ws['!ref']
  if (typeof ref !== 'string') return { r: 0, c: 0 }
  try {
    return { ...XLSX.utils.decode_range(ref).s }
  } catch {
    return { r: 0, c: 0 }
  }
}

/**
 * Put `!merges` into the same coordinate space as the rows, then clamp them.
 *
 * Excel stores merges in absolute sheet coordinates while `sheet_to_json`
 * indexes from the used range's origin, so a workbook whose range starts at B1
 * — which is what Excel writes whenever column A was never touched — drew
 * every merge one column to the right of where it belonged, widening a
 * two-column form to three. Clamping matters just as much: a merge that ran
 * into the trailing blank columns we just dropped would otherwise drag them
 * back through its colspan and re-open the very defect the trim closes.
 */
function alignMerges(raw: CellMerge[], origin: { r: number; c: number }, height: number, width: number): CellMerge[] {
  const out: CellMerge[] = []
  for (const m of raw) {
    const s = { r: m.s.r - origin.r, c: m.s.c - origin.c }
    if (s.r < 0 || s.c < 0 || s.r >= height || s.c >= width) continue
    const e = { r: Math.min(m.e.r - origin.r, height - 1), c: Math.min(m.e.c - origin.c, width - 1) }
    if (e.r < s.r || e.c < s.c) continue
    out.push({ s, e })
  }
  return out
}

/** SheetJS's reader of an opened zip package: what XLSX.read runs on one, exported but not typed. */
const parseZip = (XLSX as unknown as { parse_zip: (zip: unknown, opts: XLSX.ParsingOptions) => XLSX.WorkBook }).parse_zip

const ODS_MIMETYPE = 'mimetypeapplication/vnd.oasis.opendocument.spreadsheet'

/**
 * An OpenDocument spreadsheet, by the stored `mimetype` entry ODF puts
 * first in the package: the name at byte 30 of the first local header, and
 * its content right after.
 */
function isOdsPackage(bytes: Buffer): boolean {
  if (bytes.length < 30 + ODS_MIMETYPE.length || bytes.readUInt32LE(0) !== 0x04034b50) return false
  if (bytes.readUInt16LE(8) !== 0 || bytes.readUInt16LE(26) !== 8 || bytes.readUInt16LE(28) !== 0) return false
  return bytes.toString('latin1', 30, 30 + ODS_MIMETYPE.length) === ODS_MIMETYPE
}

/**
 * The workbook, and for an .ods its cell formatting, which SheetJS does not
 * keep (ods-format.ts). An .ods package is opened once, with SheetJS's own
 * zip reader (several times quicker than JSZip at this, which matters on a
 * 50,000-row sheet), and handed to SheetJS opened, as XLSX.read would hand
 * it on; its content.xml is read for the formatting from the same opening.
 */
function openWorkbook(bytes: Buffer): { wb: XLSX.WorkBook; formatting: OdsFormatting | null } {
  if (!isOdsPackage(bytes)) {
    // raw:false yields formatted strings — formulas export their computed values.
    const wb = XLSX.read(bytes, { type: 'buffer' })
    return { wb, formatting: wb.bookType === 'ods' ? odsFormatting(XLSX.CFB.read(bytes, { type: 'buffer' })) : null }
  }
  const zip = XLSX.CFB.read(bytes, { type: 'buffer' })
  const wb = parseZip(zip, { type: 'buffer' })
  return { wb, formatting: wb.bookType === 'ods' ? odsFormatting(zip) : null }
}

function odsFormatting(zip: unknown): OdsFormatting | null {
  const part = (name: string): string => {
    const content = XLSX.CFB.find(zip, name)?.content
    return content ? Buffer.from(content as Uint8Array).toString('utf8') : ''
  }
  const content = part('content.xml')
  return content ? odsCellFormatting(content, part('styles.xml')) : null
}

const BOLD = 1
const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

/**
 * The formatted HTML for a cell of `rows`, by way of its address in the sheet.
 *
 * The formatted text is used only when it reads the same as SheetJS's value;
 * a number cell's shown text is SheetJS's own formatting of the number, so it
 * can differ, and then the value keeps the formatting if the whole cell had
 * one. A header cell drops bold, which a `<th>` already has — as an ODF
 * heading's own bold is dropped.
 */
function richCells(format: Map<string, string>, rows: string[][], origin: { r: number; c: number }): RichCell {
  return (r, c, header) => {
    const value = rows[r]?.[c] ?? ''
    if (value === '') return undefined
    const marked = format.get(`${r + origin.r},${c + origin.c}`)
    if (marked === undefined) return undefined
    const drop = header ? BOLD : 0
    if (sameText(odfMarkedText(marked), value)) return odfMarkedHtml(marked, drop)
    const bits = odfMarkedUniformBits(marked)
    return bits > 0 ? odfFormattedHtml(value, bits, drop) : undefined
  }
}

function buildDocument(src: SourceInput): HubDocument {
  const { wb, formatting } = openWorkbook(src.bytes)
  const sections: string[] = []
  for (const [index, name] of wb.SheetNames.entries()) {
    const ws = wb.Sheets[name]
    // The saved range is whatever Excel last touched, so it routinely runs
    // dozens of blank columns past the last real value. Trim before counting:
    // an ordinary form should not be measured against the cell cap on padding.
    const rows = trimTrailingEmpty(
      XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '' }),
    )
    // Per sheet, so one oversized sheet cannot block a whole workbook.
    const cells = rows.reduce((n, r) => n + r.length, 0)
    if (cells > MAX_TABLE_CELLS) {
      throw new ConversionError(
        'table-too-large',
        `Sheet "${name}" has ${cells.toLocaleString()} cells, over this app's ${MAX_TABLE_CELLS.toLocaleString()}-cell limit. ` +
          'Split the sheet or delete unused rows, then convert again.',
      )
    }
    if (rows.length === 0) continue
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
    const origin = usedRangeOrigin(ws)
    const merges = alignMerges((ws['!merges'] ?? []) as CellMerge[], origin, rows.length, width)
    const format = formatting?.[index]
    // A cell's line breaks become <br> in rowsToHtmlTable, for every book type.
    const rich = format && format.size > 0 ? richCells(format, rows, origin) : undefined
    sections.push(
      `<h2>${escapeHtml(name)}</h2>${rowsToHtmlTable(rows, looksLikeHeader(rows), merges, rich)}`,
    )
  }
  return { html: sections.join('\n'), title: src.filename }
}
