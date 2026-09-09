import { describe, it, expect } from 'vitest'
import { readRst } from '../../src/core/readers/rst'
import { tableGrid } from '../../src/core/table-grid'

const src = (text: string, filename?: string) => ({ bytes: Buffer.from(text, 'utf8'), filename })

/** Count of real table elements in the hub HTML. */
const tables = (html: string): number => (html.match(/<table>/g) ?? []).length
const rows = (html: string): number => (html.match(/<tr>/g) ?? []).length

const GRID = `Report
======

Intro paragraph.

+------------+------------+-----------+
| Header 1   | Header 2   | Header 3  |
+============+============+===========+
| body row 1 | column 2   | column 3  |
+------------+------------+-----------+
| body row 2 | second     | third     |
+------------+------------+-----------+

Closing paragraph.
`

const SIMPLE = `Prices
======

=====  ===  =====
Item   Qty  Price
=====  ===  =====
Bolt   10   0.25
Nut    4    0.10
=====  ===  =====

After the table.
`

describe('reStructuredText grid tables', () => {
  it('emits a real table with a header, rows and cells', async () => {
    const hub = await readRst(src(GRID, 'report.rst'))
    expect(tables(hub.html)).toBe(1)
    expect(rows(hub.html)).toBe(3)
    expect(hub.html).toContain('<thead><tr><th>Header 1</th><th>Header 2</th><th>Header 3</th></tr></thead>')
    expect(hub.html).toContain('<td>body row 1</td>')
    expect(hub.html).toContain('<td>third</td>')
  })

  it('leaves no ASCII art behind and keeps the surrounding prose in order', async () => {
    const hub = await readRst(src(GRID))
    expect(hub.html).not.toContain('+---')
    expect(hub.html).not.toContain('+===')
    expect(hub.html).not.toContain('| body row 1')
    expect(hub.html.indexOf('Intro paragraph')).toBeLessThan(hub.html.indexOf('<table>'))
    expect(hub.html.indexOf('<table>')).toBeLessThan(hub.html.indexOf('Closing paragraph'))
    expect(hub.title).toBe('Report')
  })

  it('treats a grid table with no === rule as all body rows', async () => {
    const html = (
      await readRst(
        src(`+-----+-----+
| a   | b   |
+-----+-----+
| c   | d   |
+-----+-----+
`),
      )
    ).html
    expect(tables(html)).toBe(1)
    expect(html).not.toContain('<thead>')
    expect(html).toContain('<td>a</td><td>b</td>')
  })

  it('joins a cell that runs over several physical lines', async () => {
    const html = (
      await readRst(
        src(`+------------+---------------------+
| Stage      | Notes               |
+============+=====================+
| Readers    | Produce hub HTML    |
|            | for every format    |
+------------+---------------------+
`),
      )
    ).html
    expect(html).toContain('<td>Produce hub HTML for every format</td>')
  })

  it('honours a cell that spans columns', async () => {
    const html = (
      await readRst(
        src(`+------------+------------+-----------+
| a          | b          | c         |
+------------+------------+-----------+
| spans two columns       | c2        |
+------------+------------+-----------+
`),
      )
    ).html
    expect(html).toContain('<td colspan="2">spans two columns</td>')
    expect(rows(html)).toBe(2)
  })

  it('emits rowspan for a cell whose box runs through a row separator', async () => {
    // The spanning cell punches a hole in the inner border: the "+---+" that
    // would close it is replaced by the cell's own text, and its left/right
    // "|" boundaries carry straight on down.
    const source = `+------------+------------+
| body row 3 | Cells may  |
+------------+ span rows. |
| body row 4 |            |
+------------+------------+
`
    const html = (await readRst(src(source))).html
    expect(tables(html)).toBe(1)
    expect(rows(html)).toBe(2)
    expect(html).toContain('<td>body row 3</td><td rowspan="2">Cells may span rows.</td>')
    expect(html).toContain('<tr><td>body row 4</td></tr>')
  })

  it('emits rowspan when the spanning cell is the first column', async () => {
    // The row separator now starts with "|" rather than "+", so the parse
    // cannot lean on "a separator line begins with a plus".
    const source = `+------------+------------+
| spans two  | one        |
| rows       +------------+
|            | two        |
+------------+------------+
`
    const html = (await readRst(src(source))).html
    expect(tables(html)).toBe(1)
    expect(html).toContain('<td rowspan="2">spans two rows</td><td>one</td>')
    expect(html).toContain('<tr><td>two</td></tr>')
  })

  it('emits rowspan and colspan from the same table', async () => {
    const source = `+------------+------------+-----------+
| a          | b          | c         |
+------------+------------+-----------+
| down       | wide across            |
|            +------------+-----------+
| (cont)     | x          | y         |
+------------+------------+-----------+
`
    const html = (await readRst(src(source))).html
    expect(html).toContain('<td rowspan="2">down (cont)</td><td colspan="2">wide across</td>')
    expect(rows(html)).toBe(3)
  })

  it('expands rst spans into a rectangular grid for downstream writers', async () => {
    // table-grid.ts is what every writer consumes, so the markup only pays off
    // if it round-trips through the span expander.
    const source = `+------------+------------+-----------+
| a          | b          | c         |
+------------+------------+-----------+
| down       | wide across            |
|            +------------+-----------+
| (cont)     | x          | y         |
+------------+------------+-----------+
`
    const grid = tableGrid((await readRst(src(source))).html)
    expect(grid).toHaveLength(1)
    expect(grid[0]).toEqual([
      ['a', 'b', 'c'],
      ['down (cont)', 'wide across', ''],
      ['', 'x', 'y'],
    ])
  })

  it('leaves a misaligned table alone', async () => {
    const source = `+------+------+
| a  | b     |
+------+------+
`
    const html = (await readRst(src(source))).html
    expect(tables(html)).toBe(0)
    expect(html).toContain('a')
  })

  it('leaves an unterminated table alone', async () => {
    const html = (await readRst(src('+------+------+\n| a    | b    |\n\nnext paragraph\n'))).html
    expect(tables(html)).toBe(0)
    expect(html).toContain('next paragraph')
  })
})

