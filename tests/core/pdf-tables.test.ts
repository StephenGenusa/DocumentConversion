import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { extractPdfPageTexts, pdfTextToHub, readPdf } from '../../src/core/readers/pdf'
import { tableGrid } from '../../src/core/table-grid'

/**
 * Every test here does real pdfjs work, and the FIRST one in the process pays
 * for the cold start — the worker, the standard font data and the character
 * maps are all loaded on it. Warm, that is ~1.5 s; on a cold filesystem cache
 * it goes past the 5 s default and the suite fails for a reason that has
 * nothing to do with what it is testing. Heavy tests in this repo carry an
 * explicit timeout; this sets one for the file.
 */
vi.setConfig({ testTimeout: 60_000 })

/**
 * Ground truth for table detection has to come from geometry, and the only
 * geometry we can author here is a PDF drawn at fixed x/y. pdf-lib writes the
 * text-showing operators; pdfjs reads them back with the same transform matrix
 * a real exporter would produce.
 */
interface Draw {
  text: string
  x: number
  y: number
  size?: number
}

async function makePdf(pages: Draw[][]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const draws of pages) {
    const page = pdf.addPage([612, 792])
    for (const draw of draws) {
      page.drawText(draw.text, { x: draw.x, y: draw.y, size: draw.size ?? 11, font })
    }
  }
  return Buffer.from(await pdf.save())
}

/** Column origins taken from a real audit of an exported handbook page. */
const COLUMNS = [55, 139, 505]

function tableDraws(rows: string[][], top: number, step = 20): Draw[] {
  return rows.flatMap((row, r) =>
    row.flatMap((text, c) => (text === '' ? [] : [{ text, x: COLUMNS[c], y: top - r * step }])),
  )
}

const TABLE = [
  ['Code', 'Description', 'Group'],
  ['0302', 'Abrasives and grinding wheels', '03'],
  ['0318', 'Rope and twine', '03'],
  ['0304', 'Adhesives', '03'],
  ['0311', 'Anchors and guy hardware', '03'],
]

