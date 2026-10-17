import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { sanitizeToHub } from '../../src/core/allowlist'
import { markStyle } from '../../src/core/mark'
import { readDocx } from '../../src/core/readers/docx'
import { readHtml } from '../../src/core/readers/html'
import { readMarkdown } from '../../src/core/readers/md'
import { readOdt } from '../../src/core/readers/odt'
import { readRtf } from '../../src/core/readers/rtf'
import { readAsciidoc } from '../../src/core/readers/asciidoc'
import { readDjot } from '../../src/core/readers/djot'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeDocx } from '../../src/core/writers/docx'
import { writeTxt } from '../../src/core/writers/txt'
import { writeHtml } from '../../src/core/writers/html'
import { writeEpub } from '../../src/core/writers/epub'
import { writeRevealJs } from '../../src/core/writers/revealjs'
import { renderDocumentShell } from '../../src/core/shell'

const bytes = (s: string) => ({ bytes: Buffer.from(s, 'utf8') })

/**
 * Highlighted text (`<mark>`): a reviewer's "look here", Word's highlighter,
 * LibreOffice's character highlighting. The hub keeps it, with its color when
 * it is not the ordinary yellow, and every writer shows it its own way.
 */
describe('highlight in the hub', () => {
  it('keeps a plain mark, and drops every attribute it does not model', () => {
    expect(sanitizeToHub('<p>a <mark>b</mark> c</p>')).toBe('<p>a <mark>b</mark> c</p>')
    expect(sanitizeToHub('<p><mark class="x" onclick="evil()" title="t">b</mark></p>')).toBe('<p><mark>b</mark></p>')
  })

  it('keeps its own color as #RRGGBB, whatever CSS form it came in, and yellow as a plain mark', () => {
    expect(sanitizeToHub('<p><mark style="background-color: lime">b</mark></p>')).toBe('<p><mark style="background-color:#00FF00">b</mark></p>')
    expect(sanitizeToHub('<p><mark style="background: rgb(173 216 230) url(x.png)">b</mark></p>')).toBe('<p><mark style="background-color:#ADD8E6">b</mark></p>')
    expect(sanitizeToHub('<p><mark style="background-color: #ff0">b</mark></p>')).toBe('<p><mark>b</mark></p>')
    // Not a color, or none: the mark is still a highlight, the ordinary one.
    expect(sanitizeToHub('<p><mark style="background-color: var(--x); position: fixed">b</mark></p>')).toBe('<p><mark>b</mark></p>')
    expect(sanitizeToHub('<p><mark style="background: transparent">b</mark></p>')).toBe('<p><mark>b</mark></p>')
  })

  it('gives a dark highlight white text, as Word shows automatic text on it', () => {
    expect(markStyle('000080')).toBe('background-color:#000080;color:#FFFFFF')
    expect(markStyle('00FF00')).toBe('background-color:#00FF00')
    expect(sanitizeToHub('<p><mark style="background-color: navy; color: red">b</mark></p>')).toBe(
      '<p><mark style="background-color:#000080;color:#FFFFFF">b</mark></p>',
    )
    // Only what markStyle makes: a style smuggled in is rebuilt from the color alone.
    expect(sanitizeToHub('<p><mark style="background-color:#00FF00;color:#FFFFFF">b</mark></p>')).toBe(
      '<p><mark style="background-color:#00FF00">b</mark></p>',
    )
  })
})

