import { describe, it, expect, vi } from 'vitest'
import { pastedHtmlToHub, resolveRemoteImages } from '../../src/core/remote-images'
import { inlineImages } from '../../src/core/inline-images'
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

  it.each(['eml', 'msg', 'mbox', 'ics'] as const)('never fetches remote images in mail or an invitation (%s)', async (source) => {
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

describe('pictures an SVG names by address (<image href="https://…">)', () => {
  const render = vi.fn(async () => Buffer.from('%PDF'))
  const PHOTO = 'https://example.com/photo.png'
  const planSvg = (href = PHOTO): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#eee"/><image x="2" y="2" width="16" height="16" href="${href}"><title>Desk photo</title></image></svg>`
  const svgImg = (svg: string): string => `<p><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" alt="plan"></p>`
  /** The SVGs of every SVG <img> in the html, decoded. */
  const svgsIn = (html: string): string[] =>
    [...html.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'))
  const pngUri = `data:image/png;base64,${PNG.toString('base64')}`

  it('fetches them through the guarded fetcher and puts them in the SVG as data URIs', async () => {
    const d = deps({ [PHOTO]: PNG })
    const out = await resolveRemoteImages(svgImg(planSvg()), 'html', d)
    expect(d.fetch).toHaveBeenCalledTimes(1)
    const [svg] = svgsIn(out)
    expect(svg).toContain(`href="${pngUri}"`)
    expect(svg).not.toContain(PHOTO)
  })

  it.each(['eml', 'msg', 'mbox', 'ics'] as const)('never fetches them in mail or an invitation (%s)', async (source) => {
    const d = deps({ [PHOTO]: PNG })
    await resolveRemoteImages(svgImg(planSvg()), source, d)
    expect(d.lookup).not.toHaveBeenCalled()
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('refuses them on private addresses, like any other picture', async () => {
    const d = deps({ 'http://intranet.local/photo.png': PNG }, '10.0.0.5')
    const out = await resolveRemoteImages(svgImg(planSvg('http://intranet.local/photo.png')), 'html', d)
    expect(d.fetch).not.toHaveBeenCalled()
    expect(svgsIn(out)[0]).not.toContain('data:image/png')
  })

  it('counts them in the same budget as the <img>s', async () => {
    const fetcher = vi.fn(async () => ({ bytes: PNG, contentType: 'image/png' }))
    const html = `<img src="https://example.com/a.png" alt="a">${svgImg(planSvg())}`
    const out = await inlineImages(html, 'https://example.com/', fetcher, { maxImages: 1, maxPerImage: 1024, maxTotal: 1024 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('https://example.com/a.png')
    expect(svgsIn(out)[0]).toContain(PHOTO)
  })

  it('an .svg file: fetched where it is read; one that cannot be fetched becomes its description', async () => {
    const svg = { bytes: Buffer.from(planSvg() + ''), filename: 'plan.svg' }
    const fetched = await createConverter(render, { fetchImages: deps({ [PHOTO]: PNG }) }).read(svg, 'svg')
    expect(svgsIn(fetched.html)[0]).toContain(`href="${pngUri}"`)
    for (const conv of [createConverter(render, { fetchImages: deps({}) }), createConverter(render)]) {
      const [failed] = svgsIn((await conv.read(svg, 'svg')).html)
      expect(failed).not.toContain('<image')
      expect(failed).not.toContain('example.com')
      expect(failed).toContain('>[image: Desk photo]</text>')
    }
  })

  it('an SVG drawn inline in a page or a Markdown file: fetched too', async () => {
    const inline = planSvg().replace(' xmlns="http://www.w3.org/2000/svg" width="40" height="20">', ' width="40" height="20"><title>Reading room</title>')
    for (const [source, text] of [
      ['html', `<html><body><h1>Plan</h1>${inline}</body></html>`],
      ['md', `# Plan\n\n${inline}\n`],
    ] as const) {
      const d = deps({ [PHOTO]: PNG })
      const hub = await createConverter(render, { fetchImages: d }).read({ bytes: Buffer.from(text) }, source)
      expect(d.fetch, source).toHaveBeenCalledTimes(1)
      const svgs = svgsIn(hub.html)
      expect(svgs, source).toHaveLength(1)
      expect(svgs[0]).toContain(`href="${pngUri}"`)
      expect(hub.html).toContain('alt="Reading room"')
    }
  })

  it('the written document names no address, and the print window gets data URIs only', async () => {
    const conv = createConverter(render, { fetchImages: deps({}) })
    // A hub that skipped read(), still naming the address.
    await conv.write({ html: svgImg(planSvg()) }, 'pdf')
    const printed = render.mock.calls.at(-1)?.[0] as unknown as string
    for (const svg of svgsIn(printed)) expect(svg).not.toContain('example.com')
    expect(svgsIn(printed)[0]).toContain('[image: Desk photo]')
  })
})
