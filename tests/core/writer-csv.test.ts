import { describe, it, expect } from 'vitest'
import { writeCsv, extractTables } from '../../src/core/writers/csv'

const doc = (html: string) => ({ html })

describe('extractTables', () => {
  it('extracts a simple table', () => {
    const tables = extractTables('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>')
    expect(tables).toEqual([
      [
        ['A', 'B'],
        ['1', '2'],
      ],
    ])
  })

  it('expands colspan into the value followed by empty cells', () => {
    const tables = extractTables('<table><tr><td colspan="3">wide</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>')
    expect(tables[0][0]).toEqual(['wide', '', ''])
  })

  it('repeats a rowspan value down the rows it covers, for data exports', () => {
    // A merged label belongs on every row it applies to; blanking it meant
    // filtering the export silently lost the category.
    const tables = extractTables(
      '<table><tr><td rowspan="2">tall</td><td>r1</td></tr><tr><td>r2</td></tr></table>',
    )
    expect(tables[0]).toEqual([
      ['tall', 'r1'],
      ['tall', 'r2'],
    ])
  })

  it('finds multiple tables', () => {
    const html = '<table><tr><td>one</td></tr></table><p>x</p><table><tr><td>two</td></tr></table>'
    expect(extractTables(html)).toHaveLength(2)
  })
})

describe('writeCsv', () => {
  it('writes a single table as one unsuffixed part', async () => {
    const res = await writeCsv(doc('<table><tr><td>a</td><td>b</td></tr></table>'))
    expect(res.parts).toHaveLength(1)
    expect(res.parts[0].suffix).toBe('')
    expect(res.parts[0].bytes.toString('utf8')).toBe('a,b\r\n')
  })

  it('quotes cells containing commas and quotes (RFC 4180); collapses HTML whitespace', async () => {
    const res = await writeCsv(doc('<table><tr><td>a,b</td><td>say "hi"</td><td>two\nwords</td></tr></table>'))
    expect(res.parts[0].bytes.toString('utf8')).toBe('"a,b","say ""hi""",two words\r\n')
  })

  it('writes multiple tables as one part per table with .table-N suffixes', async () => {
    const res = await writeCsv(doc('<table><tr><td>one</td></tr></table><table><tr><td>two</td></tr></table>'))
    expect(res.parts.map((p) => p.suffix)).toEqual(['.table-1', '.table-2'])
    expect(res.parts[0].bytes.toString('utf8')).toBe('one\r\n')
    expect(res.parts[1].bytes.toString('utf8')).toBe('two\r\n')
  })

  it('throws no-tables for a document without tables', async () => {
    await expect(writeCsv(doc('<p>prose only</p>'))).rejects.toMatchObject({ code: 'no-tables' })
  })
})
