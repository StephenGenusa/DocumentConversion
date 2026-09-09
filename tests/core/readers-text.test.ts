import { describe, it, expect } from 'vitest'
import { readTxt } from '../../src/core/readers/txt'
import { readMarkdown } from '../../src/core/readers/md'
import { readHtml } from '../../src/core/readers/html'

const src = (s: string) => ({ bytes: Buffer.from(s, 'utf8') })

describe('readTxt', () => {
  it('makes paragraphs from blank-line blocks and escapes html', () => {
    return readTxt(src('line one\nline two\n\nsecond <b>para</b>')).then((doc) => {
      expect(doc.html).toContain('<p>line one<br>line two</p>')
      expect(doc.html).toContain('&lt;b&gt;')
    })
  })
})

const tables = (html: string): number => (html.match(/<table>/g) ?? []).length

describe('readTxt tab-delimited tables', () => {
  it('turns a uniform tab-separated block into a table with a header', async () => {
    const doc = await readTxt(src('Item\tQty\tPrice\nBolt\t10\t0.25\nNut\t4\t0.10\n'))
    expect(tables(doc.html)).toBe(1)
    expect(doc.html).toContain('<th>Item</th><th>Qty</th><th>Price</th>')
    expect(doc.html).toContain('<td>Bolt</td><td>10</td><td>0.25</td>')
    expect(doc.html).not.toContain('<p>')
  })

  it('reads a two-column, two-line block and escapes its cells', async () => {
    const doc = await readTxt(src('a\t<b>\nc\td'))
    expect(tables(doc.html)).toBe(1)
    expect(doc.html).toContain('&lt;b&gt;')
    expect(doc.html).not.toContain('<b>')
  })

  it('keeps prose around a tab-delimited block', async () => {
    const doc = await readTxt(src('An introduction.\n\nName\tRole\nAlice\tLead\n\nA closing note.'))
    expect(tables(doc.html)).toBe(1)
    expect(doc.html).toContain('<p>An introduction.</p>')
    expect(doc.html).toContain('<p>A closing note.</p>')
    expect(doc.html.indexOf('An introduction')).toBeLessThan(doc.html.indexOf('<table>'))
    expect(doc.html.indexOf('<table>')).toBeLessThan(doc.html.indexOf('A closing note'))
  })

  // ---- false positives: these must stay prose ----

  it('does not table a makefile recipe', async () => {
    const doc = await readTxt(src('all: build\n\tgcc -o app main.c\n\tstrip app\n'))
    expect(tables(doc.html)).toBe(0)
    expect(doc.html).toContain('gcc -o app main.c')
  })

  it('does not table tab-indented python', async () => {
    const doc = await readTxt(src('def total(rows):\n\tn = 0\n\tfor r in rows:\n\t\tn += r\n\treturn n\n'))
    expect(tables(doc.html)).toBe(0)
  })

  it('does not table a block whose every line is only indentation', async () => {
    // Two consecutive lines, one tab each, same field count — every structural
    // count passes. Only the "tab at column 0 is indentation" rule saves it.
    const doc = await readTxt(src('\tfirst indented line\n\tsecond indented line\n'))
    expect(tables(doc.html)).toBe(0)
  })

  it('does not table tab-aligned source declarations', async () => {
    const doc = await readTxt(src('int\tcount;\nchar\tname[32];\n'))
    expect(tables(doc.html)).toBe(0)
  })

  it('does not table code that uses tabs after text', async () => {
    const doc = await readTxt(src('const a = 1;\tconst b = 2;\nconst c = 3;\tconst d = 4;\n'))
    expect(tables(doc.html)).toBe(0)
  })

  it('does not table ordinary prose', async () => {
    const doc = await readTxt(src('The quick brown fox\njumps over the lazy dog\nand keeps on going.'))
    expect(tables(doc.html)).toBe(0)
    expect(doc.html).toContain('<p>')
  })

  it('does not table a block with a ragged tab count', async () => {
    const doc = await readTxt(src('a\tb\tc\nd\te\n'))
    expect(tables(doc.html)).toBe(0)
  })

  it('does not table a single tabbed line', async () => {
    const doc = await readTxt(src('Name\tValue'))
    expect(tables(doc.html)).toBe(0)
  })

  it('does not table lines whose first field is empty', async () => {
    const doc = await readTxt(src('Name\tValue\n\t42\n'))
    expect(tables(doc.html)).toBe(0)
  })
})

describe('readMarkdown', () => {
  it('renders markdown to html', async () => {
    const doc = await readMarkdown(src('# Title\n\n**bold**'))
    expect(doc.html).toContain('<h1>Title</h1>')
    expect(doc.html).toContain('<strong>bold</strong>')
  })
})

describe('readHtml', () => {
  it('sanitizes scripts and keeps content', async () => {
    const doc = await readHtml(src('<h1>Hi</h1><p onclick="x">t</p><script>bad()</script>'))
    expect(doc.html).toContain('<h1>Hi</h1>')
    expect(doc.html).toContain('<p>t</p>')
    expect(doc.html).not.toContain('script')
    expect(doc.title).toBe('Hi')
  })
})
