import { describe, it, expect } from 'vitest'
import { inferGrid, groupIntoRows, inferColumns, scoreGrid, type PositionedText } from '../../src/core/grid-infer'

/** Build items on a regular grid: columns at fixed x, rows 20 apart. */
function layout(rows: string[][], columnX: number[], opts: { y0?: number; step?: number } = {}): PositionedText[] {
  const step = opts.step ?? 20
  const items: PositionedText[] = []
  rows.forEach((row, r) => {
    row.forEach((text, c) => {
      if (text === '') return
      items.push({
        text,
        x0: columnX[c],
        x1: columnX[c] + text.length * 6,
        y: (opts.y0 ?? 100) + r * step,
        height: 10,
      })
    })
  })
  return items
}

const COLUMNS = [50, 200, 400]
const TABLE = [
  ['Catalogue', 'Description', 'Group'],
  ['0302', 'Abrasives and grinding wheels', '03'],
  ['0318', 'Rope and twine', '03'],
  ['0304', 'Adhesives', '03'],
]

describe('inferGrid on a clean table', () => {
  it('recovers rows and columns', () => {
    const grid = inferGrid(layout(TABLE, COLUMNS))
    expect(grid).not.toBeNull()
    expect(grid!.columns).toBe(3)
    expect(grid!.rows).toEqual(TABLE)
  })

  it('reports high confidence', () => {
    expect(inferGrid(layout(TABLE, COLUMNS))!.confidence).toBeGreaterThan(0.9)
  })

  it('tolerates small x jitter, as OCR and PDF extraction both produce', () => {
    const items = layout(TABLE, COLUMNS).map((item, i) => ({ ...item, x0: item.x0 + (i % 3) - 1 }))
    const grid = inferGrid(items)
    expect(grid!.rows).toEqual(TABLE)
  })

  it('joins several items that fall inside one cell', () => {
    const items = layout(TABLE, COLUMNS)
    // A wrapped word rendered as its own item, still inside column 2.
    items.push({ text: 'extra', x0: 260, x1: 300, y: 120, height: 10 })
    const grid = inferGrid(items)
    expect(grid!.rows[1][1]).toContain('extra')
  })
})

describe('inferGrid row ordering', () => {
  it('reads top-to-bottom when y grows downward (OCR)', () => {
    const grid = inferGrid(layout(TABLE, COLUMNS), { yIncreasesDownward: true })
    expect(grid!.rows[0][0]).toBe('Catalogue')
    expect(grid!.rows[3][0]).toBe('0304')
  })

  it('reads top-to-bottom when y grows upward (PDF)', () => {
    // PDF origin is bottom-left, so the first row has the LARGEST y.
    const flipped = layout(TABLE, COLUMNS).map((i) => ({ ...i, y: 1000 - i.y }))
    const grid = inferGrid(flipped, { yIncreasesDownward: false })
    expect(grid!.rows[0][0]).toBe('Catalogue')
    expect(grid!.rows[3][0]).toBe('0304')
  })
})

describe('inferGrid declines what is not a table', () => {
  it('rejects ordinary prose, where every line starts at one margin', () => {
    const prose = [
      'The handshake begins with a HELLO frame carrying versions.',
      'The server answers with a WELCOME frame that pins the version.',
      'If the ranges do not intersect the server closes the connection.',
      'Flow control uses a credit scheme granted in batches.',
    ].map((text, r) => ({ text, x0: 50, x1: 500, y: 100 + r * 20, height: 10 }))
    expect(inferGrid(prose)).toBeNull()
  })

  it('rejects too few rows', () => {
    expect(inferGrid(layout(TABLE.slice(0, 2), COLUMNS))).toBeNull()
  })

  it('rejects a single column', () => {
    expect(inferGrid(layout([['a'], ['b'], ['c'], ['d']], [50]))).toBeNull()
  })

  it('rejects an empty input', () => {
    expect(inferGrid([])).toBeNull()
    expect(inferGrid([{ text: '   ', x0: 0, x1: 1, y: 0 }])).toBeNull()
  })

  it('rejects a layout where only one row has two columns', () => {
    const mostlyProse: PositionedText[] = [
      { text: 'Heading here', x0: 50, x1: 200, y: 100, height: 10 },
      { text: 'A paragraph of running text', x0: 50, x1: 400, y: 120, height: 10 },
      { text: 'Another paragraph line', x0: 50, x1: 400, y: 140, height: 10 },
      { text: 'left', x0: 50, x1: 90, y: 160, height: 10 },
      { text: 'right', x0: 300, x1: 340, y: 160, height: 10 },
    ]
    expect(inferGrid(mostlyProse)).toBeNull()
  })
})

