import { describe, it, expect } from 'vitest'
import { readMarkdown } from '../../src/core/readers/md'
import { writeMarkdown } from '../../src/core/writers/md'

const read = async (text: string): Promise<string> => (await readMarkdown({ bytes: Buffer.from(text, 'utf8') })).html.trim()
const write = async (html: string): Promise<string> => (await writeMarkdown({ html })).toString('utf8').trim()
const table = (cells: string): string =>
  `<table><thead><tr><th>Name</th><th>Note</th></tr></thead><tbody><tr><td>row</td><td>${cells}</td></tr></tbody></table>`

describe('markdown table cells keep their inline formatting', () => {
  it('writes bold, italic, strike, code, links and formulas as Markdown', async () => {
    const md = await write(
      table(
        '<strong>bold</strong> <em>italic</em> <del>gone</del> <code>x = 1</code> ' +
          '<a href="https://example.com/a">link</a> <code class="language-math">x^2</code>',
      ),
    )
    expect(md).toBe(
      '| Name | Note |\n| --- | --- |\n' +
        '| row | **bold** _italic_ ~~gone~~ `x = 1` [link](https://example.com/a) $x^2$ |',
    )
  })

  it('escapes a pipe in formatted text, code and formulas', async () => {
    const md = await write(table('<strong>a|b</strong> <code>c|d</code> <code class="language-math">|x| + y_1</code>'))
    expect(md.split('\n')[2]).toBe('| row | **a\\|b** `c\\|d` $\\|x\\| + y_1$ |')
    const html = await read(md)
    expect(html).toContain('<strong>a|b</strong>')
    expect(html).toContain('<code>c|d</code>')
    expect(html).toMatch(/<code class="language-math">\|x\| \+ y_1<\/code>/)
  })

  it('keeps a paragraph-wrapped formatted cell on one line', async () => {
    const md = await write(table('<p><strong>one</strong></p><p>two</p>'))
    expect(md.split('\n')[2]).toBe('| row | **one** two |')
  })

  it('leaves a cell with block content as plain text, as before', async () => {
    const md = await write(table('<ul><li><strong>one</strong></li><li>two</li></ul>'))
    expect(md.split('\n')[2]).toBe('| row | one two |')
  })

  it('still escapes plain cells next to formatted ones', async () => {
    const md = await write(
      '<table><tbody><tr><td>*star*</td><td><em>a</em></td></tr><tr><td>x|y</td><td>1</td></tr></tbody></table>',
    )
    expect(md).toBe('| \\*star\\* | _a_ |\n| --- | --- |\n| x\\|y | 1 |')
  })

  it('round trips md -> md with the formatting', async () => {
    const source =
      '| Name | Note |\n| --- | --- |\n' +
      '| **bold** | _italic_ ~~gone~~ `a\\|b` [link](https://example.com/a) $x^2$ |\n'
    const html = await read(source)
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>a|b</code>')
    const once = await write(html)
    expect(once).toBe(source.trim())
    expect(await write(await read(once))).toBe(once)
  })
})
