/**
 * Presentation fidelity: soft line breaks must not glue words together, and a
 * slide's bullets must render as a real list rather than a stack of detached
 * paragraphs. Both defects were visible in the rendered PDF of
 * a real training deck.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readPptx } from '../../src/core/readers/pptx'
import { readOdp } from '../../src/core/readers/odp'
import { readOdt } from '../../src/core/readers/odt'

function sp(inner: string, ph?: string): string {
  const phTag = ph ? `<p:nvSpPr><p:nvPr><p:ph type="${ph}"/></p:nvPr></p:nvSpPr>` : ''
  return `<p:sp>${phTag}<p:txBody>${inner}</p:txBody></p:sp>`
}
const run = (t: string): string => `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${t}</a:t></a:r>`
const para = (...runs: string[]): string => `<a:p>${runs.map(run).join('')}</a:p>`
/** A bulleted paragraph as PowerPoint writes one: explicit buChar at a level. */
const bullet = (text: string, lvl = 0): string =>
  `<a:p><a:pPr marL="514350"${lvl ? ` lvl="${lvl}"` : ''} indent="-342900">` +
  `<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>${run(text)}</a:p>`

async function deck(slides: string[], notes?: Record<number, string>): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', '<p:presentation/>')
  slides.forEach((body, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`)
    const note = notes?.[i + 1]
    if (note) {
      zip.file(
        `ppt/slides/_rels/slide${i + 1}.xml.rels`,
        `<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`,
      )
      zip.file(
        `ppt/notesSlides/notesSlide${i + 1}.xml`,
        `<p:notes><p:cSld><p:spTree>${sp(note, 'body')}</p:spTree></p:cSld></p:notes>`,
      )
    }
  })
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}

async function odf(mimetype: string, contentXml: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', mimetype)
  zip.file('content.xml', contentXml)
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}

describe('pptx soft line breaks', () => {
  // The shape that caused it: one <a:p> holding two runs
  // with an <a:br> between them, rendered as "InvertersField Training".
  it('does not glue the words either side of a self-closing <a:br/>', async () => {
    const title = `<a:p>${run('Inverters')}<a:br/>${run('Volunteer Training Overview')}</a:p>`
    const hub = await readPptx({ bytes: await deck([sp(title, 'ctrTitle')]) })
    expect(hub.html).not.toContain('Catalogue recordsKnowledge')
    expect(hub.html).toContain('<h2>Inverters Volunteer Training Overview</h2>')
  })

  it('handles <a:br> that wraps an <a:rPr/> child, as PowerPoint writes it', async () => {
    const title =
      `<a:p>${run('Inverters')}<a:br><a:rPr lang="en-US" dirty="0"/></a:br>` +
      `${run('Volunteer Training Overview')}<a:br><a:rPr lang="en-US" dirty="0"/></a:br>` +
      `<a:endParaRPr lang="en-US" dirty="0"/></a:p>`
    const hub = await readPptx({ bytes: await deck([sp(title, 'ctrTitle')]) })
    expect(hub.html).not.toContain('Catalogue recordsKnowledge')
    expect(hub.html).toContain('<h2>Inverters Volunteer Training Overview</h2>')
    // The trailing break must not leave a dangling blank line.
    expect(hub.html).not.toContain('Presentation </h2>')
  })

  it('keeps a broken body paragraph as one paragraph with a line break', async () => {
    const body = `<a:p>${run('First line')}<a:br><a:rPr/></a:br>${run('Second line')}</a:p>`
    const hub = await readPptx({ bytes: await deck([sp(para('Title'), 'title') + sp(body)]) })
    expect(hub.html).not.toContain('lineSecond')
    expect(hub.html).toContain('<p>First line<br>Second line</p>')
  })

  it('does not glue a broken table cell', async () => {
    const cellText = `<a:p>${run('Even')}<a:br><a:rPr/></a:br>${run('Spacing')}</a:p>`
    const frame =
      `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
      `<a:tr><a:tc><a:txBody>${cellText}</a:txBody></a:tc></a:tr>` +
      `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const hub = await readPptx({ bytes: await deck([frame]) })
    expect(hub.html).not.toContain('EvenSpacing')
    expect(hub.html).toContain('<td>Even Spacing</td>')
  })

  it('does not glue speaker notes broken by <a:br>', async () => {
    const note = `<a:p>${run('Catenary curve')}<a:br><a:rPr/></a:br>${run('is the shape')}</a:p>`
    const hub = await readPptx({ bytes: await deck([sp(para('Sag'), 'title')], { 1: note }) })
    expect(hub.html).not.toContain('curveis')
    expect(hub.html).toContain('Catenary curve')
    expect(hub.html).toContain('is the shape')
  })

  it('still joins adjacent runs with no separator', async () => {
    // PowerPoint splits runs mid-word; joining them must not insert a space.
    const hub = await readPptx({ bytes: await deck([sp(para('Quarterly ', 'Roadmap'), 'title')]) })
    expect(hub.html).toContain('<h2>Quarterly Roadmap</h2>')
  })
})

describe('pptx bullet lists', () => {
  it('renders consecutive bulleted paragraphs as one list', async () => {
    const body = sp([bullet('Catalogue record Overview'), bullet('Power Factor'), bullet('Types of Load')].join(''))
    const hub = await readPptx({ bytes: await deck([sp(para('Overview'), 'title') + body]) })
    expect(hub.html).toContain('<ul>')
    expect(hub.html).toContain('<li>Catalogue record Overview</li>')
    expect(hub.html).toContain('<li>Types of Load</li>')
    expect(hub.html).not.toContain('<p>Catalogue record Overview</p>')
    // One list, not one list per bullet.
    expect((hub.html.match(/<ul>/g) ?? []).length).toBe(1)
  })

  it('nests deeper levels inside the item above them', async () => {
    const body = sp([bullet('The film:'), bullet('removes trapped air', 1), bullet('aids impregnation', 1)].join(''))
    const hub = await readPptx({ bytes: await deck([sp(para('Design'), 'title') + body]) })
    expect(hub.html).toContain('<li>The film:<ul><li>removes trapped air</li><li>aids impregnation</li></ul></li>')
  })

  it('does not nest when every bullet sits at the same level, whatever that level is', async () => {
    // The real Overview slide puts all eight bullets at lvl="1"; an absolute
    // reading of lvl would wrap them in a pointless empty outer list.
    const body = sp([bullet('One', 1), bullet('Two', 1)].join(''))
    const hub = await readPptx({ bytes: await deck([sp(para('Overview'), 'title') + body]) })
    expect(hub.html).toContain('<ul><li>One</li><li>Two</li></ul>')
    expect(hub.html).not.toContain('<ul><ul>')
    expect(hub.html).not.toContain('<li><ul>')
  })

  it('uses <ol> when the bullet is auto-numbered', async () => {
    const item = (t: string): string =>
      `<a:p><a:pPr marL="342900" indent="-342900"><a:buAutoNum type="alphaLcPeriod"/></a:pPr>${run(t)}</a:p>`
    const body = sp([item('120 F, no wind, final sag'), item('32 F, half-inch radial ice')].join(''))
    const hub = await readPptx({ bytes: await deck([sp(para('Clearances'), 'title') + body]) })
    expect(hub.html).toContain('<ol')
    expect(hub.html).toContain('<li>120 F, no wind, final sag</li>')
    expect(hub.html).not.toContain('<ul>')
  })

  it('leaves <a:buNone/> paragraphs as paragraphs', async () => {
    const plain = `<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr>${run('Clearance conditions:')}</a:p>`
    const body = sp(plain + bullet('120 F, no wind') + plain.replace('Clearance conditions:', 'Std 102 - 210'))
    const hub = await readPptx({ bytes: await deck([sp(para('MARC'), 'title') + body]) })
    expect(hub.html).toContain('<p>Clearance conditions:</p>')
    expect(hub.html).toContain('<p>Std 102 - 210</p>')
    expect(hub.html).toContain('<li>120 F, no wind</li>')
  })

  it('leaves paragraphs with no bullet markup alone', async () => {
    // Slide 3's lead sentence has no <a:pPr> at all and the master gives level 0
    // no bullet, so guessing a list here would be wrong.
    const body = sp(para('A catalogue record is a device that stores energy.') + bullet('Two parallel plates'))
    const hub = await readPptx({ bytes: await deck([sp(para('Catalogue record Overview'), 'title') + body]) })
    expect(hub.html).toContain('<p>A catalogue record is a device that stores energy.</p>')
    expect(hub.html).toContain('<li>Two parallel plates</li>')
  })

  it('never turns a title placeholder into a list', async () => {
    const hub = await readPptx({ bytes: await deck([sp(bullet('Overview'), 'title')]) })
    expect(hub.html).toContain('<h2>Overview</h2>')
    expect(hub.html).not.toContain('<li>')
  })

  it('keeps a soft break inside a bullet as one list item', async () => {
    const broken =
      `<a:p><a:pPr marL="514350" indent="-342900"><a:buChar char="&#8226;"/></a:pPr>` +
      `${run('First line')}<a:br><a:rPr/></a:br>${run('Second line')}</a:p>`
    const hub = await readPptx({ bytes: await deck([sp(para('T'), 'title') + sp(broken)]) })
    expect(hub.html).toContain('<li>First line<br>Second line</li>')
    expect((hub.html.match(/<li>/g) ?? []).length).toBe(1)
  })
})

describe('odf soft line breaks and spacing', () => {
  it('does not glue words across a non-self-closing <text:line-break>', async () => {
    const xml =
      `<office:document-content><office:body><office:text>` +
      `<text:p>Inverters<text:line-break></text:line-break>Field Training</text:p>` +
      `</office:text></office:body></office:document-content>`
    const hub = await readOdt({ bytes: await odf('application/vnd.oasis.opendocument.text', xml) })
    expect(hub.html).not.toContain('Catalogue recordsKnowledge')
    expect(hub.html).toContain('Inverters Field Training')
  })

  it('does not swallow a <text:s text:c="n"/> run of spaces', async () => {
    const xml =
      `<office:document-content><office:body><office:text>` +
      `<text:p>Head + style<text:s text:c="3"/>all CSS</text:p>` +
      `</office:text></office:body></office:document-content>`
    const hub = await readOdt({ bytes: await odf('application/vnd.oasis.opendocument.text', xml) })
    expect(hub.html).not.toContain('styleall')
    expect(hub.html).toContain('Head + style all CSS')
  })
})

describe('odt lists', () => {
  // The real handoff .odt writes 21 consecutive one-item <text:list> blocks
  // that continue one another's numbering; they rendered as 21 separate lists.
  it('merges consecutive sibling lists that share a style into one list', async () => {
    const item = (t: string, first = false): string =>
      `<text:list text:style-name="LFO1"${first ? '' : ' text:continue-numbering="true"'}>` +
      `<text:list-item><text:p>${t}</text:p></text:list-item></text:list>`
    const xml =
      `<office:document-content><office:body><office:text>` +
      item('Head + style', true) +
      item('Embedded data blobs') +
      item('Body') +
      `<text:p>Closing note.</text:p>` +
      `</office:text></office:body></office:document-content>`
    const hub = await readOdt({ bytes: await odf('application/vnd.oasis.opendocument.text', xml) })
    expect((hub.html.match(/<ul>/g) ?? []).length).toBe(1)
    expect(hub.html).toContain('<li>Head + style</li><li>Embedded data blobs</li><li>Body</li>')
    expect(hub.html).toContain('<p>Closing note.</p>')
  })

  it('nests a list inside its parent item instead of gluing the text together', async () => {
    const xml =
      `<office:document-content><office:body><office:text><text:list>` +
      `<text:list-item><text:p>Parent</text:p>` +
      `<text:list><text:list-item><text:p>Child one</text:p></text:list-item>` +
      `<text:list-item><text:p>Child two</text:p></text:list-item></text:list>` +
      `</text:list-item></text:list></office:text></office:body></office:document-content>`
    const hub = await readOdt({ bytes: await odf('application/vnd.oasis.opendocument.text', xml) })
    expect(hub.html).not.toContain('Parent Child one')
    expect(hub.html).toContain('<li>Parent<ul><li>Child one</li><li>Child two</li></ul></li>')
  })
})

describe('odp lists', () => {
  it('renders slide bullets as a list rather than loose paragraphs', async () => {
    const xml =
      `<office:document-content><office:body><office:presentation>` +
      `<draw:page draw:name="Slide 1"><draw:frame><draw:text-box>` +
      `<text:p>Overview</text:p>` +
      `<text:list><text:list-item><text:p>Catalogue record Overview</text:p></text:list-item>` +
      `<text:list-item><text:p>Power Factor</text:p></text:list-item></text:list>` +
      `</draw:text-box></draw:frame></draw:page>` +
      `</office:presentation></office:body></office:document-content>`
    const hub = await readOdp({ bytes: await odf('application/vnd.oasis.opendocument.presentation', xml) })
    expect(hub.html).toContain('<h2>Overview</h2>')
    expect(hub.html).toContain('<li>Catalogue record Overview</li>')
    expect(hub.html).toContain('<li>Power Factor</li>')
    expect(hub.html).not.toContain('<p>Catalogue record Overview</p>')
  })

  it('still titles a slide from its first line when there is no list', async () => {
    const xml =
      `<office:document-content><office:body><office:presentation>` +
      `<draw:page><draw:frame><draw:text-box>` +
      `<text:p>Risks</text:p><text:p>Vendor limits unconfirmed</text:p>` +
      `</draw:text-box></draw:frame></draw:page>` +
      `</office:presentation></office:body></office:document-content>`
    const hub = await readOdp({ bytes: await odf('application/vnd.oasis.opendocument.presentation', xml) })
    expect(hub.html).toContain('<h2>Risks</h2>')
    expect(hub.html).toContain('<p>Vendor limits unconfirmed</p>')
  })
})
