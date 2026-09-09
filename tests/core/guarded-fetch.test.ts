import { describe, it, expect, vi } from 'vitest'
import { guardedFetch, isPrivateAddress, type GuardedFetchDeps } from '../../src/core/net/guarded-fetch'

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
 * So: honour `init.redirect`. Without 'manual', resolve the chain inside the
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

describe('isPrivateAddress', () => {
  it('flags private/loopback/link-local ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.0.1', '169.254.1.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })
  it('flags the special-purpose IPv4 blocks that are not the public internet', () => {
    // Shared address space (CGNAT — routinely an ISP's or a company's inside),
    // IETF protocol assignments, benchmarking, multicast, and the reserved
    // class E block. None of them is a place a document image legitimately lives.
    for (const ip of ['100.64.0.1', '100.127.255.254', '192.0.0.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    // The local-use NAT64 prefix (RFC 8215) alongside the well-known one.
    expect(isPrivateAddress('64:ff9b:1::7f00:1')).toBe(true)
    expect(isPrivateAddress('64:ff9b:1::808:808')).toBe(true)
  })
  it('passes public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.63.255.255', '100.128.0.1', '198.17.0.1', '198.20.0.1', '2606:2800:220:1::1']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })
  it('unwraps IPv4-mapped IPv6', () => {
    expect(isPrivateAddress('::ffff:192.168.1.1')).toBe(true)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
  })

  // S1. Every spelling below denotes an address the guard already claims to
  // block; a textual prefix test only recognised the shortest spelling of each.
  it('blocks every spelling of IPv4-mapped loopback', () => {
    for (const ip of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1', // what WHATWG URL normalises the dotted form to
      '0:0:0:0:0:ffff:127.0.0.1',
      '0000:0000:0000:0000:0000:ffff:7f00:0001',
      '::ffff:0:127.0.0.1', // IPv4-translated, ::ffff:0:0:0/96
      '::127.0.0.1', // deprecated IPv4-compatible
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('blocks IPv4-mapped link-local metadata addresses in hex spelling', () => {
    expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true) // 169.254.169.254
    expect(isPrivateAddress('::ffff:c0a8:101')).toBe(true) // 192.168.1.1
    expect(isPrivateAddress('::ffff:0a00:0005')).toBe(true) // 10.0.0.5
  })

  it('blocks fully written loopback, unspecified, ULA and link-local', () => {
    for (const ip of [
      '0:0:0:0:0:0:0:1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '0:0:0:0:0:0:0:0',
      'fd12:3456:789a::1',
      'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'FE80::1',
      'febf::1',
      'fe80::1%eth0', // zone id
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('default-denies anything it cannot parse', () => {
    for (const ip of ['', ':', 'not-an-ip', '::1::2', 'fe80:::1', '12345::1', 'gggg::1', '1:2:3:4:5:6:7:8:9']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('still passes ordinary public IPv6', () => {
    for (const ip of ['2606:2800:220:1::1', '2001:4860:4860::8888', '::ffff:93.184.216.34']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
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

  it('blocks literal private IPs', async () => {
    const d = deps({})
    await expect(guardedFetch('http://192.168.1.1/admin', d)).rejects.toMatchObject({ code: 'fetch-blocked' })
    await expect(guardedFetch('http://127.0.0.1:8080/', d)).rejects.toMatchObject({ code: 'fetch-blocked' })
  })

  it('blocks a bracketed IPv6 loopback URL in every spelling', async () => {
    const d = deps({})
    // WHATWG URL rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1], so the guard
    // only ever sees the hex spelling of an IPv4-mapped host.
    for (const u of ['http://[::1]:8080/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fe80::1]/']) {
      await expect(guardedFetch(u, d), u).rejects.toMatchObject({ code: 'fetch-blocked' })
    }
  })

  it('blocks a hostname that resolves to an IPv6 private address', async () => {
    const d = deps({}, { 'v6.example.com': ['::ffff:169.254.169.254'] })
    await expect(guardedFetch('https://v6.example.com/', d)).rejects.toMatchObject({ code: 'fetch-blocked' })
  })

  it('blocks hostnames that resolve to private addresses', async () => {
    const d = deps({}, { 'internal.example.com': ['10.0.0.5'] })
    await expect(guardedFetch('https://internal.example.com/', d)).rejects.toMatchObject({
      code: 'fetch-blocked',
    })
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

  it('blocks a redirect hop into a private address', async () => {
    // The private page ANSWERS: with the hop resolved inside fetch the guard
    // would return its bytes happily, which is the failure this must catch.
    const d = deps(
      {
        'https://example.com/a': () => redirect('https://intranet.corp/x'),
        'https://intranet.corp/x': () => page('<html>internal secrets</html>'),
      },
      { 'intranet.corp': ['192.168.10.10'] },
    )
    await expect(guardedFetch('https://example.com/a', d)).rejects.toMatchObject({ code: 'fetch-blocked' })
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
