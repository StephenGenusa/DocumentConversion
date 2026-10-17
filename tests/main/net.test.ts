import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { pinnedFetch, urlFetchDeps } from '../../src/main/net'
import { guardedFetch } from '../../src/core/net/guarded-fetch'

/*
 * The real fetcher, against a server on this machine. Nothing here reaches
 * the internet: every connection is to 127.0.0.1, either pinned there on
 * purpose or refused by the guard before it is made.
 */

let server: Server
let port = 0
const seen: { url: string; headers: IncomingHttpHeaders }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/picture' })
      res.end('moved')
      return
    }
    if (req.url === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
      res.end(gzipSync('unpacked'))
      return
    }
    if (req.url === '/hang') return // never answers
    res.writeHead(200, { 'content-type': 'image/png', 'x-two': ['a', 'b'] })
    res.end('picture')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

describe('pinnedFetch', () => {
  it('connects to the checked address, never to what the name resolves to now', async () => {
    // `pinned.invalid` resolves to nothing at all: reaching the server proves
    // the connection was made to the pinned address alone.
    const res = await pinnedFetch(`http://pinned.invalid:${port}/picture`, { headers: { 'user-agent': 'test' } }, { addresses: ['127.0.0.1'] })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('picture')
    const last = seen.at(-1)!
    expect(last.headers.host).toBe(`pinned.invalid:${port}`)
    expect(last.headers['user-agent']).toBe('test')
    expect(last.headers.cookie).toBeUndefined()
  })

  it('hands a redirect back rather than following it', async () => {
    const before = seen.length
    const res = await pinnedFetch(`http://pinned.invalid:${port}/redirect`, {}, { addresses: ['127.0.0.1'] })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/picture')
    expect(seen.length - before).toBe(1)
  })

  it('unpacks a compressed body', async () => {
    const res = await pinnedFetch(`http://pinned.invalid:${port}/gzip`, {}, { addresses: ['127.0.0.1'] })
    expect(await res.text()).toBe('unpacked')
  })

  it('stops when the signal fires', async () => {
    const res = pinnedFetch(`http://pinned.invalid:${port}/hang`, { signal: AbortSignal.timeout(50) }, { addresses: ['127.0.0.1'] })
    await expect(res).rejects.toThrow()
  })

  it('refuses to connect with no checked address', async () => {
    await expect(pinnedFetch(`http://pinned.invalid:${port}/picture`, {}, { addresses: [] })).rejects.toThrow()
  })
})

describe('guardedFetch over the real fetcher', () => {
  it('never connects to this machine, however it is named', async () => {
    const before = seen.length
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '127.0.0.2']) {
      await expect(guardedFetch(`http://${host}:${port}/picture`, urlFetchDeps), host).rejects.toMatchObject({ code: 'fetch-blocked' })
    }
    expect(seen.length).toBe(before)
  })

  it('never connects when a name resolves here (fake resolver)', async () => {
    const before = seen.length
    const deps = { ...urlFetchDeps, lookup: async () => ['127.0.0.1'] }
    await expect(guardedFetch(`http://images.example.com:${port}/picture`, deps)).rejects.toMatchObject({ code: 'fetch-blocked' })
    expect(seen.length).toBe(before)
  })
})
