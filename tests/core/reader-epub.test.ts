import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readEpub } from '../../src/core/readers/epub'
import { detect } from '../../src/core/detect'

async function makeEpub(opts: { spineOrder?: string[] } = {}): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file(
    'META-INF/container.xml',
    '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  )
  const order = opts.spineOrder ?? ['ch1', 'ch2']
  zip.file(
    'OEBPS/content.opf',
    `<package><metadata><dc:title>Framing Protocol Handbook</dc:title></metadata>
     <manifest>
       <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
       <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
       <item id="css" href="style.css" media-type="text/css"/>
     </manifest>
     <spine>${order.map((id) => `<itemref idref="${id}"/>`).join('')}</spine></package>`,
  )
  zip.file(
    'OEBPS/ch1.xhtml',
    '<html><body><h1>Chapter One</h1><p>The handshake begins with a HELLO frame.</p><script>bad()</script></body></html>',
  )
  zip.file('OEBPS/ch2.xhtml', '<html><body><h1>Chapter Two</h1><p>Flow control uses credits.</p></body></html>')
  zip.file('OEBPS/style.css', 'body { color: red }')
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}

describe('readEpub', () => {
  it('concatenates spine chapters in order', async () => {
    const hub = await readEpub({ bytes: await makeEpub(), filename: 'book.epub' })
    expect(hub.html).toContain('Chapter One')
    expect(hub.html).toContain('Chapter Two')
    expect(hub.html.indexOf('Chapter One')).toBeLessThan(hub.html.indexOf('Chapter Two'))
  })

  it('honours a reordered spine', async () => {
    const hub = await readEpub({ bytes: await makeEpub({ spineOrder: ['ch2', 'ch1'] }) })
    expect(hub.html.indexOf('Chapter Two')).toBeLessThan(hub.html.indexOf('Chapter One'))
  })

  it('takes the title from OPF metadata and sanitizes chapter markup', async () => {
    const hub = await readEpub({ bytes: await makeEpub() })
    expect(hub.title).toBe('Framing Protocol Handbook')
    expect(hub.html).not.toContain('<script>')
    expect(hub.html).not.toContain('bad()')
  })

  /**
   * A spine href is a URI reference, so a filename with a space or a non-ASCII
   * character arrives percent-encoded. Looking the raw string up in the zip
   * misses, and the chapter used to vanish without a word.
   */
  it('finds a chapter whose href is percent-encoded', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/epub+zip')
    zip.file(
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    )
    zip.file(
      'OEBPS/content.opf',
      `<package><metadata><dc:title>Encoded</dc:title></metadata>
       <manifest>
         <item id="c1" href="chapter%201.xhtml" media-type="application/xhtml+xml"/>
         <item id="c2" href="%D0%B3%D0%BB%D0%B0%D0%B2%D0%B0.xhtml" media-type="application/xhtml+xml"/>
       </manifest>
       <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
    )
    zip.file('OEBPS/chapter 1.xhtml', '<html><body><p>Spaced chapter body.</p></body></html>')
    zip.file('OEBPS/глава.xhtml', '<html><body><p>Cyrillic chapter body.</p></body></html>')
    const bytes = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
    const hub = await readEpub({ bytes })
    expect(hub.html).toContain('Spaced chapter body.')
    expect(hub.html).toContain('Cyrillic chapter body.')
  })

  it('still finds a chapter whose filename really contains a percent sign', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/epub+zip')
    zip.file(
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    )
    zip.file(
      'OEBPS/content.opf',
      `<package><manifest><item id="c1" href="100%25.xhtml" media-type="application/xhtml+xml"/>
       <item id="c2" href="raw%zz.xhtml" media-type="application/xhtml+xml"/></manifest>
       <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
    )
    zip.file('OEBPS/100%.xhtml', '<html><body><p>Percent chapter.</p></body></html>')
    // Not valid percent-encoding at all: decodeURIComponent throws on it.
    zip.file('OEBPS/raw%zz.xhtml', '<html><body><p>Malformed escape chapter.</p></body></html>')
    const bytes = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
    const hub = await readEpub({ bytes })
    expect(hub.html).toContain('Percent chapter.')
    expect(hub.html).toContain('Malformed escape chapter.')
  })

  /**
   * The same two spellings apply to an image src — and this one was worse: the
   * decode was unguarded, so `<img src="100%.jpg">` threw a raw URIError out of
   * readEpub and one legally-named picture failed the whole book.
   */
  it('inlines an image whose src contains a literal or malformed percent', async () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    const zip = new JSZip()
    zip.file('mimetype', 'application/epub+zip')
    zip.file(
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    )
    zip.file(
      'OEBPS/content.opf',
      `<package><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
       <spine><itemref idref="c1"/></spine></package>`,
    )
    zip.file(
      'OEBPS/ch1.xhtml',
      '<html><body><p>Before.</p><img src="100%.png" alt="literal"/><img src="raw%zz.png" alt="malformed"/><img src="a%20b.png" alt="encoded"/><p>After.</p></body></html>',
    )
    zip.file('OEBPS/100%.png', PNG)
    zip.file('OEBPS/raw%zz.png', PNG)
    zip.file('OEBPS/a b.png', PNG)
    const bytes = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
    const hub = await readEpub({ bytes })
    expect(hub.html).toContain('Before.')
    expect(hub.html).toContain('After.')
    expect((hub.html.match(/src="data:image\/png;base64,/g) ?? []).length).toBe(3)
  })

  it('rewrites the src attribute and nothing else that happens to equal it', async () => {
    // The replacement used to be a blind split on `"<src>"`, so an alt (or any
    // attribute) with the same text as the src got a data URI written into it.
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    const zip = new JSZip()
    zip.file('mimetype', 'application/epub+zip')
    zip.file(
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    )
    zip.file(
      'OEBPS/content.opf',
      `<package><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
       <spine><itemref idref="c1"/></spine></package>`,
    )
    zip.file('OEBPS/ch1.xhtml', '<html><body><img alt="pic.png" src="pic.png"/><p>See "pic.png" above.</p></body></html>')
    zip.file('OEBPS/pic.png', PNG)
    const bytes = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
    const hub = await readEpub({ bytes })
    expect(hub.html).toContain('alt="pic.png"')
    expect(hub.html).toContain('See "pic.png" above.')
    expect(hub.html).toMatch(/src="data:image\/png;base64,/)
  })

  /**
   * A book quietly missing a chapter is the worst failure this converter has.
   * When the spine names a document the zip does not hold, say so in the
   * output rather than dropping it.
   */
  it('reports a chapter the zip does not contain instead of dropping it', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/epub+zip')
    zip.file(
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    )
    zip.file(
      'OEBPS/content.opf',
      `<package><manifest>
         <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
         <item id="gone" href="ch2.xhtml" media-type="application/xhtml+xml"/>
         <item id="css" href="style.css" media-type="text/css"/>
       </manifest>
       <spine><itemref idref="c1"/><itemref idref="gone"/><itemref idref="nosuchid"/></spine></package>`,
    )
    zip.file('OEBPS/ch1.xhtml', '<html><body><p>Present chapter.</p></body></html>')
    zip.file('OEBPS/style.css', 'body{}')
    const bytes = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
    const hub = await readEpub({ bytes })
    expect(hub.html).toContain('Present chapter.')
    expect(hub.html).toContain('ch2.xhtml')
    expect(hub.html.toLowerCase()).toContain('missing')
    // The unresolved spine idref is a dropped chapter too.
    expect(hub.html).toContain('nosuchid')
  })

  it('says nothing about non-document manifest items', async () => {
    // No spine, so the reader walks the whole manifest — stylesheets included.
    const hub = await readEpub({ bytes: await makeEpub({ spineOrder: [] }) })
    expect(hub.html).toContain('Chapter One')
    expect(hub.html.toLowerCase()).not.toContain('missing')
    expect(hub.html).not.toContain('style.css')
  })

  it('fails outright when every chapter is missing rather than returning a stub', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/epub+zip')
    zip.file(
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    )
    zip.file(
      'OEBPS/content.opf',
      `<package><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
       <spine><itemref idref="c1"/></spine></package>`,
    )
    const bytes = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
    await expect(readEpub({ bytes })).rejects.toMatchObject({ code: 'read-failed' })
  })

  it('rejects a zip that is not an epub', async () => {
    const zip = new JSZip()
    zip.file('a.txt', 'x')
    const bytes = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
    await expect(readEpub({ bytes })).rejects.toMatchObject({ code: 'read-failed' })
  })
})

describe('epub detection', () => {
  it('detects epub by mimetype and extension', async () => {
    expect(detect(await makeEpub())).toEqual({ kind: 'ok', format: 'epub' })
    expect(detect(Buffer.from('x'), 'book.epub')).toEqual({ kind: 'ok', format: 'epub' })
  })
})
