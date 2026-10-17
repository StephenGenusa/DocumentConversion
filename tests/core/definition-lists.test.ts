import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readDjot } from '../../src/core/readers/djot'
import { readRst } from '../../src/core/readers/rst'
import { sanitizeToHub } from '../../src/core/allowlist'
import { createConverter } from '../../src/core/convert'
import { writeDocx, definitionListsForDocx } from '../../src/core/writers/docx'

/*
 * Definition lists have a hub form (dl, dt, dd): a glossary is terms and what
 * they mean. Djot and reStructuredText read into it; every writer gives it a
 * shape its format has.
 */

const GLOSSARY = ': Shelf mark\n\n  Where a book _stands_.\n\n  It is on the spine.\n\n: Folio\n\n  A large book.\n'
const HUB = '<dl><dt>Shelf mark</dt><dd><p>Where a book <em>stands</em>.</p><p>It is on the spine.</p></dd><dt>Folio</dt><dd><p>A large book.</p></dd></dl>'

const squash = (html: string): string => html.replace(/>\s+</g, '><').trim()
const conv = createConverter(async () => Buffer.from('%PDF fake'))
const write = async (target: 'md' | 'txt' | 'html' | 'epub', html = HUB): Promise<string> => {
  const out = await conv.convert({ bytes: Buffer.from(html), filename: 'glossary.html' }, 'html', target)
  if (target !== 'epub') return out.parts[0].bytes.toString('utf8')
  const zip = await JSZip.loadAsync(out.parts[0].bytes)
  const pages = Object.keys(zip.files).filter((n) => n.endsWith('.xhtml') || n.endsWith('.css'))
  return (await Promise.all(pages.map((n) => zip.files[n].async('string')))).join('\n')
}

describe('definition lists', () => {
  it('Djot reads one into the hub form', async () => {
    expect(squash((await readDjot({ bytes: Buffer.from(GLOSSARY) })).html)).toBe(HUB)
  })

  it('reStructuredText reads one too', async () => {
    const hub = (await readRst({ bytes: Buffer.from('Shelf mark\n   Where a book stands.\n\nFolio\n   A large book.\n') })).html
    expect(squash(hub)).toBe('<dl><dt>Shelf mark</dt><dd><p>Where a book stands.</p></dd><dt>Folio</dt><dd><p>A large book.</p></dd></dl>')
  })

  it('the hub keeps dl, dt and dd, without their attributes', () => {
    expect(sanitizeToHub('<dl class="glossary"><dt id="a">T</dt><dd style="color:red"><p>D</p></dd></dl>')).toBe('<dl><dt>T</dt><dd><p>D</p></dd></dl>')
  })

  it('Markdown: the term on its line, each definition after `:   `, its later paragraphs indented', async () => {
    expect(await write('md')).toBe('Shelf mark\n:   Where a book _stands_.\n\n    It is on the spine.\n\nFolio\n:   A large book.')
  })

  it('plain text: the term, then its definition indented under it', async () => {
    expect(await write('txt')).toBe('Shelf mark\n    Where a book stands.\n\n    It is on the spine.\n\nFolio\n    A large book.')
  })

  it('HTML and EPUB keep the list', async () => {
    expect(squash(await write('html'))).toContain(HUB)
    const epub = await write('epub')
    expect(squash(epub)).toContain(HUB)
    expect(epub).toContain('dt { font-weight: bold; }')
  })

  it('Word: each term a bold paragraph, each definition paragraph indented below it', async () => {
    const xml = await (await JSZip.loadAsync(await writeDocx({ html: HUB }))).file('word/document.xml')!.async('string')
    const paras = xml.split('</w:p>').filter((p) => /<w:t[ >]/.test(p))
    const text = (p: string): string => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
    const shown = paras.map((p) => ({ text: text(p), bold: /<w:b\/>/.test(p), indent: /<w:ind w:left="(\d+)"/.exec(p)?.[1] })).filter((p) => p.text)
    expect(shown).toEqual([
      { text: 'Shelf mark', bold: true, indent: undefined },
      { text: 'Where a book stands.', bold: false, indent: '720' },
      { text: 'It is on the spine.', bold: false, indent: '720' },
      { text: 'Folio', bold: true, indent: undefined },
      { text: 'A large book.', bold: false, indent: '720' },
    ])
  })

  it('Word: loose text in a definition gets its own paragraph, a list inside one goes deeper', () => {
    expect(definitionListsForDocx('<dl><dt>A</dt><dd>loose <em>text</em></dd></dl>')).toBe('<p><strong>A</strong></p><p style="margin-left: 36pt">loose <em>text</em></p>')
    expect(definitionListsForDocx('<dl><dt>A</dt><dd><p>a</p><dl><dt>B</dt><dd><p>b</p></dd></dl></dd></dl>')).toBe(
      '<p><strong>A</strong></p><p style="margin-left: 36pt">a</p><p style="margin-left: 36pt"><strong>B</strong></p><p style="margin-left: 72pt">b</p>',
    )
  })
})
