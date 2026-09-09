import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readPptx } from '../../src/core/readers/pptx'

function sp(inner: string, ph?: string): string {
  const phTag = ph ? `<p:nvSpPr><p:nvPr><p:ph type="${ph}"/></p:nvPr></p:nvSpPr>` : ''
  return `<p:sp>${phTag}<p:txBody>${inner}</p:txBody></p:sp>`
}
const para = (...runs: string[]): string => `<a:p>${runs.map((r) => `<a:r><a:t>${r}</a:t></a:r>`).join('')}</a:p>`

const tableFrame = `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
<a:tbl>
<a:tr><a:tc><a:txBody>${para('Item')}</a:txBody></a:tc><a:tc><a:txBody>${para('Qty')}</a:txBody></a:tc></a:tr>
<a:tr><a:tc><a:txBody>${para('Widget')}</a:txBody></a:tc><a:tc><a:txBody>${para('3')}</a:txBody></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`

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
        `<p:notes><p:cSld><p:spTree>${sp(para(note), 'body')}</p:spTree></p:cSld></p:notes>`,
      )
    }
  })
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}

describe('pptx slide tables', () => {
  it('renders <a:tbl> as a real table, not loose paragraphs', async () => {
    const hub = await readPptx({ bytes: await deck([sp(para('Pricing'), 'title') + tableFrame]) })
    expect(hub.html).toContain('<table>')
    expect(hub.html).toContain('<td>Item</td>')
    expect(hub.html).toContain('<td>Widget</td>')
    // The cell text must not ALSO appear as standalone paragraphs.
    expect(hub.html).not.toContain('<p>Widget</p>')
  })

  it('honours merged cells', async () => {
    const merged = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>
      <a:tr><a:tc gridSpan="2"><a:txBody>${para('Wide')}</a:txBody></a:tc><a:tc hMerge="1"><a:txBody>${para('')}</a:txBody></a:tc></a:tr>
    </a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const hub = await readPptx({ bytes: await deck([merged]) })
    expect(hub.html).toContain('colspan="2"')
  })
})

describe('pptx titles', () => {
  it('uses the title placeholder even when furniture comes first in the XML', async () => {
    // A slide-number placeholder preceding the title made "42" the heading.
    const slide = sp(para('42'), 'sldNum') + sp(para('Clearances – Even or Uneven Spacing'), 'title')
    const hub = await readPptx({ bytes: await deck([slide]) })
    expect(hub.html).toContain('<h2>Clearances – Even or Uneven Spacing</h2>')
    expect(hub.html).not.toContain('<h2>42</h2>')
    expect(hub.html).not.toContain('42')
  })

  it('keeps the whole title shape, not just its first paragraph', async () => {
    const slide = sp(para('Autumn Reading Programme') + para('Branch Opening Hours'), 'title')
    const hub = await readPptx({ bytes: await deck([slide]) })
    expect(hub.html).toContain('<h2>Autumn Reading Programme Branch Opening Hours</h2>')
  })

  it('falls back to the first text when there is no title placeholder', async () => {
    const hub = await readPptx({ bytes: await deck([sp(para('Untitled deck') + para('body text'))]) })
    expect(hub.html).toContain('<h2>Untitled deck</h2>')
    expect(hub.html).toContain('<p>body text</p>')
  })
})

describe('pptx self-closing runs', () => {
  it('does not swallow markup when a slide contains <a:t/>', async () => {
    const slide = sp(`<a:p><a:r><a:t>Real Title</a:t></a:r><a:br/><a:r><a:t/></a:r></a:p>${para('Second line')}`, 'title')
    const hub = await readPptx({ bytes: await deck([slide]) })
    expect(hub.html).not.toContain('a:rPr')
    expect(hub.html).not.toContain('&lt;/a:r&gt;')
    expect(hub.html).toContain('Real Title')
  })
})

describe('pptx speaker notes', () => {
  it('includes notes rather than dropping them silently', async () => {
    const hub = await readPptx({
      bytes: await deck([sp(para('Catenary'), 'title')], { 1: 'Catenary curve is the shape that occurs' }),
    })
    expect(hub.html).toContain('Notes:')
    expect(hub.html).toContain('Catenary curve is the shape that occurs')
  })
})

describe('pptx grouped shapes', () => {
  it('reads text inside a group', async () => {
    const grouped = `<p:grpSp>${sp(para('Inside a group'))}</p:grpSp>`
    const hub = await readPptx({ bytes: await deck([sp(para('Title'), 'title') + grouped]) })
    expect(hub.html).toContain('Inside a group')
  })
})
