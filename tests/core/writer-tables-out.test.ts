import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { writeJson } from '../../src/core/writers/json'
import { writeXlsx } from '../../src/core/writers/xlsx'

const oneTable =
  '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Widget</td><td>3</td></tr><tr><td>Gadget</td><td>7</td></tr></tbody></table>'
const twoTables = `${oneTable}<h2>Second</h2><table><tr><td>a</td><td>b</td></tr></table>`

describe('writeJson', () => {
  it('emits header-keyed row objects for a single table', async () => {
    const res = await writeJson({ html: oneTable })
    expect(res.parts).toHaveLength(1)
    expect(res.parts[0].suffix).toBe('')
    expect(JSON.parse(res.parts[0].bytes.toString('utf8'))).toEqual([
      { Name: 'Widget', Qty: 3 },
      { Name: 'Gadget', Qty: 7 },
    ])
  })

  it('emits arrays of cells when there is no header row', async () => {
    const res = await writeJson({ html: '<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>' })
    expect(JSON.parse(res.parts[0].bytes.toString('utf8'))).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('writes one part per table with .table-N suffixes', async () => {
    const res = await writeJson({ html: twoTables })
    expect(res.parts.map((p) => p.suffix)).toEqual(['.table-1', '.table-2'])
  })

  it('throws no-tables when the document has none', async () => {
    await expect(writeJson({ html: '<p>prose</p>' })).rejects.toMatchObject({ code: 'no-tables' })
  })
})

/**
 * A header row that repeats a name cannot become an object: the later key
 * overwrites the earlier one and a whole column leaves the file with nothing
 * said about it. Falling back to arrays keeps every cell and every header in
 * position and invents no name, which is the honest degradation.
 */
describe('writeJson with a duplicate header name', () => {
  const repeated =
    '<table><thead><tr><th>Region</th><th>Q1</th><th>Q1</th></tr></thead>' +
    '<tbody><tr><td>North</td><td>10</td><td>20</td></tr></tbody></table>'

  it('keeps every column when the header repeats a name', async () => {
    const res = await writeJson({ html: repeated })
    expect(JSON.parse(res.parts[0].bytes.toString('utf8'))).toEqual([
      ['Region', 'Q1', 'Q1'],
      ['North', 10, 20],
    ])
  })

  it('falls back for a header whose blank cell collides with a real column name', async () => {
    // The blank second cell is keyed "column2", which is also what the third
    // header literally says — an object would silently drop one of them.
    const res = await writeJson({
      html:
        '<table><thead><tr><th>Name</th><th></th><th>column2</th></tr></thead>' +
        '<tbody><tr><td>a</td><td>1</td><td>2</td></tr></tbody></table>',
    })
    expect(JSON.parse(res.parts[0].bytes.toString('utf8'))).toEqual([
      ['Name', '', 'column2'],
      ['a', 1, 2],
    ])
  })

  it('still emits objects when the header names are all distinct', async () => {
    const res = await writeJson({ html: oneTable })
    expect(JSON.parse(res.parts[0].bytes.toString('utf8'))[0]).toEqual({ Name: 'Widget', Qty: 3 })
  })
})

describe('writeXlsx', () => {
  it('writes one workbook with a sheet per table', async () => {
    const res = await writeXlsx({ html: twoTables })
    expect(res.parts).toHaveLength(1)
    const wb = XLSX.read(res.parts[0].bytes, { type: 'buffer' })
    expect(wb.SheetNames).toHaveLength(2)
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false })
    expect(rows[0]).toEqual(['Name', 'Qty'])
    expect(rows[1]).toEqual(['Widget', '3'])
  })

  it('throws no-tables when the document has none', async () => {
    await expect(writeXlsx({ html: '<p>prose</p>' })).rejects.toMatchObject({ code: 'no-tables' })
  })
})
