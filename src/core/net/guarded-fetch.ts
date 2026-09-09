import { ConversionError } from '../errors'

export interface GuardedFetchDeps {
  /** fetch-compatible function; called with redirect:'manual' so every hop is validated. */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** Resolve a hostname to its IP addresses (injectable for tests). */
  lookup: (host: string) => Promise<string[]>
}

export interface GuardedFetchOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  signal?: AbortSignal
}

export interface GuardedFetchResult {
  bytes: Buffer
  contentType: string
  finalUrl: string
}

const DEFAULTS = { maxBytes: 10 * 1024 * 1024, timeoutMs: 20000, maxRedirects: 5 }

/* ------------------------------------------------------------------ *
 * Address classification
 *
 * An SSRF guard is only ever as good as its worst spelling. IPv6 gives the
 * same address many of them — `::ffff:127.0.0.1`, `::ffff:7f00:1` and
 * `0:0:0:0:0:ffff:127.0.0.1` are one address — and WHATWG URL parsing
 * rewrites the readable one into the hex one before the guard ever sees it,
 * so `new URL('http://[::ffff:127.0.0.1]/').hostname` is `[::ffff:7f00:1]`.
 * Matching text prefixes therefore cannot work; the address has to be parsed
 * to its sixteen bytes and judged there.
 *
 * The other half of the rule is that anything unparseable is refused. A guard
 * that returns "public" for input it did not understand is not a guard.
 * ------------------------------------------------------------------ */

/** The four octets of a dotted quad, or null if it is not one. */
function parseIpv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (!m) return null
  const octets = m.slice(1, 5).map(Number)
  return octets.every((o) => o <= 255) ? octets : null
}

/** Colon-separated groups to bytes; a trailing dotted quad fills the last two groups. */
function groupsToBytes(groups: string[]): number[] | null {
  const bytes: number[] = []
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    if (group.includes('.')) {
      if (i !== groups.length - 1) return null
      const quad = parseIpv4(group)
      if (!quad) return null
      bytes.push(...quad)
      continue
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    const word = parseInt(group, 16)
    bytes.push(word >> 8, word & 0xff)
  }
  return bytes
}

/** Expand any legal IPv6 spelling to its sixteen bytes, or null if it is not one. */
export function parseIpv6(input: string): number[] | null {
  const text = input.split('%')[0] // a zone id ("fe80::1%eth0") is not part of the address
  const halves = text.split('::')
  if (halves.length > 2) return null
  const split = (s: string): string[] => (s === '' ? [] : s.split(':'))

  if (halves.length === 1) {
    const bytes = groupsToBytes(split(halves[0]))
    return bytes && bytes.length === 16 ? bytes : null
  }

  const head = split(halves[0])
  const tail = split(halves[1])
  // A dotted quad is only ever the last thing in an address.
  if (head.some((g) => g.includes('.'))) return null
  const headBytes = groupsToBytes(head)
  const tailBytes = groupsToBytes(tail)
  if (!headBytes || !tailBytes) return null
  const zeros = 16 - headBytes.length - tailBytes.length
  if (zeros < 2 || zeros % 2 !== 0) return null // "::" stands for one group of zeros at least
  return [...headBytes, ...new Array<number>(zeros).fill(0), ...tailBytes]
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // Not private in name, but not the public internet either: shared address
  // space (CGNAT, RFC 6598 — routinely an ISP's or a company's inside),
  // IETF protocol assignments, benchmarking, multicast, and reserved class E.
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function isPrivateIpv6(b: number[]): boolean {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0)

  // Blocks that carry an IPv4 address inside them are that IPv4 address, and
  // must be judged as one however they are spelled.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(b.slice(12)) // ::ffff:0:0/96 mapped
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && zeros(10, 12)) return isPrivateIpv4(b.slice(12)) // ::ffff:0:0:0/96 translated
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) {
    return isPrivateIpv4(b.slice(12)) // 64:ff9b::/96 NAT64
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 1) {
    return true // 64:ff9b:1::/48 local-use NAT64 (RFC 8215): never global
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4(b.slice(2, 6)) // 2002::/16 6to4

  // ::/96 — the unspecified address, loopback, and the deprecated
  // IPv4-compatible block. Nothing routable lives here.
  if (zeros(0, 12)) return true
  if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true // ff00::/8 multicast
  if (b[0] === 0x01 && zeros(1, 8)) return true // 100::/64 discard-only
  return false
}

/**
 * Private / loopback / link-local / unspecified ranges, v4 and v6. Anything
 * this cannot parse is reported private, so an address we do not understand is
 * never fetched.
 */
export function isPrivateAddress(ip: string): boolean {
  const text = ip.trim()
  if (text.includes(':')) {
    const bytes = parseIpv6(text)
    return bytes ? isPrivateIpv6(bytes) : true
  }
  const octets = parseIpv4(text)
  return octets ? isPrivateIpv4(octets) : true
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
}

async function assertPublicHost(url: URL, lookup: GuardedFetchDeps['lookup']): Promise<void> {
  // URL brackets IPv6 hosts as [::1]
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const ips = isIpLiteral(host) ? [host] : await lookup(host)
  if (ips.length === 0) throw new ConversionError('fetch-failed', `Could not resolve ${host}`)
  for (const ip of ips) {
    if (isPrivateAddress(ip)) {
      throw new ConversionError('fetch-blocked', `Refusing to fetch from a private address (${host} -> ${ip})`)
    }
  }
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ConversionError('fetch-too-large', `${url} exceeds the ${maxBytes}-byte limit`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export async function guardedFetch(
  rawUrl: string,
  deps: GuardedFetchDeps,
  opts?: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const { maxBytes, timeoutMs, maxRedirects } = { ...DEFAULTS, ...opts }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = (): void => controller.abort()
  opts?.signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new ConversionError('fetch-failed', `Not a valid URL: ${rawUrl}`)
    }

    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ConversionError('fetch-failed', `Only http(s) URLs are supported (got ${url.protocol})`)
      }
      await assertPublicHost(url, deps.lookup)

      let res: Response
      try {
        res = await deps.fetch(url.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          },
          credentials: 'omit',
        })
      } catch (err) {
        if (err instanceof ConversionError) throw err
        throw new ConversionError('fetch-failed', `Fetch failed: ${(err as Error).message}`)
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new ConversionError('fetch-failed', `Redirect without location from ${url.href}`)
        try {
          url = new URL(location, url)
        } catch {
          throw new ConversionError('fetch-failed', `Redirect to an invalid URL from ${url.href}`)
        }
        continue
      }
      if (!res.ok) {
        throw new ConversionError('fetch-failed', `${url.href} returned HTTP ${res.status}`)
      }
      const bytes = await readCapped(res, maxBytes, url.href)
      return { bytes, contentType: res.headers.get('content-type') ?? '', finalUrl: url.href }
    }
    throw new ConversionError('fetch-failed', `Too many redirects (limit ${maxRedirects})`)
  } finally {
    clearTimeout(timer)
    opts?.signal?.removeEventListener('abort', onOuterAbort)
  }
}
