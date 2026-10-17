import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { sanitizeToHub } from '../../src/core/allowlist'
import { cellAlign } from '../../src/core/cell-align'
import { readDocx } from '../../src/core/readers/docx'
import { readHtml } from '../../src/core/readers/html'
import { readMarkdown } from '../../src/core/readers/md'
import { readOdt } from '../../src/core/readers/odt'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeDocx } from '../../src/core/writers/docx'
import { writeHtml } from '../../src/core/writers/html'
import { writeEpub } from '../../src/core/writers/epub'
import { writeRevealJs } from '../../src/core/writers/revealjs'

const bytes = (s: string) => ({ bytes: Buffer.from(s, 'utf8') })

const PIPE = '| Item | Note | Mass (g) |\n| :--- | :---: | ---: |\n| Beaker | rinsed | 12.5 |\n| Flask | dry | 140.25 |\n'

/**
 * A table column's alignment: numbers right, a check mark centered. The hub
 * keeps it on each cell as `style="text-align:left|center|right"`, the form
 * markdown-it writes, and nothing else of a cell's style.
 */
describe('cell alignment in the hub', () => {
  it('keeps text-align left, center or right on th and td, and nothing else of the style', () => {
    expect(sanitizeToHub('<table><tr><th style="text-align:center">a</th><td style="text-align: RIGHT; color: red">1</td></tr></table>')).toBe(
      '<table><tr><th style="text-align:center">a</th><td style="text-align:right">1</td></tr></table>',
    )
    expect(sanitizeToHub('<table><tr><td style="text-align:left" colspan="2">a</td></tr></table>')).toBe(
      '<table><tr><td colspan="2" style="text-align:left">a</td></tr></table>',
    )
  })

  it('drops any other alignment, and any other style', () => {
    expect(sanitizeToHub('<table><tr><td style="text-align:justify">a</td><td style="color:red">b</td><td style="text-align:var(--x)">c</td></tr></table>')).toBe(
      '<table><tr><td>a</td><td>b</td><td>c</td></tr></table>',
    )
    // A style smuggled in after the alignment is not kept.
    expect(sanitizeToHub('<table><tr><td style="text-align:center;background:url(x)">a</td></tr></table>')).toBe(
      '<table><tr><td style="text-align:center">a</td></tr></table>',
    )
  })

  it('reads the legacy align attribute as the same style, the style winning where both are given', () => {
    expect(sanitizeToHub('<table><tr><td align="center">a</td><th align="Right">b</th><td align="justify">c</td></tr></table>')).toBe(
      '<table><tr><td style="text-align:center">a</td><th style="text-align:right">b</th><td>c</td></tr></table>',
    )
    expect(sanitizeToHub('<table><tr><td align="center" style="text-align:right">a</td></tr></table>')).toBe(
      '<table><tr><td style="text-align:right">a</td></tr></table>',
    )
  })

  it('takes the last text-align in a style, as CSS does', () => {
    expect(cellAlign('text-align:left; text-align:center')).toBe('center')
    expect(cellAlign('text-align: right !important')).toBe('right')
    expect(cellAlign('xtext-align:right')).toBeUndefined()
    expect(cellAlign(undefined, 'left')).toBe('left')
    expect(cellAlign(undefined, undefined)).toBeUndefined()
  })

  it('is not other cells: a paragraph keeps no alignment', () => {
    expect(sanitizeToHub('<p style="text-align:center" align="center">a</p>')).toBe('<p>a</p>')
  })
})

