import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readPdf } from '../../src/core/readers/pdf'
import { writeTxt } from '../../src/core/writers/txt'
import { writeMarkdown } from '../../src/core/writers/md'

/**
 * Table-of-contents leader dots.
 *
 * A contents page is a column of "Title ......... 12" lines, and the dot run is
 * real text in the PDF. Run through the ordinary paragraph path, the whole page
 * came out as one block:
 *
 *   General Information Mission ................... 5 Company History ...... 5
 *
 * which reads as though each page number belongs to the entry that FOLLOWS it,
 * and is unusable in every target. So a contents entry is recognised by its
 * shape — text, a run of leader dots, a page number, end of line — the dots are
 * dropped, and the entries of a page become one list, so nothing can be glued
 * to anything.
 *
 * A list, not a two-column table: the entry has to survive to txt and md, where
 * it does, and a contents page is navigation rather than the document's data —
 * so the handbook's "no invented tables" property (see pdf-tables.test.ts) also
 * stays measurable as a plain count of zero.
 */

const HANDBOOK = join(__dirname, '../corpus/visitor-handbook.pdf')

interface Draw {
  text: string
  x: number
  y: number
  size?: number
}

async function makePdf(draws: Draw[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])
  for (const draw of draws) page.drawText(draw.text, { x: draw.x, y: draw.y, size: draw.size ?? 11, font })
  return Buffer.from(await pdf.save())
}

const dots = (n: number): string => '.'.repeat(n)

function contentsPage(entries: [string, number][]): Draw[] {
  return entries.map(([title, page], i) => ({
    text: `${title} ${dots(60 - title.length)} ${page}`,
    x: 90,
    y: 700 - i * 16,
  }))
}

describe('a contents entry loses its leader dots', () => {
  const ENTRIES: [string, number][] = [
    ['Mission', 5],
    ['Company History', 5],
    ['Code of Conduct', 5],
    ['General Safety Rules', 11],
  ]

  it('reads as a title and a page number, one entry per block', async () => {
    const { html } = await readPdf({ bytes: await makePdf(contentsPage(ENTRIES)), filename: 'toc.pdf' })
    expect(html).toContain('<li>Mission — 5</li>')
    expect(html).toContain('<li>Company History — 5</li>')
    expect(html).toContain('<li>General Safety Rules — 11</li>')
    expect(html).not.toContain('....')
  })

  it('never glues one entry to the next', async () => {
    const { html } = await readPdf({ bytes: await makePdf(contentsPage(ENTRIES)), filename: 'toc.pdf' })
    expect(html).not.toMatch(/Mission[^<]*Company History/)
  })
})

describe('what must not be mistaken for a contents entry', () => {
  it('leaves a fill-in-the-blank form line alone', async () => {
    const draws = [
      { text: `Employee name ${dots(40)} Date ${dots(20)}`, x: 55, y: 700 },
      { text: `Supervisor ${dots(40)} Date ${dots(20)}`, x: 55, y: 680 },
      { text: `Witness ${dots(40)} Date ${dots(20)}`, x: 55, y: 660 },
    ]
    const { html } = await readPdf({ bytes: await makePdf(draws), filename: 'form.pdf' })
    expect(html).toContain('Employee name')
    expect(html).toContain('....')
  })

  it('leaves an ellipsis in running prose alone', async () => {
    const draws = [
      'The policy reads "employees shall ... report any injury within 24 hours"',
      'and the remainder of the clause is quoted in full in Appendix 3 below.',
      'Nothing in this paragraph is a heading, a table, or a contents entry.',
    ].map((text, i) => ({ text, x: 55, y: 700 - i * 16 }))
    const { html } = await readPdf({ bytes: await makePdf(draws), filename: 'ellipsis.pdf' })
    expect(html).toContain('shall ... report any injury')
    expect(html).not.toContain('—')
  })

  it('needs a run of entries, not one stray line that ends in a number', async () => {
    const draws = [
      { text: 'The signature block below is completed by the branch manager only.', x: 55, y: 700 },
      { text: `Signed ${dots(40)} 2024`, x: 55, y: 680 },
      { text: 'Retain the completed form in the employee file for seven years.', x: 55, y: 660 },
    ]
    const { html } = await readPdf({ bytes: await makePdf(draws), filename: 'stray.pdf' })
    expect(html).toContain('....')
    expect(html).not.toContain('Signed — 2024')
  })

  it('leaves a document with no contents page byte-identical', async () => {
    const draws = [
      'This handbook describes the policies and practices that apply to you.',
      'Your employment is at-will and may be terminated at any time by either',
      'party, with or without cause and with or without any advance notice.',
    ].map((text, i) => ({ text, x: 55, y: 700 - i * 16 }))
    const { html } = await readPdf({ bytes: await makePdf(draws), filename: 'plain.pdf' })
    expect(html).toBe(
      '<p>This handbook describes the policies and practices that apply to you. ' +
        'Your employment is at-will and may be terminated at any time by either ' +
        'party, with or without cause and with or without any advance notice.</p>',
    )
  })
})

describe('the handbook contents page', () => {
  it('is legible instead of one run-on paragraph', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const { html } = await readPdf({ bytes, filename: 'handbook.pdf' })
    expect(html).toContain('<li>Mission — 5</li>')
    expect(html).toContain('<li>Company History — 5</li>')
    expect(html).toContain('<li>Code of Conduct — 5</li>')
    expect(html).toContain('<li>Worker’s Compensation — 14</li>')
    expect(html).toContain('<li>Safety &amp; Security — 12</li>')
    expect(html).toContain('<li>Americans with Disabilities Act (ADA)/Reasonable Accommodations — 15</li>')
    // Not a dot of the leader survives anywhere in the document.
    expect(html).not.toContain('.....')
    expect(html).not.toMatch(/Mission[^<]*Company History/)
  }, 120_000)

  it('survives to txt, which has no CSS to lean on', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const hub = await readPdf({ bytes, filename: 'handbook.pdf' })
    const txt = (await writeTxt(hub)).toString('utf8')
    expect(txt).toContain('Mission — 5')
    expect(txt).toContain('Company History — 5')
    expect(txt).not.toContain('.....')
    // Each entry on its own line.
    expect(txt).toMatch(/Mission — 5\n/)
  }, 120_000)

  it('survives to markdown', async () => {
    if (!existsSync(HANDBOOK)) return
    const bytes = await readFile(HANDBOOK)
    const hub = await readPdf({ bytes, filename: 'handbook.pdf' })
    const md = (await writeMarkdown(hub)).toString('utf8')
    expect(md).toContain('Mission — 5')
    expect(md).toContain('Code of Conduct — 5')
    expect(md).not.toContain('.....')
  }, 120_000)
})
