import { MAX_TABLE_CELLS } from './csv'
import {
  attr,
  odfCellMarked,
  odfCellStyleBits,
  odfFormattingTextStyles,
  odfMarkedHasFormat,
  odfStylesFormat,
  parseOdfStyles,
  withOdfStyles,
} from './odf-common'

/*
 * Inline formatting for OpenDocument spreadsheets.
 *
 * SheetJS reads an .ods into values only. Rather than replace it — its grid,
 * merges, number formats and hidden-sheet handling are what the reader is
 * built on, shared with xlsx and xls — this walks content.xml a second time
 * and records, by sheet and cell address, the formatted text of just the
 * cells that have any. xlsx.ts overlays those onto SheetJS's rows. The walk
 * counts rows and columns exactly as SheetJS's parse_content_xml does, so an
 * address here is the address SheetJS put the value at.
 *
 * Formatting comes from the same style resolution as odt and odp
 * (odf-common.ts): a cell's own `table:style-name`, else its row's and then its
 * column's `table:default-cell-style-name`, gives the starting format, and the
 * cell's paragraphs and spans apply theirs on top.
 */

/** Per sheet, in workbook order: `"row,col"` (absolute, from A1) → marked text. */
export type OdsFormatting = Map<string, string>[]

const END_CELL = '</table:table-cell>'
const END_COVERED = '</table:covered-table-cell>'

/** The start of each tag the walk counts; the rest of the tag is found by indexOf, which is quicker on a big sheet. */
const TAG = /<(\/?)(table:table|table:table-column|table:table-row|table:table-cell|table:covered-table-cell)(?=[\s/>])/g

function count(attrs: string, name: string): number {
  if (!attrs.includes(name)) return 1
  const n = parseInt(attr(attrs, name) ?? '1', 10)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * The formatted cells of every sheet, or null when no style in the document
 * turns any formatting on — the usual case, and then the walk is skipped and
 * the file reads exactly as it did.
 */
export function odsCellFormatting(contentXml: string, stylesXml: string): OdsFormatting | null {
  const named = /<office:styles\b[^>]*>([\s\S]*?)<\/office:styles>/.exec(stylesXml)?.[1] ?? ''
  const automatic = /<office:automatic-styles\b[^>]*>([\s\S]*?)<\/office:automatic-styles>/.exec(contentXml)?.[1] ?? ''
  const styles = parseOdfStyles(named + automatic)
  if (!odfStylesFormat(styles)) return null
  return withOdfStyles(styles, () => walk(contentXml, styles))
}

function walk(xml: string, styles: ReturnType<typeof parseOdfStyles>): OdsFormatting {
  const sheets: OdsFormatting = []
  const textStyles = odfFormattingTextStyles(styles)
  // Whether a cell's paragraphs or spans name a style that formats. Much
  // cheaper than marking the cell to find out, and most cells do not.
  const namesFormat = (inner: string): boolean => {
    if (textStyles.size === 0 || !inner.includes('text:style-name=')) return false
    for (const m of inner.matchAll(/text:style-name="([^"]*)"/g)) if (textStyles.has(m[1])) return true
    return false
  }
  const bitsOf = new Map<string, number>()
  const cellBits = (name: string | undefined): number => {
    if (name === undefined) return 0
    let bits = bitsOf.get(name)
    if (bits === undefined) bitsOf.set(name, (bits = odfCellStyleBits(styles, name)))
    return bits
  }
  let sheet: Map<string, string> | null = null
  // Column default styles as runs: run i covers columns up to ends[i] - 1.
  let ends: number[] = []
  let colStyles: (string | undefined)[] = []
  const columnStyle = (c: number): string | undefined => {
    let lo = 0
    let hi = ends.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ends[mid] <= c) lo = mid + 1
      else hi = mid
    }
    return colStyles[lo]
  }
  let R = -1
  let C = -1
  let rowPeat = 1
  let rowStyle: string | undefined
  let stored = 0

  TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG.exec(xml))) {
    const [, close, name] = m
    const gt = xml.indexOf('>', TAG.lastIndex)
    if (gt === -1) break
    const empty = xml.charCodeAt(gt - 1) === 47 // "/"
    const attrs = xml.slice(TAG.lastIndex, empty ? gt - 1 : gt)
    TAG.lastIndex = gt + 1
    switch (name) {
      case 'table:table':
        if (close) sheet = null
        else if (!empty) {
          sheet = new Map()
          sheets.push(sheet)
          ends = []
          colStyles = []
          R = C = -1
          rowPeat = 1
        }
        break
      case 'table:table-column':
        if (!close && sheet) {
          ends.push((ends[ends.length - 1] ?? 0) + count(attrs, 'table:number-columns-repeated'))
          colStyles.push(attr(attrs, 'table:default-cell-style-name'))
        }
        break
      case 'table:table-row':
        // As SheetJS: a row advances on its close tag, so a self-closing row
        // takes no room at all.
        if (close) {
          R += rowPeat
          rowPeat = 1
          break
        }
        if (R === -1) R = 0
        rowPeat = count(attrs, 'table:number-rows-repeated')
        rowStyle = attr(attrs, 'table:default-cell-style-name')
        C = -1
        break
      case 'table:table-cell':
      case 'table:covered-table-cell': {
        if (close) break
        const start = C + 1
        const repeat = count(attrs, 'table:number-columns-repeated')
        C = start + repeat - 1
        if (empty) break
        const covered = name === 'table:covered-table-cell'
        const end = covered ? END_COVERED : END_CELL
        const from = TAG.lastIndex
        const at = xml.indexOf(end, from)
        if (at === -1) break
        TAG.lastIndex = at + end.length
        // A covered cell's text is never shown; SheetJS ignores it too.
        if (covered || !sheet || stored >= MAX_TABLE_CELLS) break
        const own = (attrs.includes('table:style-name') ? attr(attrs, 'table:style-name') : undefined) ?? rowStyle
        const inner = xml.slice(from, at)
        const hasStyledText = namesFormat(inner)
        let last: { bits: number; marked: string | null } | null = null
        for (let c = start; c <= C && stored < MAX_TABLE_CELLS; c++) {
          const base = cellBits(own ?? columnStyle(c))
          if (base === 0 && !hasStyledText) continue
          // Repeated columns usually share a style; mark the text once per style.
          if (!last || last.bits !== base) {
            const marked = odfCellMarked(inner, base)
            last = { bits: base, marked: odfMarkedHasFormat(marked) ? marked : null }
          }
          if (last.marked === null) continue
          for (let r = R; r < R + rowPeat && stored < MAX_TABLE_CELLS; r++, stored++) sheet.set(`${r},${c}`, last.marked)
        }
        break
      }
    }
  }
  return sheets
}
