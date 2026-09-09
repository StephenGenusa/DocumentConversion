import { describe, it, expect } from 'vitest'
import { promoteHeaderRows } from '../../src/core/readers/docx'
import { tableGrid } from '../../src/core/table-grid'
import { writeJson } from '../../src/core/writers/json'
import { writeCsv } from '../../src/core/writers/csv'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeHtml } from '../../src/core/writers/html'
import { sanitizeToHub } from '../../src/core/allowlist'

const twoTables =
  '<table><tr><td>Name</td><td>Qty</td></tr><tr><td>Widget</td><td>3</td></tr></table>' +
  '<table><tr><td>a</td><td>b</td></tr></table>'

describe('docx header rows', () => {
  it('promotes the first row of tables flagged as having a header', () => {
    const out = promoteHeaderRows(twoTables, [true, false])
    expect(out).toContain('<th>Name</th>')
    expect(out).toContain('<th>Qty</th>')
    expect(out).toContain('<td>Widget</td>')
    // The unflagged table is untouched.
    expect(out).toContain('<td>a</td>')
  })

  it('leaves tables alone when nothing is flagged or a header already exists', () => {
    expect(promoteHeaderRows(twoTables, [])).toBe(twoTables)
    const withTh = '<table><tr><th>X</th></tr><tr><td>1</td></tr></table>'
    expect(promoteHeaderRows(withTh, [true])).toBe(withTh)
  })

  it('turns the flagged row into real header markup that survives to the html output', async () => {
    const raw =
      '<table><tr><td>Salvage:</td><td>Do not salvage:</td></tr><tr><td>Wire</td><td>Poles</td></tr></table>'
    const flagged = promoteHeaderRows(raw, [true])
    // Pinned in full: any change to what the promotion produces fails here,
    // and an implementation that returned its input unchanged fails first.
    expect(flagged).toBe(
      '<table><tr><th>Salvage:</th><th>Do not salvage:</th></tr><tr><td>Wire</td><td>Poles</td></tr></table>',
    )
    expect(flagged).not.toBe(raw)
    expect(sanitizeToHub(flagged)).toContain('<th>Salvage:</th>')
    const html = (await writeHtml({ html: flagged })).toString('utf8')
    expect(html).toContain('<th>Salvage:</th>')
    expect(html).toContain('<th>Do not salvage:</th>')
    expect(html).not.toContain('<td>Salvage:</td>')
  })

  it('changes NOTHING in the markdown output, because the md writer never guessed', async () => {
    // Recorded because the opposite is the natural assumption and it is wrong:
    // writeMarkdown renders every table from its grid and GFM requires a
    // header, so row 0 is the header whether or not it is <th>. Asserting
    // "markdown gets a real header" therefore proves nothing about
    // promoteHeaderRows — the bytes are identical either way.
    const raw =
      '<table><tr><td>Salvage:</td><td>Do not salvage:</td></tr><tr><td>Wire</td><td>Poles</td></tr></table>'
    const before = (await writeMarkdown({ html: raw })).toString('utf8')
    const after = (await writeMarkdown({ html: promoteHeaderRows(raw, [true]) })).toString('utf8')
    expect(after).toBe(before)
    expect(after.split('\n')[0]).toContain('Salvage:')
  })
})

describe('rowspan fill policy', () => {
  const html =
    '<table><tr><td rowspan="2">Poles</td><td>Wooden</td></tr><tr><td>Steel</td></tr></table>'

  it('repeats the spanned value for data exports', async () => {
    expect(tableGrid(html, { fillRowspan: true })[0]).toEqual([
      ['Poles', 'Wooden'],
      ['Poles', 'Steel'],
    ])
    const csv = (await writeCsv({ html })).parts[0].bytes.toString('utf8')
    expect(csv).toContain('Poles,Steel')
  })

  it('leaves it blank for markdown, which shows the merge visually', async () => {
    expect(tableGrid(html)[0]).toEqual([
      ['Poles', 'Wooden'],
      ['', 'Steel'],
    ])
  })
})

describe('json value typing', () => {
  it('emits real numbers when the text round-trips exactly', async () => {
    const res = await writeJson({
      html: '<table><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Widget</td><td>3</td></tr></tbody></table>',
    })
    expect(JSON.parse(res.parts[0].bytes.toString('utf8'))).toEqual([{ Item: 'Widget', Qty: 3 }])
  })

  it('keeps identifiers and formatted numbers as written', async () => {
    const res = await writeJson({
      html:
        '<table><thead><tr><th>Code</th><th>Price</th><th>Big</th></tr></thead><tbody>' +
        '<tr><td>0302</td><td>1.50</td><td>12345678901234567890</td></tr></tbody></table>',
    })
    const [row] = JSON.parse(res.parts[0].bytes.toString('utf8'))
    expect(row.Code).toBe('0302')
    expect(row.Price).toBe('1.50')
    expect(row.Big).toBe('12345678901234567890')
  })
})

describe('html metadata does not leak into the body', () => {
  it('drops <title> text instead of rendering it above the content', () => {
    const clean = sanitizeToHub('<head><title>Page Title</title></head><body><h1>Real Heading</h1></body>')
    expect(clean).not.toContain('Page Title')
    expect(clean).toContain('Real Heading')
  })
})