describe('grid building blocks', () => {
  it('groups items into rows by vertical proximity', () => {
    const rows = groupIntoRows(layout(TABLE, COLUMNS), true)
    expect(rows).toHaveLength(4)
    expect(rows[0].map((i) => i.text)).toEqual(['Catalogue', 'Description', 'Group'])
  })

  it('ignores a column that appears on only one row', () => {
    const items = layout(TABLE, COLUMNS)
    items.push({ text: 'stray', x0: 900, x1: 950, y: 120, height: 10 })
    expect(inferColumns(groupIntoRows(items, true), 2.5)).toHaveLength(3)
  })

  it('scores prose low and tables high', () => {
    expect(scoreGrid([['only'], ['one'], ['column']])).toBe(0)
    expect(scoreGrid([['a', 'b'], ['c', 'd']])).toBe(1)
  })
})

describe('inferGrid folds wrapped cells before it judges the layout', () => {
  /**
   * A five-row table in which three descriptions wrap: the wrapped halves land
   * in column two with nothing in column one, so only 5 of the 8 visual rows
   * populate two columns and the raw score is 0.62 — under any threshold above
   * that, a perfectly ordinary spreadsheet print is thrown away whole.
   */
  const WRAPPED: PositionedText[] = layout(
    [
      ['Catalogue', 'Description', 'Group'],
      ['0302', 'Abrasives and grinding', '03'],
      ['', 'wheels', ''],
      ['0318', 'Rope, twine and banding', '03'],
      ['', 'material', ''],
      ['0304', 'Adhesive, caulk and joint', '03'],
      ['', 'compound', ''],
      ['0311', 'Anchors', '03'],
    ],
    COLUMNS,
  )

  it('scores the visual rows low without the option', () => {
    expect(inferGrid(WRAPPED, { minConfidence: 0 })!.confidence).toBeCloseTo(5 / 8, 2)
    expect(inferGrid(WRAPPED, { minConfidence: 0.75 })).toBeNull()
  })

  it('scores and returns the folded rows with it', () => {
    const grid = inferGrid(WRAPPED, { minConfidence: 0.75, foldContinuationRows: true })
    expect(grid!.confidence).toBe(1)
    expect(grid!.rows).toEqual([
      ['Catalogue', 'Description', 'Group'],
      ['0302', 'Abrasives and grinding wheels', '03'],
      ['0318', 'Rope, twine and banding material', '03'],
      ['0304', 'Adhesive, caulk and joint compound', '03'],
      ['0311', 'Anchors', '03'],
    ])
  })

  it('still refuses prose, whose lines all start in the first column', () => {
    const prose = [
      'The handshake begins with a HELLO frame carrying versions.',
      'The server answers with a WELCOME frame that pins the version.',
      'If the ranges do not intersect the server closes the connection.',
      'Flow control uses a credit scheme granted in batches.',
    ].map((text, r) => ({ text, x0: 50, x1: 500, y: 100 + r * 20, height: 10 }))
    expect(inferGrid(prose, { foldContinuationRows: true })).toBeNull()
  })
})

describe('inferGrid handles ragged real-world rows', () => {
  it('keeps a row that omits a middle cell', () => {
    const grid = inferGrid(
      layout(
        [
          ['Item', 'Note', 'Qty'],
          ['Widget', '', '3'],
          ['Gadget', 'spare', '7'],
          ['Doohickey', '', '2'],
        ],
        COLUMNS,
      ),
    )
    expect(grid!.rows[1]).toEqual(['Widget', '', '3'])
    expect(grid!.rows[2][1]).toBe('spare')
  })
})
