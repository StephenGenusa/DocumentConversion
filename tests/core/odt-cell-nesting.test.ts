import { describe, it, expect } from 'vitest'
import { odfRowCells } from '../../src/core/readers/odt'

/**
 * A cell's <text:p> blocks were matched with a lazy regex, which closes on the
 * FIRST </text:p> — including one nested inside a <text:note-body>. Everything
 * after the note in that paragraph was therefore cut off before odfText ever
 * saw it, so a table cell containing a footnote lost the rest of its text.
 *
 * odfListItems in odf-common.ts already uses scanElements for exactly this
 * reason ("a lazy match ends on the wrong close tag"); this is the same fix.
 */
const cell = (inner: string): string => `<table:table-row><table:table-cell>${inner}</table:table-cell></table:table-row>`

describe('odt table cells with nested paragraphs', () => {
  it('keeps the text that follows a footnote in the same cell', () => {
    const xml = cell(
      '<text:p>Rated ' +
        '<text:note text:note-class="footnote">' +
        '<text:note-citation>1</text:note-citation>' +
        '<text:note-body><text:p>see appendix</text:p></text:note-body>' +
        '</text:note>' +
        ' at 400 V</text:p>',
    )
    const [value] = odfRowCells(xml)
    expect(value).toContain('Rated')
    // The defect: everything from the nested </text:p> onward was dropped.
    expect(value).toContain('400 V')
    expect(value).not.toMatch(/Rated\s*$/)
  })

  it('does not fuse the words either side of the note', () => {
    const xml = cell(
      '<text:p>alpha<text:note><text:note-citation>2</text:note-citation>' +
        '<text:note-body><text:p>note</text:p></text:note-body></text:note>beta</text:p>',
    )
    const [value] = odfRowCells(xml)
    expect(value).not.toContain('alphabeta')
    expect(value).toContain('alpha')
    expect(value).toContain('beta')
  })

  it('still joins several paragraphs in one cell', () => {
    const [value] = odfRowCells(cell('<text:p>first</text:p><text:p>second</text:p>'))
    expect(value).toBe('first second')
  })

  it('still honours number-columns-repeated', () => {
    const xml = '<table:table-row><table:table-cell table:number-columns-repeated="3"><text:p>x</text:p></table:table-cell></table:table-row>'
    expect(odfRowCells(xml)).toEqual(['x', 'x', 'x'])
  })

  it('drops trailing blank cells, which pad ODF rows to the sheet width', () => {
    // Documented behaviour of the trailing-blank trim, pinned here because the
    // scanElements change runs immediately before it.
    expect(odfRowCells(cell(''))).toEqual([])
    expect(odfRowCells('<table:table-row><table:table-cell/></table:table-row>')).toEqual([])
  })

  it('keeps a blank cell that sits BETWEEN two populated ones', () => {
    const xml =
      '<table:table-row>' +
      '<table:table-cell><text:p>a</text:p></table:table-cell>' +
      '<table:table-cell/>' +
      '<table:table-cell><text:p>c</text:p></table:table-cell>' +
      '</table:table-row>'
    expect(odfRowCells(xml)).toEqual(['a', '', 'c'])
  })
})

/**
 * The same lazy-regex defect one level up. The cell and row matchers closed
 * on the FIRST </table:table-cell> / </table:table-row>, so a cell holding a
 * nested table ended at the nested table's first cell: everything after it in
 * the outer cell vanished, the outer row's remaining cells vanished, and the
 * outer cell's opening text fused with the inner table's first cell.
 */
describe('odt nested tables', () => {
  const NESTED =
    '<table:table><table:table-row>' +
    '<table:table-cell><text:p>outer A</text:p>' +
    '<table:table><table:table-row>' +
    '<table:table-cell><text:p>inner 1</text:p></table:table-cell>' +
    '<table:table-cell><text:p>inner 2</text:p></table:table-cell>' +
    '</table:table-row></table:table>' +
    '<text:p>outer A tail</text:p></table:table-cell>' +
    '<table:table-cell><text:p>outer B</text:p></table:table-cell>' +
    '</table:table-row>' +
    '<table:table-row>' +
    '<table:table-cell><text:p>second row</text:p></table:table-cell>' +
    '<table:table-cell><text:p>still here</text:p></table:table-cell>' +
    '</table:table-row></table:table>'

  it('keeps every outer cell and row', async () => {
    const { renderOdfTable } = await import('../../src/core/readers/odt')
    const html = renderOdfTable(NESTED.replace(/^<table:table>|<\/table:table>$/g, ''))!
    for (const text of ['outer A', 'outer A tail', 'outer B', 'inner 1', 'inner 2', 'second row', 'still here']) {
      expect(html).toContain(text)
    }
    // Two outer rows, and the inner table is a real table inside the first cell.
    expect(html.match(/<tr>/g)).toHaveLength(3)
    expect(html).toMatch(/<td>[^<]*outer A[\s\S]*<table>[\s\S]*inner 1[\s\S]*<\/table>[\s\S]*outer A tail[\s\S]*<\/td>/)
  })

  it('does not fuse the outer text with the inner cell', async () => {
    const { renderOdfTable } = await import('../../src/core/readers/odt')
    const html = renderOdfTable(NESTED.replace(/^<table:table>|<\/table:table>$/g, ''))!
    expect(html).not.toContain('outer A inner 1')
    expect(html).not.toContain('Ainner')
  })
})
