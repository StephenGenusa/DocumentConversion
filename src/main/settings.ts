import { readFileSync, renameSync } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SETTINGS_SECTIONS,
  SETTINGS_VERSION,
  checkSetting,
  parseSettings,
  withSetting,
  withoutSettings,
  type Settings,
  type SettingsProblem,
  type SettingsSection,
} from '../core/settings'
import type { PdfPageSize } from '../core/types'
import { BUNDLED_LANGUAGE } from '../ocr/languages'

/**
 * The settings file (settings spec 5.1, 5.3, 5.5): `settings.json` in the
 * app's userData folder, owned by the main process.
 *
 * Read once, when the app starts, and kept in memory. Every change is checked
 * by the shared schema (src/core/settings.ts), then written whole and
 * atomically: `settings.json.tmp`, flushed, then renamed over the old file, so
 * a crash mid-write leaves the old settings, never half of the new ones.
 * Writes run one after another; each starts from the last one's result.
 *
 * A file that can't be parsed is renamed aside (`settings.json.bad-<time>`)
 * rather than overwritten, the defaults are used, and the window is told
 * once. A file with one bad value keeps everything else (the schema's rule)
 * and is left as it is: the bad value may be one a newer version understands.
 *
 * No Electron here: index.ts passes the folder and the system's region, so
 * the tests run on a temp folder and never near the real userData.
 */

export const SETTINGS_FILE = 'settings.json'

/** The channels (spec 5.6). `changed` is an event main sends; the others are invoked. */
export const SETTINGS_IPC_CHANNELS = {
  get: 'settings:get',
  set: 'settings:set',
  reset: 'settings:reset',
  notice: 'settings:notice',
  changed: 'settings:changed',
} as const

const RESET_NOTICE = 'Your settings file could not be read and was reset.'

/**
 * Where Letter is the paper people have (owner decision 2). Everywhere else
 * uses A4, which a first run saves; an unknown region keeps the built-in Letter.
 */
const LETTER_REGIONS: ReadonlySet<string> = new Set(['US', 'CA', 'MX', 'PH'])

export function pageSizeForRegion(region: string): PdfPageSize {
  return region === '' || LETTER_REGIONS.has(region) ? 'Letter' : 'A4'
}

/**
 * The system's region as two capital letters, or '' when nothing says.
 *
 * `app.getLocaleCountryCode()` answers on Windows and macOS and is often
 * empty on Linux, so the system locales are the fallback: `en-GB`, a POSIX
 * `de_DE.UTF-8`, or a bare language, whose likely region is taken (`fr` is
 * France, `en` the United States).
 */
export function regionOf(countryCode: string | undefined, locales: readonly string[]): string {
  const code = (countryCode ?? '').trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(code)) return code
  for (const locale of locales) {
    const tag = locale.split('.')[0].split('@')[0].replace(/_/g, '-')
    if (!tag || tag === 'C' || tag === 'POSIX') continue
    try {
      const region = new Intl.Locale(tag).maximize().region
      if (region && /^[A-Z]{2}$/.test(region)) return region
    } catch {
      // Not a locale tag; try the next one.
    }
  }
  return ''
}

/** The file operations a write uses, swappable in tests to make one fail. */
export interface SettingsFs {
  /** Write `text` to `path` and flush it to disk. */
  writeFile(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

const realFs: SettingsFs = {
  writeFile: async (path, text) => {
    const handle = await open(path, 'w')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  rename: (from, to) => rename(from, to),
}

export interface SettingsStoreOptions {
  /** The folder the file lives in: `app.getPath('userData')`. */
  dir: string
  /** The system's region (`regionOf`), asked only on a first run. */
  region: () => string
  /** Whether an OCR language's pack is on this computer now. */
  ocrInstalled: (code: string) => boolean
  /** The clock, for the name a bad file is renamed to. */
  now?: () => Date
  fs?: Partial<SettingsFs>
}

export type SettingsResult = { ok: true; settings: Settings } | { ok: false; message: string }

export interface SettingsStore {
  /** The settings in force: a copy, with an OCR language whose pack is gone read as English. */
  get(): Settings
  /** One `{ key, value }`, checked and saved. Refused, it changes nothing. */
  set(request: unknown): Promise<SettingsResult>
  /** `{ section }` back to its defaults, or every section when none is given. */
  reset(request: unknown): Promise<SettingsResult>
  /** The bad-file notice, once; undefined after that or when there was none. */
  takeNotice(): string | undefined
  /** Values in the file that were not used, and why (from the last read). */
  problems(): SettingsProblem[]
  /**
   * Called after each saved change, and when a pack coming or going changed
   * the OCR language in force (`packsChanged`). Returns the way to stop.
   */
  onChange(listener: (settings: Settings) => void): () => void
  /**
   * An OCR pack was installed or removed. When that changed the language in
   * force (the saved one's pack went, so English; or came back), the
   * listeners are told. Nothing is written: the file keeps the saved language.
   */
  packsChanged(): void
  /** Resolves once every write asked for so far has finished. */
  flushed(): Promise<void>
}

type Raw = Record<string, unknown>

/** The JSON text written: pretty-printed, with a final newline. */
function serialize(raw: Raw): string {
  return `${JSON.stringify(raw, null, 2)}\n`
}

/** A time as a file name can hold it on every system (no colons). */
function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * Read a settings file without changing anything: for the CLI's
 * `--settings <path>` (spec 5.7), which must never rename or rewrite a file it
 * was only asked to read.
 */
export function readSettingsFile(
  path: string,
): { ok: true; settings: Settings; problems: SettingsProblem[] } | { ok: false; message: string } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { ok: false, message: `The settings file could not be read: ${(err as Error).message}` }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, message: 'The settings file is not valid JSON.' }
  }
  const { settings, problems } = parseSettings(json)
  if (problems.some((p) => p.key === 'file')) return { ok: false, message: 'The settings file does not hold settings.' }
  return { ok: true, settings, problems }
}

