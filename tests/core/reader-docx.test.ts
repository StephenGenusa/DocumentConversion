import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { readDocx, headerTitleFromXml } from '../../src/core/readers/docx'

const DOCS = join(__dirname, '../corpus')

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** One `<w:p>` of plain runs. */
function para(...texts: string[]): string {
  return `<w:p>${texts.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join('')}</w:p>`
}

function hdr(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W} ${R}>${body}</w:hdr>`
}

/**
 * A docx small enough to reason about: body paragraphs plus whichever
 * header/footer parts the case needs, wired through the same
 * headerReference / document.xml.rels pair Word writes.
 */
async function buildDocx(opts: {
  body: string
  /** `w:type` -> part body, e.g. { default: '<w:p>…</w:p>' }. */
  headers?: Record<string, string>
  footers?: Record<string, string>
}): Promise<Buffer> {
  const zip = new JSZip()
  const rels: string[] = []
  const refs: string[] = []
  const parts: Array<[string, string]> = []
  let n = 0
  const add = (kind: 'header' | 'footer', type: string, xml: string): void => {
    n += 1
    const file = `${kind}${n}.xml`
    rels.push(
      `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${file}"/>`,
    )
    refs.push(`<w:${kind}Reference w:type="${type}" r:id="rId${n}"/>`)
    parts.push([`word/${file}`, xml])
  }
  for (const [type, xml] of Object.entries(opts.headers ?? {})) add('header', type, hdr(xml))
  for (const [type, xml] of Object.entries(opts.footers ?? {})) {
    add('footer', type, hdr(xml).replace(/w:hdr/g, 'w:ftr'))
  }
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} ${R}><w:body>${opts.body}<w:sectPr>${refs.join('')}</w:sectPr></w:body></w:document>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
  )
  for (const [name, xml] of parts) zip.file(name, xml)
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('readDocx', () => {
  it('extracts semantic html from a docx', async () => {
    const bytes = await readFile(join(__dirname, '../fixtures/sample.docx'))
    const doc = await readDocx({ bytes })
    expect(doc.html).toContain('Fixture Title')
    expect(doc.html.toLowerCase()).toContain('<strong>world</strong>')
    expect(doc.html.toLowerCase()).toContain('<li>a</li>')
  })
})

describe('headerTitleFromXml', () => {
  it('reads the running text of a header part', () => {
    expect(headerTitleFromXml(hdr(para('BRANCH', ' SUPPLY REQUEST')))).toBe('BRANCH SUPPLY REQUEST')
  })

  it('joins separate header paragraphs with a space', () => {
    expect(headerTitleFromXml(hdr(para('ACME') + para('Library Report')))).toBe('ACME Library Report')
  })

  it('rejects a header that is only a PAGE field', () => {
    const field = `<w:p><w:fldSimple w:instr=" PAGE   \\* MERGEFORMAT "><w:r><w:t>7</w:t></w:r></w:fldSimple></w:p>`
    expect(headerTitleFromXml(hdr(field))).toBeUndefined()
  })

  it('rejects a header that is only a complex PAGE/NUMPAGES field pair', () => {
    const complex =
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> of </w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
    expect(headerTitleFromXml(hdr(complex))).toBeUndefined()
  })

  it('rejects a typed-out page number', () => {
    expect(headerTitleFromXml(hdr(para('Page 3 of 9')))).toBeUndefined()
  })

  it('rejects a header that is only a date', () => {
    expect(headerTitleFromXml(hdr(para('October 11, 2023')))).toBeUndefined()
    expect(headerTitleFromXml(hdr(para('10/11/2023')))).toBeUndefined()
  })

  it('keeps the title when a page number sits beside it', () => {
    const mixed =
      `<w:p><w:r><w:t xml:space="preserve">ACME Library Report</w:t></w:r>` +
      `<w:fldSimple w:instr=" PAGE "><w:r><w:t>4</w:t></w:r></w:fldSimple></w:p>`
    expect(headerTitleFromXml(hdr(mixed))).toBe('ACME Library Report')
  })

  it('decodes entities in the header text', () => {
    expect(headerTitleFromXml(hdr(para('Ops &amp; Safety')))).toBe('Ops & Safety')
  })

  it('has no title for an empty header part', () => {
    expect(headerTitleFromXml(hdr(para('  ')))).toBeUndefined()
  })
})

