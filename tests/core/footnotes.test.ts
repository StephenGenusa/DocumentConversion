import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { sanitizeToHub } from '../../src/core/allowlist'
import { normalizeFootnotes } from '../../src/core/footnotes'
import { mergeHubDocuments } from '../../src/core/merge'
import { readMarkdown } from '../../src/core/readers/md'
import { readDocx } from '../../src/core/readers/docx'
import { readAsciidoc } from '../../src/core/readers/asciidoc'
import { readRst } from '../../src/core/readers/rst'
import { readRtf } from '../../src/core/readers/rtf'
import { readOdt } from '../../src/core/readers/odt'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeHtml } from '../../src/core/writers/html'
import { writeTxt } from '../../src/core/writers/txt'
import { writeDocx } from '../../src/core/writers/docx'
import { writeEpub } from '../../src/core/writers/epub'
import { writeRevealJs } from '../../src/core/writers/revealjs'

const bytes = (s: string) => ({ bytes: Buffer.from(s, 'utf8') })
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
/** What convert.read() does after any reader: one list, numbered by first reference. */
const numbered = (html: string) => normalizeFootnotes(html, { reorder: true })

/**
 * A footnote is a reference and a note joined by a label. The hub had no way to
 * say so: markdown-it read `[^1]: text` as a link definition and the note's
 * text vanished; Word footnotes arrived as "[1]" and a list with a stray "↑";
 * RTF ran the note into the sentence. The model:
 *
 *   <sup data-fn="label">n</sup>                 a reference
 *   <ol><li data-fn="label">…                  the notes (every item labelled), last
 */
describe('the hub footnote model', () => {
  it('passes the sanitizer with valid labels only', () => {
    const ok = '<p>a<sup data-fn="smith2020">1</sup></p><ol><li data-fn="smith2020"><p>n</p></li></ol>'
    expect(sanitizeToHub(ok)).toBe(ok)
    expect(sanitizeToHub('<p>a<sup data-fn="&quot;&gt;&lt;x">1</sup></p>')).toBe('<p>a<sup>1</sup></p>')
    expect(sanitizeToHub(`<p>a<sup data-fn="${'x'.repeat(65)}">1</sup></p>`)).toBe('<p>a<sup>1</sup></p>')
    expect(sanitizeToHub('<ol data-footnotes="evil"><li data-fn="a b">x</li></ol>')).toBe('<ol><li>x</li></ol>')
    expect(sanitizeToHub('<p data-fn="a">x</p>')).toBe('<p>x</p>')
  })

  it('numbers notes by first reference when a document is read, keeping unreferenced ones after', () => {
    const html =
      '<ol><li data-fn="b"><p>B</p></li><li data-fn="lonely"><p>L</p></li><li data-fn="a"><p>A</p></li></ol>' +
      '<p>x<sup data-fn="a">?</sup> y<sup data-fn="b">?</sup> z<sup data-fn="a">?</sup></p>'
    expect(normalizeFootnotes(html, { reorder: true })).toBe(
      '<p>x<sup data-fn="a">1</sup> y<sup data-fn="b">2</sup> z<sup data-fn="a">1</sup></p>' +
        '<ol><li data-fn="a"><p>A</p></li><li data-fn="b"><p>B</p></li><li data-fn="lonely"><p>L</p></li></ol>',
    )
  })

  it('keeps the note order an edit left, numbering by position, when written', () => {
    const html = '<p>x<sup data-fn="b">9</sup> y<sup data-fn="a">9</sup></p><ol><li data-fn="a"><p>A</p></li><li data-fn="b"><p>B</p></li></ol>'
    expect(normalizeFootnotes(html)).toBe(
      '<p>x<sup data-fn="b">2</sup> y<sup data-fn="a">1</sup></p><ol><li data-fn="a"><p>A</p></li><li data-fn="b"><p>B</p></li></ol>',
    )
  })

  it('joins several note lists into one, last', () => {
    const html = '<p>a<sup data-fn="1">1</sup></p><ol><li data-fn="1"><p>one</p></li></ol><p>b<sup data-fn="2">1</sup></p><ol><li data-fn="2"><p>two</p></li></ol>'
    const out = normalizeFootnotes(html)
    expect(out.match(/<ol>/g)).toHaveLength(1)
    expect(out.endsWith('<li data-fn="1"><p>one</p></li><li data-fn="2"><p>two</p></li></ol>')).toBe(true)
    expect(out).toContain('b<sup data-fn="2">2</sup>')
  })

  it('numbers a reference with no note after the notes, and keeps it', () => {
    const out = normalizeFootnotes('<p>a<sup data-fn="x">?</sup> b<sup data-fn="gone">?</sup></p><ol><li data-fn="x"><p>X</p></li></ol>')
    expect(out).toContain('a<sup data-fn="x">1</sup> b<sup data-fn="gone">2</sup>')
  })

  it('leaves a document with no footnotes untouched, byte for byte', () => {
    const html = '<p>a &amp; b<sup>2</sup></p>\n<ol><li>x</li></ol>'
    expect(normalizeFootnotes(html, { reorder: true })).toBe(html)
  })

  it('keeps two merged documents\' notes apart when they use the same label', () => {
    const a = { html: '<p>A<sup data-fn="1">1</sup></p><ol><li data-fn="1"><p>note A</p></li></ol>', sourceName: 'a' }
    const b = { html: '<p>B<sup data-fn="1">1</sup></p><ol><li data-fn="1"><p>note B</p></li></ol>', sourceName: 'b' }
    const merged = normalizeFootnotes(mergeHubDocuments([a, b], { headings: false }).html)
    expect(merged).toMatch(/A<sup data-fn="1">1<\/sup>/)
    expect(merged).toMatch(/B<sup data-fn="([\w.-]+)">2<\/sup>/)
    expect(merged).toMatch(/<li data-fn="1"><p>note A<\/p><\/li><li data-fn="[\w.-]+"><p>note B<\/p><\/li><\/ol>$/)
  })
})

