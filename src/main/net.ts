import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { GuardedFetchDeps, PinnedHost } from '../core/net/guarded-fetch'

/** Statuses a Response may not carry a body with. */
const NULL_BODY = new Set([204, 205, 304])

/** The response's body, unpacked as a browser would. */
function decoded(res: IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
  if (encoding === 'gzip' || encoding === 'x-gzip') return res.pipe(createGunzip())
  if (encoding === 'deflate') return res.pipe(createInflate())
  if (encoding === 'br') return res.pipe(createBrotliDecompress())
  return res
}

/**
 * A GET that connects only to the addresses the guard checked.
 *
 * globalThis.fetch resolves the host again for itself, so between the guard's
 * lookup and the connection a name could change its answer from a public
 * address to 127.0.0.1 (DNS rebinding). Here the connection's own lookup is
 * the checked list, so what was checked is what is reached. The URL keeps its
 * host name, so the Host header, TLS server name and certificate check are
 * those of the name, as with any fetch. Redirects are never followed (the
 * guard follows them, one checked hop at a time) and no cookies are sent.
 */
export function pinnedFetch(url: string, init: RequestInit, pinned: PinnedHost): Promise<Response> {
  const addresses = pinned.addresses.filter((a) => isIP(a) !== 0)
  if (addresses.length === 0) return Promise.reject(new Error('no checked address to connect to'))
  const target = new URL(url)
  const lookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, addresses.map((address) => ({ address, family: isIP(address) })))
    else callback(null, addresses[0], isIP(addresses[0]))
  }
  const headers: Record<string, string> = { 'accept-encoding': 'gzip, deflate, br' }
  new Headers(init.headers).forEach((value, key) => (headers[key] = value))
  return new Promise<Response>((resolve, reject) => {
    const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      target,
      { method: 'GET', headers, lookup, agent: false, signal: init.signal ?? undefined },
      (res) => {
        const status = res.statusCode ?? 0
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(key, v)
        }
        // A redirect's body is never read: the guard only wants its location.
        const empty = NULL_BODY.has(status) || (status >= 300 && status < 400)
        if (empty) res.resume()
        try {
          const body = empty ? null : (Readable.toWeb(decoded(res)) as ReadableStream<Uint8Array>)
          resolve(new Response(body, { status, statusText: res.statusMessage, headers: responseHeaders }))
        } catch (err) {
          res.destroy()
          reject(err)
        }
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * The real network behind every guarded fetch main makes: a fetched page,
 * pasted images, a document's remote images at read time, and OCR packs.
 */
export const urlFetchDeps: GuardedFetchDeps = {
  fetch: pinnedFetch,
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((r) => r.address),
}