describe('reStructuredText simple tables', () => {
  it('emits a real table with a header when the rules mark one', async () => {
    const hub = await readRst(src(SIMPLE, 'prices.rst'))
    expect(tables(hub.html)).toBe(1)
    expect(hub.html).toContain('<thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>')
    expect(hub.html).toContain('<td>Bolt</td><td>10</td><td>0.25</td>')
    expect(hub.html).toContain('<td>Nut</td><td>4</td><td>0.10</td>')
    expect(rows(hub.html)).toBe(3)
  })

  it('leaves no rule lines behind and keeps the surrounding prose', async () => {
    const html = (await readRst(src(SIMPLE))).html
    expect(html).not.toContain('=====  ===')
    expect(html).toContain('After the table.')
  })

  it('treats a two-rule table as all body rows', async () => {
    const html = (
      await readRst(
        src(`====  ====
a     b
c     d
====  ====

tail
`),
      )
    ).html
    expect(tables(html)).toBe(1)
    expect(html).not.toContain('<thead>')
    expect(rows(html)).toBe(2)
  })

  it('continues a row while its first column stays blank', async () => {
    const html = (
      await readRst(
        src(`=====  ==================
Stage  Notes
=====  ==================
One    first line of note
       continued here
Two    second note
=====  ==================
`),
      )
    ).html
    expect(html).toContain('<td>One</td><td>first line of note continued here</td>')
    expect(html).toContain('<td>Two</td><td>second note</td>')
    expect(rows(html)).toBe(3)
  })

  it('gives the unbounded last column the rest of the line', async () => {
    const html = (
      await readRst(
        src(`==  ====
id  what
==  ====
1   a much longer value than the rule
==  ====
`),
      )
    ).html
    expect(html).toContain('<td>a much longer value than the rule</td>')
  })

  it('does not mistake a section underline for a table', async () => {
    const html = (await readRst(src('Heading\n=======\n\nSome prose.\n'))).html
    expect(tables(html)).toBe(0)
    expect(html).toContain('Heading')
    expect(html).toContain('Some prose.')
  })

  it('emits colspan for a header underlined by a partial rule', async () => {
    // The canonical spec example: the "---" underline is the column spec for
    // the line above it, so "Inputs" covers the first two columns.
    const source = `=====  =====  ======
   Inputs     Output
------------  ------
  A      B    A or B
=====  =====  ======
True   False  True
=====  =====  ======
`
    const html = (await readRst(src(source))).html
    expect(tables(html)).toBe(1)
    expect(html).toContain('<th colspan="2">Inputs</th><th>Output</th>')
    expect(html).toContain('<th>A</th><th>B</th><th>A or B</th>')
    expect(html).toContain('<td>True</td><td>False</td><td>True</td>')
  })

  it('emits colspan for a span underline in the body', async () => {
    const source = `=====  =====  ======
A      B      C
=====  =====  ======
1      2      3
merged all the way
--------------------
=====  =====  ======
`
    const html = (await readRst(src(source))).html
    expect(html).toContain('<td>1</td><td>2</td><td>3</td>')
    expect(html).toContain('<td colspan="3">merged all the way</td>')
  })

  it('expands a simple-table colspan into a rectangular grid', async () => {
    const source = `=====  =====  ======
   Inputs     Output
------------  ------
  A      B    A or B
=====  =====  ======
True   False  True
=====  =====  ======
`
    expect(tableGrid((await readRst(src(source))).html)[0]).toEqual([
      ['Inputs', '', 'Output'],
      ['A', 'B', 'A or B'],
      ['True', 'False', 'True'],
    ])
  })

  it('declines a span underline that misses a column boundary', async () => {
    // The underline ends at 11 but no column ends there, so the span cannot be
    // resolved. Guessing would silently shift every cell one column left.
    const source = `=====  =====  ======
   Inputs     Output
-----------   ------
  A      B    A or B
=====  =====  ======
True   False  True
=====  =====  ======
`
    const html = (await readRst(src(source))).html
    expect(tables(html)).toBe(0)
    expect(html).toContain('A or B')
  })

  it('does not swallow prose that follows a table with the same shape', async () => {
    const html = (
      await readRst(
        src(`====  ====
a     b
====  ====

An ordinary sentence that runs across the column boundaries.

====  ====
c     d
====  ====
`),
      )
    ).html
    expect(tables(html)).toBe(2)
    expect(html).toContain('An ordinary sentence that runs across the column boundaries.')
  })
})

