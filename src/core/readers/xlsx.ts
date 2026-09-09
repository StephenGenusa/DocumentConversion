import * as XLSX from 'xlsx'
import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import { rowsToHtmlTable, looksLikeHeader, trimTrailingEmpty, MAX_TABLE_CELLS, type CellMerge } from './csv'
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

function buildDocument(src: SourceInput): HubDocument {
  // raw:false yields formatted strings — formulas export their computed values.
  const wb = XLSX.read(src.bytes, { type: 'buffer' })
  const sections: string[] = []
  for (const name of wb.SheetNames) {
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
    const merges = alignMerges((ws['!merges'] ?? []) as CellMerge[], usedRangeOrigin(ws), rows.length, width)
    sections.push(
      `<h2>${escapeHtml(name)}</h2>${rowsToHtmlTable(rows, looksLikeHeader(rows), merges)}`,
    )
  }
  return { html: sections.join('\n'), title: src.filename }
}