describe('reading cell alignment', () => {
  it('from Markdown pipe-table markers', async () => {
    const html = (await readMarkdown(bytes(PIPE))).html
    expect(html).toContain('<th style="text-align:left">Item</th>')
    expect(html).toContain('<th style="text-align:center">Note</th>')
    expect(html).toContain('<td style="text-align:right">140.25</td>')
  })

  it('from HTML, by style or by the align attribute', async () => {
    const html = (await readHtml({ ...bytes('<table><tr><td align="right">1</td><td style="text-align: center">x</td></tr></table>'), filename: 'a.html' })).html
    expect(html).toContain('<td style="text-align:right">1</td>')
    expect(html).toContain('<td style="text-align:center">x</td>')
  })

  it("from Word: a cell's paragraphs, when they all agree", async () => {
    const docx = await writeDocx({ html: '<table><tbody><tr><td>a</td><td>b</td><td>c</td><td>d</td></tr></tbody></table>' })
    const zip = await JSZip.loadAsync(docx)
    const xml = await zip.file('word/document.xml')!.async('string')
    const cells = (...ps: string[]): string =>
      `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${ps.map((p) => `<w:p>${p}</w:p>`).join('')}</w:tc>`
    const jc = (v: string, text: string): string => `<w:pPr><w:jc w:val="${v}"/></w:pPr><w:r><w:t>${text}</w:t></w:r>`
    const styled = (s: string, text: string): string => `<w:pPr><w:pStyle w:val="${s}"/></w:pPr><w:r><w:t>${text}</w:t></w:r>`
    const table =
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>' +
      cells(jc('end', '12.5'), jc('right', '7')) +
      cells(jc('center', 'mixed'), jc('left', 'cell')) +
      cells(styled('Numbers', '3.25')) +
      cells(jc('start', 'start')) +
      cells(jc('both', 'justified')) +
      '</w:tr></w:tbl>'
    zip.file('word/document.xml', xml.replace(/<w:sectPr\b/, `${table}<w:p/><w:sectPr`))
    const styles = await zip.file('word/styles.xml')!.async('string')
    zip.file(
      'word/styles.xml',
      styles.replace(
        '</w:styles>',
        '<w:style w:type="paragraph" w:styleId="Numbers"><w:basedOn w:val="NumBase"/></w:style>' +
          '<w:style w:type="paragraph" w:styleId="NumBase"><w:pPr><w:jc w:val="right"/></w:pPr></w:style></w:styles>',
      ),
    )
    const html = (await readDocx({ bytes: await zip.generateAsync({ type: 'nodebuffer' }), filename: 't.docx' })).html
    expect(html).toMatch(/<td style="text-align:right"><p>12\.5<\/p><p>7<\/p><\/td>/)
    expect(html).toMatch(/<td><p>mixed<\/p><p>cell<\/p><\/td>/)
    expect(html).toMatch(/<td style="text-align:right"><p>3\.25<\/p><\/td>/)
    expect(html).toMatch(/<td><p>start<\/p><\/td>/)
    expect(html).toMatch(/<td><p>justified<\/p><\/td>/)
  })

  it('from Word, round trip: what the Word writer writes reads back', async () => {
    const hub =
      '<table><thead><tr><th>Item</th><th style="text-align:right">Mass</th></tr></thead>' +
      '<tbody><tr><td>Beaker</td><td style="text-align:right">12.5</td></tr><tr><td colspan="2" style="text-align:center">total</td></tr></tbody></table>'
    const html = (await readDocx({ bytes: await writeDocx({ html: hub }), filename: 'r.docx' })).html
    // The writer marks no header row Word-side, so it reads back as a plain row.
    expect(html).toMatch(/<t[dh] style="text-align:right">(<p>)?Mass/)
    expect(html).toMatch(/<td style="text-align:right">(<p>)?12\.5/)
    expect(html).toMatch(/<td colspan="2" style="text-align:center">(<p>)?total/)
    expect(html).toMatch(/<td>(<p>)?Beaker/)
  })

  it('from LibreOffice: the paragraph style of the paragraphs in a cell', async () => {
    const NS = 'xmlns:office="o" xmlns:text="t" xmlns:style="s" xmlns:fo="f" xmlns:table="b"'
    const content = `<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>
<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Table_20_Contents"><style:paragraph-properties fo:text-align="end"/></style:style>
<style:style style:name="P2" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>
<style:style style:name="P3" style:family="paragraph" style:parent-style-name="P2"/>
<style:style style:name="P4" style:family="paragraph"><style:paragraph-properties fo:text-align="justify"/></style:style>
</office:automatic-styles><office:body><office:text><table:table><table:table-row>
<table:table-cell><text:p text:style-name="P1">12.5</text:p></table:table-cell>
<table:table-cell><text:p text:style-name="P3">ok</text:p></table:table-cell>
<table:table-cell><text:p text:style-name="P4">just</text:p></table:table-cell>
<table:table-cell><text:p text:style-name="P2">a</text:p><text:p text:style-name="P1">b</text:p></table:table-cell>
<table:table-cell><text:p>plain</text:p></table:table-cell>
</table:table-row></table:table></office:text></office:body></office:document-content>`
    const zip = new JSZip()
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
    zip.file('content.xml', content)
    const html = (await readOdt({ bytes: await zip.generateAsync({ type: 'nodebuffer' }), filename: 't.odt' })).html
    expect(html).toContain('<td style="text-align:right">12.5</td>')
    expect(html).toContain('<td style="text-align:center">ok</td>')
    expect(html).toContain('<td>just</td>')
    expect(html).toContain('<td>a b</td>')
    expect(html).toContain('<td>plain</td>')
  })
})

