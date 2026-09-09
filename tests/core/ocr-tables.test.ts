import { describe, it, expect, afterAll, vi } from 'vitest'

// tesseract's worker_threads/wasm need a moment to wind down after
// terminate(); exiting the vitest worker immediately races them.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 750)))

// conversion.ts is main-process code; nothing it needs for the OCR path is
// actually Electron, so a stub is enough to exercise ocrPagesToHub in-process.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => { throw new Error('not used in these tests') } },
}))

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  gridFromWords,
  ocrImage,
  ocrPdf,
  MIN_TABLE_CONFIDENCE,
  type OcrWord,
} from '../../src/ocr/pipeline'
import { converter, ocrPagesToHub } from '../../src/main/conversion'

const LANG_DIR = join(__dirname, '../../resources/ocr')
const haveAssets = existsSync(join(LANG_DIR, 'eng.traineddata.gz'))

/**
 * Arial is a Windows font. On a stock Linux box it is absent, and skia draws
 * .notdef boxes rather than substituting, so tesseract reads the boxes instead
 * of the text. Naming Arial's metric-compatible substitutes keeps the fixture
 * legible — and its glyph advances unchanged — on both platforms.
 */
const SANS = 'Arial, "Liberation Sans", "DejaVu Sans", sans-serif'

// ---------------------------------------------------------------------------
// Fixtures: text drawn at fixed positions, at roughly the 200 DPI the pipeline
// rasterizes PDFs at, so the recovered geometry is the geometry OCR really sees.
// ---------------------------------------------------------------------------

const TABLE = [
  ['Item', 'Qty', 'Price'],
  ['Widget', '12', '4.50'],
  ['Gadget', '7', '19.95'],
  ['Sprocket', '140', '0.75'],
  ['Flange', '3', '128.00'],
]
const COLUMN_X = [200, 800, 1150]

const PROSE = [
  'The handshake begins with a HELLO frame that carries',
  'the list of protocol versions the client understands.',
  'The server answers with a WELCOME frame pinning one',
  'version, and if the two ranges do not intersect it',
  'closes the connection without sending any payload.',
  'Flow control then uses a credit scheme granted in',
  'batches, so a slow reader never floods its own queue.',
]

async function blankCanvas(width: number, height: number) {
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#000000'
  return { canvas, ctx }
}

/**
 * A scanned-looking price table: header row plus four data rows.
 * 1700x2200 is US Letter at ~200 DPI, the resolution the PDF path rasterizes
 * at — matching it keeps the PDF fixture from resampling the glyphs (a
 * vertically stretched fixture had tesseract reading "Item" as "tem").
 */
async function renderTablePng(): Promise<Buffer> {
  const { canvas, ctx } = await blankCanvas(1700, 2200)
  TABLE.forEach((row, r) => {
    ctx.font = r === 0 ? `bold 64px ${SANS}` : `64px ${SANS}`
    row.forEach((cell, c) => ctx.fillText(cell, COLUMN_X[c], 200 + r * 160))
  })
  return canvas.toBuffer('image/png')
}

/** A page of running text: one margin, wrapped lines, no columns. */
async function renderProsePng(): Promise<Buffer> {
  const { canvas, ctx } = await blankCanvas(1700, 2200)
  ctx.font = `56px ${SANS}`
  PROSE.forEach((line, i) => ctx.fillText(line, 120, 180 + i * 140))
  return canvas.toBuffer('image/png')
}

async function scannedPdf(png: Buffer): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const image = await pdf.embedPng(png)
  const page = pdf.addPage([612, 792])
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 })
  return Buffer.from(await pdf.save())
}

// ---------------------------------------------------------------------------
// gridFromWords — the decision, tested without paying for OCR.
// Coordinates below are the ones tesseract actually returned for the fixture
// above at 200 DPI, jitter included.
// ---------------------------------------------------------------------------

function word(text: string, x0: number, ymid: number, confidence = 95): OcrWord {
  return {
    text,
    confidence,
    bbox: { x0, x1: x0 + text.length * 30, y0: ymid - 23, y1: ymid + 23 },
  }
}

