import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { isKnownLanguage, packFilename, type ModelSet } from './languages'

/**
 * Installing a downloaded language pack.
 *
 * A traineddata file is a MODEL, not a resource. A corrupt or substituted one
 * does not crash anything - it quietly reads every document the user converts
 * incorrectly, and they have no way to tell. So nothing reaches the language
 * directory until its SHA-256 matches what the catalogue expects.
 *
 * The filesystem and the fetch are injected rather than imported, which keeps
 * this Electron-free and lets every failure path - bad checksum, dead network,
 * cancellation - be tested without either.
 */

/**
 * The path a pack occupies inside `dir`, or null if the code is not one we
 * recognise.
 *
 * The check lives here, where the path is BUILT, rather than at each call site.
 * It was originally only in `installPack`, and `removePack` - added later -
 * built its own path from the raw string, so a renderer could call
 * `removeOcrLanguage('../../../../tmp/victim', 'fast')` and delete a file
 * outside the pack directory entirely. Putting it at the construction point
 * means the next function to take a language code cannot forget it.
 *
 * Belt and braces: the catalogue codes are all `[a-z_]+` so none can traverse,
 * and the resolved path is confirmed to stay inside `dir` regardless.
 */
export function packPathIn(dir: string, code: string, set: ModelSet): string | null {
  if (!isKnownLanguage(code)) return null
  const path = join(dir, packFilename(code, set))
  const inside = resolve(dir)
  if (!resolve(path).startsWith(inside + '/') && resolve(path) !== inside) return null
  return path
}

export interface PackFetchResult {
  ok: boolean
  bytes?: Buffer
  error?: string
  cancelled?: boolean
}

export type PackFetch = (url: string) => Promise<PackFetchResult>

export interface PackFs {
  writeFile(path: string, bytes: Buffer): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export interface InstallRequest {
  code: string
  set: ModelSet
  /** Directory the pack is installed into. */
  dir: string
  /** Expected SHA-256, lowercase hex. */
  sha256: string
  url?: string
}

export type InstallResult =
  | { kind: 'ok'; path: string }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }

export async function installPack(
  request: InstallRequest,
  deps: { fetch: PackFetch; fs: PackFs },
): Promise<InstallResult> {
  /*
   * The code becomes a URL path segment AND a filename, so it is checked
   * against the catalogue before either is built. Rejecting an unknown code
   * outright is stricter than sanitising one, and there is no legitimate
   * reason to install a language the app cannot then select.
   */
  const target = packPathIn(request.dir, request.code, request.set)
  if (target === null) {
    return { kind: 'error', message: `Unknown OCR language "${request.code}".` }
  }

  // A distinct temp name, so a reader never sees a partially written model and
  // a failed install cannot leave one behind under the real name.
  const temp = `${target}.part-${Date.now().toString(36)}`

  const response = await deps.fetch(request.url ?? '')
  if (!response.ok || !response.bytes) {
    if (response.cancelled) return { kind: 'cancelled' }
    return { kind: 'error', message: response.error ?? 'The download failed.' }
  }

  const digest = createHash('sha256').update(response.bytes).digest('hex')
  if (digest !== request.sha256.toLowerCase()) {
    return {
      kind: 'error',
      message:
        `The ${request.code} language pack did not match its expected checksum and was discarded. ` +
        'It may have been corrupted in transit, or served by something other than the expected source.',
    }
  }

  try {
    await deps.fs.mkdir(request.dir)
    await deps.fs.writeFile(temp, response.bytes)
    await deps.fs.rename(temp, target)
    return { kind: 'ok', path: target }
  } catch (err) {
    await deps.fs.unlink(temp).catch(() => {})
    return { kind: 'error', message: `Could not install the pack: ${(err as Error).message}` }
  }
}
