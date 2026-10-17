import { describe, it, expect, vi } from 'vitest'
import { guardedFetch, isBlockedAddress, isPrivateAddress, type GuardedFetchDeps } from '../../src/core/net/guarded-fetch'

function page(body: string, contentType = 'text/html'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}
function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } })
}

interface Call {
  url: string
  init: RequestInit
}
type TestDeps = GuardedFetchDeps & { calls: Call[] }

/**
 * The injected fetch has to MODEL a fetch, not just answer with a body.
 *
 * A real fetch follows redirects by itself unless it is told `redirect:
 * 'manual'`, and that one word is the whole reason the guard sees every hop
 * and gets to validate it. A fake that ignores `init` answers a redirect the
 * same way whether the guard asked for manual handling or not — so deleting
 * `redirect: 'manual'` from guarded-fetch.ts leaves every test green while the
 * guard silently stops seeing where the bytes actually came from.
 *
 * So: honor `init.redirect`. Without 'manual', resolve the chain inside the
 * fake, exactly as a real fetch would, and hand back only the final response.
 */
function deps(routes: Record<string, () => Response>, ips: Record<string, string[]> = {}): TestDeps {
  const calls: Call[] = []
  const serve = (url: string): Response => {
    const route = routes[url]
    if (!route) throw new Error(`no route for ${url}`)
    return route()
  }
  return {
    calls,
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (init?.redirect === 'manual') return serve(url)
      let current = url
      for (let hop = 0; hop < 20; hop++) {
        const res = serve(current)
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
        if (!location) return res
        current = new URL(location, current).href
      }
      throw new Error('too many redirects')
    }),
    lookup: vi.fn(async (host: string) => ips[host] ?? ['93.184.216.34']),
  }
}