const MEASURED: OcrWord[] = [
  word('Item', 205, 183),
  word('Qty', 803, 184),
  word('Price', 1155, 177),
  word('Widget', 201, 343),
  word('12', 807, 337),
  word('4.50', 1151, 337),
  word('Gadget', 204, 504),
  word('7', 803, 497),
  word('19.95', 1157, 497),
  word('Sprocket', 203, 663),
  word('140', 807, 657),
  word('0.75', 1153, 657),
  word('Flange', 205, 824),
  word('3', 803, 817),
  word('128.00', 1157, 817),
]

describe('gridFromWords', () => {
  it('rebuilds rows and columns from word boxes, jitter and all', () => {
    expect(gridFromWords(MEASURED)).toEqual(TABLE)
  })

  it('never lets two cells run together', () => {
    for (const row of gridFromWords(MEASURED)!) {
      expect(row).toHaveLength(3)
      for (const cell of row) expect(cell).not.toMatch(/\s{2,}/)
    }
  })

  it('refuses a perfect layout read at low confidence', () => {
    const unsure = MEASURED.map((w) => ({ ...w, confidence: MIN_TABLE_CONFIDENCE - 15 }))
    expect(gridFromWords(unsure)).toBeNull()
  })

  it('accepts the same layout once confidence clears the bar', () => {
    const sure = MEASURED.map((w) => ({ ...w, confidence: MIN_TABLE_CONFIDENCE + 1 }))
    expect(gridFromWords(sure)).toEqual(TABLE)
  })

  it('is not fooled by a handful of very confident words among noise', () => {
    // Nine words at 20% and six at 95% average out below the bar.
    const mixed = MEASURED.map((w, i) => ({ ...w, confidence: i % 3 === 0 ? 95 : 20 }))
    expect(gridFromWords(mixed)).toBeNull()
  })

  it('declines prose, whose words tile each line with no gutter', () => {
    const words: OcrWord[] = []
    PROSE.forEach((line, r) => {
      let x = 120
      for (const token of line.split(' ')) {
        words.push(word(token, x, 200 + r * 140))
        x += token.length * 30 + 20
      }
    })
    expect(gridFromWords(words)).toBeNull()
  })

  it('tolerates one row that spans the columns, such as a title', () => {
    // The gutter rule allows a minority of straddling rows; a caption or a
    // merged heading above the data must not disqualify a real table.
    const withTitle = [word('Spring price list for the north region', 205, 40), ...MEASURED]
    expect(gridFromWords(withTitle)![0][0]).toContain('Spring')
    expect(gridFromWords(withTitle)).toContainEqual(['Widget', '12', '4.50'])
  })

  it('declines empty and blank input', () => {
    expect(gridFromWords([])).toBeNull()
    expect(gridFromWords([word('   ', 10, 10)])).toBeNull()
  })

  it('declines a two-row layout: too little evidence to call it a table', () => {
    expect(gridFromWords(MEASURED.slice(0, 6))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ocrPagesToHub — grids become real markup; text pages still become paragraphs.
// ---------------------------------------------------------------------------

describe('ocrPagesToHub', () => {
  it('emits a table, with the header row as <th>', async () => {
    const hub = await ocrPagesToHub([{ text: 'Item Qty Price\nWidget 12 4.50', grid: TABLE }])
    expect(hub.html).toContain('<table>')
    expect(hub.html).toContain('<th>Item</th>')
    expect(hub.html).toContain('<td>Widget</td><td>12</td><td>4.50</td>')
    // The flattened text is replaced by the table, not printed alongside it.
    expect(hub.html).not.toContain('<p>')
  })

  it('escapes cell text', async () => {
    const hub = await ocrPagesToHub([
      { text: '', grid: [['a', 'b'], ['<b>x</b>', 'Q & A'], ['1', '2'], ['3', '4']] },
    ])
    expect(hub.html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(hub.html).toContain('Q &amp; A')
    expect(hub.html).not.toContain('<b>x</b>')
  })

  it('still writes paragraphs for pages with no table', async () => {
    const hub = await ocrPagesToHub([{ text: 'first page' }, { text: 'second page' }], 'scan.png')
    expect(hub.html).toContain('<p>first page</p>')
    expect(hub.html).toContain('<p>second page</p>')
    expect(hub.html).not.toContain('<table>')
    expect(hub.title).toBe('scan.png')
    expect(hub.sourceName).toBe('scan.png')
  })

  it('keeps text and tables in page order when a document has both', async () => {
    const hub = await ocrPagesToHub([
      { text: 'Cover page' },
      { text: 'ignored', grid: TABLE },
      { text: 'Closing notes' },
    ])
    const order = [hub.html.indexOf('Cover page'), hub.html.indexOf('<table>'), hub.html.indexOf('Closing notes')]
    expect(order[0]).toBeGreaterThanOrEqual(0)
    expect(order[1]).toBeGreaterThan(order[0])
    expect(order[2]).toBeGreaterThan(order[1])
    expect(hub.html).not.toContain('ignored')
  })

  it('survives a page with nothing on it', async () => {
    expect((await ocrPagesToHub([{ text: '' }])).html).toBe('<p></p>')
  })
})

describe('image --ocr --to csv, end to end at the core level', () => {
  it('writes the recovered grid as CSV', async () => {
    const hub = await ocrPagesToHub([{ text: 'Item Qty Price', grid: TABLE }], 'invoice.png')
    const result = await converter.write(hub, 'csv')
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].bytes.toString('utf8')).toBe(
      'Item,Qty,Price\r\nWidget,12,4.50\r\nGadget,7,19.95\r\nSprocket,140,0.75\r\nFlange,3,128.00\r\n',
    )
  })

  it('writes the recovered grid as a markdown table', async () => {
    const hub = await ocrPagesToHub([{ text: '', grid: TABLE }])
    const md = (await converter.write(hub, 'md')).parts[0].bytes.toString('utf8')
    expect(md).toContain('| Item | Qty | Price |')
    expect(md).toContain('| Widget | 12 | 4.50 |')
  })

  it('still refuses csv when OCR found no table', async () => {
    const hub = await ocrPagesToHub([{ text: 'just some scanned prose' }])
    await expect(converter.write(hub, 'csv')).rejects.toThrow(/no tables/i)
  })
})

// ---------------------------------------------------------------------------
// The real thing: rasterize, recognize, reconstruct.
// ---------------------------------------------------------------------------

describe.skipIf(!haveAssets)('OCR table reconstruction (slow, offline assets)', () => {
  it('recovers a price table from a scanned image', { timeout: 300000 }, async () => {
    const page = await ocrImage(await renderTablePng(), { langPath: LANG_DIR })
    expect(page.grid).toEqual(TABLE)
    // The text fallback is still there for targets that want prose.
    expect(page.text.toLowerCase()).toContain('sprocket')
  })

  it('carries that table all the way to CSV', { timeout: 300000 }, async () => {
    const page = await ocrImage(await renderTablePng(), { langPath: LANG_DIR })
    const csv = (await converter.write(await ocrPagesToHub([page], 'invoice.png'), 'csv')).parts[0].bytes.toString(
      'utf8',
    )
    expect(csv.split('\r\n')[0]).toBe('Item,Qty,Price')
    expect(csv).toContain('Flange,3,128.00')
  })

  it('recovers a table from a scanned PDF page', { timeout: 300000 }, async () => {
    const pages = await ocrPdf(await scannedPdf(await renderTablePng()), { langPath: LANG_DIR })
    expect(pages).toHaveLength(1)
    expect(pages[0].grid).toEqual(TABLE)
  })

  it('does not invent a table from a page of prose', { timeout: 300000 }, async () => {
    const page = await ocrImage(await renderProsePng(), { langPath: LANG_DIR })
    expect(page.grid).toBeUndefined()
    expect(page.text.toLowerCase()).toContain('handshake')
    const hub = await ocrPagesToHub([page])
    expect(hub.html).not.toContain('<table>')
    expect(hub.html).toContain('<p>')
  })
})
