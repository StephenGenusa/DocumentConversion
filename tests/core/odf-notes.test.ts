import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { odfText } from '../../src/core/readers/odf-common'
import { readOdt } from '../../src/core/readers/odt'
import { readOdp } from '../../src/core/readers/odp'
import { writeTxt } from '../../src/core/writers/txt'
import { writeMarkdown } from '../../src/core/writers/md'

/**
 * D8: notes and annotations were walked as ordinary inline text, so the
 * citation mark fused to the preceding word and the note body — or a
 * reviewer's private comment, with its author and timestamp — was spliced
 * into the middle of the sentence.
 */

function note(citation: string, body: string, cls = 'footnote'): string {
  return (
    `<text:note text:id="ftn1" text:note-class="${cls}">` +
    `<text:note-citation>${citation}</text:note-citation>` +
    `<text:note-body><text:p>${body}</text:p></text:note-body>` +
    `</text:note>`
  )
}

function annotation(creator: string, date: string, body: string): string {
  return (
    `<office:annotation office:name="__A1__">` +
    `<dc:creator>${creator}</dc:creator><dc:date>${date}</dc:date>` +
    `<text:p>${body}</text:p></office:annotation>` +
    `<office:annotation-end office:name="__A1__"/>`
  )
}

const ODF_NS = 'xmlns:office="o" xmlns:text="t" xmlns:dc="d" xmlns:table="tb"'

