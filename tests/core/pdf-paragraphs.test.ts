import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { extractPdfPageLines, readPdf } from '../../src/core/readers/pdf'

/**
 * Paragraph and heading structure on a real 70-page document.
 *
 * pdfjs ends a visual line with a standalone BLANK item that carries
 * `hasEOL: true` — and whose transform is already the origin of the line that
 * FOLLOWS it:
 *
 *   {"s":"customer satisfaction.", "eol":false, "y":596.87, "h":10.98}
 *   {"s":"",                       "eol":true,  "y":569.93, "h":0}
 *   {"s":"Elmwood strives to …",   "eol":true,  "y":569.93, "h":10.98}
 *
 * Take a line's `y` from that marker and every recorded baseline is the NEXT
 * line's, so every paragraph gap is seen one line too early: the last line of
 * each paragraph is glued to the front of the next, and a heading's gap
 * collapses to zero so it is never split out at all. A line's geometry has to
 * come from its own glyphs.
 */

const HANDBOOK = join(__dirname, '../corpus/visitor-handbook.pdf')

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** Geometry is the only ground truth here, so the page is drawn at fixed x/y. */
async function makePdf(draws: { text: string; x: number; y: number; size?: number }[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])
  for (const draw of draws) page.drawText(draw.text, { x: draw.x, y: draw.y, size: draw.size ?? 11, font })
  return Buffer.from(await pdf.save())
}

describe('a pdf line takes its geometry from its own glyphs', () => {
  it('does not adopt the baseline of the line below it', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const pages = await extractPdfPageLines({ bytes, filename: 'handbook.pdf' })
    const lines = pages[1]

    // Matched on how the paragraph ENDS, not on which word happens to begin its
    // last line - that depends on where the text wraps, which changes whenever
    // the fixture's prose is edited.
    const tail = lines.find((l) => l.text.trimEnd().endsWith('satisfaction.'))
    const next = lines.find((l) => l.text.startsWith('Elmwood Libraries strives to provide'))
    expect(tail, 'the tail line of paragraph one').toBeDefined()
    expect(next, 'the first line of paragraph two').toBeDefined()
    // Its own baseline, not the 552.00 of the line beneath it.
    expect(tail!.y).toBeCloseTo(580.0, 1)
    expect(next!.y).toBeCloseTo(552.0, 1)
    // Which is what makes the paragraph gap visible at the right place.
    expect(tail!.y - next!.y).toBeGreaterThan(20)
  }, 60_000)

  it('keeps the heading line at its own baseline and glyph height', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const pages = await extractPdfPageLines({ bytes, filename: 'handbook.pdf' })
    const heading = pages[1].find((l) => l.text.startsWith('I N T R O D U C T I O N'))
    expect(heading, 'the centred INTRODUCTION heading').toBeDefined()
    expect(heading!.y).toBeCloseTo(706.0, 1)
    expect(heading!.height).toBeCloseTo(18, 1)
  }, 60_000)
})

describe('handbook paragraphs and headings', () => {
  it('keeps a paragraph whole instead of breaking one line early', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const { html } = await readPdf({ bytes, filename: 'handbook.pdf' })
    expect(html).toContain('resulting in outstanding service and customer satisfaction.')
    // The tail must not open a paragraph of its own.
    expect(html).not.toContain('<p>satisfaction.')
    expect(html).toContain('<p>Elmwood Libraries strives to provide a welcoming environment')
  }, 60_000)

  it('lifts a large centred heading out of the prose that follows it', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const { html } = await readPdf({ bytes, filename: 'handbook.pdf' })
    expect(html).toContain('<h2>I N T R O D U C T I O N</h2>')
    expect(html).not.toContain('<p>I N T R O D U C T I O N Thank you')
  }, 60_000)

  it('recovers the section headings instead of burying them in paragraphs', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const { html } = await readPdf({ bytes, filename: 'handbook.pdf' })
    for (const heading of ['Mission', 'Company History', 'Code of Conduct']) {
      expect(html, heading).toContain(`<h2>${heading}</h2>`)
      expect(html, heading).not.toContain(`<p>${heading} `)
    }
    // Real handbooks run dozens of headings deep; a handful for hundreds of
    // paragraphs was the whole (broken) document before this fix.
    expect(count(html, '<h2>')).toBeGreaterThanOrEqual(40)
  }, 60_000)
})

describe('a heading set hard against its own body text', () => {
  const BODY = [
    'Elmwood Libraries provides the highest quality of service to its members with a',
    'commitment to excellence and integrity. We serve our customers with professionalism,',
    'and we respect each person we happen to meet along the way.',
  ]

  it('is still a heading when no gap separates it from the paragraph below', async () => {
    // Every gap on this page is the same 16pt, so nothing flushes the heading
    // into a block of its own — only its glyph height gives it away.
    const draws = [
      { text: 'Mission', x: 55, y: 700, size: 18 },
      ...BODY.map((text, i) => ({ text, x: 55, y: 684 - i * 16 })),
    ]
    const { html } = await readPdf({ bytes: await makePdf(draws), filename: 'tight-heading.pdf' })
    expect(html).toContain('<h2>Mission</h2>')
    expect(html).toContain('<p>Elmwood Libraries provides')
    expect(html).not.toContain('<p>Mission Elmwood')
  })

  it('does not promote the first line of an ordinary paragraph', async () => {
    const draws = BODY.map((text, i) => ({ text, x: 55, y: 700 - i * 16 }))
    const { html } = await readPdf({ bytes: await makePdf(draws), filename: 'plain.pdf' })
    expect(html).not.toContain('<h2>')
  })
})

/**
 * Diff-review follow-up. A line ending in `-` is joined to the next with no
 * space, which is right for a hyphenated word broken at the margin ("con-" /
 * "tinued") and wrong for a hyphen that is punctuation: "10 -" / "20" became
 * "10 -20", and "see Chapter 3 -" / "the appendix" fused into "3 -the". Only a
 * hyphen glued to a letter is a word break.
 */
describe('pdf hyphen joins', () => {
  it('rejoins a word broken at a hyphen without a space, keeping the hyphen', async () => {
    // The hyphen stays: dropping it is right for "con-tinued" and wrong for
    // "self-" / "aware", and the reader cannot tell the two apart. Not losing
    // a character beats a guess.
    const bytes = await makePdf([
      { text: 'The report was con-', x: 72, y: 700 },
      { text: 'tinued on the next page.', x: 72, y: 686 },
    ])
    const { html } = await readPdf({ bytes })
    expect(html).toContain('con-tinued on the next page.')
  }, 60_000)

  it('keeps a space after a hyphen that stands alone as punctuation', async () => {
    const bytes = await makePdf([
      { text: 'Values range from 10 -', x: 72, y: 700 },
      { text: '20 in the sample.', x: 72, y: 686 },
    ])
    const { html } = await readPdf({ bytes })
    expect(html).toContain('10 - 20 in the sample.')
    expect(html).not.toContain('-20')
  }, 60_000)
})
