import { describe, it, expect } from 'vitest'
import { readMarkdown } from '../../src/core/readers/md'
import { writeMarkdown } from '../../src/core/writers/md'

const read = async (text: string): Promise<string> => (await readMarkdown({ bytes: Buffer.from(text, 'utf8') })).html.trim()
const write = async (html: string): Promise<string> => (await writeMarkdown({ html })).toString('utf8').trim()
const roundTrip = async (text: string): Promise<string> => write(await read(text))

describe('GitHub task lists', () => {
  it('read as ballot boxes, so the state survives every output', async () => {
    const html = await read('- [ ] todo\n- [x] done\n- [X] also done\n- plain\n')
    expect(html).toContain('<li>☐ todo</li>')
    expect(html).toContain('<li>☑ done</li>')
    expect(html).toContain('<li>☑ also done</li>')
    expect(html).toContain('<li>plain</li>')
  })

  it('work in ordered and loose lists', async () => {
    expect(await read('1. [x] first\n2. [ ] second\n')).toMatch(/<li>☑ first<\/li>\s*<li>☐ second<\/li>/)
    expect(await read('- [ ] loose\n\n- [x] items\n')).toMatch(/<li>\s*<p>☐ loose<\/p>/)
  })

  it('need the box at the start of the item, followed by a space', async () => {
    const html = await read('- see [ ] later\n- [x]no space\n- [link](x)\n')
    expect(html).toContain('see [ ] later')
    expect(html).toContain('[x]no space')
    expect(html).not.toContain('☐')
    expect(html).not.toContain('☑')
  })

  it('write back to Markdown as [ ] and [x]', async () => {
    expect(await roundTrip('- [ ] todo\n- [x] done\n')).toMatch(/^\*\s+\[ \] todo\n\*\s+\[x\] done$/)
  })

  it('leave a ballot box that is not at the start of an item alone', async () => {
    expect(await write('<ul><li>a ☐ b</li></ul>')).toMatch(/^\*\s+a ☐ b$/)
  })
})

describe('GitHub alerts', () => {
  for (const [marker, label] of [
    ['NOTE', 'Note'],
    ['TIP', 'Tip'],
    ['IMPORTANT', 'Important'],
    ['WARNING', 'Warning'],
    ['CAUTION', 'Caution'],
  ]) {
    it(`read [!${marker}] as a quote with a bold "${label}"`, async () => {
      const html = await read(`> [!${marker}]\n> Mind the gap.\n`)
      expect(html).toMatch(new RegExp(`^<blockquote>\\s*<p><strong>${label}</strong></p>\\s*<p>Mind the gap.</p>\\s*</blockquote>$`))
    })
  }

  it('keep several paragraphs after the label', async () => {
    const html = await read('> [!TIP]\n>\n> One.\n>\n> Two.\n')
    expect(html).toMatch(/<p><strong>Tip<\/strong><\/p>\s*<p>One.<\/p>\s*<p>Two.<\/p>/)
  })

  it('accept any case, as GitHub does', async () => {
    expect(await read('> [!note]\n> x\n')).toContain('<strong>Note</strong>')
  })

  it('leave an unknown type, a marker mid-line, or a marker outside a quote alone', async () => {
    expect(await read('> [!DANGER]\n> x\n')).toContain('[!DANGER]')
    expect(await read('> [!NOTE] inline text\n')).toContain('[!NOTE] inline text')
    expect(await read('[!NOTE]\n')).toContain('[!NOTE]')
  })

  it('write back to Markdown as the GitHub marker', async () => {
    expect(await roundTrip('> [!WARNING]\n> Hot.\n')).toMatch(/^> \[!WARNING\]\n>\s*\n> Hot\.$/)
  })
})

describe('strikethrough', () => {
  it('reads a single tilde, as GitHub does, as well as a double one', async () => {
    expect(await read('a ~gone~ b\n')).toBe('<p>a <s>gone</s> b</p>')
    expect(await read('a ~~gone~~ b\n')).toBe('<p>a <s>gone</s> b</p>')
    expect(await read('~two words~ and *em*\n')).toBe('<p><s>two words</s> and <em>em</em></p>')
  })

  it('does not strike through approximate numbers, paths or code', async () => {
    expect(await read('about ~5 and ~10 people\n')).toBe('<p>about ~5 and ~10 people</p>')
    expect(await read('see ~/docs and ~/src\n')).toBe('<p>see ~/docs and ~/src</p>')
    expect(await read('`~kept~`\n')).toBe('<p><code>~kept~</code></p>')
    expect(await read('a ~ b ~ c\n')).toBe('<p>a ~ b ~ c</p>')
  })

  it('is written as ~~, which every Markdown reader accepts', async () => {
    expect(await write('<p>a <s>gone</s> b</p>')).toBe('a ~~gone~~ b')
  })
})

describe('emoji shortcodes', () => {
  it('become the emoji', async () => {
    expect(await read('Ship it :tada: :+1:\n')).toBe('<p>Ship it 🎉 👍</p>')
  })

  it('leave unknown codes, times and code spans alone', async () => {
    expect(await read(':not_an_emoji: at 10:30:00\n')).toBe('<p>:not_an_emoji: at 10:30:00</p>')
    expect(await read('`:tada:`\n')).toBe('<p><code>:tada:</code></p>')
  })

  it('leave emoticons as the author typed them; GitHub does not convert :) either', async () => {
    expect(await read('ok :) and :-( and 8)\n')).toBe('<p>ok :) and :-( and 8)</p>')
  })
})
