import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { writeEpub } from '../../src/core/writers/epub'
import { readEpub } from '../../src/core/readers/epub'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const book = (html: string, title = 'Framing Protocol'): { html: string; title: string } => ({ html, title })

async function open(bytes: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(bytes)
}

const text = async (zip: JSZip, name: string): Promise<string> => {
  const f = zip.files[name]
  if (!f) throw new Error(`missing ${name}`)
  return f.async('string')
}

describe('writeEpub container structure', () => {
  /**
   * Readers identify an epub by reading `mimetype` at a FIXED OFFSET in the
   * zip: it must be the first entry and it must be STORED, never deflated.
   * Getting this wrong is the most common way a generated epub simply refuses
   * to open, and no higher-level assertion would catch it — so check the raw
   * local file header rather than trusting JSZip's own view.
   */
  it('writes mimetype first, uncompressed, with the exact media type', async () => {
    const bytes = await writeEpub(book('<h1>One</h1><p>Body.</p>'))
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK')
    // Local file header: compression method is a 2-byte LE field at offset 8.
    expect(bytes.readUInt16LE(8)).toBe(0)
    const nameLen = bytes.readUInt16LE(26)
    const extraLen = bytes.readUInt16LE(28)
    expect(bytes.subarray(30, 30 + nameLen).toString('latin1')).toBe('mimetype')
    const start = 30 + nameLen + extraLen
    expect(bytes.subarray(start, start + 20).toString('latin1')).toBe('application/epub+zip')
  })

  it('points container.xml at an OPF that exists', async () => {
    const zip = await open(await writeEpub(book('<h1>One</h1><p>Body.</p>')))
    const container = await text(zip, 'META-INF/container.xml')
    const full = /full-path="([^"]+)"/.exec(container)?.[1]
    expect(full).toBeDefined()
    expect(zip.files[full as string]).toBeDefined()
  })

  it('resolves every spine idref and every manifest href', async () => {
    const zip = await open(await writeEpub(book('<h1>One</h1><p>A.</p><h1>Two</h1><p>B.</p>')))
    const opfPath = /full-path="([^"]+)"/.exec(await text(zip, 'META-INF/container.xml'))?.[1] as string
    const opf = await text(zip, opfPath)
    const dir = opfPath.slice(0, opfPath.lastIndexOf('/') + 1)

    const manifest = new Map<string, string>()
    for (const m of opf.matchAll(/<item\b[^>]*\/>/g)) {
      const id = /\bid="([^"]+)"/.exec(m[0])?.[1]
      const href = /\bhref="([^"]+)"/.exec(m[0])?.[1]
      if (id && href) manifest.set(id, href)
    }
    expect(manifest.size).toBeGreaterThan(0)
    for (const href of manifest.values()) expect(zip.files[dir + href]).toBeDefined()

    const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1])
    expect(spine.length).toBe(2)
    for (const idref of spine) expect(manifest.has(idref)).toBe(true)
  })

  it('declares the title and a unique identifier', async () => {
    const zip = await open(await writeEpub(book('<h1>One</h1><p>B.</p>', 'Framing Protocol')))
    const opfPath = /full-path="([^"]+)"/.exec(await text(zip, 'META-INF/container.xml'))?.[1] as string
    const opf = await text(zip, opfPath)
    expect(opf).toContain('<dc:title>Framing Protocol</dc:title>')
    expect(opf).toMatch(/<dc:identifier[^>]*>\S+<\/dc:identifier>/)
    expect(opf).toContain('<dc:language>')
  })
})

