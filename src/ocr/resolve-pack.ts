import { BUNDLED_LANGUAGE, packFilename, type ModelSet } from './languages'

/**
 * Which directory holds the pack for a given language.
 *
 * There are two: the one inside the installer, and the one the user downloads
 * into. tesseract takes a single `langPath`, so the choice has to be made per
 * language before the worker is created.
 *
 * Bundled wins. English keeps working with no network and cannot be shadowed
 * by a downloaded file - which matters because a downloaded pack is the one
 * thing here that did not come from the installer, and silently preferring it
 * would make the offline guarantee depend on what is in a writable directory.
 *
 * Pure, with `exists` injected, so every branch is testable without a disk.
 */
export interface ResolveInput {
  language: string
  set: ModelSet
  /** The directory inside the installation. */
  bundledDir: string
  /** The directory downloads are installed into. */
  userDir: string
  exists: (path: string) => boolean
}

export interface ResolvedPack {
  dir: string
  file: string
  /** Where it came from, so the UI can say "bundled" rather than "installed". */
  source: 'bundled' | 'downloaded'
}

/**
 * The bundled pack is gzipped, the downloaded ones are not: tesseract.js is
 * configured with `gzip: true` for the shipped English data, and the upstream
 * tessdata repositories serve plain `.traineddata`. Both spellings are checked
 * rather than assuming one.
 */
function candidates(language: string, set: ModelSet): string[] {
  const plain = packFilename(language, set)
  return [plain, `${plain}.gz`]
}

export function resolvePack(input: ResolveInput): ResolvedPack | null {
  const order: Array<['bundled' | 'downloaded', string]> = [
    ['bundled', input.bundledDir],
    ['downloaded', input.userDir],
  ]
  for (const [source, dir] of order) {
    for (const file of candidates(input.language, input.set)) {
      if (input.exists(`${dir}/${file}`)) return { dir, file, source }
    }
  }
  return null
}

/**
 * Every language that can be selected right now, bundled or downloaded.
 *
 * The bundled language is always reported even if the file check fails: a
 * missing English pack is a broken installation, and offering an empty list
 * would present that as "no languages available" rather than as the fault it
 * is.
 */
export function installedLanguages(
  codes: string[],
  input: Omit<ResolveInput, 'language'>,
): Array<{ code: string; source: 'bundled' | 'downloaded' }> {
  const found = codes
    .map((code) => ({ code, resolved: resolvePack({ ...input, language: code }) }))
    .filter((r) => r.resolved !== null)
    .map((r) => ({ code: r.code, source: r.resolved!.source }))
  if (!found.some((f) => f.code === BUNDLED_LANGUAGE)) {
    found.unshift({ code: BUNDLED_LANGUAGE, source: 'bundled' })
  }
  return found
}

/** Whether a resolved pack file is gzipped, which tesseract must be told. */
export function packIsGzipped(file: string): boolean {
  return file.endsWith('.gz')
}
