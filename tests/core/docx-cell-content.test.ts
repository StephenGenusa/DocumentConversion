import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { writeDocx, flattenForDocx } from '../../src/core/writers/docx'
import { readHtml } from '../../src/core/readers/html'

/** Every word Word will show, in order, and how many tables it holds. */
async function docxText(html: string): Promise<{ text: string; tables: number }> {
  const xml = await (await JSZip.loadAsync(await writeDocx({ html }))).file('word/document.xml')!.async('string')
  const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(' ')
  return { text: text.replace(/\s+/g, ' '), tables: (xml.match(/<w:tbl>/g) ?? []).length }
}

const inOrder = (text: string, words: string[]): boolean => {
  let at = 0
  for (const w of words) {
    const i = text.indexOf(w, at)
    if (i < 0) return false
    at = i + w.length
  }
  return true
}

/**
 * html-to-docx 1.8.0 writes nothing for these shapes. Each case is one the
 * library was measured dropping; each word must come back, in order.
 */
describe('docx writer keeps content html-to-docx drops inside cells', () => {
  const cases: [string, string, string[]][] = [
    ['a table nested in a cell', '<table><tr><td><table><tr><td>ALPHA</td><td>BETA</td></tr></table></td></tr></table>', ['ALPHA', 'BETA']],
    ['a table nested in a header cell', '<table><tr><th><table><tr><td>ALPHA</td></tr></table></th></tr></table>', ['ALPHA']],
    ['a table in a list item', '<ul><li>ONE<table><tr><td>ALPHA</td></tr></table></li></ul>', ['ONE', 'ALPHA']],
    ['a div holding a paragraph in a cell', '<table><tr><td><div><p>ALPHA</p></div></td></tr></table>', ['ALPHA']],
    ['a div holding a heading in a cell', '<table><tr><td><div><h1>ALPHA</h1><p>BETA</p></div></td></tr></table>', ['ALPHA', 'BETA']],
    ['nested divs in a cell', '<table><tr><td><div><div><p>ALPHA</p></div>BETA</div></td></tr></table>', ['ALPHA', 'BETA']],
    ['three levels of tables', '<table><tr><td><table><tr><td><table><tr><td>ALPHA</td></tr></table></td><td>BETA</td></tr></table></td></tr></table>', ['ALPHA', 'BETA']],
    ['every paragraph of a list item', '<ul><li><p>ONE</p><p>ALPHA</p><p>BETA</p></li></ul>', ['ONE', 'ALPHA', 'BETA']],
    ['text then a paragraph in a list item', '<ol><li>ONE<p>ALPHA</p></li></ol>', ['ONE', 'ALPHA']],
    ['a heading in a list item', '<ul><li><p>ONE</p><h3>ALPHA</h3></li></ul>', ['ONE', 'ALPHA']],
    ['paragraphs around a nested list and code', '<ul><li><p>ONE</p><p>TWO</p><ul><li>ALPHA</li></ul><pre><code>BETA</code></pre><p>GAMMA</p><p>DELTA</p></li></ul>', ['ONE', 'TWO', 'ALPHA', 'BETA', 'GAMMA', 'DELTA']],
    ['a nested table beside a block cell', '<table><tr><td><table><tr><td><b>ALPHA</b><br><a href="https://example.com/a">BETA</a></td></tr></table></td><td><div><p>GAMMA</p></div></td></tr></table>', ['ALPHA', 'BETA', 'GAMMA']],
  ]
  for (const [name, html, words] of cases) {
    it(name, async () => {
      const { text } = await docxText(html)
      expect(inOrder(text, words), `${words.join(', ')} in: ${text}`).toBe(true)
    })
  }

  it('keeps the old-style layout page whole (tests/fixtures/layout-table.html)', async () => {
    const hub = await readHtml({ bytes: readFileSync('tests/fixtures/layout-table.html'), filename: 'layout-table.html' })
    const { text } = await docxText(hub.html)
    expect(
      inOrder(text, ['Home', 'Guestbook', 'Sections', 'Bays', 'Trolleys', 'Mezzanines', 'Notes on Shelf Runs', 'access check', 'reshelved into the north wall', 'Last updated 2003']),
      text,
    ).toBe(true)
  })

  it('puts plain cells of a nested row on one line, marked like the .doc reader', () => {
    expect(flattenForDocx('<table><tr><td><table><tr><td>a</td><td></td><td>b</td></tr></table></td></tr></table>')).toBe(
      '<table><tr><td><p>a | b</p></td></tr></table>',
    )
  })

  it('does not let text either side of a block run together when its div goes', () => {
    expect(flattenForDocx('<table><tr><td><div>before<p>mid</p>after</div></td></tr></table>')).toBe(
      '<table><tr><td><p>before</p><p>mid</p><p>after</p></td></tr></table>',
    )
  })

  it('joins an item\'s paragraphs a blank line apart and leaves surviving blocks alone', () => {
    expect(flattenForDocx('<ul><li><p>one</p><h2>two</h2><ul><li>sub</li></ul><p>three</p></li></ul>')).toBe(
      '<ul><li>one<br><br><strong>two</strong><ul><li>sub</li></ul>three</li></ul>',
    )
  })

  it('leaves an item of one paragraph as the library already writes it', () => {
    const one = '<ul><li><p>only</p></li><li>plain <b>text</b></li></ul>'
    expect(flattenForDocx(one)).toBe(one)
  })

  it('leaves the outer table a table', async () => {
    const { tables } = await docxText('<table><tr><td><table><tr><td>x</td></tr></table></td><td>y</td></tr></table>')
    expect(tables).toBe(1)
  })

  it('returns a document with no table byte-for-byte, and leaves what the library handles alone', () => {
    const plain = '<div><p>a</p></div><p>b &amp; c</p>'
    expect(flattenForDocx(plain)).toBe(plain)
    const handled = '<table><tr><td><p>a</p><ul><li>b</li></ul><div>inline only</div></td></tr></table>'
    expect(flattenForDocx(handled)).toBe(handled)
  })
})

describe('docx writer keeps a cell of formatted text one paragraph', () => {
  it('puts inline content in a cell into one paragraph', async () => {
    expect(flattenForDocx('<table><tr><td>a <strong>b</strong> c</td><th><em>d</em></th></tr></table>')).toBe(
      '<table><tr><td><p>a <strong>b</strong> c</p></td><th><p><em>d</em></p></th></tr></table>',
    )
    const xml = await (await JSZip.loadAsync(await writeDocx({ html: '<table><tr><td>ALPHA <strong>BETA</strong> GAMMA</td></tr></table>' })))
      .file('word/document.xml')!
      .async('string')
    const cell = /<w:tc>[\s\S]*?<\/w:tc>/.exec(xml)![0]
    expect(cell.match(/<w:p>/g)).toHaveLength(1)
    expect(cell).toMatch(/<w:b\/>[\s\S]*BETA/)
  })

  it('leaves a cell of plain text alone', () => {
    const plain = '<table><tr><td>plain text</td></tr></table>'
    expect(flattenForDocx(plain)).toBe(plain)
  })
})