async function odt(body: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
  zip.file(
    'content.xml',
    `<?xml version="1.0"?><office:document-content ${ODF_NS}>` +
      `<office:body><office:text>${body}</office:text></office:body></office:document-content>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}

describe('odfText footnotes and endnotes', () => {
  it('keeps the citation mark inline without fusing it to the preceding word', () => {
    const text = odfText(`The catalogue record${note('1', 'See appendix B for ratings.')} is rated for 400 V.`)
    expect(text).toContain('The catalogue record [1] is rated for 400 V.')
    expect(text).not.toContain('catalogue record1')
    expect(text).not.toContain('catalogue record [1]See')
  })

  it('moves the note body out of the sentence to the end of the block', () => {
    const text = odfText(`The catalogue record${note('1', 'See appendix B for ratings.')} is rated for 400 V.`)
    expect(text).toBe('The catalogue record [1] is rated for 400 V. [1] See appendix B for ratings.')
  })

  it('never splices a note body between two words', () => {
    const text = odfText(`alpha${note('2', 'aside')}beta`)
    // The mark separates them; the body is not between them.
    expect(text).toBe('alpha [2] beta [2] aside')
    expect(text).not.toContain('alphabeta')
    expect(text).not.toContain('alpha2aside')
  })

  it('keeps several notes in one paragraph in order', () => {
    const text = odfText(`One${note('1', 'first body')} and two${note('2', 'second body')} end.`)
    expect(text).toBe('One [1] and two [2] end. [1] first body [2] second body')
    expect(text.indexOf('[1] first body')).toBeLessThan(text.indexOf('[2] second body'))
  })

  it('treats an endnote the same as a footnote', () => {
    const text = odfText(`Claim${note('i', 'Endnote body.', 'endnote')} holds.`)
    expect(text).toBe('Claim [i] holds. [i] Endnote body.')
  })

  it('keeps a symbol citation and a multi-paragraph body', () => {
    const xml =
      `Text<text:note text:note-class="footnote"><text:note-citation>*</text:note-citation>` +
      `<text:note-body><text:p>First line.</text:p><text:p>Second line.</text:p></text:note-body>` +
      `</text:note> after.`
    expect(odfText(xml)).toBe('Text [*] after. [*] First line. Second line.')
  })

  it('falls back to a mark when the citation is missing', () => {
    const xml =
      `Text<text:note text:note-class="footnote">` +
      `<text:note-body><text:p>Orphan body.</text:p></text:note-body></text:note> after.`
    const text = odfText(xml)
    expect(text).toBe('Text [*] after. [*] Orphan body.')
    expect(text).not.toContain('TextOrphan')
  })

  it('keeps the mark when the body is empty', () => {
    const xml = `Text<text:note text:note-class="footnote"><text:note-citation>3</text:note-citation></text:note> after.`
    expect(odfText(xml)).toBe('Text [3] after.')
  })

  it('does not let a note body swallow a tab stop in the running text', () => {
    const gap = ' '.repeat(4)
    const text = odfText(`Chapter One${note('1', 'note body')}<text:tab/>Page 3`)
    expect(text).toBe(`Chapter One [1]${gap}Page 3 [1] note body`)
  })
})

describe('odfText annotations', () => {
  it('drops the comment rather than splicing it into the sentence', () => {
    const text = odfText(`Price is ${annotation('Bob', '2026-02-03T10:00:00', 'Check this with finance')}ten dollars.`)
    expect(text).toBe('Price is ten dollars.')
  })

  it('never leaks the commenter or the comment date as prose', () => {
    const text = odfText(`Price is ${annotation('Bob', '2026-02-03T10:00:00', 'Check this with finance')}ten dollars.`)
    expect(text).not.toContain('Bob')
    expect(text).not.toContain('2026-02-03')
    expect(text).not.toContain('finance')
  })

  it('separates the words either side of a dropped comment', () => {
    const text = odfText(`before${annotation('Ann', '2026-01-01', 'private')}after`)
    expect(text).toBe('before after')
    expect(text).not.toContain('beforeafter')
  })

  it('drops a lone annotation-end milestone without fusing its neighbours', () => {
    expect(odfText('left<office:annotation-end office:name="__A1__"/>right')).toBe('left right')
    expect(odfText('left<office:annotation-end office:name="__A1__"></office:annotation-end>right')).toBe('left right')
  })

  it('drops a comment that itself contains a note', () => {
    const xml = `Body <office:annotation><dc:creator>Bob</dc:creator><text:p>see${note('9', 'hidden')}</text:p></office:annotation>tail`
    const text = odfText(xml)
    expect(text).toBe('Body tail')
    expect(text).not.toContain('hidden')
    expect(text).not.toContain('[9]')
  })

  it('keeps a real note that follows a dropped comment', () => {
    const xml = `Start ${annotation('Bob', '2026-01-01', 'private')}rest${note('1', 'kept body')} end.`
    expect(odfText(xml)).toBe('Start rest [1] end. [1] kept body')
  })
})

describe('readOdt with notes and comments', () => {
  it('renders a footnote as inline mark plus trailing body, and drops the comment', async () => {
    const bytes = await odt(
      `<text:p>The catalogue record${note('1', 'See appendix B for ratings.')} is rated for 400 V.</text:p>` +
        `<text:p>Price is ${annotation('Bob', '2026-02-03T10:00:00', 'Check this with finance')}ten dollars.</text:p>`,
    )
    const hub = await readOdt({ bytes, filename: 'notes.odt' })
    expect(hub.html).toContain('<p>The catalogue record [1] is rated for 400 V. [1] See appendix B for ratings.</p>')
    expect(hub.html).toContain('<p>Price is ten dollars.</p>')
    expect(hub.html).not.toContain('Bob')
    expect(hub.html).not.toContain('finance')
  })

  it('carries the same shape into the CSS-less targets', async () => {
    const bytes = await odt(
      `<text:p>The catalogue record${note('1', 'See appendix B for ratings.')} is rated for 400 V.</text:p>` +
        `<text:p>Price is ${annotation('Bob', '2026-02-03T10:00:00', 'Check this with finance')}ten dollars.</text:p>`,
    )
    const hub = await readOdt({ bytes, filename: 'notes.odt' })

    const txt = (await writeTxt(hub)).toString('utf8')
    expect(txt).toContain('The catalogue record [1] is rated for 400 V. [1] See appendix B for ratings.')
    expect(txt).toContain('Price is ten dollars.')
    expect(txt).not.toContain('Bob')
    expect(txt).not.toContain('finance')

    // The md writer escapes the brackets so the mark can never be read as a
    // link reference; `\[1\]` renders as a literal "[1]".
    const md = (await writeMarkdown(hub)).toString('utf8')
    expect(md).toContain('The catalogue record \\[1\\] is rated for 400 V. \\[1\\] See appendix B for ratings.')
    expect(md).toContain('Price is ten dollars.')
    expect(md).not.toContain('Bob')
    expect(md).not.toContain('finance')
    expect(md).not.toMatch(/catalogue record\S*1See/)
  })

  it('handles notes and comments inside headings and list items', async () => {
    const bytes = await odt(
      `<text:h text:outline-level="1">Ratings${note('1', 'heading note')}</text:h>` +
        `<text:list><text:list-item><text:p>Item${note('2', 'item note')} text</text:p></text:list-item></text:list>` +
        `<text:p>Plain ${annotation('Bob', '2026-01-01', 'secret')}text</text:p>`,
    )
    const hub = await readOdt({ bytes, filename: 'mixed.odt' })
    expect(hub.html).toContain('<h1>Ratings [1] [1] heading note</h1>')
    expect(hub.html).toContain('<li>Item [2] text [2] item note</li>')
    expect(hub.html).toContain('<p>Plain text</p>')
    expect(hub.html).not.toContain('secret')
    expect(hub.html).not.toContain('Bob')
    expect(hub.html).not.toContain('Ratings1')
    expect(hub.html).not.toContain('Item2')
  })

  /**
   * `odfRowCells` in odt.ts carves each cell out with a lazy
   * `<text:p\b[^>]*>([\s\S]*?)</text:p>` regex, which closes on the FIRST
   * `</text:p>` — including one nested inside a note body. A cell holding a
   * note reached `odfText` already truncated and lost its trailing " value".
   * SUPERSEDED: odt.ts now scans elements rather than matching lazily, so the
   * whole cell survives and this asserts the complete text. The note body itself is still recovered, nothing fuses, and the
   * comment case is whole because comments are stripped before that regex runs.
   */
  it('does not fuse or leak in a table cell, and no longer truncates', async () => {
    const bytes = await odt(
      `<table:table><table:table-row>` +
        `<table:table-cell><text:p>Cell${note('3', 'cell note')} value</text:p></table:table-cell>` +
        `<table:table-cell><text:p>Plain ${annotation('Bob', '2026-01-01', 'secret')}text</text:p></table:table-cell>` +
        `</table:table-row></table:table>`,
    )
    const hub = await readOdt({ bytes, filename: 'cells.odt' })
    expect(hub.html).toContain('<td>Cell [3] value [3] cell note</td>')
    expect(hub.html).not.toContain('Cell3')
    expect(hub.html).toContain('<td>Plain text</td>')
    expect(hub.html).not.toContain('secret')
    expect(hub.html).not.toContain('Bob')
    expect(hub.html).not.toContain('2026-01-01')
  })
})

/**
 * In a presentation an `<office:annotation>` is a child of `<draw:page>`, not
 * of a paragraph, so the slide scan in odp.ts meets the comment's `<text:p>`
 * directly and — it being the first text on the page — made it the slide's
 * heading. That is why comments are stripped in `loadOdfContent` as well as in
 * `odfText`: at that door no ODF reader can miss them.
 */
describe('readOdp with slide comments', () => {
  async function odp(page: string): Promise<Buffer> {
    const zip = new JSZip()
    zip.file('mimetype', 'application/vnd.oasis.opendocument.presentation')
    zip.file(
      'content.xml',
      `<?xml version="1.0"?><office:document-content ${ODF_NS} xmlns:draw="dr" xmlns:svg="s">` +
        `<office:body><office:presentation>${page}</office:presentation></office:body></office:document-content>`,
    )
    return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
  }

  it('never promotes a slide comment to the slide title', async () => {
    const bytes = await odp(
      `<draw:page draw:name="Slide 1">` +
        `<office:annotation svg:x="1cm" svg:y="1cm"><dc:creator>Bob</dc:creator>` +
        `<dc:date>2026-01-01T09:00:00</dc:date><text:p>internal only, do not ship</text:p></office:annotation>` +
        `<draw:frame><draw:text-box><text:p>Quarterly Roadmap</text:p>` +
        `<text:p>Gateway ships Q3</text:p></draw:text-box></draw:frame></draw:page>`,
    )
    const hub = await readOdp({ bytes, filename: 'deck.odp' })
    expect(hub.html).toContain('<h2>Quarterly Roadmap</h2>')
    expect(hub.html).toContain('<p>Gateway ships Q3</p>')
    expect(hub.html).not.toContain('internal only')
    expect(hub.html).not.toContain('Bob')
    expect(hub.html).not.toContain('2026-01-01')
  })

  it('keeps a footnote on a slide and drops a comment inside the same paragraph', async () => {
    const bytes = await odp(
      `<draw:page draw:name="Slide 1"><draw:frame><draw:text-box>` +
        `<text:p>Ratings</text:p>` +
        `<text:p>Rated${note('1', 'per appendix B')} at 400 V ` +
        `${annotation('Bob', '2026-01-01', 'double-check')}today.</text:p>` +
        `</draw:text-box></draw:frame></draw:page>`,
    )
    const hub = await readOdp({ bytes, filename: 'deck.odp' })
    expect(hub.html).toContain('<h2>Ratings</h2>')
    expect(hub.html).toContain('<p>Rated [1] at 400 V today. [1] per appendix B</p>')
    expect(hub.html).not.toContain('Rated1')
    expect(hub.html).not.toContain('double-check')
    expect(hub.html).not.toContain('Bob')
  })
})
