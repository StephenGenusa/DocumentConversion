import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { readXlsx } from '../../src/core/readers/xlsx'
import { ConversionError } from '../../src/core/errors'

const DOCS = join(__dirname, '../corpus')
const itIfCorpus = existsSync(DOCS) ? it : it.skip

function workbookBytes(
  sheets: Record<string, (string | number)[][]>,
  bookType: 'xlsx' | 'xls' | 'ods' = 'xlsx',
): Buffer {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType }))
}

/**
 * A genuinely password-protected BIFF8 workbook: a real .xls with a FilePass
 * record (0x002f, XOR obfuscation) spliced in right after the leading BOF.
 * The xlsx library reaches its real "File is password-protected" throw, so the
 * test exercises the same path an encrypted workbook from Excel takes.
 */
function encryptedXlsBytes(): Buffer {
  const plain = Buffer.from(workbookBytes({ Secret: [['a', 'b']] }, 'xls'))
  const cfb = XLSX.CFB.read(plain, { type: 'buffer' })
  const entry = XLSX.CFB.find(cfb, '/Workbook') ?? XLSX.CFB.find(cfb, '/Book')
  if (!entry) throw new Error('fixture: no workbook stream')
  const content = Buffer.from(entry.content as Uint8Array)
  const filePass = Buffer.from([0x2f, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  const afterBof = 4 + content.readUInt16LE(2)
  const patched = Buffer.concat([content.subarray(0, afterBof), filePass, content.subarray(afterBof)])
  entry.content = patched
  entry.size = patched.length
  return Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' }) as Uint8Array)
}

describe('readXlsx', () => {
  it('renders each sheet as a heading plus table', async () => {
    const bytes = workbookBytes({
      Inventory: [
        ['Item', 'Qty'],
        ['Widget', 3],
      ],
      Prices: [['Widget', 9.5]],
    })
    const hub = await readXlsx({ bytes, filename: 'book.xlsx' })
    expect(hub.html).toContain('<h2>Inventory</h2>')
    expect(hub.html).toContain('<h2>Prices</h2>')
    expect(hub.html).toContain('<td>Widget</td>')
    expect(hub.html).toContain('<td>3</td>')
  })

  it('sets the workbook filename as title', async () => {
    const bytes = workbookBytes({ S: [['x']] })
    const hub = await readXlsx({ bytes, filename: 'metrics.xlsx' })
    expect(hub.title).toBe('metrics.xlsx')
  })

  it('reads legacy .xls and OpenDocument .ods through the same reader', async () => {
    for (const bookType of ['xls', 'ods'] as const) {
      const bytes = workbookBytes({ Data: [['Item', 'Qty'], ['Widget', 3]] }, bookType)
      const hub = await readXlsx({ bytes, filename: `book.${bookType}` })
      expect(hub.html, bookType).toContain('<td>Widget</td>')
      expect(hub.html, bookType).toContain('<td>3</td>')
    }
  })

  it('converts a workbook far larger than the old cumulative cap', async () => {
    // Regression: a real 2.1 MB workbook (~317k cells over 5 sheets) was
    // rejected because the budget was cumulative and set at 50k.
    const rows = Array.from({ length: 12000 }, (_, i) => [i, i, i, i, i]) // 60k cells/sheet
    const bytes = workbookBytes({ One: rows, Two: rows, Three: rows, Four: rows, Five: rows })
    const hub = await readXlsx({ bytes, filename: 'big.xlsx' })
    expect(hub.html).toContain('<h2>One</h2>')
    expect(hub.html).toContain('<h2>Five</h2>')
  }, 60000)

  /**
   * `sheet_to_json` materialises the whole `!ref` range, and Excel's saved
   * range routinely runs 30-odd columns past the last thing anyone typed. With
   * the shell's `table-layout: fixed` those junk columns divide the page
   * evenly, so a two-column form drew one letter per line down a 20px column
   * and ran to 115 pages.
   */
  describe('trailing empty rows and columns', () => {
    const pad = (row: (string | number)[], width: number): (string | number)[] =>
      row.concat(Array(width - row.length).fill(''))

    /** Column slots a row occupies, colspans counted in full. */
    const rowWidths = (html: string): number[] =>
      [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, body]) =>
        [...body.matchAll(/<t[dh]([^>]*)>/g)].reduce((n, [, attrs]) => {
          const span = /colspan="(\d+)"/.exec(attrs)
          return n + (span ? Number(span[1]) : 1)
        }, 0),
      )

    it('drops trailing all-empty columns so a two-column form stays two columns', async () => {
      const bytes = workbookBytes({
        Form: [pad(['Job Number', '5502187'], 34), pad(['Project Name', 'Northgate Annex'], 34)],
      })
      const hub = await readXlsx({ bytes, filename: 'form.xlsx' })
      expect(hub.html).toContain('<tr><td>Job Number</td><td>5502187</td></tr>')
      expect(hub.html).not.toContain('<td></td>')
      expect(rowWidths(hub.html)).toEqual([2, 2])
    })

    it('keeps an empty column between two populated ones', async () => {
      const bytes = workbookBytes({ Gap: [pad(['A', '', 'C'], 20), pad(['B', '', 'D'], 20)] })
      const hub = await readXlsx({ bytes, filename: 'gap.xlsx' })
      expect(hub.html).toContain('<tr><td>A</td><td></td><td>C</td></tr>')
      expect(rowWidths(hub.html)).toEqual([3, 3])
    })

    it('drops trailing all-empty rows', async () => {
      const bytes = workbookBytes({
        Tail: [
          ['Item', 'Qty'],
          ['Widget', '3'],
          ['', ''],
          ['', ''],
        ],
      })
      const hub = await readXlsx({ bytes, filename: 'tail.xlsx' })
      expect(rowWidths(hub.html)).toEqual([2, 2])
    })

    it('leaves an interior empty row alone', async () => {
      const bytes = workbookBytes({
        Mid: [
          ['Item', 'Qty'],
          ['', ''],
          ['Widget', '3'],
        ],
      })
      const hub = await readXlsx({ bytes, filename: 'mid.xlsx' })
      expect(rowWidths(hub.html)).toEqual([2, 2, 2])
    })

    itIfCorpus('leaves a sheet whose range is entirely used untouched', async () => {
      const bytes = readFileSync(join(DOCS, 'catalogue-codes.xlsx'))
      const hub = await readXlsx({ bytes, filename: 'catalogue-codes.xlsx' })
      const widths = rowWidths(hub.html)
      expect(widths.length).toBe(410)
      expect(new Set(widths)).toEqual(new Set([3]))
    })

    it('still renders a sheet of nothing but blank cells as it always did', async () => {
      const bytes = workbookBytes({ Blank: [['', '', ''], ['', '', '']] })
      const hub = await readXlsx({ bytes, filename: 'blank.xlsx' })
      expect(rowWidths(hub.html)).toEqual([3, 3])
    })

    itIfCorpus('anchors merges to the used-range origin and clamps them to the trimmed grid', async () => {
      // This workbook's `!ref` starts at column B, so sheet_to_json's column 0
      // is spreadsheet column B while `!merges` stays in absolute coordinates.
      // Un-shifted, every section header merged across B:C landed one column
      // to the right and widened the table to three columns.
      const bytes = readFileSync(join(DOCS, 'form-with-merged-cells.xls'))
      const hub = await readXlsx({ bytes, filename: 'form-with-merged-cells.xls' })
      expect(hub.html).toContain('<td colspan="2">Transmittal Data</td>')
      expect(hub.html).toContain('<td colspan="2">Special Instructions:</td>')
      expect(Math.max(...rowWidths(hub.html))).toBe(2)
    })
  })

  describe('failure messages', () => {
    it('names the real format and the password for an encrypted .xls', async () => {
      const bytes = encryptedXlsBytes()
      const err = await readXlsx({ bytes, filename: 'budget.xls' }).then(
        () => null,
        (e: unknown) => e,
      )
      // A ConversionError passes through convert.ts untouched, so the message
      // below is the whole message — no "Could not read xlsx:" prefix bolted on.
      expect(err).toBeInstanceOf(ConversionError)
      const message = (err as ConversionError).message
      expect(message).toContain('.xls file')
      expect(message).not.toContain('xlsx')
      expect(message).not.toContain('Could not read')
      expect(message).toMatch(/password/i)
      expect(message).toMatch(/remove the password/i)
    })

    it('names the real format when a workbook is simply unreadable', async () => {
      // A truncated OLE header: recognised as a container, unreadable as a book.
      const bytes = Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.alloc(64, 3),
      ])
      const err = await readXlsx({ bytes, filename: 'sheet.ods' }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(ConversionError)
      expect((err as ConversionError).message).toContain('.ods file')
      expect((err as ConversionError).message).not.toContain('xlsx')
    })

    it('lets a table-too-large ConversionError through unchanged', async () => {
      const rows = Array.from({ length: 120_000 }, (_, i) => [i, i, i, i, i]) // 600k cells
      const bytes = workbookBytes({ Huge: rows })
      await expect(readXlsx({ bytes, filename: 'huge.xlsx' })).rejects.toThrow(/cell limit|-cell limit/)
    }, 120000)
  })
})
