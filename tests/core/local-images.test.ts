import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inlineLocalImages, isLocalImageSrc } from '../../src/core/local-images'
import { readMarkdown } from '../../src/core/readers/md'
import { readTextile } from '../../src/core/readers/textile'
import { readDjot } from '../../src/core/readers/djot'
import { createConverter } from '../../src/core/convert'

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4480000000049454e44ae426082',
  'hex',
)
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'

let root: string
let doc: string

beforeAll(async () => {
  // root/
  //   pics/up.png          ../pics/up.png from the document
  //   doc/
  //     assets/fig.svg
  //     assets/my fig.png
  //     assets/nested.svg  names ./fig.png beside itself
  //     assets/fig.png
  //     notes.txt          not a picture
  root = await mkdtemp(join(tmpdir(), 'local-images-'))
  doc = join(root, 'doc')
  await mkdir(join(doc, 'assets'), { recursive: true })
  await mkdir(join(root, 'pics'))
  await writeFile(join(doc, 'assets', 'fig.svg'), SVG)
  await writeFile(join(doc, 'assets', 'fig.png'), PNG)
  await writeFile(join(doc, 'assets', 'my fig.png'), PNG)
  await writeFile(
    join(doc, 'assets', 'nested.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="4" height="4"><image href="fig.png" width="4" height="4"/></svg>',
  )
  await writeFile(join(root, 'pics', 'up.png'), PNG)
  await writeFile(join(doc, 'notes.txt'), 'secret text, not a picture')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const md = async (text: string, ctx: { sourceDir?: string } = { sourceDir: doc }): Promise<string> =>
  (await readMarkdown({ bytes: Buffer.from(text, 'utf8'), filename: 'guide.md' }, ctx)).html

describe('isLocalImageSrc', () => {
  it('takes paths and file: URLs, and leaves data:, web addresses and shares alone', () => {
    for (const src of ['a.png', 'assets/a.png', '../a.png', '/abs/a.png', 'file:///abs/a.png', 'C:\\pics\\a.png', 'C:/pics/a.png']) {
      expect(isLocalImageSrc(src), src).toBe(true)
    }
    for (const src of ['', 'data:image/png;base64,AA', 'https://example.com/a.png', '//cdn.example.com/a.png', '\\\\host\\share\\a.png', 'file://host/share/a.png']) {
      expect(isLocalImageSrc(src), src).toBe(false)
    }
  })
})

describe('Markdown pictures by path', () => {
  it('embeds a relative SVG and PNG from the document folder', async () => {
    const html = await md('![chart](assets/fig.svg)\n\n![dot](assets/fig.png)\n')
    expect(html).toContain('src="data:image/svg+xml')
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).not.toContain('assets/')
  })

  it('reads ../ paths, absolute paths and file: URLs', async () => {
    const abs = join(root, 'pics', 'up.png')
    for (const ref of ['../pics/up.png', abs, pathToFileURL(abs).href]) {
      expect(await md(`![up](${ref})\n`), ref).toContain('src="data:image/png;base64,')
    }
  })

  it('reads a path with spaces, written either way Markdown allows', async () => {
    expect(await md('![a](<assets/my fig.png>)\n')).toContain('src="data:image/png;base64,')
    expect(await md('![a](assets/my%20fig.png)\n')).toContain('src="data:image/png;base64,')
  })

  it('reads a raw <img> and ignores a query or fragment', async () => {
    expect(await md('<img src="assets/fig.png" alt="raw">\n')).toContain('src="data:image/png;base64,')
    expect(await md('![q](assets/fig.png?raw=true#x)\n')).toContain('src="data:image/png;base64,')
  })

  it("embeds an SVG's own pictures by path, relative to the SVG", async () => {
    const html = await md('![n](assets/nested.svg)\n')
    const uri = /src="(data:image\/svg\+xml[^"]+)"/.exec(html)?.[1]
    expect(uri).toBeDefined()
    const svg = uri!.includes(';base64,')
      ? Buffer.from(uri!.split(',')[1], 'base64').toString('utf8')
      : decodeURIComponent(uri!.slice(uri!.indexOf(',') + 1))
    expect(svg).toContain('data:image/png;base64,')
  })

  it('leaves a missing file, a non-picture and a directory as their description', async () => {
    for (const ref of ['assets/missing.png', 'notes.txt', 'assets']) {
      const html = await md(`![lost ${ref}](${ref})\n`)
      expect(html, ref).not.toContain('<img')
      expect(html, ref).toContain(`lost ${ref}`)
      expect(html, ref).not.toContain('secret text')
    }
  })

  it('reads nothing from disk without a folder', async () => {
    const html = await md('![chart](assets/fig.png)\n', {})
    expect(html).not.toContain('data:image')
    expect(html).toContain('chart')
  })
})

describe('the other readers that name pictures by path', () => {
  it('Textile and Djot embed them too', async () => {
    const textile = await readTextile({ bytes: Buffer.from('!assets/fig.png!\n') }, { sourceDir: doc })
    expect(textile.html).toContain('src="data:image/png;base64,')
    const djot = await readDjot({ bytes: Buffer.from('![dot](assets/fig.png)\n') }, { sourceDir: doc })
    expect(djot.html).toContain('src="data:image/png;base64,')
  })
})

describe('through the converter', () => {
  it('a read with the folder keeps the picture for the editor and every writer', async () => {
    const converter = createConverter(async () => Buffer.alloc(0))
    const hub = await converter.read({ bytes: Buffer.from('![chart](assets/fig.svg)\n'), filename: 'guide.md' }, 'md', { sourceDir: doc })
    expect(hub.html).toContain('src="data:image/svg+xml')
  })

  it('a file: link keeps its text and loses its address', async () => {
    const html = await md('[notes](file:///etc/passwd)\n')
    expect(html).toContain('notes')
    expect(html).not.toContain('file:')
  })

  it('inlineLocalImages leaves html with no pictures untouched', async () => {
    const html = '<p>no pictures</p>'
    expect(await inlineLocalImages(html, { sourceDir: doc })).toBe(html)
  })
})
