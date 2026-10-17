import { ConversionError } from '../errors'

export interface GuardedFetchDeps {
  /**
   * fetch-compatible function; called with redirect:'manual' so every hop is
   * validated. It must connect only to one of `pinned.addresses`, the ones the
   * guard has just checked, never resolve the host again: a name that answers
   * a public address to the check and 127.0.0.1 to the connection (DNS
   * rebinding) would otherwise walk straight past the guard. main/net.ts does.
   */
  fetch: (url: string, init: RequestInit, pinned: PinnedHost) => Promise<Response>
  /** Resolve a hostname to its IP addresses (injectable for tests). */
  lookup: (host: string) => Promise<string[]>
}

/** The addresses a host was checked at; the connection is made to one of these. */
export interface PinnedHost {
  addresses: string[]
}

export interface GuardedFetchOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  signal?: AbortSignal
  /**
   * Whether the local network may be fetched from: the private ranges and
   * single-label names (Settings → Web, "Allow pictures from your local
   * network"). On when not given. Loopback, link-local and the other blocked
   * addresses are refused either way.
   */
  allowPrivate?: boolean
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

/*
 * What is allowed and what is not (owner, 2026-10-16). The public internet,
 * and the private networks a company's intranet lives on: 10/8, 172.16/12,
 * 192.168/16, fc00::/7, and single-label names ("http://intranet/logo.png"),
 * which are judged by the address they resolve to like any other name.
 *
 * Blocked, because nothing a document legitimately shows lives there and
 * something worth stealing often does: this machine (loopback, `localhost`),
 * link-local, which is where the cloud metadata services that hand out
 * credentials answer (169.254.169.254; fd00:ec2::254 for AWS over IPv6,
 * which sits inside the otherwise allowed fc00::/7), the unspecified
 * address, multicast, and the reserved and special-purpose blocks. Shared
 * address space (100.64/10, CGNAT) stays blocked too: it is an ISP's inside
 * rather than a company's, and Alibaba Cloud's metadata service is
 * 100.100.100.200.
 */

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets
  if (a === 0 || a === 127) return true // "this network", loopback
  if (a === 169 && b === 254) return true // link-local, cloud metadata
  // Not the public internet, and not an intranet either: shared address
  // space (CGNAT, RFC 6598), IETF protocol assignments, benchmarking,
  // multicast, and reserved class E.
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return true // 192.0.0/24, 192.0.2/24 only: 192.0.64/18 is WordPress's
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function isBlockedIpv6(b: number[]): boolean {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0)

  // Blocks that carry an IPv4 address inside them are that IPv4 address, and
  // must be judged as one however they are spelled.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIpv4(b.slice(12)) // ::ffff:0:0/96 mapped
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && zeros(10, 12)) return isBlockedIpv4(b.slice(12)) // ::ffff:0:0:0/96 translated
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) {
    return isBlockedIpv4(b.slice(12)) // 64:ff9b::/96 NAT64
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 1) {
    return true // 64:ff9b:1::/48 local-use NAT64 (RFC 8215): never global
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIpv4(b.slice(2, 6)) // 2002::/16 6to4

  // ::/96 — the unspecified address, loopback, and the deprecated
  // IPv4-compatible block. Nothing routable lives here.
  if (zeros(0, 12)) return true
  // fd00:ec2::254, AWS's metadata service over IPv6, inside fc00::/7.
  if (b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2 && zeros(4, 14) && b[14] === 0x02 && b[15] === 0x54) return true
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true // ff00::/8 multicast
  if (b[0] === 0x01 && zeros(1, 8)) return true // 100::/64 discard-only
  return false
}

/**
 * Loopback / link-local / unspecified / multicast / reserved ranges, v4 and
 * v6. Anything this cannot parse is reported blocked, so an address we do not
 * understand is never fetched.
 */
export function isBlockedAddress(ip: string): boolean {
  const text = ip.trim()
  if (text.includes(':')) {
    const bytes = parseIpv6(text)
    return bytes ? isBlockedIpv6(bytes) : true
  }
  const octets = parseIpv4(text)
  return octets ? isBlockedIpv4(octets) : true
}

/** 10/8, 172.16/12, 192.168/16: the IPv4 ranges an intranet lives on. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * An address on a local network: the private IPv4 ranges, IPv6 unique local
 * (fc00::/7), and a private IPv4 address carried inside IPv6 (mapped,
 * translated, NAT64, 6to4), judged as the IPv4 address it is. These are
 * allowed unless the local-network setting is off (`allowPrivate`).
 */
export function isPrivateAddress(ip: string): boolean {
  const text = ip.trim()
  if (!text.includes(':')) {
    const octets = parseIpv4(text)
    return octets ? isPrivateIpv4(octets) : false
  }
  const b = parseIpv6(text)
  if (!b) return false
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0)
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(b.slice(12))
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && zeros(10, 12)) return isPrivateIpv4(b.slice(12))
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return isPrivateIpv4(b.slice(12))
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4(b.slice(2, 6))
  return (b[0] & 0xfe) === 0xfc
}

/**
 * Names that mean this machine whatever DNS says (RFC 6761): refused before
 * any lookup, so a resolver that answers `localhost` with something else
 * changes nothing.
 */
function isBlockedName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  return name === 'localhost' || name.endsWith('.localhost')
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
}

/**
 * A name with no dot ("intranet"): it can only mean a host on the local
 * network, found through the system's search domains, so with the local
 * network off it is refused by name, before any lookup.
 */
function isSingleLabelName(host: string): boolean {
  return !isIpLiteral(host) && !host.replace(/\.$/, '').includes('.')
}

const LOCAL_NETWORK_OFF = 'the local network is turned off in Settings → Web'

/** The host's addresses, every one of them checked; the fetch is pinned to these. */
async function allowedAddresses(url: URL, lookup: GuardedFetchDeps['lookup'], allowPrivate: boolean): Promise<string[]> {
  // URL brackets IPv6 hosts as [::1]
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isBlockedName(host)) {
    throw new ConversionError('fetch-blocked', `Refusing to fetch from this computer (${host})`)
  }
  if (!allowPrivate && isSingleLabelName(host)) {
    throw new ConversionError('fetch-blocked', `Refusing to fetch from ${host}: ${LOCAL_NETWORK_OFF}`)
  }
  const ips = isIpLiteral(host) ? [host] : await lookup(host)
  if (ips.length === 0) throw new ConversionError('fetch-failed', `Could not resolve ${host}`)
  for (const ip of ips) {
    if (isBlockedAddress(ip)) {
      throw new ConversionError(
        'fetch-blocked',
        `Refusing to fetch from a loopback, link-local or reserved address (${host} -> ${ip})`,
      )
    }
    if (!allowPrivate && isPrivateAddress(ip)) {
      throw new ConversionError('fetch-blocked', `Refusing to fetch from ${host} (${ip}): ${LOCAL_NETWORK_OFF}`)
    }
  }
  return ips
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
  const allowPrivate = opts?.allowPrivate !== false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = (): void => controller.abort()
  opts?.signal?.addEventListener('abort', onOuterAbort, { once: true })
  // A signal that fired before this call never fires again, so the listener
  // alone would let a canceled job's later fetches each run to the timeout.
  if (opts?.signal?.aborted) controller.abort()

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
      const addresses = await allowedAddresses(url, deps.lookup, allowPrivate)

      let res: Response
      try {
        res = await deps.fetch(
          url.href,
          {
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            },
            credentials: 'omit',
          },
          { addresses },
        )
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
