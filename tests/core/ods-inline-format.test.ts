import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { readXlsx } from '../../src/core/readers/xlsx'
import { extractTables } from '../../src/core/writers/csv'

/*
 * OpenDocument spreadsheets are read by SheetJS, which keeps a cell's text and
 * nothing of how it looks. These build .ods packages in memory, with the cell
 * and text styles LibreOffice writes, and check that the hub table keeps the
 * formatting — in the cell SheetJS put the text in.
 */

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"'

const AUTO = `<office:automatic-styles>
<style:style style:name="ceB" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="ceI" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="ceHead" style:family="table-cell" style:parent-style-name="Heading"/>
<style:style style:name="ceAll" style:family="table-cell"><style:text-properties fo:font-weight="bold" fo:font-style="italic" style:text-underline-style="solid" style:text-line-through-style="solid" style:text-position="super 58%"/></style:style>
<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="T3" style:family="text"><style:text-properties style:text-position="sub 58%"/></style:style>
<style:style style:name="TPlain" style:family="text"><style:text-properties fo:font-weight="normal"/></style:style>
<style:style style:name="TColour" style:family="text"><style:text-properties fo:color="#ff0000"/></style:style>
<style:style style:name="P1" style:family="paragraph"><style:text-properties style:text-underline-style="solid"/></style:style>
</office:automatic-styles>`

const STYLES = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}><office:styles>
<style:style style:name="Default" style:family="table-cell"><style:text-properties fo:font-weight="normal"/></style:style>
<style:style style:name="Heading" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>
</office:styles></office:document-styles>`

const MANIFEST =
  '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">' +
  '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>' +
  '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>'

async function ods(tables: string, auto = AUTO): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' })
  zip.file('META-INF/manifest.xml', MANIFEST)
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}>${auto}<office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`,
  )
  zip.file('styles.xml', STYLES)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Promise<Buffer>
}

/** A string cell; `xml` is the cell's inner XML, `attrs` its extra attributes. */
const cell = (xml: string, attrs = ''): string =>
  `<table:table-cell office:value-type="string"${attrs}>${xml}</table:table-cell>`
const p = (xml: string, attrs = ''): string => `<text:p${attrs}>${xml}</text:p>`
const row = (...cells: string[]): string => `<table:table-row>${cells.join('')}</table:table-row>`
const table = (name: string, body: string, attrs = ''): string =>
  `<table:table table:name="${name}"${attrs}>${body}</table:table>`

async function read(tables: string): Promise<string> {
  return (await readXlsx({ bytes: await ods(tables), filename: 'sheet.ods' })).html
}