describe('isBlockedAddress', () => {
  it('blocks loopback, link-local (cloud metadata) and the unspecified address', () => {
    for (const ip of ['127.0.0.1', '127.255.255.254', '169.254.169.254', '169.254.1.1', '0.0.0.0', '0.1.2.3', '::1', '::', 'fe80::1']) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })
  it('allows the private ranges an intranet lives on (owner, 2026-10-16)', () => {
    for (const ip of ['10.0.0.5', '10.255.255.254', '172.16.0.9', '172.31.255.1', '192.168.0.1', '192.168.255.254', 'fc00::1', 'fd12:3456:789a::1', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })
  it("still blocks AWS's IPv6 metadata address, inside the allowed fc00::/7", () => {
    expect(isBlockedAddress('fd00:ec2::254')).toBe(true)
    expect(isBlockedAddress('fd00:0ec2:0:0:0:0:0:0254')).toBe(true)
    expect(isBlockedAddress('fd00:ec2::253')).toBe(false)
  })
  it('blocks the special-purpose IPv4 blocks that are neither the internet nor an intranet', () => {
    // Shared address space (CGNAT; Alibaba Cloud's metadata is 100.100.100.200),
    // IETF protocol assignments, documentation, benchmarking, multicast, and
    // the reserved class E block.
    for (const ip of ['100.64.0.1', '100.100.100.200', '100.127.255.254', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
    // The local-use NAT64 prefix (RFC 8215) alongside the well-known one.
    expect(isBlockedAddress('64:ff9b:1::7f00:1')).toBe(true)
    expect(isBlockedAddress('64:ff9b:1::808:808')).toBe(true)
  })
  it('passes public addresses', () => {
    // 192.0.77.2 is i0.wp.com: only 192.0.0/24 and 192.0.2/24 of 192.0/16 are special.
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.0.77.2', '198.17.0.1', '198.20.0.1', '2606:2800:220:1::1']) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })
  it('judges IPv4-mapped IPv6 as the IPv4 address it carries', () => {
    expect(isBlockedAddress('::ffff:192.168.1.1')).toBe(false)
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true)
  })

  // S1. Every spelling below denotes an address the guard already claims to
  // block; a textual prefix test only recognized the shortest spelling of each.
  it('blocks every spelling of IPv4-mapped loopback', () => {
    for (const ip of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1', // what WHATWG URL normalizes the dotted form to
      '0:0:0:0:0:ffff:127.0.0.1',
      '0000:0000:0000:0000:0000:ffff:7f00:0001',
      '::ffff:0:127.0.0.1', // IPv4-translated, ::ffff:0:0:0/96
      '::127.0.0.1', // deprecated IPv4-compatible
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it('judges IPv4-mapped addresses in hex spelling as the IPv4 address', () => {
    expect(isBlockedAddress('::ffff:a9fe:a9fe')).toBe(true) // 169.254.169.254
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true) // 127.0.0.1
    expect(isBlockedAddress('::ffff:c0a8:101')).toBe(false) // 192.168.1.1
    expect(isBlockedAddress('::ffff:0a00:0005')).toBe(false) // 10.0.0.5
  })

  it('blocks fully written loopback, unspecified and link-local', () => {
    for (const ip of [
      '0:0:0:0:0:0:0:1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '0:0:0:0:0:0:0:0',
      'FE80::1',
      'febf::1',
      'fe80::1%eth0', // zone id
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it('default-denies anything it cannot parse', () => {
    for (const ip of ['', ':', 'not-an-ip', '::1::2', 'fe80:::1', '12345::1', 'gggg::1', '1:2:3:4:5:6:7:8:9']) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it('still passes ordinary public IPv6', () => {
    for (const ip of ['2606:2800:220:1::1', '2001:4860:4860::8888', '::ffff:93.184.216.34']) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })
})

describe('guardedFetch', () => {
  it('fetches a page and reports content type and final url', async () => {
    const d = deps({ 'https://example.com/spec': () => page('<html>hi</html>') })
    const res = await guardedFetch('https://example.com/spec', d)
    expect(res.bytes.toString()).toContain('hi')
    expect(res.contentType).toContain('text/html')
    expect(res.finalUrl).toBe('https://example.com/spec')
  })

  it('rejects non-http(s) schemes', async () => {
    const d = deps({})
    await expect(guardedFetch('file:///C:/secret.txt', d)).rejects.toMatchObject({ code: 'fetch-failed' })
    await expect(guardedFetch('ftp://example.com/x', d)).rejects.toMatchObject({ code: 'fetch-failed' })
  })

  it('blocks literal loopback, link-local and unspecified addresses', async () => {
    const d = deps({})
    for (const u of ['http://127.0.0.1:8080/', 'http://127.1/', 'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/', 'http://[fd00:ec2::254]/']) {
      await expect(guardedFetch(u, d), u).rejects.toMatchObject({ code: 'fetch-blocked' })
    }
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('fetches from intranet addresses and single-label names', async () => {
    const png = (): Response => page('img', 'image/png')
    const d = deps(
      {
        'http://10.1.2.3/logo.png': png,
        'http://192.168.1.20/logo.png': png,
        'http://172.16.4.4/logo.png': png,
        'http://[fd12::7]/logo.png': png,
        'http://intranet/logo.png': png,
        'https://wiki.corp.example/logo.png': png,
      },
      { intranet: ['10.20.30.40'], 'wiki.corp.example': ['192.168.7.7'] },
    )
    for (const u of ['http://10.1.2.3/logo.png', 'http://192.168.1.20/logo.png', 'http://172.16.4.4/logo.png', 'http://[fd12::7]/logo.png', 'http://intranet/logo.png', 'https://wiki.corp.example/logo.png']) {
      expect((await guardedFetch(u, d)).bytes.toString(), u).toBe('img')
    }
  })

  it('refuses localhost by name, whatever the resolver says', async () => {
    const d = deps({ 'http://localhost/x': () => page('mine') }, { localhost: ['93.184.216.34'], 'app.localhost': ['93.184.216.34'] })
    for (const u of ['http://localhost/x', 'http://LOCALHOST./x', 'http://app.localhost/x']) {
      await expect(guardedFetch(u, d), u).rejects.toMatchObject({ code: 'fetch-blocked' })
    }
    expect(d.lookup).not.toHaveBeenCalled()
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('refuses a name that resolves to loopback or link-local, if any one of its addresses does', async () => {
    const d = deps(
      {},
      {
        'loop.example.com': ['127.0.0.1'],
        'loop6.example.com': ['::1'],
        'meta.example.com': ['169.254.169.254'],
        'll.example.com': ['fe80::1'],
        'mixed.example.com': ['93.184.216.34', '127.0.0.1'],
      },
    )
    for (const host of ['loop.example.com', 'loop6.example.com', 'meta.example.com', 'll.example.com', 'mixed.example.com']) {
      await expect(guardedFetch(`https://${host}/`, d), host).rejects.toMatchObject({ code: 'fetch-blocked' })
    }
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('pins the connection to the addresses it checked (DNS rebinding)', async () => {
    // The name answers a public address to the check and loopback after: the
    // fetch is told to connect to what was checked, and asks nothing again.
    const answers = [['93.184.216.34'], ['127.0.0.1']]
    const d = deps({ 'https://rebind.example.com/x': () => page('ok') })
    d.lookup = vi.fn(async () => answers.shift() ?? ['127.0.0.1'])
    await guardedFetch('https://rebind.example.com/x', d)
    expect(d.lookup).toHaveBeenCalledTimes(1)
    expect(vi.mocked(d.fetch).mock.calls[0][2]).toEqual({ addresses: ['93.184.216.34'] })
  })

  it('blocks a bracketed IPv6 loopback URL in every spelling', async () => {
    const d = deps({})
    // WHATWG URL rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1], so the guard
    // only ever sees the hex spelling of an IPv4-mapped host.
    for (const u of ['http://[::1]:8080/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fe80::1]/']) {
      await expect(guardedFetch(u, d), u).rejects.toMatchObject({ code: 'fetch-blocked' })
    }
  })

  it('blocks a hostname that resolves to an IPv6-mapped link-local address', async () => {
    const d = deps({}, { 'v6.example.com': ['::ffff:169.254.169.254'] })
    await expect(guardedFetch('https://v6.example.com/', d)).rejects.toMatchObject({ code: 'fetch-blocked' })
  })

  it('fetches from hostnames that resolve to private addresses', async () => {
    const d = deps({ 'https://internal.example.com/': () => page('inside') }, { 'internal.example.com': ['10.0.0.5'] })
    expect((await guardedFetch('https://internal.example.com/', d)).bytes.toString()).toBe('inside')
  })

  it('follows redirects itself, one hop at a time, and validates every hop', async () => {
    const d = deps({
      'https://example.com/a': () => redirect('https://example.com/b'),
      'https://example.com/b': () => page('final'),
    })
    const res = await guardedFetch('https://example.com/a', d)
    expect(res.bytes.toString()).toBe('final')
    expect(res.finalUrl).toBe('https://example.com/b')
    // Two fetches, not one: the guard resolved the redirect, so it had the
    // chance to check the host it was being sent to. One call here means the
    // hop was resolved inside fetch, out of the guard's sight.
    expect(d.calls.map((c) => c.url)).toEqual(['https://example.com/a', 'https://example.com/b'])
    expect(d.lookup).toHaveBeenCalledTimes(2)
  })

  it('asks for manual redirects, omits credentials and carries an abort signal on every hop', async () => {
    const d = deps({
      'https://example.com/a': () => redirect('https://example.com/b'),
      'https://example.com/b': () => page('final'),
    })
    await guardedFetch('https://example.com/a', d)
    expect(d.calls).toHaveLength(2)
    for (const call of d.calls) {
      expect(call.init.redirect, call.url).toBe('manual')
      expect(call.init.credentials, call.url).toBe('omit')
      expect(call.init.signal, call.url).toBeInstanceOf(AbortSignal)
      expect((call.init.headers as Record<string, string>)['user-agent']).toContain('Mozilla/5.0')
    }
  })

  it('blocks a redirect hop into loopback or link-local', async () => {
    // The blocked page ANSWERS: with the hop resolved inside fetch the guard
    // would return its bytes happily, which is the failure this must catch.
    for (const to of ['http://127.0.0.1/admin', 'http://[::1]/admin', 'http://localhost/admin', 'http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/x', 'https://sneaky.example.com/x']) {
      const d = deps(
        {
          'https://example.com/a': () => redirect(to),
          [to]: () => page('<html>internal secrets</html>'),
        },
        { 'sneaky.example.com': ['127.0.0.1'] },
      )
      await expect(guardedFetch('https://example.com/a', d), to).rejects.toMatchObject({ code: 'fetch-blocked' })
      expect(d.calls.map((c) => c.url), to).toEqual(['https://example.com/a'])
    }
  })

  it('follows a redirect hop into the intranet', async () => {
    const d = deps(
      {
        'https://example.com/a': () => redirect('https://intranet.corp/x'),
        'https://intranet.corp/x': () => page('<html>wiki</html>'),
      },
      { 'intranet.corp': ['192.168.10.10'] },
    )
    expect((await guardedFetch('https://example.com/a', d)).bytes.toString()).toContain('wiki')
  })

  it('aborts a hanging request instead of waiting forever', async () => {
    // Proves the signal it passes is a live one: the fake only ever settles
    // when the abort fires.
    const d: GuardedFetchDeps = {
      fetch: vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
      ),
      lookup: vi.fn(async () => ['93.184.216.34']),
    }
    await expect(guardedFetch('https://example.com/slow', d, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'fetch-failed',
    })
  })

  it('honors a caller signal that was already aborted before the call', async () => {
    // A listener never sees an abort that already happened; without checking
    // `aborted`, every fetch after a cancel ran to its full timeout.
    const d = deps({ 'https://example.com/a': () => new Response('ok') })
    const outer = new AbortController()
    outer.abort()
    await guardedFetch('https://example.com/a', d, { signal: outer.signal }).catch(() => undefined)
    expect(d.calls[0]?.init.signal?.aborted).toBe(true)
  })

  it('gives up after too many redirects', async () => {
    const d = deps({ 'https://example.com/loop': () => redirect('https://example.com/loop') })
    await expect(guardedFetch('https://example.com/loop', d)).rejects.toMatchObject({ code: 'fetch-failed' })
  })

  it('reports an unparseable redirect target as fetch-failed, not as an unexpected error', async () => {
    const d = deps({ 'https://example.com/a': () => redirect('http://[bad') })
    await expect(guardedFetch('https://example.com/a', d)).rejects.toMatchObject({ code: 'fetch-failed' })
  })

  it('rejects oversized responses', async () => {
    const d = deps({ 'https://example.com/big': () => page('x'.repeat(2048)) })
    await expect(guardedFetch('https://example.com/big', d, { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'fetch-too-large',
    })
  })

  it('rejects non-2xx statuses as fetch-failed', async () => {
    const d = deps({ 'https://example.com/404': () => new Response('nope', { status: 404 }) })
    await expect(guardedFetch('https://example.com/404', d)).rejects.toMatchObject({ code: 'fetch-failed' })
  })
})

describe('local network off (Settings → Web, spec 4.2)', () => {
  const off = { allowPrivate: false }
  const png = (): Response => page('img', 'image/png')

  it('isPrivateAddress names the intranet ranges, however they are spelled', () => {
    for (const ip of ['10.0.0.5', '172.16.0.9', '172.31.255.1', '192.168.0.1', 'fc00::1', 'fd12:3456:789a::1', '::ffff:10.0.0.1', '::ffff:c0a8:101', '64:ff9b::a00:1', '2002:0a00:0001::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['93.184.216.34', '172.32.0.1', '172.15.255.255', '192.169.0.1', '11.0.0.1', '2606:4700::1111', 'fe00::1']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('blocks the private ranges, by address and by a name that resolves into them', async () => {
    const d = deps({}, { 'wiki.corp.example': ['192.168.7.7'], 'mixed.example.com': ['93.184.216.34', '10.0.0.1'] })
    for (const u of ['http://10.1.2.3/logo.png', 'http://192.168.1.20/logo.png', 'http://172.16.4.4/logo.png', 'http://[fd12::7]/logo.png', 'http://[::ffff:10.0.0.1]/x', 'https://wiki.corp.example/logo.png', 'https://mixed.example.com/x']) {
      await expect(guardedFetch(u, d, off), u).rejects.toMatchObject({ code: 'fetch-blocked' })
    }
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('blocks a single-label name before any lookup, whatever it would resolve to', async () => {
    const d = deps({ 'http://intranet/logo.png': png }, { intranet: ['93.184.216.34'] })
    for (const u of ['http://intranet/logo.png', 'http://INTRANET./logo.png']) {
      await expect(guardedFetch(u, d, off), u).rejects.toMatchObject({ code: 'fetch-blocked', message: expect.stringMatching(/local network/) })
    }
    expect(d.lookup).not.toHaveBeenCalled()
  })

  it('blocks a redirect hop into the intranet', async () => {
    const d = deps(
      { 'https://example.com/a': () => redirect('https://intranet.corp/x'), 'https://intranet.corp/x': () => page('wiki') },
      { 'intranet.corp': ['192.168.10.10'] },
    )
    await expect(guardedFetch('https://example.com/a', d, off)).rejects.toMatchObject({ code: 'fetch-blocked' })
  })

  it('still fetches from the public internet', async () => {
    const d = deps({ 'https://example.com/logo.png': png })
    expect((await guardedFetch('https://example.com/logo.png', d, off)).bytes.toString()).toBe('img')
  })

  it('loopback and link-local stay blocked either way', async () => {
    const d = deps({})
    for (const opts of [off, { allowPrivate: true }, undefined]) {
      for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/', 'http://[fe80::1]/']) {
        await expect(guardedFetch(u, d, opts), u).rejects.toMatchObject({ code: 'fetch-blocked' })
      }
    }
  })
})
