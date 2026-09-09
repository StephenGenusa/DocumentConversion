import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readRtf } from '../../src/core/readers/rtf'
import { tableGrid } from '../../src/core/table-grid'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeCsv } from '../../src/core/writers/csv'

/**
 * `\trowd ... \cell ... \row` used to degrade to `<p>a | b</p>` because
 * @iarna/rtf-to-html has no table model. A pre-pass now cuts table regions out
 * of the RTF, parses them here, and stitches real <table> markup back over a
 * placeholder — everything else still takes the old converter path.
 */

const doc = (body: string): Buffer =>
  Buffer.from(`{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}\n${body}\n}`, 'latin1')

const hub = async (body: string): Promise<string> => (await readRtf({ bytes: doc(body) })).html

const tableCount = (html: string): number => (html.match(/<table\b/g) ?? []).length

describe('rtf tables: basic shape', () => {
  it('emits real table markup for a two-column table', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000
\intbl Stage\cell Owner\cell\row
\trowd\cellx3000\cellx6000
\intbl Readers\cell Alice\cell\row`,
    )
    expect(tableCount(html)).toBe(1)
    expect(tableGrid(html)).toEqual([
      [
        ['Stage', 'Owner'],
        ['Readers', 'Alice'],
      ],
    ])
    // The old " | " separator must be gone, not merely hidden.
    expect(html).not.toContain('Stage | Owner')
  })

  it('keeps consecutive rows in one table and starts a new one after prose', async () => {
    const html = await hub(
      String.raw`\pard Intro\par
\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\trowd\cellx3000\cellx6000\intbl C\cell D\cell\row
\pard Between the tables\par
\trowd\cellx3000\cellx6000\intbl E\cell F\cell\row
\pard After\par`,
    )
    expect(tableCount(html)).toBe(2)
    const grids = tableGrid(html)
    expect(grids[0]).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ])
    expect(grids[1]).toEqual([['E', 'F']])
    // The prose around and between the tables survives, in order.
    expect(html.indexOf('Intro')).toBeLessThan(html.indexOf('<table'))
    expect(html).toContain('Between the tables')
    expect(html).toContain('After')
  })

  it('pads a row that has fewer cells than \\cellx declared columns', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx2000\cellx4000\cellx6000\intbl one\cell two\cell three\cell\row
\trowd\cellx2000\cellx4000\cellx6000\intbl only\cell\row`,
    )
    expect(tableGrid(html)).toEqual([
      [
        ['one', 'two', 'three'],
        ['only', '', ''],
      ],
    ])
  })

  it('marks a \\trhdr row as a header row', async () => {
    const html = await hub(
      String.raw`\pard\trowd\trhdr\cellx3000\cellx6000\intbl Item\cell Qty\cell\row
\trowd\cellx3000\cellx6000\intbl Widget\cell 3\cell\row`,
    )
    expect(html).toContain('<thead>')
    expect(html).toContain('<th>Item</th>')
    expect(html).toContain('<td>Widget</td>')
  })
})

describe('rtf tables: cell text quality', () => {
  it('escapes HTML metacharacters in cell text', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl R&D\cell <b>not markup</b>\cell\row`,
    )
    expect(html).toContain('R&amp;D')
    expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt;')
    expect(tableGrid(html)[0][0]).toEqual(['R&D', '<b>not markup</b>'])
  })

  it('keeps inline bold and italic inside cells', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl \b Bold\b0  tail\cell \i Ital\i0\cell\row`,
    )
    expect(html).toContain('<strong>Bold</strong> tail')
    expect(html).toContain('<em>Ital</em>')
  })

  it('does not run two paragraphs in one cell together ("FromAlice")', async () => {
    const html = await hub(String.raw`\pard\trowd\cellx3000\intbl From\par Alice\cell\row`)
    expect(html).toContain('From<br />Alice')
    expect(tableGrid(html)[0][0][0]).toBe('From Alice')
    expect(html).not.toContain('FromAlice')
  })

  /**
   * SUPERSEDED (2026-08-31): this used to assert `tableCount === 1`, because a
   * nested table was flattened into its containing cell — the grid was lost and
   * only the text survived. The reader now emits the inner grid as a real
   * nested <table>, so there are two <table> elements. Every other expectation
   * below is unchanged and still passes: table-grid's ownRows() does not recurse
   * into a nested table, so the parent cell's *text* still reads "Widget 3" and
   * the words still do not run together. See tests/core/rtf-nested-tables.test.ts.
   */
  it('keeps a nested table as a nested grid, without joining words', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000
\intbl Widget\nestcell 3\nestcell\nestrow{\*\nesttableprops\trowd\cellx1500\cellx3000\row}\cell Ready\cell\row`,
    )
    expect(tableCount(html)).toBe(2)
    const grid = tableGrid(html)[0]
    expect(grid[0][0]).toBe('Widget 3')
    expect(grid[0][1]).toBe('Ready')
    expect(html).not.toContain('Widget3')
  })

  it("decodes \\'hh and \\uN escapes inside cells", async () => {
    const html = await hub(
      '\\pard\\trowd\\cellx3000\\cellx6000\\intbl caf\\\'e9\\cell \\u8220?quoted\\u8221?\\cell\\row',
    )
    expect(tableGrid(html)[0][0]).toEqual(['café', '“quoted”'])
  })

  it('drops hidden text but keeps the surrounding cell', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl Visible\v Secret\v0\cell Kept\cell\row`,
    )
    expect(html).not.toContain('Secret')
    expect(tableGrid(html)[0][0]).toEqual(['Visible', 'Kept'])
  })
})

