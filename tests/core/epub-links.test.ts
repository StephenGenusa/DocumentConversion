import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { readEpub } from '../../src/core/readers/epub'

const CORPUS = join(__dirname, '../corpus')

/**
 * An epub's chapters are separate files inside the zip, and they cross-refer to
 * each other: `href="p8chap1.xhtml#chap-016"`. Concatenating the spine into one
 * hub document leaves those hrefs pointing at files that exist nowhere, and the
 * anchors they aim at are gone too — the hub allowlist permits no `id`, so all
 * 73 targets in one corpus chapter were stripped while 260 links survived.
 *
 * Rendered, a relative href resolves against whatever directory the output
 * happens to sit in, so the book's cross-references became links into the
 * converter's own temporary files. A link that cannot work is worse than no
 * link: the text is kept, the dead affordance is not.
 */
async function epubWithLinks(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file(
    'META-INF/container.xml',
    '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
  )
  zip.file(
    'OPS/book.opf',
    `<package><metadata><dc:title>Linked Book</dc:title></metadata>
     <manifest>
       <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
       <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
     </manifest>
     <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
  )
  zip.file(
    'OPS/c1.xhtml',
    `<html><body>
       <p>See <a href="c2.xhtml#sec-2">Chapter Two</a> for the details.</p>
       <p>Also <a href="../OPS/c2.xhtml">the whole chapter</a>.</p>
       <p>Jump to <a href="#local">a local anchor</a>.</p>
       <p>Read <a href="https://example.com/spec">the spec</a> online.</p>
       <p>Mail <a href="mailto:editor@example.com">the editor</a>.</p>
       <p>An <a href="c2.xhtml#x"><em>emphasised</em> cross-reference</a> here.</p>
     </body></html>`,
  )
  zip.file('OPS/c2.xhtml', '<html><body><h1 id="sec-2">Chapter Two</h1><p>Body.</p></body></html>')
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}

describe('epub internal links', () => {
  it('keeps the text of a cross-reference but not the dead link', async () => {
    const { html } = await readEpub({ bytes: await epubWithLinks() })
    expect(html).toContain('See Chapter Two for the details.')
    expect(html).not.toContain('c2.xhtml')
  })

  it('drops a same-document fragment link, whose target the allowlist strips', async () => {
    const { html } = await readEpub({ bytes: await epubWithLinks() })
    expect(html).toContain('Jump to a local anchor.')
    expect(html).not.toContain('href="#local"')
  })

  it('keeps external http and mailto links intact', async () => {
    const { html } = await readEpub({ bytes: await epubWithLinks() })
    expect(html).toContain('<a href="https://example.com/spec">the spec</a>')
    expect(html).toContain('<a href="mailto:editor@example.com">the editor</a>')
  })

  it('keeps markup inside an unwrapped cross-reference', async () => {
    const { html } = await readEpub({ bytes: await epubWithLinks() })
    expect(html).toContain('<em>emphasised</em> cross-reference')
    expect(html).not.toContain('<a href="c2.xhtml#x"')
  })

  it('leaves no relative link in the real corpus book', async () => {
    const file = join(CORPUS, 'inference-notes.epub')
    if (!existsSync(file)) return
    const bytes = await readFile(file)
    const { html } = await readEpub({ bytes, filename: 'inference-notes.epub' })
    const hrefs = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)].map((m) => m[1])
    const relative = hrefs.filter((h) => !/^(https?|mailto):/i.test(h))
    expect(relative).toEqual([])
    // The external references are content and must survive.
    expect(hrefs.length).toBeGreaterThan(0)
    // The book's prose is untouched — only the dead affordance went.
    expect(html).toContain('example.com/papers')
  })
})

/** The corpus book, read once per assertion; skipped if the fixture is absent. */
async function corpusBook(): Promise<string> {
  const bytes = await readFile(join(CORPUS, 'inference-notes.epub'))
  return (await readEpub({ bytes, filename: 'inference-notes.epub' })).html
}

/**
 * Chapter images. `inlineChapterImages` resolves a relative src against the
 * chapter's own path and rewrites it to a data URI; before this fixture carried
 * any <img>, the whole function ran zero times.
 */
describe.skipIf(!existsSync(join(CORPUS, 'inference-notes.epub')))('epub: chapter images', () => {
  it('inlines a relative figure as a data URI', async () => {
    const html = await corpusBook()
    expect(html).toMatch(/<img[^>]+src="data:image\/png;base64,[A-Za-z0-9+/=]+"/)
    expect(html).toContain('alt="throughput against batch size"')
  })

  it('resolves a src that needs percent-decoding to match the archive entry', async () => {
    // Stored as "figure two.png", referenced as "figure%20two.png".
    const html = await corpusBook()
    expect(html).toContain('alt="latency"')
    expect(html).not.toMatch(/src="[^"]*figure%20two\.png"/)
  })

  /*
   * Pins CURRENT behaviour, which is a known defect, not the desired one.
   *
   * An <img> whose target is not in the archive keeps its relative src, so the
   * reader emits a path that resolves to nothing and the viewer draws a broken
   * icon. remaining_work.md section 3 records this for the markdown and
   * notebook readers and notes that it should degrade to alt text, the way
   * sanitizeToHub already does for a src-less <img> and the html reader does
   * for unresolvable paths; the epub reader has it too.
   *
   * When that is fixed, this test fails and should be inverted — which is the
   * point of pinning it.
   */
  it('resolves every image it can, and leaves the unresolvable one dangling', async () => {
    const html = await corpusBook()
    const srcs = [...html.matchAll(/<img[^>]+src="([^"]*)"/g)].map((m) => m[1])
    expect(srcs.filter((s) => s.startsWith('data:')).length).toBe(3)
    expect(srcs.filter((s) => !s.startsWith('data:'))).toEqual(['images/missing-figure.png'])
  })
})
