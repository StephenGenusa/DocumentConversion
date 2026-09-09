import { describe, it, expect } from 'vitest'
import { writeMarkdown } from '../../src/core/writers/md'

const md = async (html: string): Promise<string> => (await writeMarkdown({ html })).toString('utf8')

/**
 * Byte-for-byte characterization of the pipe tables the markdown writer emits.
 *
 * Every expectation below was captured from the turndown + turndown-plugin-gfm
 * output before the writer stopped handing whole tables to turndown (that path
 * was quadratic in document size). The writer now renders the pipe table from
 * the same grid itself, so these cases pin the output down: escaping, empty
 * cells, span expansion, ragged padding, blockquote and list indentation, and
 * the blank line around the table all have to keep matching turndown exactly.
 */
const EXPECTED: Record<string, [html: string, markdown: string]> = {
  'header row': [
    '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Widget</td><td>3</td></tr></tbody></table>',
    '| Name | Qty |\n| --- | --- |\n| Widget | 3 |',
  ],
  'headerless table promotes the first row': [
    '<table><tbody><tr><td>When</td><td>2026-09-01</td></tr><tr><td>Location</td><td>Room 4</td></tr></tbody></table>',
    '| When | 2026-09-01 |\n| --- | --- |\n| Location | Room 4 |',
  ],
  'block elements inside cells': [
    '<table><thead><tr><th>Stage</th><th>Owner</th></tr></thead><tbody><tr><td><p>Readers</p></td><td><p>Alice</p></td></tr></tbody></table>',
    '| Stage | Owner |\n| --- | --- |\n| Readers | Alice |',
  ],
  'a pipe in a cell is escaped': [
    '<table><tbody><tr><td>a|b</td><td>c</td></tr><tr><td>x</td><td>y</td></tr></tbody></table>',
    '| a\\|b | c |\n| --- | --- |\n| x | y |',
  ],
  'a backslash before a pipe escapes both': [
    '<table><tbody><tr><td>a\\|b</td><td>c</td></tr><tr><td>x</td><td>1</td></tr></tbody></table>',
    '| a\\\\\\|b | c |\n| --- | --- |\n| x | 1 |',
  ],
  'markdown punctuation is escaped the way turndown escapes it': [
    '<table><tbody><tr><td>*star*</td><td>_under_</td><td>[link]</td><td>`code`</td></tr>' +
      '<tr><td>- dash</td><td># hash</td><td>1. num</td><td>&gt; quote</td></tr></tbody></table>',
    '| \\*star\\* | \\_under\\_ | \\[link\\] | \\`code\\` |\n| --- | --- | --- | --- |\n' +
      '| \\- dash | \\# hash | 1\\. num | \\> quote |',
  ],
  'empty cells keep their column': [
    '<table><tbody><tr><td>a</td><td></td><td>c</td></tr><tr><td></td><td>b</td><td></td></tr></tbody></table>',
    '| a |  | c |\n| --- | --- | --- |\n|  | b |  |',
  ],
  'ragged rows are padded': [
    '<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td></tr></tbody></table>',
    '| a | b | c |\n| --- | --- | --- |\n| d |  |  |',
  ],
  'colspan widens the header': [
    '<table><thead><tr><th colspan="2">Wide</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    '| Wide |  |\n| --- | --- |\n| a | b |',
  ],
  'rowspan leaves the covered cell blank': [
    '<table><tbody><tr><td rowspan="2">R</td><td>a</td></tr><tr><td>b</td></tr></tbody></table>',
    '| R | a |\n| --- | --- |\n|  | b |',
  ],
  'entities are decoded, angle brackets survive': [
    '<table><tbody><tr><td>&lt;ALL CATEGORIES&gt;</td><td>A &amp; B</td></tr><tr><td>x</td><td>2</td></tr></tbody></table>',
    '| <ALL CATEGORIES> | A & B |\n| --- | --- |\n| x | 2 |',
  ],
  'a blank line separates the table from surrounding blocks': [
    '<h2>Sheet</h2><p>Before</p><table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>1</td></tr></tbody></table><p>After</p>',
    '## Sheet\n\nBefore\n\n| a | b |\n| --- | --- |\n| c | 1 |\n\nAfter',
  ],
  'two sheets in one document': [
    '<h2>One</h2><table><tbody><tr><td>a</td><td>1</td></tr></tbody></table>' +
      '<h2>Two</h2><table><tbody><tr><td>b</td><td>2</td></tr></tbody></table>',
    '## One\n\n| a | 1 |\n| --- | --- |\n\n## Two\n\n| b | 2 |\n| --- | --- |',
  ],
  'a nested table flattens into its containing cell': [
    '<table><tbody><tr><td>outer<table><tbody><tr><td>i1</td><td>i2</td></tr></tbody></table></td><td>z</td></tr></tbody></table>',
    '| outer i1 i2 | z |\n| --- | --- |',
  ],
  'a layout table with one blank cell still renders': [
    '<table><tr><td></td></tr></table><p>after</p>',
    '|  |\n| --- |\n\nafter',
  ],
  'a table inside a list item keeps the list indentation': [
    '<ul><li>Item<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>1</td></tr></tbody></table></li></ul>',
    '*   Item\n    \n    | a | b |\n    | --- | --- |\n    | c | 1 |',
  ],
  'a table inside a blockquote keeps the quote marker': [
    '<blockquote><table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>1</td></tr></tbody></table></blockquote>',
    '> | a | b |\n> | --- | --- |\n> | c | 1 |',
  ],
  'th attributes do not leak into the output': [
    '<table><thead><tr><th class="c" id="i">A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
  ],
  'a br inside a cell becomes a space, not a broken row': [
    '<table><tbody><tr><td>line1<br>line2</td><td>b</td></tr><tr><td>c</td><td>1</td></tr></tbody></table>',
    '| line1 line2 | b |\n| --- | --- |\n| c | 1 |',
  ],
  'a document with no tables is untouched': [
    '<h1>Title</h1><p>Just <em>text</em> here.</p>',
    '# Title\n\nJust _text_ here.',
  ],
  'a table with a row but no cells disappears': [
    '<p>hi</p><table><tr></tr></table><p>bye</p>',
    'hi\n\nbye',
  ],
}

describe('writeMarkdown pipe-table fidelity', () => {
  for (const [name, [html, expected]] of Object.entries(EXPECTED)) {
    it(name, async () => {
      expect(await md(html)).toBe(expected)
    })
  }

  // Regression: turndown-plugin-gfm reads node.rows[0].parentNode with no
  // guard, so an empty <table> (an empty CSV renders one) crashed the whole
  // conversion with "Cannot read properties of undefined".
  it('drops a table with no rows instead of throwing', async () => {
    expect(await md('<p>hi</p><table></table>')).toBe('hi')
    expect(await md('<table><tbody></tbody></table>')).toBe('')
  })
})