describe('rtf tables: merged cells', () => {
  it('collapses a horizontal merge into colspan without duplicating text', async () => {
    const html = await hub(
      String.raw`\pard\trowd\clmgf\cellx3000\clmrg\cellx6000\cellx9000
\intbl Subtotal\cell\cell 12\cell\row`,
    )
    expect(html).toContain('<td colspan="2">Subtotal</td>')
    expect(html.match(/Subtotal/g) ?? []).toHaveLength(1)
    expect(tableGrid(html)).toEqual([[['Subtotal', '', '12']]])
  })

  it('keeps text a \\clmrg continuation cell unexpectedly carries', async () => {
    const html = await hub(
      String.raw`\pard\trowd\clmgf\cellx3000\clmrg\cellx6000\intbl Left\cell Right\cell\row`,
    )
    expect(html).toContain('Left')
    expect(html).toContain('Right')
    expect(tableGrid(html)[0][0][0]).toBe('Left Right')
  })

  it('collapses a vertical merge into rowspan', async () => {
    const html = await hub(
      String.raw`\pard\trowd\clvmgf\cellx3000\cellx6000\intbl Poles\cell Wooden\cell\row
\trowd\clvmrg\cellx3000\cellx6000\intbl\cell Steel\cell\row`,
    )
    expect(html).toContain('<td rowspan="2">Poles</td>')
    expect(html.match(/Poles/g) ?? []).toHaveLength(1)
    expect(tableGrid(html, { fillRowspan: true })).toEqual([
      [
        ['Poles', 'Wooden'],
        ['Poles', 'Steel'],
      ],
    ])
  })

  it('does not merge a \\clvmrg cell that carries its own text', async () => {
    const html = await hub(
      String.raw`\pard\trowd\clvmgf\cellx3000\cellx6000\intbl Poles\cell Wooden\cell\row
\trowd\clvmrg\cellx3000\cellx6000\intbl Steel poles\cell Steel\cell\row`,
    )
    expect(html).toContain('Steel poles')
    expect(tableGrid(html)).toEqual([
      [
        ['Poles', 'Wooden'],
        ['Steel poles', 'Steel'],
      ],
    ])
  })
})

describe('rtf tables: fallback never loses content', () => {
  it('falls back to degraded paragraphs when the region is not brace-balanced', async () => {
    const html = await hub(
      String.raw`\pard Before\par
\trowd\cellx3000\cellx6000\intbl {\b Broken\cell Cell\cell\row
\pard After\par`,
    )
    expect(tableCount(html)).toBe(0)
    expect(html).toContain('Before')
    expect(html).toContain('Broken')
    expect(html).toContain('Cell')
    expect(html).toContain('After')
    // Degraded cells still must not run together.
    expect(html).not.toContain('BrokenCell')
  })

  it('keeps the text when a producer writes cell content before \\trowd', async () => {
    const html = await hub(
      String.raw`\pard Alpha\cell Beta\cell\trowd\cellx3000\cellx6000\row
\pard Tail\par`,
    )
    // Not a confident parse, so no table — but nothing is dropped either.
    expect(tableCount(html)).toBe(0)
    expect(html).toContain('Alpha')
    expect(html).toContain('Beta')
    expect(html).toContain('Tail')
    expect(html).not.toContain('AlphaBeta')
  })

  it('ignores \\trowd with no closing \\row instead of swallowing the text', async () => {
    const html = await hub(String.raw`\pard Prose\par
\trowd\cellx3000\cellx6000\intbl Dangling\cell text\cell
\pard Tail\par`)
    expect(tableCount(html)).toBe(0)
    expect(html).toContain('Prose')
    expect(html).toContain('Dangling')
    expect(html).toContain('Tail')
  })

  it('still rejects non-rtf bytes', async () => {
    await expect(readRtf({ bytes: Buffer.from('not rtf at all') })).rejects.toMatchObject({
      code: 'rtf-parse-failed',
    })
  })
})

