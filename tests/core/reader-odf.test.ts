import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readOdt } from '../../src/core/readers/odt'
import { readOdp } from '../../src/core/readers/odp'
import { detect } from '../../src/core/detect'

async function odf(mimetype: string, contentXml: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', mimetype)
  zip.file('content.xml', contentXml)
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}

const ODT_XML = `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t">
<office:body><office:text>
<text:h text:outline-level="1">Requirements Overview</text:h>
<text:p>The system <text:span>shall</text:span> support conversions.</text:p>
<text:h text:outline-level="2">Constraints</text:h>
<text:list><text:list-item><text:p>Runs offline</text:p></text:list-item>
<text:list-item><text:p>Keeps formatting</text:p></text:list-item></text:list>
<text:p>Escaping &lt;works&gt; correctly.</text:p>
</office:text></office:body></office:document-content>`

const ODP_XML = `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:draw="d" xmlns:text="t">
<office:body><office:presentation>
<draw:page draw:name="Slide 1"><draw:frame><draw:text-box>
<text:p>Quarterly Roadmap</text:p><text:p>Gateway rebuild ships in Q3</text:p>
</draw:text-box></draw:frame></draw:page>
<draw:page draw:name="Slide 2"><draw:frame><draw:text-box>
<text:p>Risks</text:p><text:p>Vendor limits unconfirmed</text:p>
</draw:text-box></draw:frame></draw:page>
</office:presentation></office:body></office:document-content>`

const ODT_TABLE_XML = `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb">
<office:body><office:text>
<text:h text:outline-level="1">Handoff</text:h>
<table:table table:name="Table1">
<table:table-header-rows><table:table-row>
<table:table-cell><text:p>Aspect</text:p></table:table-cell><table:table-cell><text:p>Detail</text:p></table:table-cell>
</table:table-row></table:table-header-rows>
<table:table-row><table:table-cell><text:p>Delivery</text:p></table:table-cell><table:table-cell><text:p>Single HTML file</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell><text:p>Language</text:p></table:table-cell><table:table-cell><text:p>Vanilla JavaScript</text:p></table:table-cell></table:table-row>
</table:table>
<text:p>Closing note.</text:p>
</office:text></office:body></office:document-content>`

describe('readOdt tables', () => {
  const bytes = (): Promise<Buffer> => odf('application/vnd.oasis.opendocument.text', ODT_TABLE_XML)

  it('emits real tables rather than loose paragraphs', async () => {
    const hub = await readOdt({ bytes: await bytes(), filename: 'handoff.odt' })
    expect(hub.html).toContain('<table>')
    expect(hub.html).toContain('<th>Aspect</th>')
    expect(hub.html).toContain('<td>Delivery</td>')
    expect(hub.html).toContain('<td>Single HTML file</td>')
  })

  it('does not also emit the cell text as top-level paragraphs', async () => {
    const hub = await readOdt({ bytes: await bytes() })
    expect(hub.html).not.toContain('<p>Delivery</p>')
    expect(hub.html).not.toContain('<p>Aspect</p>')
    // Surrounding content still comes through in order.
    expect(hub.html).toContain('<h1>Handoff</h1>')
    expect(hub.html).toContain('<p>Closing note.</p>')
    expect(hub.html.indexOf('<table>')).toBeLessThan(hub.html.indexOf('Closing note.'))
  })
})

describe('readOdt', () => {
  it('renders headings, paragraphs and lists', async () => {
    const hub = await readOdt({
      bytes: await odf('application/vnd.oasis.opendocument.text', ODT_XML),
      filename: 'spec.odt',
    })
    expect(hub.html).toContain('<h1>Requirements Overview</h1>')
    expect(hub.html).toContain('<h2>Constraints</h2>')
    expect(hub.html).toContain('The system shall support conversions.')
    expect(hub.html).toContain('<li>Runs offline</li>')
    expect(hub.html).toContain('<li>Keeps formatting</li>')
    expect(hub.title).toBe('Requirements Overview')
  })

  it('decodes entities and escapes markup', async () => {
    const hub = await readOdt({ bytes: await odf('application/vnd.oasis.opendocument.text', ODT_XML) })
    expect(hub.html).toContain('Escaping &lt;works&gt; correctly.')
    expect(hub.html).not.toContain('<works>')
  })

  it('rejects a zip with no ODF content', async () => {
    const zip = new JSZip()
    zip.file('a.txt', 'x')
    await expect(readOdt({ bytes: (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer })).rejects.toMatchObject(
      { code: 'read-failed' },
    )
  })
})

describe('readOdp', () => {
  it('renders one section per slide with the first line as the title', async () => {
    const hub = await readOdp({
      bytes: await odf('application/vnd.oasis.opendocument.presentation', ODP_XML),
      filename: 'deck.odp',
    })
    expect(hub.html).toContain('<h2>Quarterly Roadmap</h2>')
    expect(hub.html).toContain('<p>Gateway rebuild ships in Q3</p>')
    expect(hub.html).toContain('<h2>Risks</h2>')
    expect(hub.html.indexOf('Quarterly Roadmap')).toBeLessThan(hub.html.indexOf('Risks'))
  })
})

describe('ODF detection', () => {
  it('detects odt and odp instead of rejecting them', async () => {
    expect(await odf('application/vnd.oasis.opendocument.text', ODT_XML).then((b) => detect(b))).toEqual({
      kind: 'ok',
      format: 'odt',
    })
    expect(await odf('application/vnd.oasis.opendocument.presentation', ODP_XML).then((b) => detect(b))).toEqual({
      kind: 'ok',
      format: 'odp',
    })
  })
  it('maps the extensions', () => {
    expect(detect(Buffer.from('x'), 'a.odt')).toEqual({ kind: 'ok', format: 'odt' })
    expect(detect(Buffer.from('x'), 'a.odp')).toEqual({ kind: 'ok', format: 'odp' })
  })
})