describe('writeEpub chapters', () => {
  const chapterCount = async (bytes: Buffer): Promise<number> => {
    const zip = await open(bytes)
    return Object.keys(zip.files).filter((n) => /ch\d+\.xhtml$/.test(n)).length
  }

  it('splits at top-level h1', async () => {
    expect(await chapterCount(await writeEpub(book('<h1>A</h1><p>1</p><h1>B</h1><p>2</p><h1>C</h1><p>3</p>')))).toBe(3)
  })

  /**
   * A book whose single h1 is its own title would otherwise become one
   * enormous chapter, so the split falls to h2. The lone h1 then leads the
   * document as a title page of its own — better than burying the book's title
   * inside its first chapter.
   */
  it('falls back to h2 when there are fewer than two h1', async () => {
    const zip = await open(await writeEpub(book('<h1>Book</h1><h2>A</h2><p>1</p><h2>B</h2><p>2</p>')))
    const nav = await text(zip, 'OEBPS/nav.xhtml')
    expect(nav).toContain('>A<')
    expect(nav).toContain('>B<')
    expect(await text(zip, 'OEBPS/ch001.xhtml')).toContain('Book')
    expect(Object.keys(zip.files).filter((n) => /ch\d+\.xhtml$/.test(n))).toHaveLength(3)
  })

  it('emits a single chapter for a document with no headings', async () => {
    expect(await chapterCount(await writeEpub(book('<p>Just prose.</p><p>More prose.</p>')))).toBe(1)
  })

  it('keeps content that appears before the first heading', async () => {
    const bytes = await writeEpub(book('<p>Front matter.</p><h1>A</h1><p>1</p><h1>B</h1><p>2</p>'))
    const recovered = await readEpub({ bytes })
    expect(recovered.html).toContain('Front matter.')
  })

  it('names chapters in the navigation from their headings', async () => {
    const zip = await open(await writeEpub(book('<h1>Framing</h1><p>1</p><h1>Flow Control</h1><p>2</p>')))
    const nav = await text(zip, 'OEBPS/nav.xhtml')
    expect(nav).toContain('Framing')
    expect(nav).toContain('Flow Control')
    const ncx = await text(zip, 'OEBPS/toc.ncx')
    expect(ncx).toContain('Flow Control')
  })
})

describe('writeEpub images', () => {
  it('extracts data URIs to files and rewrites the src', async () => {
    const zip = await open(
      await writeEpub(book(`<h1>A</h1><p><img src="data:image/png;base64,${PNG_B64}" alt="fig"></p>`)),
    )
    const media = Object.keys(zip.files).filter((n) => n.startsWith('OEBPS/images/') && !zip.files[n].dir)
    expect(media).toHaveLength(1)
    expect(media[0]).toMatch(/\.png$/)
    const chapter = await text(zip, 'OEBPS/ch001.xhtml')
    expect(chapter).not.toContain('data:image')
    expect(chapter).toContain('images/')
    const opf = await text(zip, 'OEBPS/content.opf')
    expect(opf).toContain('media-type="image/png"')
  })

  it('stores one copy of an image used in several chapters', async () => {
    const img = `<img src="data:image/png;base64,${PNG_B64}" alt="logo">`
    const zip = await open(await writeEpub(book(`<h1>A</h1><p>${img}</p><h1>B</h1><p>${img}</p>`)))
    expect(Object.keys(zip.files).filter((n) => n.startsWith('OEBPS/images/') && !zip.files[n].dir)).toHaveLength(1)
  })

  it('keeps genuinely different images apart', async () => {
    const zip = await open(
      await writeEpub(
        book(
          `<h1>A</h1><p><img src="data:image/png;base64,${PNG_B64}"></p>` +
            `<p><img src="data:image/gif;base64,${GIF_B64}"></p>`,
        ),
      ),
    )
    expect(Object.keys(zip.files).filter((n) => n.startsWith('OEBPS/images/') && !zip.files[n].dir)).toHaveLength(2)
  })

  it('leaves a remote image as a remote reference', async () => {
    const zip = await open(await writeEpub(book('<h1>A</h1><p><img src="https://example.com/x.png"></p>')))
    expect(Object.keys(zip.files).filter((n) => n.startsWith('OEBPS/images/') && !zip.files[n].dir)).toHaveLength(0)
    expect(await text(zip, 'OEBPS/ch001.xhtml')).toContain('https://example.com/x.png')
  })
})

describe('writeEpub XHTML validity', () => {
  /**
   * EPUB 2 and 3 both require well-formed XML, so an HTML5 void element like
   * <br> or <img> must be serialized self-closing and a bare & must be
   * escaped. A reader that hits a parse error shows nothing at all.
   */
  it('self-closes void elements and escapes bare ampersands', async () => {
    const zip = await open(await writeEpub(book('<h1>A &amp; B</h1><p>one<br>two</p><hr>')))
    const chapter = await text(zip, 'OEBPS/ch001.xhtml')
    expect(chapter).toMatch(/<br\s*\/>/)
    expect(chapter).toMatch(/<hr\s*\/>/)
    expect(chapter).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/)
  })

  it('declares the xhtml namespace and an xml prolog on every chapter', async () => {
    const zip = await open(await writeEpub(book('<h1>A</h1><p>1</p><h1>B</h1><p>2</p>')))
    for (const name of ['OEBPS/ch001.xhtml', 'OEBPS/ch002.xhtml', 'OEBPS/nav.xhtml']) {
      const xml = await text(zip, name)
      expect(xml.startsWith('<?xml')).toBe(true)
      expect(xml).toContain('xmlns="http://www.w3.org/1999/xhtml"')
    }
  })
})