describe('readDocx page headers', () => {
  const itIfCorpus = existsSync(DOCS) ? it : it.skip

  itIfCorpus('surfaces the page header of the corpus supply request as its title', async () => {
    const bytes = await readFile(join(DOCS, 'supply-request-header.docx'))
    const doc = await readDocx({ bytes })
    expect(doc.title).toBe('BRANCH SUPPLY REQUEST')
    expect(doc.html.startsWith('<h1>BRANCH SUPPLY REQUEST</h1>')).toBe(true)
    // Once, not once per page.
    expect(doc.html.match(/BRANCH SUPPLY REQUEST/g)).toHaveLength(1)
  })

  itIfCorpus('still drops footers, which are page furniture', async () => {
    const bytes = await readFile(join(DOCS, 'induction-pack-with-footer.docx'))
    const doc = await readDocx({ bytes })
    expect(doc.html).not.toContain('Proprietary')
    expect(doc.title).toBeUndefined()
  })

  it('ignores a footer even when there is no header', async () => {
    const bytes = await buildDocx({
      body: para('Body text.'),
      footers: { default: para('Confidential — page furniture') },
    })
    const doc = await readDocx({ bytes })
    expect(doc.html).not.toContain('Confidential')
    expect(doc.title).toBeUndefined()
  })

  it('falls back to a first-page header when there is no default one', async () => {
    const bytes = await buildDocx({ body: para('Body text.'), headers: { first: para('Quarterly Review') } })
    const doc = await readDocx({ bytes })
    expect(doc.title).toBe('Quarterly Review')
    expect(doc.html.startsWith('<h1>Quarterly Review</h1>')).toBe(true)
  })

  it('emits a header shared by the first and default parts only once', async () => {
    const bytes = await buildDocx({
      body: para('Body text.'),
      headers: { default: para('Quarterly Review'), first: para('Quarterly Review') },
    })
    const doc = await readDocx({ bytes })
    expect(doc.html.match(/Quarterly Review/g)).toHaveLength(1)
  })

  it('skips a default header that is only a page number and takes the real one', async () => {
    const bytes = await buildDocx({
      body: para('Body text.'),
      headers: { default: para('Page 2 of 4'), first: para('Quarterly Review') },
    })
    const doc = await readDocx({ bytes })
    expect(doc.title).toBe('Quarterly Review')
    expect(doc.html).not.toContain('Page 2 of 4')
  })

  it('does not repeat a header the body already states', async () => {
    const bytes = await buildDocx({
      body: para('Quarterly Review') + para('Body text.'),
      headers: { default: para('Quarterly Review') },
    })
    const doc = await readDocx({ bytes })
    expect(doc.title).toBe('Quarterly Review')
    expect(doc.html.match(/Quarterly Review/g)).toHaveLength(1)
    expect(doc.html.startsWith('<h1>')).toBe(false)
  })

  it('leaves a document that already opens with a heading alone', async () => {
    const bytes = await buildDocx({
      body: `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Real Title</w:t></w:r></w:p>${para('Body.')}`,
      headers: { default: para('ACME Corporation') },
    })
    const doc = await readDocx({ bytes })
    expect(doc.html).not.toContain('ACME Corporation')
    expect(doc.html.startsWith('<h1>Real Title</h1>')).toBe(true)
  })

  it('adds no title and no heading when the document has no header', async () => {
    const bytes = await readFile(join(__dirname, '../fixtures/sample.docx'))
    const doc = await readDocx({ bytes })
    expect(doc.title).toBeUndefined()
  })
})
