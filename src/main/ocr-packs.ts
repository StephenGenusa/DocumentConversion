import { app } from 'electron'
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { lookup as dnsLookup } from 'node:dns/promises'
import { guardedFetch } from '../core/net/guarded-fetch'
import { installPack, packPathIn, type PackFetch } from '../ocr/pack-install'
import { installedLanguages, packIsGzipped, resolvePack } from '../ocr/resolve-pack'
import { LANGUAGES, downloadUrl, findLanguage, type ModelSet } from '../ocr/languages'
import { digestFor } from '../ocr/checksums.generated'
import { ocrLangDir } from './ocr-host'

/**
 * Downloading and managing OCR language packs.
 *
 * The fetch goes through `guardedFetch`, so the SSRF protection, redirect
 * handling and IPv6 classification already fought for on the URL reader apply
 * here too. There is no reason for a model download to be less careful than a
 * page fetch - it is the same act with a more dangerous payload.
 */

/** Downloads live in userData, which is writable and survives an upgrade. */
export function userPackDir(): string {
  return join(app.getPath('userData'), 'ocr')
}

const fs = {
  writeFile: (path: string, bytes: Buffer) => writeFile(path, bytes),
  rename: (from: string, to: string) => rename(from, to),
  unlink: (path: string) => unlink(path),
  mkdir: async (path: string) => void (await mkdir(path, { recursive: true })),
}

/** The same address resolution the URL reader is given. */
const netDeps = {
  fetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
  lookup: async (host: string): Promise<string[]> =>
    (await dnsLookup(host, { all: true })).map((a) => a.address),
}

const fetchPack =
  (signal?: AbortSignal): PackFetch =>
  async (url) => {
    try {
      // A pack is larger than a web page, so the default 10 MB budget would
      // refuse the bigger `best` models outright.
      const result = await guardedFetch(url, netDeps, { signal, maxBytes: 64 * 1024 * 1024 })
      return { ok: true, bytes: result.bytes }
    } catch (err) {
      return { ok: false, error: (err as Error).message, cancelled: signal?.aborted }
    }
  }

export interface PackListing {
  code: string
  name: string
  script: string
  installed: boolean
  source?: 'bundled' | 'downloaded'
  set?: ModelSet
  size: { fast: number; best: number }
}

export function listPacks(): PackListing[] {
  const shared = { bundledDir: ocrLangDir(), userDir: userPackDir(), exists: existsSync }
  return LANGUAGES.map((language) => {
    const fast = resolvePack({ ...shared, language: language.code, set: 'fast' })
    const best = resolvePack({ ...shared, language: language.code, set: 'best' })
    const found = fast ?? best
    return {
      code: language.code,
      name: language.name,
      script: language.script,
      installed: found !== null,
      source: found?.source,
      set: fast ? 'fast' : best ? 'best' : undefined,
      size: language.size,
    }
  })
}

/**
 * Where the pipeline should look for a language, and whether that file is
 * gzipped. Both travel together because getting the second wrong is an ENOENT
 * on the first.
 */
export function langPathFor(language: string, set: ModelSet = 'fast'): { dir: string; gzip: boolean } {
  const resolved = resolvePack({
    language,
    set,
    bundledDir: ocrLangDir(),
    userDir: userPackDir(),
    exists: existsSync,
  })
  if (!resolved) return { dir: ocrLangDir(), gzip: true }
  return { dir: resolved.dir, gzip: packIsGzipped(resolved.file) }
}

export function installedCodes(): Array<{ code: string; source: 'bundled' | 'downloaded' }> {
  return installedLanguages(LANGUAGES.map((l) => l.code), {
    set: 'fast',
    bundledDir: ocrLangDir(),
    userDir: userPackDir(),
    exists: existsSync,
  })
}

/**
 * Fetch and install one pack.
 *
 * The checksum comes from the catalogue when it has one. It does NOT have one
 * yet: generating the table means downloading all 25 languages in both model
 * sets and recording their digests, which is a deliberate step and not
 * something to fake with a placeholder. Until that exists the install refuses
 * rather than accepting an unverified model - the alternative is a download
 * that looks verified and is not, which is worse than no feature.
 */
export async function downloadPack(
  code: string,
  set: ModelSet,
  sha256Override: string | undefined,
  signal?: AbortSignal,
): Promise<{ kind: 'ok'; path: string } | { kind: 'error'; message: string } | { kind: 'cancelled' }> {
  const language = findLanguage(code)
  if (!language) return { kind: 'error', message: `Unknown OCR language "${code}".` }
  // The digest comes from the generated table, not from the renderer. A caller
  // supplying its own would defeat the point of verifying at all.
  const sha256 = digestFor(code, set)?.sha256 ?? sha256Override
  if (!sha256) {
    return {
      kind: 'error',
      message:
        `No verified checksum is recorded for the ${language.name} pack, so it cannot be ` +
        'installed. Language packs are models: an unverified one would read every document ' +
        'you convert without any sign that something was wrong. Run ' +
        '`node scripts/ocr-checksums.mjs` to record the digests for this tessdata tag.',
    }
  }
  return installPack(
    { code, set, dir: userPackDir(), sha256, url: downloadUrl(code, set) },
    { fetch: fetchPack(signal), fs },
  )
}

/** Remove a downloaded pack. A bundled one is part of the installation. */
export async function removePack(code: string, set: ModelSet): Promise<{ ok: boolean; message?: string }> {
  // packPathIn refuses a code that is not in the catalogue. Building the path
  // directly here is what made this an arbitrary-file-delete: the code comes
  // from the renderer and a traversal resolved outside the pack directory.
  const path = packPathIn(userPackDir(), code, set)
  if (path === null) return { ok: false, message: `Unknown OCR language "${code}".` }
  if (!existsSync(path)) return { ok: false, message: 'That pack is not installed as a download.' }
  try {
    await unlink(path)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** What is actually on disk in the user directory, for a manage view. */
export async function downloadedFiles(): Promise<string[]> {
  const dir = userPackDir()
  if (!existsSync(dir)) return []
  return (await readdir(dir)).filter((f) => f.endsWith('.traineddata'))
}
