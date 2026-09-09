/**
 * Two ways a .docx loses meaning on the way into the hub, both found by LOOKING
 * at the rendered page rather than at a string:
 *
 *  - a numbered procedure with a screenshot after each step came out as
 *    `1. 2. [image] 1. [image] 1. …` — mammoth starts a fresh <ol> after every
 *    interrupting paragraph, so every step after the second was numbered 1;
 *  - a table of contents came out as "How to Catalogue Page 3", because the tab
 *    between the entry and its page number is whitespace that HTML collapses.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { readDocx, mergeInterruptedOrderedLists, keepTabsVisible } from '../../src/core/readers/docx'
import { writeTxt } from '../../src/core/writers/txt'
import { writeMarkdown } from '../../src/core/writers/md'
import { sanitizeToHub } from '../../src/core/allowlist'

const DOCS = join(__dirname, '../corpus')
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** The gap a Word tab leaves behind: no-break spaces, which nothing collapses. */
const GAP = '\u00a0'.repeat(4)

/** One numbered/bulleted paragraph belonging to `numId`. */
function item(numId: number, text: string, ilvl = 0): string {
  return (
    `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr>` +
    `<w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>` +
    `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  )
}

/** One ordinary paragraph. */
function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

/**
 * A docx carrying a real word/numbering.xml, because mammoth decides ordered vs
 * bulleted from the numbering part and emits no list at all without it.
 *
 * numId 1 and 2 are two separate decimal lists (what Word writes for two lists
 * that each start at 1); numId 3 is a bullet list.
 */
async function buildListDocx(body: string): Promise<Buffer> {
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
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W} ${R}><w:body>${body}</w:body></w:document>`)
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
  )
  zip.file(
    'word/numbering.xml',
    `<?xml version="1.0"?><w:numbering ${W}>` +
      `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>` +
      `<w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>` +
      `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>` +
      `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
      `<w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>` +
      `<w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

const count = (html: string, re: RegExp): number => (html.match(re) ?? []).length

describe('mergeInterruptedOrderedLists', () => {
  it('stitches an ordered list back together across the paragraph that split it', () => {
    const html = '<ol><li>One</li><li>Two</li></ol><p>Aside.</p><ol><li>Three</li></ol>'
    expect(mergeInterruptedOrderedLists(html, ['5', '5', '5'])).toBe(
      '<ol><li>One</li><li>Two<p>Aside.</p></li><li>Three</li></ol>',
    )
  })

  it('keeps two lists apart when Word gave them different numbering instances', () => {
    const html = '<ol><li>One</li></ol><p>Aside.</p><ol><li>One again</li></ol>'
    expect(mergeInterruptedOrderedLists(html, ['5', '9'])).toBe(html)
  })

  it('leaves bullets alone: nothing about them renumbers, and folding indents the image', () => {
    const html = '<ul><li>A</li></ul><p>Aside.</p><ul><li>B</li></ul>'
    expect(mergeInterruptedOrderedLists(html, ['5', '5'])).toBe(html)
  })

  it('does nothing when the item count and the numbering cannot be lined up', () => {
    const html = '<ol><li>One</li></ol><p>Aside.</p><ol><li>Two</li></ol>'
    expect(mergeInterruptedOrderedLists(html, ['5'])).toBe(html)
    expect(mergeInterruptedOrderedLists(html, [])).toBe(html)
  })

  it('counts a nested list against its own paragraphs, not the outer one', () => {
    const html = '<ol><li>One<ol><li>Sub</li></ol></li></ol><p>Aside.</p><ol><li>Two</li></ol>'
    expect(mergeInterruptedOrderedLists(html, ['5', '5', '5'])).toBe(
      '<ol><li>One<ol><li>Sub</li></ol><p>Aside.</p></li><li>Two</li></ol>',
    )
  })

  it('gives bare text between the fragments a block of its own', () => {
    const html = '<ol><li>One</li></ol>loose text<ol><li>Two</li></ol>'
    expect(mergeInterruptedOrderedLists(html, ['5', '5'])).toBe(
      '<ol><li>One<p>loose text</p></li><li>Two</li></ol>',
    )
  })

  it('refuses a merge that would have nowhere to put the interruption', () => {
    // No item to fold "Aside." into: merging here would silently drop it.
    const html = '<ol>stray<ol><li>Nested</li></ol></ol><p>Aside.</p><ol><li>Two</li></ol>'
    expect(mergeInterruptedOrderedLists(html, ['5', '5'])).toBe(html)
  })

  it('joins a chain of interrupted fragments into one list', () => {
    const html = '<ol><li>a</li></ol><p>x</p><ol><li>b</li></ol><p>y</p><ol><li>c</li></ol>'
    expect(mergeInterruptedOrderedLists(html, ['1', '1', '1'])).toBe(
      '<ol><li>a<p>x</p></li><li>b<p>y</p></li><li>c</li></ol>',
    )
  })
})

describe('readDocx numbered lists interrupted by their own screenshots', () => {
  const itIfCorpus = existsSync(DOCS) ? it : it.skip

  itIfCorpus('numbers the corpus procedure 1..13 instead of restarting at every image', async () => {
    const bytes = await readFile(join(DOCS, 'context-menu-howto.docx'))
    const doc = await readDocx({ bytes })
    // Was 10 <ol> for 13 <li>, so eleven of the thirteen steps read "1.".
    expect(count(doc.html, /<ol[\s>]/g)).toBe(1)
    expect(count(doc.html, /<li[\s>]/g)).toBe(13)
    // Every screenshot is still there, and still between the right steps.
    expect(count(doc.html, /<img\b/g)).toBe(17)
    expect(doc.html).toContain('(I put them in that order, but you can do whatever order you want.)')
    expect(doc.html.indexOf('In that new group you will need:')).toBeLessThan(
      doc.html.indexOf('(I put them in that order'),
    )
    expect(doc.html.indexOf('(I put them in that order')).toBeLessThan(
      doc.html.indexOf('Still under the jobs tab'),
    )
  })

  itIfCorpus('leaves no block stranded between two list items, which no editor can model', async () => {
    const bytes = await readFile(join(DOCS, 'context-menu-howto.docx'))
    const doc = await readDocx({ bytes })
    expect(doc.html).not.toMatch(/<\/li>\s*<(?!li|\/)/)
    // Everything the merge produced survives the hub allowlist unchanged.
    expect(count(sanitizeToHub(doc.html), /<li[\s>]/g)).toBe(13)
  })

  it('merges an interrupted list but not a genuinely new one', async () => {
    const bytes = await buildListDocx(
      item(1, 'One') + item(1, 'Two') + para('Aside.') + item(1, 'Three') + para('Break.') + item(2, 'Fresh'),
    )
    const doc = await readDocx({ bytes })
    expect(count(doc.html, /<ol[\s>]/g)).toBe(2)
    expect(doc.html).toContain('<li>Two<p>Aside.</p></li><li>Three</li></ol>')
    expect(doc.html).toContain('<p>Break.</p><ol><li>Fresh</li></ol>')
  })

  it('does not fuse two bullet lists', async () => {
    const bytes = await buildListDocx(item(3, 'A') + para('Aside.') + item(3, 'B'))
    const doc = await readDocx({ bytes })
    expect(count(doc.html, /<ul[\s>]/g)).toBe(2)
  })
})

describe('keepTabsVisible', () => {
  it('turns a collapsing tab into a gap that survives', () => {
    expect(keepTabsVisible('<p>How to Catalogue\tPage 3</p>')).toBe(`<p>How to Catalogue${GAP}Page 3</p>`)
  })

  it('leaves markup alone, tabs inside attributes included', () => {
    expect(keepTabsVisible('<img alt="a\tb" src="x">')).toBe('<img alt="a\tb" src="x">')
  })

  it('is a no-op on html with no tabs', () => {
    expect(keepTabsVisible('<p>plain</p>')).toBe('<p>plain</p>')
  })
})

describe('readDocx tab stops', () => {
  const itIfCorpus = existsSync(DOCS) ? it : it.skip

  itIfCorpus('keeps a table-of-contents entry apart from its page number', async () => {
    const bytes = await readFile(join(DOCS, 'branch-notes-with-toc.docx'))
    const doc = await readDocx({ bytes })
    expect(doc.html).not.toContain('\t')
    expect(doc.html).toContain(`<p>How to Catalogue${GAP}Page 3</p>`)
    expect(doc.html).toContain(`<p>Reference Section${GAP}Page 20, 21, &amp; 22</p>`)
  })

  /**
   * The same entry from a two-paragraph document, so the writers — turndown in
   * particular — are not asked to walk three megabytes of embedded screenshots
   * for an assertion about four characters.
   */
  it('carries the separation into the css-less targets and the hub allowlist', async () => {
    const bytes = await buildListDocx(
      `<w:p><w:r><w:t xml:space="preserve">How to Catalogue</w:t></w:r><w:r><w:tab/></w:r>` +
        `<w:r><w:t xml:space="preserve">Page 3</w:t></w:r></w:p>`,
    )
    const doc = await readDocx({ bytes })
    expect(doc.html).toBe(`<p>How to Catalogue${GAP}Page 3</p>`)
    expect((await writeTxt(doc)).toString('utf8')).toContain(`How to Catalogue${GAP}Page 3`)
    expect((await writeMarkdown(doc)).toString('utf8')).toContain(`How to Catalogue${GAP}Page 3`)
    expect(sanitizeToHub(doc.html)).toContain(`How to Catalogue${GAP}Page 3`)
  })
})