const INTRO = 'The table below lists the commodity codes used by the estimating team.'
const OUTRO = 'Codes are reviewed each March by the standards committee.'

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('readPdf recovers a table from column geometry', () => {
  it('extracts the grid a table was drawn as', async () => {
    const bytes = await makePdf([tableDraws(TABLE, 650)])
    const { html } = await readPdf({ bytes, filename: 'codes.pdf' })
    expect(tableGrid(html)).toEqual([TABLE])
  })

  it('emits real table markup, not a paragraph of run-together cells', async () => {
    const bytes = await makePdf([tableDraws(TABLE, 650)])
    const { html } = await readPdf({ bytes, filename: 'codes.pdf' })
    expect(html).toContain('<table>')
    expect(html).toContain('<tr>')
    expect(html).toContain('<td>')
    expect(html).not.toContain('<p>0302 Abrasives')
  })

  it('keeps prose above and below the table out of it', async () => {
    const bytes = await makePdf([
      [
        { text: 'Catalogue code reference', x: 55, y: 720, size: 16 },
        { text: INTRO, x: 55, y: 690 },
        ...tableDraws(TABLE, 640),
        { text: OUTRO, x: 55, y: 500 },
      ],
    ])
    const { html } = await readPdf({ bytes, filename: 'codes.pdf' })

    expect(tableGrid(html)).toEqual([TABLE])
    expect(html).toContain(INTRO)
    expect(html).toContain(OUTRO)
    // Region-level: the prose sits outside the table element, in reading order.
    const open = html.indexOf('<table>')
    const close = html.indexOf('</table>')
    expect(html.indexOf(INTRO)).toBeLessThan(open)
    expect(html.indexOf(OUTRO)).toBeGreaterThan(close)
  })

  it('writes each cell exactly once', async () => {
    const bytes = await makePdf([
      [
        { text: INTRO, x: 55, y: 690 },
        ...tableDraws(TABLE, 640),
        { text: OUTRO, x: 55, y: 500 },
      ],
    ])
    const { html } = await readPdf({ bytes, filename: 'codes.pdf' })
    for (const cell of ['Abrasives and grinding wheels', 'Anchors and guy hardware', 'Rope and twine']) {
      expect(occurrences(html, cell)).toBe(1)
    }
    expect(occurrences(html, INTRO)).toBe(1)
    expect(occurrences(html, OUTRO)).toBe(1)
  })

  it('decides per page, not per document', async () => {
    const prose = [
      'The handshake begins with a HELLO frame carrying the supported versions.',
      'The server answers with a WELCOME frame that pins the negotiated version.',
      'If the ranges do not intersect at all the server closes the connection.',
      'Flow control uses a credit scheme, and credits are granted in batches.',
    ].map((text, i) => ({ text, x: 55, y: 700 - i * 16 }))
    const bytes = await makePdf([prose, tableDraws(TABLE, 650), prose])
    const { html } = await readPdf({ bytes, filename: 'mixed.pdf' })

    expect(tableGrid(html)).toEqual([TABLE])
    expect(occurrences(html, '<table')).toBe(1)
    expect(html).toContain('credit scheme')
  })

  it('folds a wrapped cell into the row above instead of starting a row', async () => {
    const draws = [
      ...tableDraws(
        [
          ['Code', 'Description', 'Group'],
          ['0302', 'Abrasives and grinding', '03'],
        ],
        650,
      ),
      // Continuation of the description cell: same column, no new code.
      { text: 'wheels for metalwork', x: COLUMNS[1], y: 610 },
      ...tableDraws(
        [
          ['0318', 'Rope and twine', '03'],
          ['0304', 'Adhesives', '03'],
          ['0311', 'Anchors and guy hardware', '03'],
        ],
        590,
      ),
    ]
    const { html } = await readPdf({ bytes: await makePdf([draws]), filename: 'wrapped.pdf' })
    const [grid] = tableGrid(html)
    expect(grid).toEqual([
      ['Code', 'Description', 'Group'],
      ['0302', 'Abrasives and grinding wheels for metalwork', '03'],
      ['0318', 'Rope and twine', '03'],
      ['0304', 'Adhesives', '03'],
      ['0311', 'Anchors and guy hardware', '03'],
    ])
    expect(occurrences(html, 'wheels for metalwork')).toBe(1)
  })

  it('folds a cell that wrapped onto two continuation lines', async () => {
    // A dense spreadsheet print wraps a long cell more than once. One
    // continuation used to be tolerated inside a run and two ended it, which
    // dropped every remaining row of the table.
    const draws = [
      ...tableDraws([['Code', 'Description', 'Group'], ['0302', 'Abrasives and grinding', '03']], 650),
      { text: 'wheels, cutoff discs and', x: COLUMNS[1], y: 610 },
      { text: 'emery cloth for metalwork', x: COLUMNS[1], y: 590 },
      ...tableDraws(
        [
          ['0318', 'Rope and twine', '03'],
          ['0304', 'Adhesives', '03'],
          ['0311', 'Anchors and guy hardware', '03'],
        ],
        570,
      ),
    ]
    const { html } = await readPdf({ bytes: await makePdf([draws]), filename: 'wrapped2.pdf' })
    const [grid] = tableGrid(html)
    expect(grid).toEqual([
      ['Code', 'Description', 'Group'],
      ['0302', 'Abrasives and grinding wheels, cutoff discs and emery cloth for metalwork', '03'],
      ['0318', 'Rope and twine', '03'],
      ['0304', 'Adhesives', '03'],
      ['0311', 'Anchors and guy hardware', '03'],
    ])
  })

  it('keeps a column that a full cell almost touches', async () => {
    // Column origins measured at 11pt: these descriptions end 5-8pt short of
    // the Group column, inside the 0.9-line-height cell gap, so the first pass
    // reads "…discs 03" as one cell. The column origin is still visible on the
    // rows that do not fill their cell, and the region is re-split along it.
    const NARROW = [
      ['Code', 'Description', 'Group'],
      ['0302', 'Abrasives, grinding wheels and cutoff discs', '03'],
      ['0318', 'Rope, twine and banding material', '03'],
      ['0304', 'Adhesive, caulk, sealer and joint compound', '03'],
      ['0311', 'Anchors, guy hardware and pole line fittings', '03'],
    ]
    const draws = NARROW.flatMap((row, r) =>
      row.map((text, c) => ({ text, x: [55, 139, 357][c], y: 650 - r * 20 })),
    )
    const { html } = await readPdf({ bytes: await makePdf([draws]), filename: 'narrow.pdf' })
    expect(tableGrid(html)).toEqual([NARROW])
  })
})