describe('writing cell alignment', () => {
  it('Markdown: the alignment markers of each column, read back the same', async () => {
    const hub = (await readMarkdown(bytes(PIPE))).html
    const md = (await writeMarkdown({ html: hub })).toString('utf8')
    expect(md).toContain('| :--- | :---: | ---: |')
    expect((await writeMarkdown({ html: (await readMarkdown({ bytes: Buffer.from(md) })).html })).toString('utf8')).toBe(md)
  })

  it('Markdown: a column is aligned as its body cells agree, empty cells aside, else as its header', async () => {
    const hub =
      '<table><thead><tr><th style="text-align:center">A</th><th>B</th><th style="text-align:right">C</th><th>D</th></tr></thead><tbody>' +
      '<tr><td>1</td><td style="text-align:right">2</td><td></td><td style="text-align:center">x</td></tr>' +
      '<tr><td>3</td><td style="text-align:right">4</td><td></td><td>y</td></tr></tbody></table>'
    const md = (await writeMarkdown({ html: hub })).toString('utf8')
    expect(md).toContain('| --- | ---: | ---: | --- |')
  })

  it('Markdown: a second header row has no say in its columns', async () => {
    const hub =
      '<table><thead><tr><th rowspan="2">Member</th><th colspan="2">Demand</th></tr><tr><th>Timber</th><th>FRP</th></tr></thead>' +
      '<tbody><tr><td>Stringer</td><td style="text-align:right">29.0</td><td style="text-align:right">27.3</td></tr></tbody></table>'
    expect((await writeMarkdown({ html: hub })).toString('utf8')).toContain('| --- | ---: | ---: |')
  })

  it('Markdown: a table with no alignment is written as before', async () => {
    const md = (await writeMarkdown({ html: '<table><tr><th>a</th></tr><tr><td>1</td></tr></table>' })).toString('utf8')
    expect(md).toContain('| a |\n| --- |\n| 1 |')
  })

  it('Word: w:jc in each paragraph of an aligned cell, in its place in w:pPr', async () => {
    const hub = '<table><thead><tr><th style="text-align:center">A</th></tr></thead><tbody><tr><td style="text-align:right"><p>1</p><p>2</p></td></tr><tr><td>3</td></tr></tbody></table>'
    const xml = await (await JSZip.loadAsync(await writeDocx({ html: hub }))).file('word/document.xml')!.async('string')
    const paragraphs = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map((m) => m[0])
    const of = (text: string): string => paragraphs.find((p) => p.includes(`>${text}</w:t>`))!
    expect(of('A')).toMatch(/<w:jc w:val="center"\/><\/w:pPr>/)
    expect(of('1')).toMatch(/<w:jc w:val="right"\/><\/w:pPr>/)
    expect(of('2')).toMatch(/<w:jc w:val="right"\/><\/w:pPr>/)
    expect(of('3')).not.toContain('<w:jc')
  })

  it('html, pdf, slides and epub: the style is kept on the cell', async () => {
    const hub = (await readMarkdown(bytes(PIPE))).html
    const html = (await writeHtml({ html: hub })).toString('utf8')
    expect(html).toContain('<td style="text-align:right">140.25</td>')
    expect(html).not.toMatch(/\b(th|td)\s*\{[^}]*text-align/)
    const deck = (await writeRevealJs({ html: hub })).toString('utf8')
    expect(deck).toContain('<td style="text-align:right">140.25</td>')
    const zip = await JSZip.loadAsync(await writeEpub({ html: hub, title: 'T' }))
    const pages = await Promise.all(Object.keys(zip.files).filter((n) => n.endsWith('.xhtml')).map((n) => zip.file(n)!.async('string')))
    expect(pages.join('')).toContain('<td style="text-align:right">140.25</td>')
  })
})
