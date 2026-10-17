import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { writeDocx } from '../../src/core/writers/docx'
import { AUTO_TABLE_ROWS, AUTO_TABLE_WORD } from '../../src/core/shell'

/*
 * Word tables sized by what their columns hold, as PDF and HTML lay them out
 * (shell.ts: a document of modest tables, no word over AUTO_TABLE_WORD):
 * html-to-docx shares the width out evenly, so a "#" column took as much of
 * the page as a column of sentences, and "86.4 kN·m" broke beside it.
 */

async function documentXml(html: string): Promise<string> {
  return (await JSZip.loadAsync(await writeDocx({ html }))).file('word/document.xml')!.async('string')
}

const grid = (table: string): number[] =>
  [...(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/.exec(table)?.[1] ?? '').matchAll(/<w:gridCol w:w="(\d+)"/g)].map((m) => Number(m[1]))
const tables = (xml: string): string[] => xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []
const rows = (table: string): string[] => table.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []
const cells = (row: string): string[] => row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []
const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0)

/** The width between the margins of the page the writer emits. */
function textWidth(xml: string): number {
  const page = Number(/<w:pgSz w:w="(\d+)"/.exec(xml)![1])
  const left = Number(/<w:pgMar\b[^>]*w:left="(\d+)"/.exec(xml)![1])
  const right = Number(/<w:pgMar\b[^>]*w:right="(\d+)"/.exec(xml)![1])
  const gutter = Number(/<w:pgMar\b[^>]*w:gutter="(\d+)"/.exec(xml)?.[1] ?? 0)
  return page - left - right - gutter
}

const SENTENCE = 'A long sentence that describes the inspection finding in some detail for the reader.'

describe('docx table column widths', () => {
  it('fills the width between the margins, a column of sentences wider than a column of numbers', async () => {
    const xml = await documentXml(
      `<table><thead><tr><th>#</th><th>Load</th><th>Finding</th></tr></thead><tbody>` +
        `<tr><td>1</td><td>86.4 kN·m</td><td>${SENTENCE}</td></tr>` +
        `<tr><td>2</td><td>189 kN·m</td><td>Short.</td></tr></tbody></table>`,
    )
    const [table] = tables(xml)
    const cols = grid(table)
    expect(cols).toHaveLength(3)
    expect(sum(cols)).toBe(textWidth(xml))
    expect(table).toContain(`<w:tblW w:w="${textWidth(xml)}" w:type="dxa"/>`)
    expect(cols[2]).toBeGreaterThan(cols[1])
    expect(cols[1]).toBeGreaterThan(cols[0])
    // The short columns take what they hold, the sentences the rest.
    expect(cols[2]).toBeGreaterThan(textWidth(xml) / 2)
    // Each cell says its width too, the grid's.
    for (const row of rows(table)) {
      expect(cells(row).map((c) => Number(/<w:tcW w:w="(\d+)" w:type="dxa"\/>/.exec(c)?.[1]))).toEqual(cols)
    }
  })

  it('gives a cell spanning columns the sum of their widths, and widens them for a long spanning cell', async () => {
    const xml = await documentXml(
      `<table><thead><tr><th>Member</th><th colspan="2">Demand under the replacement deck options considered</th></tr>` +
        `<tr><th></th><th>A</th><th>B</th></tr></thead><tbody>` +
        `<tr><td>Interior stringer of the north truss</td><td>1</td><td>2</td></tr></tbody></table>`,
    )
    const [table] = tables(xml)
    const cols = grid(table)
    expect(sum(cols)).toBe(textWidth(xml))
    const first = cells(rows(table)[0])
    expect(first[1]).toContain('<w:gridSpan w:val="2"/>')
    expect(Number(/<w:tcW w:w="(\d+)"/.exec(first[1])![1])).toBe(cols[1] + cols[2])
    // The two one-letter columns share the long header's width between them.
    expect(cols[1] + cols[2]).toBeGreaterThan(textWidth(xml) / 3)
  })

  it('narrows the cell margins of a table whose words do not fit whole with them', async () => {
    const row = '<tr>' + ['Interior', 'Elastomeric', '86.4 kN·m', '29.0 kN·m', '27.3 kN·m', 'Timber', 'Utilization', 'Replace'].map((t) => `<td>${t}</td>`).join('') + '</tr>'
    const xml = await documentXml(`<table>${row}${row}</table>`)
    const [table] = tables(xml)
    const margins = [.../<w:tblCellMar>([\s\S]*?)<\/w:tblCellMar>/.exec(table)![1].matchAll(/<w:(left|right) w:type="dxa" w:w="(\d+)"\/>/g)].map((m) => Number(m[2]))
    expect(margins).toHaveLength(2)
    for (const m of margins) expect(m).toBeLessThan(160)
    expect(sum(grid(table))).toBe(textWidth(xml))
    // A short table keeps html-to-docx's margins.
    const small = tables(await documentXml('<table><tr><td>a</td><td>b</td></tr></table>'))[0]
    expect(small).toMatch(/<w:tblCellMar><w:top w:type="dxa" w:w="80"\/><w:left w:type="dxa" w:w="160"\/>/)
  })

  it('keeps the even columns when any table holds a word too long to lay out by content', async () => {
    const long = 'x'.repeat(AUTO_TABLE_WORD + 1)
    const xml = await documentXml(`<table><tr><td>1</td><td>${long}</td><td>${SENTENCE}</td></tr></table>`)
    const cols = grid(tables(xml)[0])
    expect(new Set(cols).size).toBe(1)
    expect(xml).not.toContain('<w:tcW')
  })

  it('keeps the even columns for a document of more rows than are laid out by content', async () => {
    const body = `<tr><td>1</td><td>${SENTENCE}</td></tr>`.repeat(AUTO_TABLE_ROWS + 1)
    const cols = grid(tables(await documentXml(`<table>${body}</table>`))[0])
    expect(new Set(cols).size).toBe(1)
  })

  it('repeats the header rows on each page and keeps them with the first body row', async () => {
    const xml = await documentXml(
      `<p>Before</p><table><thead><tr><th rowspan="2">Member</th><th colspan="2">Demand</th></tr><tr><th>Timber</th><th>FRP</th></tr></thead>` +
        `<tbody><tr><td>Stringer</td><td>29.0</td><td>27.3</td></tr><tr><td>Beam</td><td>72.4</td><td>68.1</td></tr></tbody></table>`,
    )
    const rs = rows(tables(xml)[0])
    expect(rs).toHaveLength(4)
    for (const header of rs.slice(0, 2)) {
      expect(header).toMatch(/<w:trPr><w:cantSplit\/><w:tblHeader\/><\/w:trPr>/)
      for (const p of header.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? []) expect(p).toContain('<w:keepNext/>')
    }
    for (const body of rs.slice(2)) {
      expect(body).not.toContain('w:tblHeader')
      expect(body).not.toContain('<w:keepNext/>')
    }
  })

  it('marks no header on a table without one', async () => {
    const xml = await documentXml(`<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>`)
    expect(xml).not.toContain('w:tblHeader')
  })

  it('sizes each of several tables by its own content', async () => {
    const xml = await documentXml(
      `<table><tr><td>${SENTENCE}</td><td>1</td></tr></table><p>Between</p>` + `<table><tr><td>1</td><td>${SENTENCE}</td></tr></table>`,
    )
    const [a, b] = tables(xml).map(grid)
    expect(a[0]).toBeGreaterThan(a[1])
    expect(b[1]).toBeGreaterThan(b[0])
    expect(sum(a)).toBe(textWidth(xml))
    expect(sum(b)).toBe(textWidth(xml))
  })
})
