import { describe, it, expect } from 'vitest'
import { readOpml } from '../../src/core/readers/opml'
import { detect } from '../../src/core/detect'

const read = (text: string, filename = 'feeds.opml') => readOpml({ bytes: Buffer.from(text, 'utf8'), filename })

const FEEDS = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My &amp; feeds</title><ownerName>Someone</ownerName></head>
  <body>
    <outline text="News">
      <outline text="Example Daily" type="rss" xmlUrl="https://example.com/feed.xml" htmlUrl="https://example.com/"/>
      <outline title="Only a feed" xmlUrl="https://example.org/rss"/>
    </outline>
    <outline text="Plan">
      <outline text="Phase one">
        <outline text="Draft &lt;b&gt;spec&lt;/b&gt;" _note="Due Friday"/>
      </outline>
    </outline>
    <outline text="Unsafe" url="javascript:alert(1)"/>
  </body>
</opml>`

describe('OPML outlines', () => {
  it('takes the title from head and nests the outlines as lists', async () => {
    const hub = await read(FEEDS)
    expect(hub.title).toBe('My & feeds')
    expect(hub.html).toMatch(/^<h1>My &amp; feeds<\/h1>\n<ul>/)
    const body = hub.html.replace(/\s+/g, '')
    expect(body).toContain('<ul><li>News<ul><li><ahref="https://example.com/">ExampleDaily</a></li>')
    expect(body).toContain('<li>Plan<ul><li>Phaseone<ul><li>')
  })

  it('links the htmlUrl, else the url, else the feed', async () => {
    const hub = await read(FEEDS)
    expect(hub.html).toContain('<a href="https://example.com/">Example Daily</a>')
    expect(hub.html).toContain('<a href="https://example.org/rss">Only a feed</a>')
    expect(hub.html).not.toContain('javascript:')
    expect(hub.html).toContain('<li>Unsafe</li>')
  })

  it('shows outline text as text, and keeps a note', async () => {
    const hub = await read(FEEDS)
    expect(hub.html).toContain('Draft &lt;b&gt;spec&lt;/b&gt;<br><em>Due Friday</em>')
  })

  it('reads a deeply nested outline without overflowing the stack', async () => {
    const depth = 20000
    const xml = `<opml><body>${'<outline text="x">'.repeat(depth)}${'</outline>'.repeat(depth)}</body></opml>`
    const hub = await read(xml)
    expect(hub.html.match(/<li>/g)).toHaveLength(depth)
  })

  it('names the document after the file when head has no title', async () => {
    const hub = await read('<opml><body><outline text="a"/></body></opml>', 'list.opml')
    expect(hub.title).toBe('list.opml')
  })

  it('shows a file that is not an outline as XML', async () => {
    const hub = await read('<rss><channel><title>t</title></channel></rss>', 'odd.opml')
    expect(hub.html).toContain('<pre><code class="language-xml">')
  })

  it('is detected by extension', () => {
    const d = detect(Buffer.from('<opml/>'), 'subs.OPML')
    expect(d.kind === 'ok' && d.format).toBe('opml')
  })
})
