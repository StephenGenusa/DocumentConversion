import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { XlsxBook, type CellValue } from '../../src/core/writers/xlsx-stream'
import { sheetNamer, writeRows, writeTable } from '../../src/core/writers/rows'
import { writeXlsx } from '../../src/core/writers/xlsx'

async function book(sheets: Array<[string, CellValue[][]]>, opts?: { zip64Above?: number }): Promise<Buffer> {
  const b = new XlsxBook(opts)
  for (const [name, rows] of sheets) {
    const s = b.sheet(name)
    for (const r of rows) await s.row(r)
    await s.end()
  }
  return b.end()
}

const asRows = (bytes: Buffer, sheet?: string): unknown[][] => {
  const wb = XLSX.read(bytes)
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet ?? wb.SheetNames[0]], { header: 1 })
}

describe('XlsxBook: a workbook written as it goes', () => {
  it('reads back as written: text as text, numbers as numbers, an empty cell empty', async () => {
    const rows: CellValue[][] = [
      ['Name', 'Qty', 'Note'],
      ['a & <b> "q"', 1.5, ''],
      ['  lead', -2, 'line\nbreak'],
      ['tail ', 1e21, 'tab\there'],
      ['_x0041_ is not A', '007', 'ünï 漢字 😀'],
      ['\u0001control', 0, 'z'],
    ]
    const out = asRows(await book([['Sheet & one', rows]]))
    expect(out[0]).toEqual(['Name', 'Qty', 'Note'])
    expect(out[1]).toEqual(['a & <b> "q"', 1.5])
    expect(out[2]).toEqual(['  lead', -2, 'line\nbreak'])
    expect(out[3]).toEqual(['tail ', 1e21, 'tab\there'])
    expect(out[4]).toEqual(['_x0041_ is not A', '007', 'ünï 漢字 😀'])
    expect(out[5]).toEqual(['\u0001control', 0, 'z'])
    expect(XLSX.read(await book([['Sheet & one', rows]])).SheetNames).toEqual(['Sheet & one'])
  })

  it('writes inline strings, one style, and the parts in the order Excel writes them', async () => {
    const zip = await JSZip.loadAsync(await book([['A', [['x', 1]]], ['B', [['y']]]]))
    expect(Object.keys(zip.files).slice(0, 5)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml'])
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t>x</t></is></c><c r="B1"><v>1</v></c>')
    expect(sheet).toContain('<ignoredError numberStoredAsText="1" sqref="A1:B1"/>')
    expect(zip.file('xl/sharedStrings.xml')).toBeNull()
  })

  it('makes the same bytes for the same workbook', async () => {
    const sheets: Array<[string, CellValue[][]]> = [['A', [['x', 1], ['y', 2]]]]
    expect((await book(sheets)).equals(await book(sheets))).toBe(true)
  })

  it('writes a part past the 32-bit sizes with ZIP64 sizes, which readers take', async () => {
    const rows: CellValue[][] = Array.from({ length: 2000 }, (_, i) => [`row ${i}`, i])
    const bytes = await book([['Big', rows]], { zip64Above: 1000 })
    // The ZIP64 extra field (header id 1) is there, and every reader still reads the book.
    expect(bytes.includes(Buffer.from([0x01, 0x00, 0x10, 0x00]))).toBe(true)
    const zip = await JSZip.loadAsync(bytes)
    expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('row 1999')
    expect(asRows(bytes)[1999]).toEqual(['row 1999', 1999])
  })
})

describe('xlsx from a document\'s tables', () => {
  it('writes each table as a sheet, its first row first', async () => {
    const body = Array.from({ length: 5 }, (_, i) => `<tr><td>r${i}</td><td>${i}</td></tr>`).join('')
    const res = await writeXlsx({ html: `<table><tr><th>Head</th><th>N</th></tr>${body}</table><table><tr><td>only</td></tr></table>` })
    expect(XLSX.read(res.parts[0].bytes).SheetNames).toEqual(['Table 1', 'Table 2'])
    // Text, as a document's cells always were in a workbook.
    expect(asRows(res.parts[0].bytes)).toEqual([['Head', 'N'], ['r0', '0'], ['r1', '1'], ['r2', '2'], ['r3', '3'], ['r4', '4']])
  })

  it('continues a table past the sheet limit on "name (2)", its first row repeated', async () => {
    const b = new XlsxBook()
    await writeTable(b, sheetNamer(), 'Table 1', ['Head'], [['r0'], ['r1'], ['r2'], ['r3']], 3)
    const bytes = await b.end()
    expect(XLSX.read(bytes).SheetNames).toEqual(['Table 1', 'Table 1 (2)'])
    expect(asRows(bytes, 'Table 1 (2)')).toEqual([['Head'], ['r2'], ['r3']])
  })
})

/** The best time of each job over `rounds`, in turn, after a warm-up (writer-md-perf.test.ts says why: no fixed budgets). */
async function bestInTurn(jobs: Array<() => Promise<unknown>>, rounds = 5): Promise<number[]> {
  for (const job of jobs) await job()
  const best = jobs.map(() => Infinity)
  for (let r = 0; r < rounds; r++) {
    for (let j = 0; j < jobs.length; j++) {
      const t0 = performance.now()
      await jobs[j]()
      best[j] = Math.min(best[j], performance.now() - t0)
    }
  }
  return best
}

describe('xlsx writing performance', () => {
  function* rows(n: number): Generator<string[]> {
    for (let i = 0; i < n; i++) yield [String(i), `Name ${i}`, `${i * 1.25}`, `Region ${i % 7}`, i % 3 ? 'note' : '']
  }
  const write = (n: number): Promise<unknown> => writeRows([{ name: 'items', header: ['id', 'name', 'price', 'region', 'note'], rows: rows(n) }], 'xlsx')

  /**
   * Rows are written as they come: four 25k-row tables against one of 100k
   * take the same time when the cost is linear, four times it when
   * quadratic; the bound, 2x, sits between.
   */
  it('scales close to linearly with row count', async () => {
    const [smallMs, largeMs] = await bestInTurn([
      async () => {
        for (let i = 0; i < 4; i++) await write(25_000)
      },
      () => write(100_000),
    ])
    expect(largeMs / smallMs, `100k rows ${largeMs.toFixed(0)} ms, 4 x 25k rows ${smallMs.toFixed(0)} ms`).toBeLessThan(2)
  }, 300_000)
})