describe('.ods inline formatting', () => {
  it('keeps span formatting inside a cell', async () => {
    const html = await read(
      table(
        'Codes',
        row(
          cell(p('A <text:span text:style-name="T1">bold</text:span> and <text:span text:style-name="T2">slanted</text:span> word')),
          cell(p('H<text:span text:style-name="T3">2</text:span>O')),
        ),
      ),
    )
    expect(html).toContain('<td>A <strong>bold</strong> and <em>slanted</em> word</td>')
    expect(html).toContain('<td>H<sub>2</sub>O</td>')
  })

  it('keeps a whole cell bold from its cell style, following the parent style', async () => {
    const html = await read(
      table('Codes', row(cell(p('Total'), ' table:style-name="ceB"'), cell(p('Folio'), ' table:style-name="ceHead"'), cell(p('Plain')))),
    )
    expect(html).toContain('<td><strong>Total</strong></td>')
    expect(html).toContain('<td><strong>Folio</strong></td>')
    expect(html).toContain('<td>Plain</td>')
  })

  it('nests every kind in the hub order', async () => {
    const html = await read(table('Codes', row(cell(p('All'), ' table:style-name="ceAll"'))))
    expect(html).toContain('<td><strong><em><u><s><sup>All</sup></s></u></em></strong></td>')
  })

  it("uses the column's default cell style, across repeated columns", async () => {
    const html = await read(
      table(
        'Codes',
        '<table:table-column table:default-cell-style-name="Default"/>' +
          '<table:table-column table:number-columns-repeated="2" table:default-cell-style-name="ceI"/>' +
          '<table:table-column table:number-columns-repeated="1021" table:default-cell-style-name="Default"/>' +
          row(cell(p('one')), cell(p('two')), cell(p('three')), cell(p('four'))) +
          // The cell's own style wins over the column's.
          row(cell(p('five')), cell(p('six'), ' table:style-name="Default"'), cell(p('seven')), cell(p('eight'))),
      ),
    )
    expect(html).toContain('<tr><td>one</td><td><em>two</em></td><td><em>three</em></td><td>four</td></tr>')
    expect(html).toContain('<tr><td>five</td><td>six</td><td><em>seven</em></td><td>eight</td></tr>')
  })

  it('lets a span switch off what the cell style turns on', async () => {
    const html = await read(
      table('Codes', row(cell(p('Bold <text:span text:style-name="TPlain">plain</text:span> bold'), ' table:style-name="ceB"'))),
    )
    expect(html).toContain('<td><strong>Bold </strong>plain<strong> bold</strong></td>')
  })

  it('keeps paragraph-style formatting in a cell', async () => {
    const html = await read(table('Codes', row(cell(p('lined', ' text:style-name="P1"')))))
    expect(html).toContain('<td><u>lined</u></td>')
  })

  it('stays aligned past repeated cells, repeated rows and merged cells', async () => {
    const html = await read(
      table(
        'Codes',
        row(cell(p('Wide'), ' table:number-columns-spanned="2" table:style-name="ceB"'), '<table:covered-table-cell/>', cell(p('after'), ' table:style-name="ceI"')) +
          '<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="3"/></table:table-row>' +
          row('<table:table-cell table:number-columns-repeated="2"/>', cell(p('third'), ' table:style-name="ceB"')) +
          row(cell(p('same'), ' table:number-columns-repeated="2" table:style-name="ceI"'), cell(p('x'))) +
          '<table:table-row table:number-rows-repeated="1000000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>',
      ),
    )
    expect(html).toContain('<td colspan="2"><strong>Wide</strong></td><td><em>after</em></td>')
    expect(html).toContain('<tr><td></td><td></td><td><strong>third</strong></td></tr>')
    expect(html).toContain('<tr><td><em>same</em></td><td><em>same</em></td><td>x</td></tr>')
  })

  it('keeps cells aligned when the sheet starts below and right of A1', async () => {
    const html = await read(
      table(
        'Codes',
        '<table:table-row><table:table-cell table:number-columns-repeated="4"/></table:table-row>' +
          row('<table:table-cell/>', cell(p('Left')), cell(p('Right'), ' table:style-name="ceB"')),
      ),
    )
    expect(html).toContain('<tr><td>Left</td><td><strong>Right</strong></td></tr>')
  })

  it('keeps the line between paragraphs in a cell as it is read today', async () => {
    const plain = await read(table('Codes', row(cell(p('first') + p('second')))))
    const bold = await read(table('Codes', row(cell(p('first') + p('<text:span text:style-name="T1">second</text:span>')))))
    expect(plain).toContain('<td>first\nsecond</td>')
    expect(bold).toContain('<td>first\n<strong>second</strong></td>')
  })

  it("formats a number cell's shown text", async () => {
    const html = await read(
      table(
        'Codes',
        row(
          '<table:table-cell office:value-type="float" office:value="1234.5" table:style-name="ceB"><text:p>1 234,50</text:p></table:table-cell>',
          cell(p('Count')),
        ),
      ),
    )
    expect(html).toContain('<td><strong>1 234,50</strong></td>')
  })

  it("keeps a whole cell's format when SheetJS reads a different text than the paragraphs", async () => {
    // SheetJS takes office:string-value over the paragraphs; the formatted
    // paragraphs cannot be used, but the cell's one format still applies.
    const html = await read(
      table(
        'Codes',
        row(
          cell(p('shown'), ' office:string-value="stored" table:style-name="ceB"'),
          cell(p('<text:span text:style-name="T1">half</text:span> shown'), ' office:string-value="stored too"'),
        ),
      ),
    )
    expect(html).toContain('<td><strong>stored</strong></td><td>stored too</td>')
  })

  it('does not wrap a header cell in a bold the header already gives it', async () => {
    const html = await read(
      table(
        'Codes',
        row(cell(p('Name'), ' table:style-name="ceHead"'), cell(p('<text:span text:style-name="T2">Qty</text:span>'), ' table:style-name="ceB"')) +
          row(cell(p('Folio')), '<table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell>'),
      ),
    )
    expect(html).toContain('<thead><tr><th>Name</th><th><em>Qty</em></th></tr></thead>')
  })

  it('formats each sheet in its own table, hidden ones included as before', async () => {
    const html = await read(
      table('First', row(cell(p('one'), ' table:style-name="ceB"'))) +
        table('Second', row(cell(p('two')), cell(p('three'), ' table:style-name="ceI"'))),
    )
    expect(html).toContain('<h2>First</h2><table><tbody><tr><td><strong>one</strong></td></tr></tbody></table>')
    expect(html).toContain('<h2>Second</h2><table><tbody><tr><td>two</td><td><em>three</em></td></tr></tbody></table>')
  })

  it('leaves a cell alone when its styles say nothing about the formatting kinds', async () => {
    const html = await read(table('Codes', row(cell(p('<text:span text:style-name="TColour">red</text:span> text')))))
    expect(html).toContain('<td>red text</td>')
  })

  it('drops a comment in a cell, as SheetJS does', async () => {
    const html = await read(
      table(
        'Codes',
        row(cell('<office:annotation><text:p>private remark</text:p></office:annotation>' + p('<text:span text:style-name="T1">kept</text:span>'))),
      ),
    )
    expect(html).toContain('<td><strong>kept</strong></td>')
    expect(html).not.toContain('private remark')
  })

  it('exports the plain values to csv', async () => {
    const html = await read(table('Codes', row(cell(p('A <text:span text:style-name="T1">bold</text:span> word'), ' table:style-name="ceI"'))))
    expect(extractTables(html)).toEqual([[['A bold word']]])
  })

  it('does not change a spreadsheet with no formatting styles', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Item', 'Qty'], ['Folio', 3]]), 'Data')
    const bytes = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'ods' }))
    const html = (await readXlsx({ bytes, filename: 'book.ods' })).html
    expect(html).toContain('<thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Folio</td><td>3</td></tr></tbody>')
  })
})

describe('stock-formatting.ods (tests/corpus)', () => {
  const file = join(__dirname, '../corpus/stock-formatting.ods')
  const itIfCorpus = existsSync(file) ? it : it.skip

  itIfCorpus('keeps the formatting the generator wrote', async () => {
    const html = (await readXlsx({ bytes: readFileSync(file), filename: 'stock-formatting.ods' })).html
    expect(html).toContain('<thead><tr><th>Catalogue</th><th>Description</th><th>Group</th><th>Count</th></tr></thead>')
    expect(html).toContain('<td><strong>BUCKRAM</strong> BOX FILE A4</td><td><em>FICTION</em></td>')
    expect(html).toContain('<td><strong>C-1002</strong></td><td><strong>LINEN JACKET A5</strong></td>')
    expect(html).toContain('CLASS <sup>1</sup>')
    expect(html).toContain('A<sub>5</sub>')
    expect(html).toContain('<td colspan="2"><strong>Seasonal stock</strong></td><td><em>STATIONERY</em></td>')
    expect(html).toContain('<td><s>Struck items are withdrawn from the catalogue.</s></td>')
  })
})