describe('writeEpub round trip', () => {
  /**
   * The strongest cheap check available: an epub this app writes must be one
   * this app can read, using code that is already well covered.
   */
  it('recovers text and images through readEpub', async () => {
    const bytes = await writeEpub(
      book(
        `<h1>Framing</h1><p>The handshake begins with a HELLO frame.</p>` +
          `<p><img src="data:image/png;base64,${PNG_B64}" alt="fig"></p>` +
          `<h1>Flow Control</h1><p>Credits govern the sender.</p>`,
        'Framing Protocol',
      ),
    )
    const back = await readEpub({ bytes, filename: 'out.epub' })
    expect(back.title).toBe('Framing Protocol')
    expect(back.html).toContain('The handshake begins with a HELLO frame.')
    expect(back.html).toContain('Credits govern the sender.')
    expect(back.html).toContain('Framing')
    expect(back.html).toContain('Flow Control')
    // The reader inlines chapter images back to data URIs.
    expect(back.html).toContain('data:image/png;base64,')
  })

  it('keeps a table intact through the round trip', async () => {
    const bytes = await writeEpub(
      book('<h1>Rates</h1><table><tbody><tr><td>Stage</td><td>Owner</td></tr></tbody></table>'),
    )
    const back = await readEpub({ bytes })
    expect(back.html).toContain('<table')
    expect(back.html).toContain('Stage')
    expect(back.html).toContain('Owner')
  })
})

/**
 * Real books wrap each chapter's body in a <div> or <section>, so scanning only
 * the hub's top-level children found no headings at all: a 231-page corpus book
 * with 20 <h1> produced two chapters. Generic containers carry no meaning of
 * their own, so they are unwrapped before the split.
 */
describe('writeEpub headings inside wrappers', () => {
  const chapterCount = async (bytes: Buffer): Promise<number> => {
    const zip = await open(bytes)
    return Object.keys(zip.files).filter((n) => /ch\d+\.xhtml$/.test(n)).length
  }

  it('finds headings wrapped in a div', async () => {
    expect(
      await chapterCount(
        await writeEpub(book('<div><h1>A</h1><p>1</p></div><div><h1>B</h1><p>2</p></div>')),
      ),
    ).toBe(2)
  })

  it('finds headings wrapped several containers deep', async () => {
    expect(
      await chapterCount(
        await writeEpub(book('<section><div><h1>A</h1><p>1</p></div></section><section><h1>B</h1><p>2</p></section>')),
      ),
    ).toBe(2)
  })

  it('does not unwrap a container that is real content', async () => {
    // A <div> inside a list item or table cell is structural; only top-level
    // generic wrappers are transparent.
    const bytes = await writeEpub(book('<h1>A</h1><table><tbody><tr><td><div>cell</div></td></tr></tbody></table>'))
    const zip = await open(bytes)
    const chapter = await text(zip, 'OEBPS/ch001.xhtml')
    expect(chapter).toContain('<td>')
    expect(chapter).toContain('cell')
  })

  it('keeps every heading it finds in document order', async () => {
    const zip = await open(
      await writeEpub(book('<div><h1>Framing</h1><p>1</p></div><div><h1>Flow</h1><p>2</p></div>')),
    )
    const nav = await text(zip, 'OEBPS/nav.xhtml')
    expect(nav.indexOf('Framing')).toBeLessThan(nav.indexOf('Flow'))
  })
})

/**
 * A <span> holding block content is a wrapper, not inline markup — the corpus
 * book puts 13 of its 20 <h1> inside one. The hub allowlist strips every
 * attribute from a span, so such an element carries no meaning whatever; but
 * only spans that actually contain block content are unwrapped, so ordinary
 * inline spans are untouched.
 */
describe('writeEpub block content inside a span', () => {
  it('finds a heading wrapped in a span', async () => {
    const zip = await open(
      await writeEpub(book('<span><h1>A</h1><p>1</p></span><span><h1>B</h1><p>2</p></span>')),
    )
    expect(Object.keys(zip.files).filter((n) => /ch\d+\.xhtml$/.test(n))).toHaveLength(2)
  })

  it('leaves an inline span alone', async () => {
    const zip = await open(await writeEpub(book('<h1>A</h1><p>plain <span>inline</span> text</p>')))
    const chapter = await text(zip, 'OEBPS/ch001.xhtml')
    expect(chapter).toContain('<span>inline</span>')
  })
})
