import { describe, it, expect, vi } from 'vitest'
import { pastedHtmlToHub, resolveRemoteImages } from '../../src/core/remote-images'
import { createConverter } from '../../src/core/convert'
import type { GuardedFetchDeps } from '../../src/core/net/guarded-fetch'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function deps(images: Record<string, Buffer>, address = '93.184.216.34'): GuardedFetchDeps {
  return {
    fetch: vi.fn(async (url: string) => {
      const body = images[url]
      if (!body) return new Response('missing', { status: 404 })
      return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'image/png' } })
    }),
    lookup: vi.fn(async () => [address]),
  }
}

describe('pastedHtmlToHub', () => {
  it('embeds a pasted remote image as a data URI', async () => {
    const d = deps({ 'https://example.com/chart.png': PNG })
    const out = await pastedHtmlToHub('<p>Sales</p><img src="https://example.com/chart.png" alt="chart">', d)
    expect(out).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`)
    expect(out).not.toContain('https://example.com/chart.png')
  })

  it('turns an image that cannot be fetched into its alt text, not an empty box', async () => {
    const out = await pastedHtmlToHub('<img src="https://example.com/gone.png" alt="org chart">', deps({}))
    expect(out).not.toContain('<img')
    expect(out).toContain('[image: org chart]')
  })

  it('refuses images on private addresses, like a fetched page does', async () => {
    const d = deps({ 'http://intranet.local/secret.png': PNG }, '10.0.0.5')
    const out = await pastedHtmlToHub('<img src="http://intranet.local/secret.png" alt="x">', d)
    expect(out).not.toContain('data:image/png')
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('cannot resolve a relative source, since a paste has no base URL', async () => {
    const d = deps({})
    const out = await pastedHtmlToHub('<img src="img/a.png" alt="a">', d)
    expect(out).toContain('[image: a]')
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('makes no request when the paste has no remote images', async () => {
    const d = deps({})
    const html = `<p>hi</p><img src="data:image/png;base64,${PNG.toString('base64')}">`
    const out = await pastedHtmlToHub(html, d)
    expect(out).toContain('data:image/png')
    expect(d.lookup).not.toHaveBeenCalled()
  })

  it('still sanitizes the paste', async () => {
    const out = await pastedHtmlToHub('<p onclick="x()">a<script>x()</script></p>', deps({}))
    expect(out).toBe('<p>a</p>')
  })

  it('skipping keeps the images already fetched and opens the paste at once', async () => {
    const skip = new AbortController()
    const d: GuardedFetchDeps = {
      fetch: vi.fn((url: string, init: RequestInit) => {
        if (url.endsWith('/fast.png')) {
          return Promise.resolve(new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } }))
        }
        // Hangs until skipped, like a dead host would until its timeout.
        return new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) return reject(new Error('aborted'))
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }),
      lookup: vi.fn(async () => ['93.184.216.34']),
    }
    const stages: string[] = []
    const html =
      '<img src="https://e.example/fast.png" alt="fast">' +
      '<img src="https://e.example/slow1.png" alt="slow one">' +
      '<img src="https://e.example/slow2.png" alt="slow two">'
    const started = Date.now()
    const pending = pastedHtmlToHub(
      html,
      d,
      {
        signal: skip.signal,
        onProgress: (stage) => {
          stages.push(stage)
          if (stage.startsWith('Fetched 1 ')) skip.abort()
        },
      },
      60_000,
    )
    const out = await pending
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(out).toContain('data:image/png;base64,')
    expect(out).toContain('[image: slow one]')
    expect(out).toContain('[image: slow two]')
    expect(stages[0]).toBe('Fetching 3 images')
    expect(stages.at(-1)).toBe('Fetched 3 of 3 images')
  })
})

describe('resolveRemoteImages', () => {
  it('embeds a document\'s remote images through the guarded fetcher', async () => {
    const d = deps({ 'https://example.com/fig.png': PNG })
    const out = await resolveRemoteImages('<p><img src="https://example.com/fig.png" alt="fig"></p>', 'html', d)
    expect(out).toContain(`data:image/png;base64,${PNG.toString('base64')}`)
  })

  it('fetches a protocol-relative source over https', async () => {
    const d = deps({ 'https://cdn.example.com/fig.png': PNG })
    const out = await resolveRemoteImages('<img src="//cdn.example.com/fig.png">', 'md', d)
    expect(out).toContain('data:image/png')
  })

  it('leaves relative sources for the writers', async () => {
    const d = deps({})
    const html = '<img src="images/fig.png" alt="fig">'
    expect(await resolveRemoteImages(html, 'html', d)).toBe(html)
    expect(d.lookup).not.toHaveBeenCalled()
  })

  it.each(['eml', 'msg', 'mbox'] as const)('never fetches an email\'s remote images (%s)', async (source) => {
    const d = deps({ 'https://tracker.example/open.gif': PNG })
    const out = await resolveRemoteImages('<img src="https://tracker.example/open.gif" alt="">', source, d)
    expect(d.lookup).not.toHaveBeenCalled()
    expect(d.fetch).not.toHaveBeenCalled()
    expect(out).not.toContain('tracker.example')
    expect(out).toContain('[image: not included]')
  })

  it('drops remote images when it has no network', async () => {
    const out = await resolveRemoteImages('<img src="https://example.com/fig.png" alt="fig">', 'html', undefined)
    expect(out).toContain('[image: fig]')
  })
})

describe('converter and remote images', () => {
  const render = vi.fn(async () => Buffer.from('%PDF'))
  const md = (s: string) => ({ bytes: Buffer.from(s, 'utf8') })

  it('embeds them at read time, so the html output stands alone', async () => {
    const conv = createConverter(render, { fetchImages: deps({ 'https://example.com/fig.png': PNG }) })
    const out = await conv.convert(md('![fig](https://example.com/fig.png)'), 'md', 'html')
    const html = out.parts[0].bytes.toString('utf8')
    expect(html).toContain('data:image/png;base64,')
    expect(html).not.toContain('https://example.com/fig.png')
  })

  it('a dead image host no longer fails a docx', async () => {
    const conv = createConverter(render, { fetchImages: deps({}) })
    const out = await conv.convert(md('before\n\n![gone](https://example.com/gone.png)\n\nafter'), 'md', 'docx')
    expect(out.parts[0].bytes.byteLength).toBeGreaterThan(0)
  })

  it('never hands a writer a remote image, even on a hub that skipped read()', async () => {
    const conv = createConverter(render)
    await conv.write({ html: '<p><img src="https://example.com/a.png" alt="a"></p>' }, 'pdf')
    const printed = render.mock.calls.at(-1)?.[0] as unknown as string
    expect(printed).not.toContain('https://example.com/a.png')
    expect(printed).toContain('[image: a]')
  })
})
