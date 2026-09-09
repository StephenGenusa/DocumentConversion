import Papa from 'papaparse'
import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import type { HubDocument, SourceInput } from '../types'

/**
 * Per-table (and per-sheet) guard, not a whole-workbook budget. Routine
 * business spreadsheets run to hundreds of thousands of cells across several
 * sheets; a cumulative 50k cap rejected an ordinary 2 MB workbook outright.
 */
export const MAX_TABLE_CELLS = 500_000

function isNumeric(s: string): boolean {
  return s.trim() !== '' && !Number.isNaN(Number(s.trim().replace(/,/g, '')))
}

/** First row is a header when none of its cells are numeric but the body has numbers. */
export function looksLikeHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false
  const [first, ...body] = rows
  if (first.some(isNumeric)) return false
  return body.some((r) => r.some(isNumeric))
}

export interface CellMerge {
  s: { r: number; c: number }
  e: { r: number; c: number }
}

/**
 * Drop trailing all-empty columns and rows.
 *
 * A spreadsheet's saved `!ref` is whatever range Excel last touched, so an
 * ordinary two-column form arrives 34 columns wide with 32 of them blank. The
 * PDF shell gives tables `table-layout: fixed`, which divides the page evenly
 * across every column present — load-bearing for genuinely wide tables, fatal
 * with junk ones: "WR Number" drew one letter per line down a 20px column and
 * the form ran to 115 pages.
 *
 * Only *trailing* emptiness goes. A blank column or row *between* two
 * populated ones is deliberate layout and is kept, and a grid with nothing in
 * it at all is returned untouched so a wholly blank sheet renders as before.
 */
export function trimTrailingEmpty(rows: string[][]): string[][] {
  let lastRow = -1
  let lastCol = -1
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if ((rows[r][c] ?? '').trim() === '') continue
      lastRow = r
      if (c > lastCol) lastCol = c
    }
  }
  if (lastRow < 0) return rows
  if (lastRow === rows.length - 1 && rows.every((row) => row.length <= lastCol + 1)) return rows
  return rows.slice(0, lastRow + 1).map((row) => (row.length > lastCol + 1 ? row.slice(0, lastCol + 1) : row))
}

/**
 * Render a grid, applying spreadsheet merge ranges as colspan/rowspan.
 * Ignoring them collapsed form-style sheets (one workbook had 73 merges,
 * including a header spanning C1:N1) into misaligned columns.
 */
export function rowsToHtmlTable(rows: string[][], header: boolean, merges: CellMerge[] = []): string {
  const anchors = new Map<string, { colspan: number; rowspan: number }>()
  const covered = new Set<string>()
  for (const m of merges) {
    const colspan = m.e.c - m.s.c + 1
    const rowspan = m.e.r - m.s.r + 1
    if (colspan < 1 || rowspan < 1 || (colspan === 1 && rowspan === 1)) continue
    anchors.set(`${m.s.r},${m.s.c}`, { colspan, rowspan })
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) covered.add(`${r},${c}`)
      }
    }
  }
  const cell = (tag: string, value: string, r: number, c: number): string => {
    if (covered.has(`${r},${c}`)) return ''
    const span = anchors.get(`${r},${c}`)
    const attrs = span
      ? (span.colspan > 1 ? ` colspan="${span.colspan}"` : '') + (span.rowspan > 1 ? ` rowspan="${span.rowspan}"` : '')
      : ''
    return `<${tag}${attrs}>${escapeHtml(value)}</${tag}>`
  }
  const tr = (row: string[], tag: string, r: number): string =>
    `<tr>${row.map((v, c) => cell(tag, v, r, c)).join('')}</tr>`
  if (header) {
    const [first, ...body] = rows
    return `<table><thead>${tr(first, 'th', 0)}</thead><tbody>${body
      .map((row, i) => tr(row, 'td', i + 1))
      .join('')}</tbody></table>`
  }
  return `<table><tbody>${rows.map((row, i) => tr(row, 'td', i)).join('')}</tbody></table>`
}

export async function readCsv(src: SourceInput): Promise<HubDocument> {
  const text = src.bytes.toString('utf8').replace(/^﻿/, '').trim()
  const parsed = Papa.parse<string[]>(text, { delimitersToGuess: [',', ';', '\t'] })
  // Exports from a spreadsheet pad every line out to the sheet's used range,
  // so a two-column form arrives with a tail of empty fields — the same defect
  // the xlsx reader hits, with the same one-character-per-line result.
  const rows = trimTrailingEmpty(
    parsed.data.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== '')),
  )
  const cells = rows.reduce((n, r) => n + r.length, 0)
  if (cells > MAX_TABLE_CELLS) {
    throw new ConversionError(
      'table-too-large',
      `This file has ${cells.toLocaleString()} cells, over this app's ${MAX_TABLE_CELLS.toLocaleString()}-cell limit. ` +
        'Split it into smaller files, then convert again.',
    )
  }
  return { html: rowsToHtmlTable(rows, looksLikeHeader(rows)), title: src.filename }
}
