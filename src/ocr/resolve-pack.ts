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
 * Which pack OCR reads a language with, whichever model it is.
 *
 * A language counts as installed with either model on disk. When there is a
 * choice the rule is, in order:
 *
 * - The bundled pack wins, for the reason `resolvePack` gives: nothing in the
 *   writable directory may shadow what came with the installer.
 * - Otherwise the best model beats the fast one. The app only ever downloads
 *   fast, so a best file is there because someone put it there on purpose,
 *   accepting slower recognition for better accuracy. Choosing per document
 *   (by page count, say) would make the same file read differently from one
 *   day to the next, which is worse than either model.
 */
export interface ResolvedModel extends ResolvedPack {
  set: ModelSet
}

export function resolveLanguage(input: Omit<ResolveInput, 'set'>): ResolvedModel | null {
  for (const [source, dir] of [
    ['bundled', input.bundledDir],
    ['downloaded', input.userDir],
  ] as const) {
    for (const set of ['best', 'fast'] as const) {
      for (const file of candidates(input.language, set)) {
        if (input.exists(`${dir}/${file}`)) return { dir, file, source, set }
      }
    }
  }
  return null
}

/** The models of a language present in one directory, fast first. */
export function modelsIn(dir: string, language: string, exists: (path: string) => boolean): ModelSet[] {
  return (['fast', 'best'] as const).filter((set) => candidates(language, set).some((f) => exists(`${dir}/${f}`)))
}

/**
 * Every language that can be selected right now, bundled or downloaded, with
 * either model.
 *
 * The bundled language is always reported even if the file check fails: a
 * missing English pack is a broken installation, and offering an empty list
 * would present that as "no languages available" rather than as the fault it
 * is.
 */
export function installedLanguages(
  codes: string[],
  input: Omit<ResolveInput, 'language' | 'set'>,
): Array<{ code: string; source: 'bundled' | 'downloaded' }> {
  const found = codes
    .map((code) => ({ code, resolved: resolveLanguage({ ...input, language: code }) }))
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