describe('reStructuredText table content', () => {
  it('escapes markup inside cells', async () => {
    // The border must be as wide as the row, or the grid parser declines and
    // the whole block comes through as one escaped paragraph of ASCII art —
    // which satisfies "no <script>, yes &lt;script&gt;" without a table ever
    // being read, and enshrines the parse failure the suite forbids above.
    const html = (
      await readRst(
        src(`+---------------------+
| <script>x</script>  |
+---------------------+
| a & b < c > d "e"   |
+---------------------+
`),
      )
    ).html
    expect(tables(html)).toBe(1)
    expect(html).not.toContain('+---')
    expect(html).toContain('<td>&lt;script&gt;x&lt;/script&gt;</td>')
    expect(html).toContain('<td>a &amp; b &lt; c &gt; d "e"</td>')
    expect(html).not.toContain('<script>')
  })

  it('keeps inline emphasis, strong and literals inside cells', async () => {
    const html = (
      await readRst(
        src(`==========  ==========  ==========
**strong**  *emphasis*  \`\`code\`\`
==========  ==========  ==========
plain       text        here
==========  ==========  ==========
`),
      )
    ).html
    expect(html).toContain('<strong>strong</strong>')
    expect(html).toContain('<em>emphasis</em>')
    expect(html).toContain('<code>code</code>')
  })

  it('renders a .. table:: directive once, with its caption', async () => {
    const html = (
      await readRst(
        src(`.. table:: Quarterly results

   =====  =====
   Q      Total
   =====  =====
   Q1     10
   Q2     20
   =====  =====
`),
      )
    ).html
    expect(tables(html)).toBe(1)
    expect(html).toContain('Quarterly results')
    expect(html).toContain('<td>Q1</td><td>10</td>')
    // The directive body must not also come through as preformatted ASCII art.
    expect(html).not.toContain('=====')
    expect(html).not.toContain('<pre>')
  })

  it('reads a table indented inside a block quote', async () => {
    const html = (
      await readRst(
        src(`Intro.

   +-----+-----+
   | a   | b   |
   +-----+-----+
`),
      )
    ).html
    expect(tables(html)).toBe(1)
    expect(html).toContain('<td>a</td><td>b</td>')
  })

  it('reads a table nested in a list item without leaving stray tags', async () => {
    const html = (
      await readRst(
        src(`- item one

  ====  ====
  a     b
  ====  ====

- item two
`),
      )
    ).html
    expect(tables(html)).toBe(1)
    expect(html).toContain('<li>item two</li>')
    expect(html).not.toContain('</p><p>')
    expect(html).toContain('<p>item one</p>')
  })

  it('handles both syntaxes in one document', async () => {
    const html = (
      await readRst(
        src(`Mixed
=====

====  ====
a     b
====  ====

+-----+-----+
| c   | d   |
+-----+-----+
`),
      )
    ).html
    expect(tables(html)).toBe(2)
    expect(html).toContain('<td>a</td><td>b</td>')
    expect(html).toContain('<td>c</td><td>d</td>')
  })
})