describe('reading footnotes', () => {
  it('Markdown: keeps the author\'s labels, every note, and multi-paragraph notes', async () => {
    const md =
      'A claim[^smith2020] and another[^2] and again[^smith2020].\n\n' +
      '[^smith2020]: Smith, 2020.\n\n' +
      '[^2]: First paragraph.\n\n    Second paragraph.\n\n' +
      '[^unused]: Never referenced.\n'
    const html = (await readMarkdown(bytes(md))).html
    expect(squash(html)).toContain('A claim<sup data-fn="smith2020">1</sup> and another<sup data-fn="2">2</sup> and again<sup data-fn="smith2020">1</sup>.')
    expect(squash(html)).toMatch(/<ol> ?<li data-fn="smith2020"> ?<p>Smith, 2020.<\/p> ?<\/li> ?<li data-fn="2"> ?<p>First paragraph.<\/p> ?<p>Second paragraph.<\/p> ?<\/li> ?<li data-fn="unused"> ?<p>Never referenced.<\/p> ?<\/li> ?<\/ol>/)
  })

  it('Markdown: leaves a reference to an undefined note as written', async () => {
    expect((await readMarkdown(bytes('See[^missing].\n'))).html).toContain('See[^missing].')
  })

  it('Markdown: gives an inline note ^[…] a label of its own', async () => {
    const html = (await readMarkdown(bytes('Inline^[An inline note.] here.\n'))).html
    expect(html).toMatch(/Inline<sup data-fn="[\w.-]+">1<\/sup> here/)
    expect(html).toContain('An inline note.')
  })

  it('Word: maps footnotes and endnotes, without the ↑ back-link', async () => {
    const html = numbered((await readDocx({ bytes: await docxWithNotes(), filename: 'n.docx' })).html)
    expect(squash(html)).toMatch(/Claim<sup data-fn="1">1<\/sup>/)
    expect(squash(html)).toMatch(/Later<sup data-fn="e1">2<\/sup>/)
    expect(squash(html)).toMatch(/<li data-fn="1"><p>The source\.?<\/p><\/li><li data-fn="e1"><p>An endnote\.?<\/p><\/li><\/ol>/)
    expect(html).not.toContain('↑')
    expect(html).not.toContain('[1]')
  })

  it('AsciiDoc: footnote:[…] and a reused named footnote', async () => {
    const html = numbered((await readAsciidoc({ ...bytes('A claim.footnote:[First note.] Named.footnote:n[Named note.] Again.footnote:n[]\n'), filename: 'a.adoc' })).html)
    expect(squash(html)).toMatch(/A claim\.<sup data-fn="1">1<\/sup> Named\.<sup data-fn="2">2<\/sup> Again\.<sup data-fn="2">2<\/sup>/)
    expect(squash(html)).toMatch(/<ol><li data-fn="1"><p>First note\.<\/p><\/li><li data-fn="2"><p>Named note\.<\/p><\/li><\/ol>/)
  })

  it('reStructuredText: numbered and auto-numbered footnotes', async () => {
    const rst = 'A claim [1]_ and an auto one [#]_.\n\n.. [1] Numbered note.\n.. [#] Auto note.\n'
    const html = squash(numbered((await readRst({ ...bytes(rst), filename: 'a.rst' })).html))
    expect(html).toMatch(/A claim <sup data-fn="1">1<\/sup> and an auto one <sup data-fn="[\w.-]+">2<\/sup>/)
    expect(html).toMatch(/<li data-fn="1"><p>Numbered note\.<\/p><\/li><li data-fn="[\w.-]+"><p>Auto note\.<\/p><\/li><\/ol>/)
    expect(html).not.toContain('[1] Numbered')
  })

  it('RTF: takes the note out of the sentence and into the notes', async () => {
    const rtf = '{\\rtf1\\ansi Claim{\\super\\chftn}{\\footnote\\pard\\plain{\\super\\chftn} The source note.}. More text.\\par}'
    const html = squash(numbered((await readRtf(bytes(rtf))).html))
    expect(html).toMatch(/Claim<sup data-fn="1">1<\/sup>\. More text\./)
    expect(html).toMatch(/<ol><li data-fn="1">.*The source note\..*<\/li><\/ol>$/)
    expect(html).not.toContain('Claim The source')
  })

  it('ODT: notes become references and one notes list', async () => {
    const note = (c: string, body: string) =>
      `<text:note text:note-class="footnote"><text:note-citation>${c}</text:note-citation><text:note-body><text:p>${body}</text:p></text:note-body></text:note>`
    const html = squash(numbered(
      (await readOdt({ bytes: await odt(`<text:p>The record${note('1', 'See appendix B.')} is rated.</text:p><text:p>Second${note('2', 'Other note.')} para.</text:p>`), filename: 'n.odt' })).html),
    )
    expect(html).toContain('The record<sup data-fn="1">1</sup> is rated.')
    expect(html).toContain('Second<sup data-fn="2">2</sup> para.')
    expect(html).toMatch(/<ol><li data-fn="1"><p>See appendix B\.<\/p><\/li><li data-fn="2"><p>Other note\.<\/p><\/li><\/ol>$/)
  })
})