describe('reading highlight', () => {
  it('from HTML, and from inline HTML in Markdown', async () => {
    expect((await readHtml({ ...bytes('<p>a <mark>key</mark> b</p>'), filename: 'a.html' })).html).toContain('<mark>key</mark>')
    expect((await readMarkdown(bytes('a <mark>key</mark> b\n'))).html).toContain('a <mark>key</mark> b')
    expect((await readMarkdown(bytes('a <mark style="background-color:#00FF00">key</mark> b\n'))).html).toContain(
      '<mark style="background-color:#00FF00">key</mark>',
    )
  })

  it('in code, as documentation pages mark the line that matters, and the code is still colored', async () => {
    const page = '<pre><code class="language-js">let a = 1\n<mark style="background: #cfe8fc">let b = 2</mark></code></pre>'
    const hub = (await readHtml({ ...bytes(page), filename: 'a.html' })).html
    expect(hub).toContain('<mark style="background-color:#CFE8FC">let b = 2</mark>')
    const xml = await (await JSZip.loadAsync(await writeDocx({ html: hub }))).file('word/document.xml')!.async('string')
    expect(xml).toMatch(/<w:shd [^>]*w:fill="CFE8FC"[^>]*\/>[\s\S]*?<w:t[^>]*>let<\/w:t>/)
    const out = (await writeHtml({ html: hub })).toString('utf8')
    expect(out).toMatch(/<mark style="background-color:#CFE8FC"><span class="hljs-keyword">let<\/span> b = <span class="hljs-number">2<\/span><\/mark>/)
  })

  it('from AsciiDoc #text# and Djot {=text=}', async () => {
    expect((await readAsciidoc({ ...bytes('A #key# word.\n'), filename: 'a.adoc' })).html).toContain('<mark>key</mark>')
    expect((await readDjot({ ...bytes('A {=key=} word.\n'), filename: 'a.dj' })).html).toContain('<mark>key</mark>')
  })

  it("from Word's highlighter, each color as itself, and from run shading", async () => {
    const docx = await writeDocx({ html: '<p>a <mark>plain</mark> b <mark style="background-color:#00FF00">green</mark> c</p>' })
    const zip = await JSZip.loadAsync(docx)
    const xml = await zip.file('word/document.xml')!.async('string')
    // Shading as Google Docs and others write a highlight: w:shd on the run.
    const shaded =
      '<w:p><w:r><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="ADD8E6"/></w:rPr><w:t>shaded</w:t></w:r>' +
      '<w:r><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="auto"/></w:rPr><w:t xml:space="preserve"> none</w:t></w:r></w:p>'
    zip.file('word/document.xml', xml.replace(/<w:sectPr\b/, `${shaded}<w:sectPr`))
    const html = (await readDocx({ bytes: await zip.generateAsync({ type: 'nodebuffer' }), filename: 'h.docx' })).html
    expect(html).toContain('<mark>plain</mark>')
    expect(html).toContain('<mark style="background-color:#00FF00">green</mark>')
    expect(html).toContain('<mark style="background-color:#ADD8E6">shaded</mark>')
    expect(html).toContain('</mark> none')
  })

  it('from LibreOffice character highlighting', async () => {
    const NS = 'xmlns:office="o" xmlns:text="t" xmlns:style="s" xmlns:fo="f"'
    const content = `<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>
<style:style style:name="H" style:family="text"><style:text-properties fo:background-color="#ffff00"/></style:style>
<style:style style:name="T" style:family="text"><style:text-properties fo:background-color="transparent"/></style:style>
</office:automatic-styles><office:body><office:text><text:p>A <text:span text:style-name="H">key</text:span> and <text:span text:style-name="T">plain</text:span>.</text:p></office:text></office:body></office:document-content>`
    const zip = new JSZip()
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
    zip.file('content.xml', content)
    const html = (await readOdt({ bytes: await zip.generateAsync({ type: 'nodebuffer' }), filename: 'h.odt' })).html
    expect(html).toContain('<mark>key</mark>')
    expect(html).not.toContain('<mark>plain')
  })

  it('from RTF \\highlight, with its color, and \\highlight0 ends it', async () => {
    const rtf = '{\\rtf1\\ansi{\\colortbl;\\red255\\green255\\blue0;\\red0\\green255\\blue0;}A {\\highlight1 key} and {\\highlight2 green\\highlight0  off}\\par}'
    const html = (await readRtf(bytes(rtf))).html
    expect(html).toContain('<mark>key</mark>')
    expect(html).toContain('<mark style="background-color:#00FF00">green</mark>')
    expect(html).not.toContain('off</mark>')
  })
})

describe('writing highlight', () => {
  it('to Markdown as inline HTML, which reads back the same', async () => {
    const hub = '<p>a <mark>key</mark> and <mark style="background-color:#00FF00">green</mark></p>'
    const md = (await writeMarkdown({ html: hub })).toString('utf8')
    expect(md.trim()).toBe('a <mark>key</mark> and <mark style="background-color:#00FF00">green</mark>')
    expect((await readMarkdown(bytes(md))).html).toContain(hub)
  })

  it("to Word as its highlighter, or the mark's own color", async () => {
    const docx = await writeDocx({ html: '<p>a <mark>key</mark> b <mark style="background-color:#ADD8E6">blue</mark></p>' })
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')
    expect(xml).toMatch(/<w:highlight w:val="yellow"\/>[\s\S]*?<w:t[^>]*>key<\/w:t>/)
    expect(xml).toMatch(/<w:shd [^>]*w:fill="ADD8E6"[^>]*\/>[\s\S]*?<w:t[^>]*>blue<\/w:t>/)
  })

  it('round-trips Word to Word', async () => {
    const first = await writeDocx({ html: '<p>a <mark style="background-color:#000080;color:#FFFFFF">dark</mark></p>' })
    const hub = (await readDocx({ bytes: first, filename: 'a.docx' })).html
    expect(hub).toContain('<mark style="background-color:#000080;color:#FFFFFF">dark</mark>')
  })

  it('to plain text as just its text', async () => {
    expect((await writeTxt({ html: '<p>a <mark>key</mark> b</p>' })).toString('utf8').trim()).toBe('a key b')
  })

  it('to HTML, PDF, EPUB and slides with a readable yellow', async () => {
    const shell = renderDocumentShell({ html: '<p><mark>k</mark></p>' })
    expect(shell).toMatch(/mark \{[^}]*background(?:-color)?: #[0-9a-f]{6}[^}]*color: #[0-9a-f]{6}/i)
    expect((await writeHtml({ html: '<p><mark>k</mark></p>' })).toString('utf8')).toContain('<mark>k</mark>')
    const epub = await JSZip.loadAsync(await writeEpub({ html: '<h1>T</h1><p><mark>k</mark></p>' }))
    expect(await epub.file('OEBPS/style.css')!.async('string')).toMatch(/mark \{[^}]*background/)
    const chapter = Object.keys(epub.files).find((n) => n.endsWith('.xhtml') && !n.endsWith('nav.xhtml'))!
    expect(await epub.file(chapter)!.async('string')).toContain('<mark>k</mark>')
    const deck = (await writeRevealJs({ html: '<h1>T</h1><p><mark>k</mark></p>' })).toString('utf8')
    expect(deck).toContain('<mark>k</mark>')
    expect(deck).toMatch(/\.reveal mark \{[^}]*background/)
  })
})
