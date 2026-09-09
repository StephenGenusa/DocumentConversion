import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { extractPdfPageLines, readPdf } from '../../src/core/readers/pdf'
import { loadPdfjs } from '../../src/core/pdfjs-loader'

// pdfjs's first load can outrun the 5s default when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 })

/**
 * Letter-spaced headings: recovering the word gaps the page actually drew.
 *
 * The handbook's display headings are set with a space typed between every
 * letter and TWO between words, which is how "T A B L E  O F  C O N T E N T S"
 * reads on paper. pdfjs collapses any run of whitespace glyphs to a single
 * space — `saveLastChar` pushes exactly one " " however many space glyphs it
 * skipped — so `getTextContent` hands back
 *
 *   "T A B L E O F C O N T E N T S"
 *
 * with every gap the same width and the word boundaries gone. The evidence is
 * still in the page's operator list, where the glyphs are shown one at a time
 * and the double spaces survive; that is where the boundaries come back from.
 *
 * The bar for the fix is that ordinary prose is untouched, which the last
 * describe here proves line by line over all seventy pages.
 */

const HANDBOOK = join(__dirname, '../corpus/visitor-handbook.pdf')

/** A recovered word gap is drawn no-break, so HTML cannot squeeze it away again. */
const NB = '\u00A0'

async function makePdf(draws: { text: string; x: number; y: number; size?: number }[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])
  for (const draw of draws) page.drawText(draw.text, { x: draw.x, y: draw.y, size: draw.size ?? 11, font })
  return Buffer.from(await pdf.save())
}

describe('a letter-spaced heading keeps its word gaps', () => {
  it('parts the words a double space parted', async () => {
    const bytes = await makePdf([{ text: 'T A B L E  O F  C O N T E N T S', x: 100, y: 700, size: 18 }])
    const [lines] = await extractPdfPageLines({ bytes, filename: 'spaced.pdf' })
    expect(lines[0].text).toBe(`T A B L E${NB}${NB}O F${NB}${NB}C O N T E N T S`)
  })

  it('leaves a single-word letter-spaced heading exactly as it was', async () => {
    const bytes = await makePdf([{ text: 'I N T R O D U C T I O N', x: 100, y: 700, size: 18 }])
    const [lines] = await extractPdfPageLines({ bytes, filename: 'one-word.pdf' })
    expect(lines[0].text).toBe('I N T R O D U C T I O N')
  })

  it('measures the gap against the run itself, not a fixed number of points', async () => {
    // The same shape at a third of the type size: the gaps are a third as wide
    // in points, and the boundaries still have to land in the same places.
    const bytes = await makePdf([{ text: 'W I D E  G A P S', x: 100, y: 700, size: 6 }])
    const [lines] = await extractPdfPageLines({ bytes, filename: 'small.pdf' })
    expect(lines[0].text).toBe(`W I D E${NB}${NB}G A P S`)
  })

  it('parts a heading whose words are parted by three spaces, not two', async () => {
    const bytes = await makePdf([{ text: 'O N E   T W O', x: 100, y: 700, size: 18 }])
    const [lines] = await extractPdfPageLines({ bytes, filename: 'three.pdf' })
    expect(lines[0].text).toBe(`O N E${NB}${NB}${NB}T W O`)
  })

  it('leaves prose that merely contains a few spaced initials alone', async () => {
    const bytes = await makePdf([
      { text: 'The grade A B and C classifications apply to every welded joint here.', x: 55, y: 700 },
    ])
    const [lines] = await extractPdfPageLines({ bytes, filename: 'prose.pdf' })
    expect(lines[0].text).toBe('The grade A B and C classifications apply to every welded joint here.')
  })
})

describe('the handbook headings', () => {
  it('parts TABLE OF CONTENTS into three words', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const pages = await extractPdfPageLines({ bytes, filename: 'handbook.pdf' })
    const heading = pages[2].find((l) => l.text.startsWith('T A B L E'))
    expect(heading, 'the contents heading').toBeDefined()
    expect(heading!.text).toBe(`T A B L E${NB}${NB}O F${NB}${NB}C O N T E N T S`)
  }, 120_000)

  it('parts GENERAL INFORMATION into two words', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const pages = await extractPdfPageLines({ bytes, filename: 'handbook.pdf' })
    // Page 6: Mission, Company History and Code of Conduct each get their
    // own page ahead of it (see build-pdf-handbook.mjs).
    const heading = pages[6].find((l) => l.text.startsWith('G E N E R A L'))
    expect(heading, 'the GENERAL INFORMATION heading').toBeDefined()
    // "ON" is glued in the source itself: somebody typed the spaces by hand.
    expect(heading!.text).toBe(`G E N E R A L${NB}${NB}I N F O R M A T I ON`)
  }, 120_000)

  it('still writes INTRODUCTION as the one word it is', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const { html } = await readPdf({ bytes, filename: 'handbook.pdf' })
    expect(html).toContain('<h2>I N T R O D U C T I O N</h2>')
  }, 120_000)
})

/**
 * The pre-fix line text, rebuilt from pdfjs exactly as `itemsToLines` built it
 * before: concatenate every item's string, cut at hasEOL, squeeze runs of
 * spaces. This is the "before" half of the proof below.
 */
async function linesBeforeTheFix(bytes: Buffer): Promise<string[][]> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
  const pages: string[][] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const lines: string[] = []
    let text = ''
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      if (typeof item.str !== 'string') continue
      text += item.str
      if (item.hasEOL) {
        const trimmed = text.replace(/[ \t]+/g, ' ').trim()
        if (trimmed) lines.push(trimmed)
        text = ''
      }
    }
    const tail = text.replace(/[ \t]+/g, ' ').trim()
    if (tail) lines.push(tail)
    pages.push(lines)
    page.cleanup()
  }
  return pages
}

describe('ordinary prose is untouched', () => {
  it('widens a gap and does nothing else, on two lines in seventy pages', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const before = await linesBeforeTheFix(bytes)
    const after = await extractPdfPageLines({ bytes, filename: 'handbook.pdf' })

    expect(after).toHaveLength(before.length)
    const changed: string[] = []
    for (let p = 0; p < before.length; p++) {
      expect(after[p], `page ${p} line count`).toHaveLength(before[p].length)
      for (let i = 0; i < before[p].length; i++) {
        const now = after[p][i].text
        // Nothing is removed, reordered or re-cased: widening a gap is the only
        // edit, so squeezing the widened gaps back reproduces the old text
        // character for character.
        expect(now.replace(/\u00A0/g, ' ').replace(/ +/g, ' '), `page ${p} line ${i}`).toBe(before[p][i])
        if (now !== before[p][i]) changed.push(now)
      }
    }
    expect(changed).toEqual([
      `T A B L E${NB}${NB}O F${NB}${NB}C O N T E N T S`,
      `G E N E R A L${NB}${NB}I N F O R M A T I ON`,
    ])
  }, 180_000)

  it('leaves every ordinary handbook paragraph as it was', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const { html } = await readPdf({ bytes, filename: 'handbook.pdf' })
    for (const paragraph of [
      'Thank you for joining Elmwood Libraries, the library service',
      'Elmwood Libraries strives to provide a welcoming environment in which members and volunteers',
      'Horseplay will not be tolerated',
    ]) {
      expect(html, paragraph).toContain(paragraph)
    }
    // No paragraph anywhere picked up a widened gap.
    const paragraphs = html.match(/<p>[^<]*<\/p>/g) ?? []
    expect(paragraphs.filter((p) => p.includes(NB))).toEqual([])
  }, 120_000)
})