const NOTED = '<p>A claim<sup data-fn="smith2020">1</sup>.</p><ol><li data-fn="smith2020"><p>Smith, 2020.</p></li></ol>'

describe('writing footnotes', () => {
  it('Markdown: [^label] references and definitions, exactly what was read', async () => {
    const md = 'A claim[^smith2020] and[^2].\n\n[^smith2020]: Smith, 2020.\n\n[^2]: First paragraph.\n\n    Second paragraph.'
    const out = (await writeMarkdown(await readMarkdown(bytes(md)))).toString('utf8').trim()
    expect(out).toBe(md)
  })

  it('HTML and PDF: linked references and a Notes section with back-links', async () => {
    const html = (await writeHtml({ html: NOTED })).toString('utf8')
    expect(html).toContain('<sup class="fnref"><a href="#fn-smith2020" id="fnref-smith2020">1</a></sup>')
    expect(html).toMatch(/<section class="footnotes"><h2>Notes<\/h2><ol><li id="fn-smith2020"><p>Smith, 2020\. <a href="#fnref-smith2020" class="fnback" aria-label="Back to the text">↩<\/a><\/p><\/li><\/ol><\/section>/)
    expect(html).not.toContain('data-fn')
  })

  it('text: [n] markers and a numbered Notes list', async () => {
    const txt = (await writeTxt({ html: NOTED })).toString('utf8')
    expect(txt).toContain('A claim[1].')
    expect(txt).toMatch(/NOTES[\s\S]*1\. Smith, 2020\./i)
  })

  it('Word: superscript numbers and a Notes list', async () => {
    const xml = await (await JSZip.loadAsync(await writeDocx({ html: NOTED }))).file('word/document.xml')!.async('string')
    expect(xml).toMatch(/<w:vertAlign w:val="superscript"\/>\s*<\/w:rPr>\s*<w:t[^>]*>1<\/w:t>/)
    expect(xml).toContain('Notes')
    expect(xml).toContain('Smith, 2020.')
  })

  it('EPUB: pop-up notes linked across chapter files', async () => {
    const html = '<h1>One</h1><p>A claim<sup data-fn="a">1</sup>.</p><h1>Two</h1><p>Text.</p><ol><li data-fn="a"><p>The note.</p></li></ol>'
    const zip = await JSZip.loadAsync(await writeEpub({ html }))
    const files = Object.keys(zip.files).filter((f) => /ch\d+\.xhtml$/.test(f)).sort()
    const first = await zip.file(files[0])!.async('string')
    const last = await zip.file(files[files.length - 1])!.async('string')
    const noteFile = files[files.length - 1].split('/').pop()
    expect(first).toContain('xmlns:epub="http://www.idpf.org/2007/ops"')
    expect(first).toContain(`<a epub:type="noteref" href="${noteFile}#fn-a" id="fnref-a">1</a>`)
    expect(last).toMatch(/<li id="fn-a" epub:type="footnote"/)
  })

  it('slides: plain numbers and a Notes list, no links', async () => {
    const deck = (await writeRevealJs({ html: NOTED })).toString('utf8')
    expect(deck).toContain('A claim<sup>1</sup>')
    expect(deck).toContain('Smith, 2020.')
    expect(deck).not.toContain('data-fn')
  })
})

async function docxWithNotes(): Promise<Buffer> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const z = new JSZip()
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/></Types>')
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  z.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/></Relationships>')
  z.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Claim</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p><w:p><w:r><w:t>Later</w:t></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p></w:body></w:document>`)
  z.file('word/footnotes.xml', `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:id="1"><w:p><w:r><w:t>The source.</w:t></w:r></w:p></w:footnote></w:footnotes>`)
  z.file('word/endnotes.xml', `<?xml version="1.0"?><w:endnotes ${W}><w:endnote w:id="1"><w:p><w:r><w:t>An endnote.</w:t></w:r></w:p></w:endnote></w:endnotes>`)
  return z.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}

async function odt(body: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
  zip.file('content.xml', `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:text>${body}</office:text></office:body></office:document-content>`)
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}
