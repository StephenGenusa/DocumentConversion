import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { readXlsx } from '../../src/core/readers/xlsx'
import { readCsv } from '../../src/core/readers/csv'
import { writeCsv } from '../../src/core/writers/csv'
import { writeXlsx } from '../../src/core/writers/xlsx'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeTxt } from '../../src/core/writers/txt'

function book(rows: string[][], bookType: 'xlsx' | 'xls'): Buffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Notes')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType }))
}

describe('a line break inside a spreadsheet cell', () => {
  it('shows as <br> for an Alt+Enter break in .xlsx and .xls', async () => {
    for (const type of ['xlsx', 'xls'] as const) {
      const hub = await readXlsx({ bytes: book([['Room', 'Hours'], ['North hall', 'Mon\nTue & Wed']], type), filename: `n.${type}` })
      expect(hub.html).toContain('<td>Mon<br>Tue &amp; Wed</td>')
    }
  })

  it('shows as <br> for a newline in a quoted csv field, CRLF included', async () => {
    const hub = await readCsv({ bytes: Buffer.from('Room,Hours\r\nNorth hall,"Mon\r\nTue"\r\n'), filename: 'n.csv' })
    expect(hub.html).toContain('<td>Mon<br>Tue</td>')
  })

  it('reads to csv, xlsx and md as before, the lines a space apart; txt keeps the break', async () => {
    const hub = await readXlsx({ bytes: book([['Room', 'Hours'], ['North hall', 'Mon\nTue']], 'xlsx'), filename: 'n.xlsx' })
    expect((await writeCsv(hub)).parts[0].bytes.toString('utf8')).toBe('Room,Hours\r\nNorth hall,Mon Tue\r\n')
    const sheet = XLSX.read((await writeXlsx(hub)).parts[0].bytes, { type: 'buffer' })
    expect(XLSX.utils.sheet_to_json(sheet.Sheets[sheet.SheetNames[0]], { header: 1 })).toEqual([['Room', 'Hours'], ['North hall', 'Mon Tue']])
    expect((await writeMarkdown(hub)).toString('utf8')).toContain('| North hall | Mon Tue |')
    // The text table lays the cell out on two lines, in its column.
    expect((await writeTxt(hub)).toString('utf8')).toContain('North hall   Mon\n             Tue')
  })
})
