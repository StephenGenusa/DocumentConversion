import { describe, it, expect } from 'vitest'
import { readCsv } from '../../src/core/readers/csv'

const src = (text: string, filename?: string) => ({ bytes: Buffer.from(text, 'utf8'), filename })

describe('readCsv', () => {
  it('renders rows as an html table', async () => {
    const hub = await readCsv(src('Name,Qty\nWidget,3\nGadget,7\n', 'inv.csv'))
    expect(hub.html).toContain('<table>')
    expect(hub.html).toContain('<th>Name</th>')
    expect(hub.html).toContain('<td>Widget</td>')
    expect(hub.html).toContain('<td>7</td>')
  })

  it('uses thead only when the first row looks like a header', async () => {
    const noHeader = await readCsv(src('1,2\n3,4\n', 'nums.csv'))
    expect(noHeader.html).not.toContain('<th>')
    const withHeader = await readCsv(src('col,other\n1,2\n', 'x.csv'))
    expect(withHeader.html).toContain('<th>col</th>')
  })

  it('auto-detects semicolon and tab delimiters', async () => {
    const semi = await readCsv(src('a;b\nc;d\n', 'x.csv'))
    expect(semi.html).toContain('<td>c</td>')
    const tab = await readCsv(src('a\tb\nc\td\n', 'x.tsv'))
    expect(tab.html).toContain('<td>d</td>')
  })

  it('escapes html in cells', async () => {
    const hub = await readCsv(src('a,b\n<script>,x\n', 'x.csv'))
    expect(hub.html).not.toContain('<script>')
    expect(hub.html).toContain('&lt;script&gt;')
  })

  it('accepts the cell counts a routine business file reaches', async () => {
    // A 2 MB workbook of ~300k cells used to be rejected outright.
    const rows = 'a,b,c,d,e\n'.repeat(20000) // 100k cells
    const hub = await readCsv(src(rows, 'big.csv'))
    expect(hub.html).toContain('<table>')
  })

  it('drops trailing empty columns a spreadsheet export padded the rows with', async () => {
    // Same defect as the xlsx reader's `!ref` padding: with `table-layout:
    // fixed` the junk columns divide the page evenly and every cell renders
    // one character per line.
    const hub = await readCsv(src('Job Number,5502187,,,,,,,,\nProject,Northgate Annex,,,,,,,,\n', 'form.csv'))
    expect(hub.html).toContain('<tr><td>Job Number</td><td>5502187</td></tr>')
    expect(hub.html).not.toContain('<td></td>')
  })

  it('keeps an empty column between two populated ones', async () => {
    const hub = await readCsv(src('A,,C\nB,,D\n', 'gap.csv'))
    expect(hub.html).toContain('<tr><td>A</td><td></td><td>C</td></tr>')
  })

  it('rejects genuinely oversized tables with an actionable message', async () => {
    const wide = `${'x,'.repeat(500_001)}end\n`
    await expect(readCsv(src(wide, 'huge.csv'))).rejects.toMatchObject({ code: 'table-too-large' })
    await expect(readCsv(src(wide, 'huge.csv'))).rejects.toThrowError(/Split it into smaller files/)
  })
})
