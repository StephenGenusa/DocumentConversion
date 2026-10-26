import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { githubSlug, headingAnchorsForOutput } from '../../src/core/heading-anchors'
import { headingBookmarkName, writeDocx } from '../../src/core/writers/docx'
import { writeRevealJs } from '../../src/core/writers/revealjs'
import { kindleLinks } from '../../src/core/writers/azw3'
import { readMarkdown } from '../../src/core/readers/md'
import { writeHtml } from '../../src/core/writers/html'
import { writeEpub } from '../../src/core/writers/epub'

const bytes = (s: string) => ({ bytes: Buffer.from(s, 'utf8') })

/**
 * A Markdown contents list (`- [10. Things not confirmed](#10-things-not-confirmed)`)
 * printed to pdf as dead text: the hub keeps the link but no heading has an
 * id, so Chromium had nothing to link to and dropped every one.
 */
describe('links to headings', () => {
  it('slugs a heading as GitHub does', () => {
    expect(githubSlug('10. Things not confirmed')).toBe('10-things-not-confirmed')
    expect(githubSlug('TL;DR for the RTX 4090 (24 GB)')).toBe('tldr-for-the-rtx-4090-24-gb')
    expect(githubSlug('3.1 Legacy quants (_0 and _1)')).toBe('31-legacy-quants-_0-and-_1')
    expect(githubSlug('Café — résumé')).toBe('café--résumé')
  })

  it('gives the linked heading its id and leaves the others bare', () => {
    const out = headingAnchorsForOutput('<p><a href="#b-side">B</a></p><h2>A side</h2><h2>B side</h2>')
    expect(out).toBe('<p><a href="#b-side">B</a></p><h2>A side</h2><h2 id="b-side">B side</h2>')
  })

  it('numbers repeated headings in order, as GitHub does', () => {
    const out = headingAnchorsForOutput('<h2>Notes</h2><h2>Notes</h2><h2>Notes</h2><a href="#notes-2">x</a><a href="#notes">y</a>')
    expect(out).toBe('<h2 id="notes">Notes</h2><h2>Notes</h2><h2 id="notes-2">Notes</h2><a href="#notes-2">x</a><a href="#notes">y</a>')
  })

  it('takes the text of inline markup in a heading, and a link written in capitals', () => {
    const out = headingAnchorsForOutput('<h3>Using <code>llama.cpp</code></h3><a href="#Using-LLAMACPP">x</a>')
    expect(out).toBe('<h3 id="using-llamacpp">Using <code>llama.cpp</code></h3><a href="#using-llamacpp">x</a>')
  })

  it('keeps the text of a link that points at nothing, and leaves footnote links alone', () => {
    const html = '<p><a href="#nowhere">gone</a> <a href="#fn-1">1</a></p><ol><li id="fn-1">n</li></ol>'
    expect(headingAnchorsForOutput(html)).toBe('<p>gone <a href="#fn-1">1</a></p><ol><li id="fn-1">n</li></ol>')
  })

  it('leaves external links and a document without fragment links untouched', () => {
    const html = '<h2>A</h2><p><a href="https://example.com/#a">x</a></p>'
    expect(headingAnchorsForOutput(html)).toBe(html)
  })

  it('links a Markdown contents list in the html and pdf shell', async () => {
    const md = '# Guide\n\n- [10. Things not confirmed](#10-things-not-confirmed)\n\n## 10. Things not confirmed\n\nText.\n'
    const html = (await writeHtml(await readMarkdown(bytes(md)))).toString('utf8')
    expect(html).toContain('<a href="#10-things-not-confirmed">10. Things not confirmed</a>')
    expect(html).toContain('<h2 id="10-things-not-confirmed">10. Things not confirmed</h2>')
  })

  it('links a heading in another chapter of an EPUB', async () => {
    const md = '# One\n\nSee [the second](#two).\n\n# Two\n\nText.\n'
    const zip = await JSZip.loadAsync(await writeEpub(await readMarkdown(bytes(md))))
    const names = Object.keys(zip.files).filter((n) => n.endsWith('.xhtml') && /ch\d+/.test(n)).sort()
    const chapters = await Promise.all(names.map((n) => zip.file(n)!.async('string')))
    expect(chapters.join('')).toContain('id="two"')
    expect(chapters[0]).toMatch(/href="ch\d+\.xhtml#two"/)
  })

  it('links a Word heading by bookmark, and keeps external links external', async () => {
    const md = '- [**Bold** two](#two)\n\nSee [web](https://example.com/).\n\n## Two\n\nText.\n'
    const zip = await JSZip.loadAsync(await writeDocx(await readMarkdown(bytes(md))))
    const xml = await zip.file('word/document.xml')!.async('string')
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    expect(xml).toMatch(/<w:pStyle w:val="Heading2"\/>[\s\S]*?<w:bookmarkStart w:id="\d+" w:name="two"\/><w:bookmarkEnd w:id="\d+"\/>/)
    expect(xml).toContain('<w:hyperlink w:anchor="two" w:history="1">')
    expect(rels).not.toContain('Target="#')
    expect(rels).toContain('Target="https://example.com/"')
    expect(xml).not.toMatch(/[]/)
  })

  it('names Word bookmarks as Word allows: a letter first, 40 at most, unique', () => {
    const taken = new Set<string>()
    expect(headingBookmarkName('10-things-not-confirmed', taken)).toBe('h10_things_not_confirmed')
    expect(headingBookmarkName('10-things-not-confirmed', taken)).toBe('h10_things_not_confirmed_2')
    expect(headingBookmarkName('café', taken)).toBe('caf_')
    expect(headingBookmarkName('x'.repeat(60), taken).length).toBeLessThanOrEqual(40)
  })

  it('links a slide by its heading, as reveal.js moves between slides', async () => {
    const md = '# One\n\nSee [two](#two).\n\n# Two\n\nText.\n'
    const deck = (await writeRevealJs(await readMarkdown(bytes(md)))).toString('utf8')
    expect(deck).toContain('<a href="#/two">two</a>')
    expect(deck).toContain('<h1 id="two">Two</h1>')
  })

  it('points a Kindle link at the fragment and byte offset of its target', () => {
    const bodies = ['<p><a href="ch002.xhtml#two">two</a> <a href="#nope">gone</a> <a href="https://x.y/#a">web</a></p>', '<p>é</p><h1 id="two">Two</h1>']
    const [first, second] = kindleLinks(bodies, ['OEBPS/ch001.xhtml', 'OEBPS/ch002.xhtml'])
    // '<p>é</p>' is 9 bytes: the é is two.
    expect(first).toBe('<p><a href="kindle:pos:fid:0001:off:0000000009">two</a> gone <a href="https://x.y/#a">web</a></p>')
    expect(second).toBe(bodies[1])
  })
})