/** Open the store: read the file now, and on a first run save the regional page size. */
export function openSettings(options: SettingsStoreOptions): SettingsStore {
  const fs: SettingsFs = { ...realFs, ...options.fs }
  const now = options.now ?? (() => new Date())
  const path = join(options.dir, SETTINGS_FILE)
  const listeners = new Set<(settings: Settings) => void>()

  let raw: Raw = {}
  let settings: Settings
  let problems: SettingsProblem[] = []
  let notice: string | undefined
  let queue: Promise<unknown> = Promise.resolve()
  /** A new file is needed: none yet, or a bad one was moved aside. */
  let fresh = false

  let text: string | undefined
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') fresh = true
    else notice = RESET_NOTICE // There, but unreadable (permissions, a folder): use the defaults, leave it be.
  }
  if (text !== undefined) {
    let json: unknown
    let parsed = true
    try {
      json = JSON.parse(text)
    } catch {
      parsed = false
    }
    const read = parsed ? parseSettings(json) : undefined
    if (!read || read.problems.some((p) => p.key === 'file')) {
      // Kept beside, not deleted: it may be the user's only copy of what they chose.
      try {
        renameSync(path, `${path}.bad-${stamp(now())}`)
        fresh = true
      } catch {
        // Could not move it; the defaults are used and the next change overwrites it.
      }
      notice = RESET_NOTICE
    } else {
      raw = read.raw
      problems = read.problems
    }
  }

  if (fresh) {
    let region = ''
    try {
      region = options.region()
    } catch {
      // No region known: the built-in default stands.
    }
    // Written even when it holds only the version: the file's being there is what makes the next start not a first run.
    raw = pageSizeForRegion(region) === 'A4' ? withSetting({}, 'pdf.pageSize', 'A4') : { version: SETTINGS_VERSION }
  }
  settings = parseSettings(raw).settings

  /**
   * Write `next` and make it the settings in force; on failure nothing
   * changes. `tell` is false for the first-run file, which changes nothing
   * already in force.
   */
  const commit = (next: () => { raw: Raw } | { refused: string }, tell = true): Promise<SettingsResult> => {
    const run = queue.then(async (): Promise<SettingsResult> => {
      const candidate = next()
      if ('refused' in candidate) return { ok: false, message: candidate.refused }
      const nextRaw = candidate.raw
      try {
        await mkdir(options.dir, { recursive: true })
        const tmp = `${path}.tmp`
        await fs.writeFile(tmp, serialize(nextRaw))
        await fs.rename(tmp, path)
      } catch (err) {
        return { ok: false, message: `Settings could not be saved: ${(err as Error).message}` }
      }
      raw = nextRaw
      const read = parseSettings(raw)
      settings = read.settings
      problems = read.problems
      if (tell) notify()
      ocrInForce = get().ocr.language
      return { ok: true, settings: get() }
    })
    queue = run.catch(() => undefined)
    return run
  }

  const get = (): Settings => {
    const copy = structuredClone(settings)
    if (!options.ocrInstalled(copy.ocr.language)) copy.ocr.language = BUNDLED_LANGUAGE
    return copy
  }

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener(get())
      } catch {
        // One listener's failure is not the save's.
      }
    }
  }

  /** The OCR language the listeners were last told of (or that was in force at the start). */
  let ocrInForce = get().ocr.language

  if (fresh) void commit(() => ({ raw }), false)

  return {
    get,
    set: (request) =>
      commit(() => {
        const checked = checkSetting(request)
        if ('refused' in checked) return checked
        if (checked.key === 'ocr.language' && !options.ocrInstalled(checked.value as string)) {
          return { refused: `The ${String(checked.value)} OCR language is not installed.` }
        }
        return { raw: withSetting(raw, checked.key, checked.value) }
      }),
    reset: (request) =>
      commit(() => {
        if (request === undefined || request === null) return { raw: withoutSettings(raw) }
        if (typeof request !== 'object' || Array.isArray(request)) return { refused: 'no section' }
        const section = (request as Raw).section
        if (section === undefined) return { raw: withoutSettings(raw) }
        if (typeof section !== 'string' || !SETTINGS_SECTIONS.includes(section as SettingsSection)) {
          return { refused: 'unknown section' }
        }
        return { raw: withoutSettings(raw, section as SettingsSection) }
      }),
    takeNotice: () => {
      const once = notice
      notice = undefined
      return once
    },
    problems: () => problems.map((p) => ({ ...p })),
    onChange: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    flushed: () => queue.then(() => undefined),
    packsChanged: () => {
      const now = get().ocr.language
      if (now === ocrInForce) return
      ocrInForce = now
      notify()
    },
  }
}

/**
 * The invoked `settings:*` channels, for index.ts to register. Each request
 * is checked in the store; the page is not trusted to send a well-formed one,
 * and never sends a whole file: one `{ key, value }` at a time (spec 5.3).
 */
export function settingsIpcHandlers(
  store: SettingsStore,
): Record<'settings:get' | 'settings:set' | 'settings:reset' | 'settings:notice', (event: unknown, request: unknown) => unknown> {
  return {
    [SETTINGS_IPC_CHANNELS.get]: () => store.get(),
    [SETTINGS_IPC_CHANNELS.set]: (_event: unknown, request: unknown) => store.set(request),
    [SETTINGS_IPC_CHANNELS.reset]: (_event: unknown, request: unknown) => store.reset(request),
    [SETTINGS_IPC_CHANNELS.notice]: () => store.takeNotice(),
  }
}
