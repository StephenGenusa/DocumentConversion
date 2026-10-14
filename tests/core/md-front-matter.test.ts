import { describe, it, expect } from 'vitest'
import { readMarkdown } from '../../src/core/readers/md'
import { readIpynb } from '../../src/core/readers/ipynb'
import { renderEditableText } from '../../src/core/text-intake'

const read = (text: string, frontMatter?: boolean) =>
  readMarkdown({ bytes: Buffer.from(text, 'utf8') }, undefined, frontMatter === undefined ? undefined : { frontMatter })

/**
 * YAML front matter is metadata, not content. Before this, markdown-it read
 * the opening `---` as a rule and the last `key: value` line plus the closing
 * `---` as a setext heading:
 *
 *   ---\ntitle: Hello\nauthor: me\n---   ->   <hr><h2>title: Hello\nauthor: me</h2>
 */
describe('markdown front matter', () => {
  it('is removed, and its title becomes the document title', async () => {
    const hub = await read('---\ntitle: Hello\nauthor: me\n---\n\n# Body\n\nText.\n')
    expect(hub.title).toBe('Hello')
    expect(hub.html).not.toContain('<hr')
    expect(hub.html).not.toContain('author')
    expect(hub.html).toContain('<h1>Body</h1>')
  })

  it('takes a quoted title whole, colon and all', async () => {
    expect((await read('---\ntitle: "Notes: part 2"\n---\nx\n')).title).toBe('Notes: part 2')
    // YAML escapes: '' inside single quotes, \" and \\ inside double quotes.
    expect((await read("---\ntitle: 'It''s here'\n---\nx\n")).title).toBe("It's here")
    expect((await read('---\ntitle: "Say \\"hi\\""\n---\nx\n')).title).toBe('Say "hi"')
  })

  it('is removed when it has no title, and sets none', async () => {
    const hub = await read('---\nlayout: post\ntags:\n  - a\n  - b\n# a comment\n\n---\nBody\n')
    expect(hub.title).toBeUndefined()
    expect(hub.html.trim()).toBe('<p>Body</p>')
  })

  it('may close with ...', async () => {
    const hub = await read('---\ntitle: Dots\n...\nBody\n')
    expect(hub.title).toBe('Dots')
    expect(hub.html.trim()).toBe('<p>Body</p>')
  })

  it('ignores a block title (| or >), which needs a YAML parser to read', async () => {
    const hub = await read('---\ntitle: >\n  Folded\n  title\n---\nBody\n')
    expect(hub.title).toBeUndefined()
    expect(hub.html.trim()).toBe('<p>Body</p>')
  })

  it('survives a BOM and Windows line endings', async () => {
    const hub = await read('﻿---\r\ntitle: Windows\r\n---\r\nBody\r\n')
    expect(hub.title).toBe('Windows')
    expect(hub.html.trim()).toBe('<p>Body</p>')
  })

  describe('leaves ordinary Markdown alone', () => {
    const unchanged = async (text: string) => {
      const on = await read(text)
      const off = await read(text, false)
      expect(on.html).toBe(off.html)
      expect(on.title).toBeUndefined()
    }
    it('a rule at the top with prose under it', () => unchanged('---\nSome prose here.\n---\nMore.\n'))
    it('a block that is never closed', () => unchanged('---\ntitle: Open\n\nBody text\n'))
    it('two rules with nothing between them', () => unchanged('---\n---\nBody\n'))
    it('front matter that is not at the very start', () => unchanged('Intro\n\n---\ntitle: Late\n---\n'))
    it('a closing line more than 200 lines down', () =>
      unchanged('---\n' + 'k: v\n'.repeat(201) + '---\nBody\n'))
  })

  it('applies to pasted Markdown too', async () => {
    const html = await renderEditableText('---\ntitle: Pasted\n---\nBody\n', 'md')
    expect(html).not.toContain('title: Pasted')
    expect(html).toContain('Body')
  })

  it('does not apply inside a notebook cell, where --- is a rule', async () => {
    const nb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'markdown', metadata: {}, source: ['---\n', 'title: kept\n', '---\n', 'Cell text\n'] }],
    }
    const hub = await readIpynb({ bytes: Buffer.from(JSON.stringify(nb)), filename: 'n.ipynb' })
    expect(hub.html).toContain('title: kept')
  })
})
