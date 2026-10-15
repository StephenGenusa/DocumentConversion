import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readOdt } from '../../src/core/readers/odt'
import { readOdp } from '../../src/core/readers/odp'

const NS = 'xmlns:office="o" xmlns:text="t" xmlns:style="s" xmlns:fo="f" xmlns:table="tb" xmlns:draw="d"'

async function odf(mimetype: string, contentXml: string, stylesXml?: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', mimetype)
  zip.file('content.xml', contentXml)
  if (stylesXml) zip.file('styles.xml', stylesXml)
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}

const AUTO = `<office:automatic-styles>
<style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="I" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="U" style:family="text"><style:text-properties style:text-underline-style="solid"/></style:style>
<style:style style:name="NoU" style:family="text"><style:text-properties style:text-underline-style="none"/></style:style>
<style:style style:name="S" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
<style:style style:name="Sup" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>
<style:style style:name="Sub" style:family="text"><style:text-properties style:text-position="sub 58%"/></style:style>
<style:style style:name="SupPct" style:family="text"><style:text-properties style:text-position="33% 58%"/></style:style>
<style:style style:name="SubPct" style:family="text"><style:text-properties style:text-position="-33% 58%"/></style:style>
<style:style style:name="Plain" style:family="text"><style:text-properties fo:font-weight="normal"/></style:style>
<style:style style:name="Child" style:family="text" style:parent-style-name="Emphatic"/>
<style:style style:name="BoldPara" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="BoldHeading" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>
</office:automatic-styles>`

const STYLES = `<?xml version="1.0"?><office:document-styles ${NS}><office:styles>
<style:style style:name="Strong" style:family="text"><style:text-properties fo:font-weight="700"/></style:style>
<style:style style:name="Emphatic" style:family="text" style:parent-style-name="Strong"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="Heading_20_1" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>
</office:styles></office:document-styles>`

function odt(body: string): string {
  return `<?xml version="1.0"?><office:document-content ${NS}>${AUTO}<office:body><office:text>${body}</office:text></office:body></office:document-content>`
}

async function read(body: string): Promise<string> {
  const bytes = await odf('application/vnd.oasis.opendocument.text', odt(body), STYLES)
  return (await readOdt({ bytes, filename: 'sample.odt' })).html
}

describe('ODF inline formatting', () => {
  it('maps automatic text styles to hub tags', async () => {
    const html = await read(
      '<text:p>A <text:span text:style-name="B">bold</text:span>, <text:span text:style-name="I">slanted</text:span>, ' +
        '<text:span text:style-name="U">lined</text:span> and <text:span text:style-name="S">struck</text:span> word.</text:p>',
    )
    expect(html).toContain('<p>A <strong>bold</strong>, <em>slanted</em>, <u>lined</u> and <s>struck</s> word.</p>')
  })

  it('reads named styles from styles.xml, following parent styles', async () => {
    const html = await read('<text:p>See <text:span text:style-name="Child">this</text:span> note.</text:p>')
    expect(html).toContain('<p>See <strong><em>this</em></strong> note.</p>')
  })

  it('combines nested spans', async () => {
    const html = await read(
      '<text:p><text:span text:style-name="B">Loud <text:span text:style-name="I">and slanted</text:span></text:span> end</text:p>',
    )
    expect(html).toContain('<p><strong>Loud <em>and slanted</em></strong> end</p>')
  })

  it('reads superscript and subscript in both forms', async () => {
    const html = await read(
      '<text:p>x<text:span text:style-name="Sup">2</text:span> H<text:span text:style-name="Sub">2</text:span>O ' +
        'y<text:span text:style-name="SupPct">3</text:span> C<text:span text:style-name="SubPct">4</text:span></text:p>',
    )
    expect(html).toContain('<p>x<sup>2</sup> H<sub>2</sub>O y<sup>3</sup> C<sub>4</sub></p>')
  })

  it('does not underline an underline style of "none"', async () => {
    const html = await read('<text:p>An <text:span text:style-name="NoU">ordinary</text:span> word.</text:p>')
    expect(html).toContain('<p>An ordinary word.</p>')
  })

  it('carries a bold paragraph style, and lets a span switch it off', async () => {
    const html = await read(
      '<text:p text:style-name="BoldPara">All loud <text:span text:style-name="Plain">but this</text:span></text:p>',
    )
    expect(html).toContain('<p><strong>All loud </strong>but this</p>')
  })

  it('does not bold a heading because its style is bold', async () => {
    const html = await read(
      '<text:h text:style-name="Heading_20_1" text:outline-level="1">Plain Title</text:h>' +
        '<text:h text:style-name="BoldHeading" text:outline-level="2">Second <text:span text:style-name="I">Part</text:span></text:h>',
    )
    expect(html).toContain('<h1>Plain Title</h1>')
    expect(html).toContain('<h2>Second <em>Part</em></h2>')
  })

  it('keeps the title plain text', async () => {
    const bytes = await odf(
      'application/vnd.oasis.opendocument.text',
      odt('<text:h text:outline-level="1">The <text:span text:style-name="B">Big</text:span> Plan</text:h>'),
      STYLES,
    )
    expect((await readOdt({ bytes })).title).toBe('The Big Plan')
  })

  it('formats text in tables, lists and footnotes', async () => {
    const html = await read(
      '<table:table><table:table-row><table:table-cell><text:p><text:span text:style-name="B">Cell</text:span></text:p></table:table-cell></table:table-row></table:table>' +
        '<text:list><text:list-item><text:p><text:span text:style-name="I">Item</text:span></text:p></text:list-item></text:list>' +
        '<text:p>Body<text:note><text:note-citation>1</text:note-citation><text:note-body><text:p>A <text:span text:style-name="B">firm</text:span> aside</text:p></text:note-body></text:note></text:p>',
    )
    expect(html).toContain('<td><strong>Cell</strong></td>')
    expect(html).toContain('<li><em>Item</em></li>')
    expect(html).toContain('<p>A <strong>firm</strong> aside</p>')
  })

  it('escapes text inside formatted runs', async () => {
    const html = await read('<text:p><text:span text:style-name="B">&lt;b&gt; &amp; co</text:span></text:p>')
    expect(html).toContain('<p><strong>&lt;b&gt; &amp; co</strong></p>')
  })

  it('formats slide text in presentations', async () => {
    const xml = `<?xml version="1.0"?><office:document-content ${NS}>${AUTO}<office:body><office:presentation>
<draw:page draw:name="One"><draw:frame><draw:text-box>
<text:p>Fictional Deck</text:p><text:p>Make it <text:span text:style-name="B">count</text:span></text:p>
</draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>`
    const bytes = await odf('application/vnd.oasis.opendocument.presentation', xml)
    const html = (await readOdp({ bytes })).html
    expect(html).toContain('<h2>Fictional Deck</h2>')
    expect(html).toContain('<p>Make it <strong>count</strong></p>')
  })
})
