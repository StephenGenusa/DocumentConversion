import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readDocx } from '../../src/core/readers/docx'
import { createConverter } from '../../src/core/convert'

/*
 * mammoth reads a paragraph's text and none of its fonts, so a code block in
 * a Word file came back as ordinary paragraphs with its indentation gone. The
 * reader recognises the code paragraphs — our own docx writer's (every run in
 * Courier, lines split by breaks), Word's "HTML Preformatted"-style ones, and
 * runs of paragraphs set wholly in a monospace font — and makes them a code block.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const STYLES =
  `<?xml version="1.0"?><w:styles ${W}>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="HTMLPreformatted"><w:name w:val="HTML Preformatted"/><w:basedOn w:val="Normal"/>` +
  `<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Listing"><w:name w:val="Listing"/><w:basedOn w:val="Normal"/>` +
  `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style>` +
  `<w:style w:type="character" w:styleId="Mono"><w:name w:val="Mono"/><w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/></w:rPr></w:style>` +
  `</w:styles>`

async function docx(body: string, styles = STYLES): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  )
  zip.file('word/styles.xml', styles)
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

const para = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const styled = (style: string, runs: string): string => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs}</w:p>`
const run = (text: string, rPr = ''): string => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const font = (name: string): string => `<w:rFonts w:ascii="${name}" w:hAnsi="${name}"/>`

const read = async (body: string, styles?: string): Promise<string> => (await readDocx({ bytes: await docx(body, styles), filename: 'a.docx' })).html

describe('docx: code blocks', () => {
  it('reads Word\'s "HTML Preformatted" paragraphs as one block, blank line, tab and indent kept', async () => {
    const html = await read(
      para('Before.') +
        styled('HTMLPreformatted', run('if (a &lt; b) {')) +
        styled('HTMLPreformatted', run('    run();')) +
        styled('HTMLPreformatted', '') +
        styled('HTMLPreformatted', `<w:r><w:tab/><w:t>done();</w:t></w:r>`) +
        styled('HTMLPreformatted', run('}')) +
        para('After.'),
    )
    expect(html).toBe('<p>Before.</p><pre><code>if (a &lt; b) {\n    run();\n\n\tdone();\n}</code></pre><p>After.</p>')
  })

  it('reads paragraphs set wholly in a monospace font, by run, by character style or by paragraph style', async () => {
    const html = await read(
      `<w:p>${run('SELECT id', font('Consolas'))}<w:r><w:rPr>${font('Consolas')}</w:rPr><w:br/></w:r>${run('  FROM t', font('Consolas'))}</w:p>` +
        `<w:p>${run('WHERE ', '<w:rStyle w:val="Mono"/>')}${run('n = 1', font('DejaVu Sans Mono'))}</w:p>` +
        para('Then.') +
        styled('Listing', run('x = 1')),
    )
    expect(html).toBe('<pre><code>SELECT id\n  FROM t\nWHERE n = 1</code></pre><p>Then.</p><pre><code>x = 1</code></pre>')
  })

  it('leaves prose with a word of code in it, a heading and a one-line monospace cell alone', async () => {
    const html = await read(
      `<w:p>${run('Call ')}${run('run()', font('Courier'))}${run(' twice.')}</w:p>` +
        `<w:tbl><w:tr><w:tc><w:p>${run('ID-42', font('Courier New'))}</w:p></w:tc></w:tr></w:tbl>`,
    )
    expect(html).not.toContain('<pre>')
    expect(html).toContain('<p>Call run() twice.</p>')
    expect(html).toContain('ID-42')
  })
})

describe('docx: a document set in a monospace face is not code', () => {
  it('when its Normal style is monospace, as a screenplay is', async () => {
    const styles =
      `<?xml version="1.0"?><w:styles ${W}>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr>${font('Courier New')}</w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="Dialogue"><w:name w:val="Dialogue"/><w:basedOn w:val="Normal"/></w:style></w:styles>`
    const html = await read(styled('Dialogue', run('We should go.')) + styled('Dialogue', run('Not yet.')) + para('The door opens.'), styles)
    expect(html).toBe('<p>We should go.</p><p>Not yet.</p><p>The door opens.</p>')
  })

  it('when nearly every paragraph is set in it directly', async () => {
    const lines = Array.from({ length: 24 }, (_, i) => `<w:p>${run(`Line ${i} of the letter.`, font('Courier New'))}</w:p>`)
    const html = await read(para('Dear reader,') + lines.join(''))
    expect(html).not.toContain('<pre>')
  })
})

describe('md → docx → md', () => {
  const conv = createConverter(async () => Buffer.from(''))
  const roundTrip = async (md: string): Promise<string> => {
    const docxOut = await conv.convert({ bytes: Buffer.from(md), filename: 'a.md' }, 'md', 'docx')
    const back = await conv.convert({ bytes: docxOut.parts[0].bytes, filename: 'a.docx' }, 'docx', 'md')
    return back.parts[0].bytes.toString('utf8')
  }

  it('gives back a fenced code block, indentation, blank lines and language', async () => {
    const code = 'def total(items):\n    result = 0\n    for item in items:\n        result += item\n\n    return result'
    const md = await roundTrip(`Intro.\n\n\`\`\`python\n${code}\n\`\`\`\n\nMiddle.\n\n\`\`\`\nplain  two  spaces\n  indented <tag> & more\n\`\`\`\n\nEnd with \`inline\` code.\n`)
    expect(md).toContain(`\`\`\`python\n${code}\n\`\`\``)
    expect(md).toContain('```\nplain  two  spaces\n  indented <tag> & more\n```')
    expect(md).toContain('Middle.')
    expect(md).toContain('End with inline code.')
  })
})
