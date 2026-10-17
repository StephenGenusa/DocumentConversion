import { describe, it, expect, vi } from 'vitest'
import { pastedHtmlToHub, resolveRemoteImages } from '../../src/core/remote-images'
import { inlineImages } from '../../src/core/inline-images'
import { createConverter } from '../../src/core/convert'
import { loadUrl } from '../../src/core/readers/url'
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

/** A server where every picture is a PNG of `size` bytes, and `/page` is a page of `count` of them. */
function bigDeps(count: number, size: number): GuardedFetchDeps {
  const png = Buffer.alloc(size, 7)
  PNG.copy(png)
  const page = `<html><head><title>Gallery</title></head><body><article><h1>Gallery</h1><p>${'Every picture of the collection, in order. '.repeat(20)}</p>${Array.from({ length: count }, (_, i) => `<p><img src="/p/${i}.png" alt="p${i}"></p>`).join('')}</article></body></html>`
  return {
    fetch: vi.fn(async (url: string) =>
      url.endsWith('/page')
        ? new Response(page, { headers: { 'content-type': 'text/html' } })
        : new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } }),
    ),
    lookup: vi.fn(async () => ['93.184.216.34']),
  }
}

describe('no picture count or total (owner, 2026-10-16)', () => {
  const count = 120
  const size = 256 * 1024 // 120 x 256 KB = 30 MB, past the old 100 pictures and 25 MB
  const html = Array.from({ length: count }, (_, i) => `<img src="https://e.example/p/${i}.png" alt="p${i}">`).join('')

  it('a paste gets every picture', async () => {
    const out = await pastedHtmlToHub(html, bigDeps(count, size))
    expect(out.match(/data:image\/png/g)).toHaveLength(count)
    expect(out).not.toContain('[image:')
  })

  it("a document's remote pictures all arrive", async () => {
    const out = await resolveRemoteImages(html, 'html', bigDeps(count, size))
    expect(out.match(/data:image\/png/g)).toHaveLength(count)
  })

  it('a fetched web page gets every picture', async () => {
    const res = await loadUrl('https://e.example/page', bigDeps(count, size))
    expect(res.kind).toBe('html')
    expect(res.kind === 'html' && res.html.match(/data:image\/png/g)).toHaveLength(count)
  })

  it('a picture over the old 2 MB arrives', async () => {
    const out = await pastedHtmlToHub('<img src="https://e.example/p/big.png" alt="big">', bigDeps(1, 5 * 1024 * 1024))
    expect(out).toContain('data:image/png')
  })
})

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

  it('embeds images from the intranet (owner, 2026-10-16)', async () => {
    for (const [src, address] of [
      ['http://intranet/logo.png', '10.0.0.5'],
      ['http://wiki.corp/logo.png', '192.168.1.9'],
      ['http://10.1.2.3/logo.png', '10.1.2.3'],
    ]) {
      const d = deps({ [src]: PNG }, address)
      const out = await pastedHtmlToHub(`<img src="${src}" alt="x">`, d)
      expect(out, src).toContain('data:image/png')
    }
  })

  it('refuses images on loopback and link-local addresses, like a fetched page does', async () => {
    for (const [src, address] of [
      ['http://intranet.local/secret.png', '127.0.0.1'],
      ['http://localhost/secret.png', '93.184.216.34'],
      ['http://169.254.169.254/latest/meta-data/', '169.254.169.254'],
      ['http://[::1]/secret.png', '::1'],
      ['http://[fe80::1]/secret.png', 'fe80::1'],
    ]) {
      const d = deps({ [src]: PNG }, address)
      const out = await pastedHtmlToHub(`<img src="${src}" alt="x">`, d)
      expect(out, src).not.toContain('data:image/png')
      expect(d.fetch, src).not.toHaveBeenCalled()
    }
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

  it('refuses them on loopback addresses, like any other picture', async () => {
    const d = deps({ 'http://intranet.local/photo.png': PNG }, '127.0.0.1')
    const out = await resolveRemoteImages(svgImg(planSvg('http://intranet.local/photo.png')), 'html', d)
    expect(d.fetch).not.toHaveBeenCalled()
    expect(svgsIn(out)[0]).not.toContain('data:image/png')
  })

  it('fetches them along with the <img>s, every one', async () => {
    const fetcher = vi.fn(async () => ({ bytes: PNG, contentType: 'image/png' }))
    const html = `<img src="https://example.com/a.png" alt="a">${svgImg(planSvg())}`
    const out = await inlineImages(html, 'https://example.com/', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledWith('https://example.com/a.png')
    expect(fetcher).toHaveBeenCalledWith(PHOTO)
    expect(svgsIn(out)[0]).not.toContain(PHOTO)
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

describe('Settings → Web (spec 4.2, 8.1)', () => {
  const OFF = { fetchPictures: false, allowLocalNetwork: true }
  const NO_LAN = { fetchPictures: true, allowLocalNetwork: false }
  const two = '<p>a</p><img src="https://example.com/a.png" alt="chart"><img src="https://example.com/b.png" alt="logo">'
  /** A notice collector, as ctx.onAdvice. */
  const notices = () => {
    const seen: { kind: string; message: string }[] = []
    return { seen, onAdvice: (kind: string, message: string) => void seen.push({ kind, message }) }
  }

  it('fetch off: nothing is fetched, each picture is its description, and one notice says how many', async () => {
    const d = deps({ 'https://example.com/a.png': PNG, 'https://example.com/b.png': PNG })
    const n = notices()
    const out = await resolveRemoteImages(two, 'html', d, { web: OFF, onAdvice: n.onAdvice })
    expect(d.lookup).not.toHaveBeenCalled()
    expect(d.fetch).not.toHaveBeenCalled()
    expect(out).toContain('[image: chart]')
    expect(out).toContain('[image: logo]')
    expect(out).not.toContain('https://example.com/')
    expect(n.seen).toEqual([{ kind: 'pictures-not-fetched', message: '2 web pictures were not fetched (Settings → Web)' }])
  })

  it('fetch off: one picture is "1 web picture was"', async () => {
    const n = notices()
    await resolveRemoteImages('<img src="https://example.com/a.png" alt="a">', 'md', deps({}), { web: OFF, onAdvice: n.onAdvice })
    expect(n.seen.map((s) => s.message)).toEqual(['1 web picture was not fetched (Settings → Web)'])
  })

  it('fetch off: no notice for a document with no web pictures', async () => {
    const n = notices()
    await resolveRemoteImages('<p>no pictures</p>', 'html', deps({}), { web: OFF, onAdvice: n.onAdvice })
    expect(n.seen).toEqual([])
  })

  it.each(['eml', 'msg', 'mbox', 'ics'] as const)('mail and invitations are unchanged: never fetched, no notice (%s)', async (source) => {
    for (const web of [OFF, NO_LAN, undefined]) {
      const d = deps({ 'https://example.com/a.png': PNG })
      const n = notices()
      const out = await resolveRemoteImages(two, source, d, { web, onAdvice: n.onAdvice })
      expect(d.fetch).not.toHaveBeenCalled()
      expect(out).toContain('[image: chart]')
      expect(n.seen).toEqual([])
    }
  })

  it('local network off: an intranet picture is its description, a public one still arrives', async () => {
    const d: GuardedFetchDeps = {
      ...deps({ 'https://example.com/a.png': PNG, 'http://wiki.corp/b.png': PNG }),
      lookup: vi.fn(async (host: string) => (host === 'wiki.corp' ? ['10.1.1.1'] : ['93.184.216.34'])),
    }
    const html = '<img src="https://example.com/a.png" alt="public"><img src="http://wiki.corp/b.png" alt="intranet">'
    const out = await resolveRemoteImages(html, 'html', d, { web: NO_LAN })
    expect(out).toContain('data:image/png;base64,')
    expect(out).toContain('[image: intranet]')
    // With the setting on (the default) the intranet picture arrives too.
    const on = await resolveRemoteImages(html, 'html', d)
    expect(on).not.toContain('[image:')
  })

  it('a paste with fetch off: descriptions and the notice', async () => {
    const d = deps({ 'https://example.com/a.png': PNG })
    const n = notices()
    const out = await pastedHtmlToHub(two, d, { web: OFF, onAdvice: n.onAdvice })
    expect(d.fetch).not.toHaveBeenCalled()
    expect(out).toContain('[image: chart]')
    expect(n.seen.map((s) => s.message)).toEqual(['2 web pictures were not fetched (Settings → Web)'])
  })

  it('a paste with the local network off refuses an intranet picture', async () => {
    const d = deps({ 'http://intranet/logo.png': PNG }, '10.0.0.5')
    const out = await pastedHtmlToHub('<img src="http://intranet/logo.png" alt="logo">', d, { web: NO_LAN })
    expect(d.fetch).not.toHaveBeenCalled()
    expect(out).toContain('[image: logo]')
  })

  it('a web page with fetch off: the page is opened (the user asked for it), its pictures are not', async () => {
    const d = bigDeps(3, 64)
    const n = notices()
    const res = await loadUrl('https://e.example/page', d, { web: OFF, onAdvice: n.onAdvice })
    expect(res.kind).toBe('html')
    expect(d.fetch).toHaveBeenCalledTimes(1)
    expect(res.kind === 'html' && res.html).toContain('[image: p0]')
    expect(n.seen.map((s) => s.message)).toEqual(['3 web pictures were not fetched (Settings → Web)'])
  })

  it('a web page on the intranet is refused with the local network off', async () => {
    const d = deps({}, '192.168.1.5')
    await expect(loadUrl('http://wiki/page', d, { web: NO_LAN })).rejects.toMatchObject({ code: 'fetch-blocked' })
    await expect(loadUrl('https://wiki.corp.example/page', d, { web: NO_LAN })).rejects.toMatchObject({ code: 'fetch-blocked' })
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('a conversion with fetch off gives the notice through the converter', async () => {
    const d = deps({ 'https://example.com/fig.png': PNG })
    const conv = createConverter(vi.fn(async () => Buffer.from('%PDF')), { fetchImages: d })
    const n = notices()
    const out = await conv.convert({ bytes: Buffer.from('![fig](https://example.com/fig.png)') }, 'md', 'html', { web: OFF }, { onAdvice: n.onAdvice })
    expect(d.fetch).not.toHaveBeenCalled()
    expect(out.parts[0].bytes.toString('utf8')).toContain('[image: fig]')
    expect(n.seen).toEqual([{ kind: 'pictures-not-fetched', message: '1 web picture was not fetched (Settings → Web)' }])
  })
})
