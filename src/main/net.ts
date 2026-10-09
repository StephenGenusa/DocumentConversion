import { lookup as dnsLookup } from 'node:dns/promises'
import type { GuardedFetchDeps } from '../core/net/guarded-fetch'

/**
 * The real network behind every guarded fetch main makes: a fetched page,
 * pasted images, and a document's remote images at read time.
 */
export const urlFetchDeps: GuardedFetchDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((r) => r.address),
}