describe('rtf tables: the mixed fixture', () => {
  const load = async (): Promise<string> =>
    (await readRtf({
      bytes: await readFile(join(__dirname, '../fixtures/sample-rtf-table.rtf')),
      filename: 'sample-rtf-table.rtf',
    })).html

  it('reads both tables, the prose between them, and strips the picture', async () => {
    const html = await load()
    expect(tableCount(html)).toBe(2)
    expect(html).toContain('Inventory Report')
    expect(html).toContain('<strong>Alice</strong>')
    expect(html).toContain('<em>Q3 review</em>')
    expect(html).toContain('Notes follow the table.')
    expect(html).toContain('End of report.')
    // The \pict group's hex payload must not reach the body.
    expect(html).not.toContain('0102030405')
    expect(html).not.toContain('wmetafile')
  })

  it('models the header row, the merge and the multi-paragraph cell', async () => {
    const grids = tableGrid(await load(), { fillRowspan: true })
    expect(grids[0]).toEqual([
      ['Item', 'Qty', 'Notes'],
      ['Widget', '3', 'Ships Monday Backordered'],
      ['Subtotal & tax', '', '12'],
    ])
    expect(grids[1]).toEqual([
      ['Poles', 'Wooden'],
      ['Poles', 'Steel'],
    ])
  })

  it('survives the markdown and csv writers as a real table', async () => {
    const html = await load()
    const md = (await writeMarkdown({ html })).toString('utf8')
    expect(md).toContain('| Item | Qty | Notes |')
    expect(md).toContain('| Widget | 3 | Ships Monday Backordered |')
    const csv = (await writeCsv({ html })).parts[0].bytes.toString('utf8')
    expect(csv).toContain('Item,Qty,Notes')
    expect(csv).toContain('Widget,3,Ships Monday Backordered')
  })
})

describe('rtf tables: scale', () => {
  it('handles a document with many tables in linear time', async () => {
    const rows = Array.from(
      { length: 400 },
      (_, n) =>
        `\\pard Note ${n}\\par\n\\trowd\\cellx3000\\cellx6000\\intbl r${n}c0\\cell r${n}c1\\cell\\row`,
    ).join('\n')
    const started = Date.now()
    const html = await hub(rows)
    expect(Date.now() - started).toBeLessThan(10000)
    // Prose between every row, so each row is its own table.
    expect(tableCount(html)).toBe(400)
    expect(html).toContain('<td>r399c1</td>')
    expect(html).not.toContain('zZrTfTbL')
  })
})

describe('rtf tables: a real-shaped picture-heavy file', () => {
  it('converts quickly, keeps its prose and stays picture-free', async () => {
    const file = join(__dirname, '../corpus/review-notes.rtf')
    if (!existsSync(file)) return
    const bytes = await readFile(file)
    const started = Date.now()
    const hubDoc = await readRtf({ bytes, filename: 'review-notes.rtf' })
    const elapsed = Date.now() - started
    // ~48 KB in, well under 1 KB of prose out: the file is 44 embedded WMF
    // pictures (scaled down from a real 826 KB / 44-picture original).
    expect(hubDoc.html.length).toBeLessThan(1000)
    expect(hubDoc.html).toContain('Quill, I have completed my review of request 7742.')
    expect(hubDoc.html).toContain('Add 1 additional bookend at the end of the north run.')
    expect(hubDoc.html).toContain('Iris Vellum')
    // It genuinely has no tables, so the table pre-pass must add none.
    expect(tableCount(hubDoc.html)).toBe(0)
    expect(hubDoc.html).not.toMatch(/[0-9a-f]{200,}/i)
    expect(elapsed).toBeLessThan(4000)
  })
})
