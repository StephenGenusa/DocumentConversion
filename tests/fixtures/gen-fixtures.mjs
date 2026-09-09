import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const here = dirname(fileURLToPath(import.meta.url))

// sample.docx — via html-to-docx (CJS default export, returns a Buffer)
const htd = await import('html-to-docx')
const HTMLtoDOCX = htd.default ?? htd
const docx = await HTMLtoDOCX(
  '<h1>Fixture Title</h1><p>Hello <strong>world</strong></p><ul><li>a</li><li>b</li></ul>',
)
await writeFile(join(here, 'sample.docx'), Buffer.from(docx))

// sample.pdf — via pdf-lib, one page with extractable text
const pdf = await PDFDocument.create()
const page = pdf.addPage([300, 200])
const font = await pdf.embedFont(StandardFonts.Helvetica)
page.drawText('Hello PDF world', { x: 40, y: 120, size: 18, font })
await writeFile(join(here, 'sample.pdf'), Buffer.from(await pdf.save()))

// sample.xlsx — two sheets, header row + computed-looking values
const XLSX = (await import('xlsx')).default ?? (await import('xlsx'))
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ['Product', 'Quantity', 'Price'],
    ['Widget', 3, 9.5],
    ['Gadget', 7, 12.25],
  ]),
  'Inventory',
)
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Region', 'Total'], ['North', 42]]), 'Totals')
await writeFile(join(here, 'sample.xlsx'), Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })))

// sample.csv
await writeFile(
  join(here, 'sample.csv'),
  'Project,Owner,Status\nGateway rebuild,Alice,Active\nBilling migration,Bob,Planned\n',
)

// sample-code.ts — source-code input fixture
await writeFile(
  join(here, 'sample-code.ts'),
  `export function grantWindow(initial: number): number {\n  const replenish = 16\n  return initial + replenish\n}\n`,
)

// sample.png — 3x1 image (embed-mode fixture)
await writeFile(
  join(here, 'sample.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAYAAACczIWkAAAAEklEQVR4nGNgYGD4z8DA8B8ABQ0CAmXEU2sAAAAASUVORK5CYII=',
    'base64',
  ),
)

// sample.ipynb — markdown + code cells with stream output
await writeFile(
  join(here, 'sample.ipynb'),
  JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: 'python' } },
      cells: [
        {
          cell_type: 'markdown',
          metadata: {},
          source: ['# Throughput Analysis\n', '\n', 'Measuring the **credit window** behaviour.'],
        },
        {
          cell_type: 'code',
          metadata: {},
          execution_count: 1,
          source: ['window = 64\n', 'print("replenished", window + 16)'],
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['replenished 80\n'] }],
        },
      ],
    },
    null,
    1,
  ),
)

// sample.pptx — two slides with titles and body text
const JSZip = (await import('jszip')).default
const pptx = new JSZip()
pptx.file('[Content_Types].xml', '<Types/>')
pptx.file('ppt/presentation.xml', '<p:presentation/>')
const slideXml = (title, body) =>
  `<p:sld xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>` +
  `<a:p><a:r><a:t>${title}</a:t></a:r></a:p><a:p><a:r><a:t>${body}</a:t></a:r></a:p>` +
  `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
pptx.file('ppt/slides/slide1.xml', slideXml('Quarterly Roadmap', 'Gateway rebuild ships during the third quarter'))
pptx.file('ppt/slides/slide2.xml', slideXml('Outstanding Risks', 'Vendor throughput limits remain unconfirmed'))
await writeFile(join(here, 'sample.pptx'), await pptx.generateAsync({ type: 'nodebuffer' }))

// sample.epub — two spine chapters
const epub = new JSZip()
epub.file('mimetype', 'application/epub+zip')
epub.file(
  'META-INF/container.xml',
  '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
)
epub.file(
  'OEBPS/content.opf',
  '<package><metadata><dc:title>Protocol Handbook</dc:title></metadata>' +
    '<manifest><item id="c1" href="c1.xhtml"/><item id="c2" href="c2.xhtml"/></manifest>' +
    '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
)
epub.file(
  'OEBPS/c1.xhtml',
  '<html><body><h1>Handshake Chapter</h1><p>The handshake begins with a HELLO frame carrying versions.</p></body></html>',
)
epub.file(
  'OEBPS/c2.xhtml',
  '<html><body><h1>Flowcontrol Chapter</h1><p>Receivers grant credits in batches of sixteen frames.</p></body></html>',
)
await writeFile(join(here, 'sample.epub'), await epub.generateAsync({ type: 'nodebuffer' }))

// sample.mbox — two messages
await writeFile(
  join(here, 'sample.mbox'),
  [
    'From alice@example.com Mon Aug 31 10:00:00 2026',
    'From: Alice Example <alice@example.com>',
    'To: Bob Builder <bob@example.com>',
    'Subject: Vendor throughput',
    '',
    'The vendor confirmed sustained throughput of one hundred requests.',
    '',
    'From bob@example.com Mon Aug 31 11:00:00 2026',
    'From: Bob Builder <bob@example.com>',
    'To: Alice Example <alice@example.com>',
    'Subject: Re: Vendor throughput',
    '',
    'Acknowledged, updating the throttle configuration accordingly.',
    '',
  ].join('\n'),
)

// OpenDocument text and presentation
const odf = async (mimetype, content, name) => {
  const z = new JSZip()
  z.file('mimetype', mimetype)
  z.file('content.xml', content)
  await writeFile(join(here, name), await z.generateAsync({ type: 'nodebuffer' }))
}
await odf(
  'application/vnd.oasis.opendocument.text',
  `<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text>
<text:h text:outline-level="1">Interface Requirements</text:h>
<text:p>Every endpoint must accept idempotency keys for retries.</text:p>
<text:list><text:list-item><text:p>Operates entirely offline</text:p></text:list-item></text:list>
</office:text></office:body></office:document-content>`,
  'sample.odt',
)
await odf(
  'application/vnd.oasis.opendocument.presentation',
  `<office:document-content xmlns:office="o" xmlns:draw="d" xmlns:text="t"><office:body><office:presentation>
<draw:page draw:name="p1"><draw:frame><draw:text-box><text:p>Migration Planning</text:p><text:p>Cutover scheduled during the fourth quarter</text:p></draw:text-box></draw:frame></draw:page>
<draw:page draw:name="p2"><draw:frame><draw:text-box><text:p>Rollback Strategy</text:p><text:p>Restore from the nightly snapshot archive</text:p></draw:text-box></draw:frame></draw:page>
</office:presentation></office:body></office:document-content>`,
  'sample.odp',
)

// Calendar invite
await writeFile(
  join(here, 'sample.ics'),
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:evt-1',
    'SUMMARY:Architecture review meeting',
    'DTSTART:20260901T150000Z',
    'DTEND:20260901T160000Z',
    'LOCATION:Conference room four',
    'DESCRIPTION:Walk through the framing specification together',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'),
)

// AsciiDoc and reStructuredText
await writeFile(
  join(here, 'sample.adoc'),
  '= Vendor Throughput Notes\n\nThe vendor confirmed *sustained* throughput and _burst_ allowances.\n\n== Documented limits\n\n* One hundred requests per second sustained\n* Bursting towards two hundred fifty\n',
)
await writeFile(
  join(here, 'sample.rst'),
  'Vendor Throughput Notes\n=======================\n\nThe vendor confirmed **sustained** throughput and *burst* allowances.\n\nDocumented limits\n-----------------\n\n- One hundred requests per second sustained\n- Bursting towards two hundred fifty\n',
)

console.log('fixtures written')