describe('readPdf declines what is not a table', () => {
  it('leaves ordinary prose as paragraphs', async () => {
    const draws = [
      'This handbook provides you with information about the policies and practices that apply',
      'to the relationship between the company and its employees. Your employment is at-will,',
      'and is for an indefinite and unspecified term, and may be terminated at any time by you',
      'or the company, with or without cause and with or without any advance notice given.',
      'This handbook is not intended to be an employment contract and will not be recognized',
      'as one. It replaces and supersedes all previous personnel practices and policies.',
    ].map((text, i) => ({ text, x: 55, y: 700 - i * 16 }))
    const { html } = await readPdf({ bytes: await makePdf([draws]), filename: 'prose.pdf' })
    expect(html).not.toContain('<table')
    expect(html).toContain('at-will')
  })

  it('leaves a justified line with a wide word space alone', async () => {
    // A single stretched gap mid-paragraph is not a column boundary.
    const draws = [
      { text: 'may not be amended without the express written approval of the president.', x: 55, y: 700 },
      { text: 'notice.', x: 55, y: 684 },
      { text: 'All such changes will be communicated through official notices, and the', x: 93, y: 684 },
      { text: 'revised information may supersede or eliminate existing policies entirely.', x: 55, y: 668 },
      { text: 'Your manager is also a key resource concerning policies and procedures.', x: 55, y: 652 },
    ]
    const { html } = await readPdf({ bytes: await makePdf([draws]), filename: 'justified.pdf' })
    expect(html).not.toContain('<table')
  })

  it('leaves a bulleted list as prose, not a two-column table', async () => {
    const bullets = [
      'Horseplay will not be tolerated in the reading rooms at any time.',
      'Report unsafe or defective equipment to management immediately.',
      'Never use equipment unless trained and authorized to do so.',
      'Keep all work areas clean and free of clutter at all times.',
      'Turn off equipment or machinery whenever it is not in use.',
    ]
    const draws = bullets.flatMap((text, i) => [
      { text: '•', x: 67, y: 700 - i * 16 },
      { text, x: 85, y: 700 - i * 16 },
    ])
    const { html } = await readPdf({ bytes: await makePdf([draws]), filename: 'bullets.pdf' })
    expect(html).not.toContain('<table')
    expect(html).toContain('Horseplay')
  })

  it('leaves a lettered outline alone', async () => {
    const draws = ['first', 'second', 'third', 'fourth'].flatMap((word, i) => [
      { text: `${i + 1}.`, x: 67, y: 700 - i * 16 },
      { text: `The ${word} obligation of every employee on a customer site.`, x: 90, y: 700 - i * 16 },
    ])
    const { html } = await readPdf({ bytes: await makePdf([draws]), filename: 'outline.pdf' })
    expect(html).not.toContain('<table')
  })

  it('needs more than two rows to call something a table', async () => {
    const draws = tableDraws(TABLE.slice(0, 2), 650)
    const { html } = await readPdf({ bytes: await makePdf([draws]), filename: 'tiny.pdf' })
    expect(html).not.toContain('<table')
    expect(html).toContain('Abrasives and grinding wheels')
  })

  it('needs the columns to hold across rows, not on one line only', async () => {
    const draws = [
      { text: 'Employees receiving offensive messages over company equipment should', x: 55, y: 700 },
      { text: 'report those messages to their manager without any delay whatsoever.', x: 55, y: 684 },
      { text: 'Effective date', x: 55, y: 668 },
      { text: 'March 2024', x: 300, y: 668 },
      { text: 'The remainder of this section describes the reporting procedure itself.', x: 55, y: 652 },
    ]
    const { html } = await readPdf({ bytes: await makePdf([draws]), filename: 'oneline.pdf' })
    expect(html).not.toContain('<table')
  })
})

describe('table detection does not disturb the existing pdf paths', () => {
  it('leaves extractPdfPageTexts as one plain-text block per page', async () => {
    const bytes = await makePdf([tableDraws(TABLE, 650), [{ text: 'Second page body text.', x: 55, y: 700 }]])
    const texts = await extractPdfPageTexts({ bytes, filename: 'codes.pdf' })
    expect(texts).toHaveLength(2)
    expect(texts[0]).not.toContain('<')
    expect(texts[0].split('\n')).toEqual([
      'Code Description Group',
      '0302 Abrasives and grinding wheels 03',
      '0318 Rope and twine 03',
      '0304 Adhesives 03',
      '0311 Anchors and guy hardware 03',
    ])
    expect(texts[1]).toBe('Second page body text.')
  })

  it('builds no tables from OCR text, which carries no geometry', () => {
    const { html } = pdfTextToHub([
      ['Code Description Group', '0302 Abrasives 03', '0318 Rope 03', '0304 Adhesives 03'].join('\n'),
    ])
    expect(html).not.toContain('<table')
    expect(html).toContain('Abrasives')
  })

  it('still reads the plain sample fixture', async () => {
    const bytes = await readFile(join(__dirname, '../fixtures/sample.pdf'))
    const { html } = await readPdf({ bytes })
    expect(html).toContain('Hello PDF world')
    expect(html).not.toContain('<table')
  })
})

describe('the real handbook stays prose', () => {
  const handbook = join(__dirname, '../corpus/visitor-handbook.pdf')

  it('invents no tables across seventy prose-heavy pages', async () => {
    if (!existsSync(handbook)) return
    const bytes = await readFile(handbook)
    const { html } = await readPdf({ bytes, filename: 'visitor-handbook.pdf' })
    expect(occurrences(html, '<table')).toBe(0)
    // The bulleted safety rules are the shape most likely to be shredded.
    expect(html).toContain('Horseplay will not be tolerated')
    expect(html).toContain('Company History')
  }, 60_000)

  it('keeps running heads and folios out of the body', async () => {
    if (!existsSync(handbook)) return
    const bytes = await readFile(handbook)
    const { html } = await readPdf({ bytes, filename: 'handbook.pdf' })
    expect(occurrences(html, 'EMPLOYEE HANDBOOK | EXAMPLECORP ENGINEERING &amp; CONSULTING')).toBe(0)
  }, 60_000)
})