import type { PdfPageSize, PdfRenderOptions, ReadOptions } from './types'
import type { PictureFormat, RenderFormat } from './rendered-blocks'
import { DEFAULT_PDF_SCALE, MAX_SCALE, MIN_SCALE, PDF_PAGE_SIZES } from './pdf-options'
import { isKnownLanguage } from '../ocr/languages'

/**
 * The settings schema (settings spec 5.2-5.4): remembered defaults for
 * conversion choices.
 *
 * Pure: no Electron and no disk, so the app, the CLI and the tests share one
 * set of rules. The main process owns the file (src/main/settings.ts); this
 * module says what the file may hold, what a bad value falls back to, and how
 * a conversion's options are built from the settings and a request.
 *
 * A file holds only what differs from the defaults. Every field is checked on
 * its own, so one bad value costs that value and nothing else. Keys this app
 * does not know are left in the file untouched: they may belong to a newer
 * version, and opening that file in an older app must not lose them.
 */

/** The schema version this app writes. A newer file is read field by field, never migrated down. */
export const SETTINGS_VERSION = 1

export interface Settings {
  /** The schema these settings follow: always SETTINGS_VERSION once parsed. */
  version: number
  /** What a picture the target can't hold becomes. Transparent pictures and drawings stay PNG/SVG whatever this says. */
  pictures: { format: PictureFormat }
  /** Fetching a document's web pictures, and whether intranet addresses may be among them. */
  web: { fetchPictures: boolean; allowLocalNetwork: boolean }
  /** Diagrams and formulas: Sharp (SVG) or Image (PNG), where the target takes both (spec B4). */
  rendered: { format: RenderFormat }
  /** Code blocks coloured by language in the outputs (not the editor). */
  code: { colour: boolean }
  /** What a new PDF starts with. Orientation stays a per-document choice. */
  pdf: { pageSize: PdfPageSize; scale: number; headerFooter: boolean }
  /** Reading choices that are set once: transcript times, SQLite view results. */
  read: { transcriptTimestamps: boolean; sqliteViews: boolean }
  /** The OCR language a new image starts with. */
  ocr: { language: string }
}

export type SettingsSection = Exclude<keyof Settings, 'version'>

/** One setting, named `section.field`, as `settings:set` takes it. */
export type SettingKey = {
  [S in SettingsSection]: `${S}.${keyof Settings[S] & string}`
}[SettingsSection]

/** The type of the value a setting holds. */
export type SettingValue<K extends SettingKey> = K extends `${infer S}.${infer F}`
  ? S extends SettingsSection
    ? F extends keyof Settings[S]
      ? Settings[S][F]
      : never
    : never
  : never

/** A value that was not used, and why. `key` is a setting, a section, `version` or `file`. */
export interface SettingsProblem {
  key: string
  message: string
}

function deepFreeze<T>(value: T): T {
  for (const inner of Object.values(value as object)) {
    if (typeof inner === 'object' && inner !== null) deepFreeze(inner)
  }
  return Object.freeze(value)
}

/**
 * The built-in defaults (owner decisions, 2026-10-16). Pictures default to JPG:
 * the render host still keeps PNG for any picture with transparency, and
 * drawings stay SVG or PNG, so JPG only ever replaces an opaque photo. Letter
 * is the built-in page size; the main process saves A4 on first run outside
 * the Letter countries.
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = deepFreeze({
  version: SETTINGS_VERSION,
  pictures: { format: 'jpeg' },
  web: { fetchPictures: true, allowLocalNetwork: true },
  rendered: { format: 'svg' },
  code: { colour: true },
  pdf: { pageSize: 'Letter', scale: DEFAULT_PDF_SCALE, headerFooter: false },
  read: { transcriptTimestamps: true, sqliteViews: false },
  ocr: { language: 'eng' },
} satisfies Settings)

/** How one field is checked: a test, and what it wants in plain words. */
interface Rule {
  ok: (value: unknown) => boolean
  wants: string
}

const isBoolean: Rule = { ok: (v) => typeof v === 'boolean', wants: 'true or false' }
const oneOf = (values: readonly string[]): Rule => ({
  ok: (v) => typeof v === 'string' && values.includes(v),
  wants: `one of ${values.join(', ')}`,
})

const RULES: { [S in SettingsSection]: Record<keyof Settings[S], Rule> } = {
  pictures: { format: oneOf(['png', 'jpeg']) },
  web: { fetchPictures: isBoolean, allowLocalNetwork: isBoolean },
  rendered: { format: oneOf(['svg', 'png']) },
  code: { colour: isBoolean },
  pdf: {
    pageSize: oneOf(PDF_PAGE_SIZES),
    // The range Chromium prints at. A request's zoom is clamped into it; a saved one outside it is a bad file.
    scale: {
      ok: (v) => typeof v === 'number' && Number.isFinite(v) && v >= MIN_SCALE && v <= MAX_SCALE,
      wants: `a zoom from ${MIN_SCALE} to ${MAX_SCALE}`,
    },
    headerFooter: isBoolean,
  },
  read: { transcriptTimestamps: isBoolean, sqliteViews: isBoolean },
  // A language in the catalogue. Whether its pack is installed is the main process's question.
  ocr: { language: { ok: (v) => typeof v === 'string' && isKnownLanguage(v), wants: 'an OCR language code' } },
}

/** The sections, in the order the file and the dialog list them. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = Object.keys(RULES) as SettingsSection[]
const SECTIONS = SETTINGS_SECTIONS

/** Every setting, in the order the file and the dialog list them. */
export const SETTING_KEYS: readonly SettingKey[] = SECTIONS.flatMap((s) =>
  Object.keys(RULES[s]).map((f) => `${s}.${f}` as SettingKey),
)
const KEY_SET: ReadonlySet<string> = new Set(SETTING_KEYS)

type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function has(obj: Raw, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function splitKey(key: SettingKey): [SettingsSection, string] {
  const dot = key.indexOf('.')
  return [key.slice(0, dot) as SettingsSection, key.slice(dot + 1)]
}

function ruleFor(key: SettingKey): Rule {
  const [section, field] = splitKey(key)
  return (RULES[section] as Record<string, Rule>)[field]
}

/** A value as a problem message shows it: short, whatever was in the file. */
function shown(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** One setting's value, read by key. */
export function settingOf<K extends SettingKey>(settings: Readonly<Settings>, key: K): SettingValue<K> {
  const [section, field] = splitKey(key)
  return (settings[section] as Record<string, unknown>)[field] as SettingValue<K>
}

/** A file's version: a whole number from 1 up, else undefined. */
function versionOf(raw: Raw): number | undefined {
  const v = raw.version
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** One step, from version N to N+1. Pure: it returns a new object and changes nothing it was given. */
export type Migration = (raw: Raw) => Raw

/** The steps this app knows, keyed by the version each starts from. Version 1 is the first: none yet. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {}

/**
 * Bring a file up to `current`, one step at a time. A file with no version is
 * version 1. A newer file is returned as it is: it is read field by field and
 * never migrated down. A missing step stops the run at the version reached,
 * rather than claim a version the file was never brought to.
 */
export function migrate(
  raw: Raw,
  steps: Readonly<Record<number, Migration>> = MIGRATIONS,
  current: number = SETTINGS_VERSION,
): { raw: Raw; version: number } {
  let version = versionOf(raw) ?? 1
  if (version >= current) return { raw, version }
  let out = raw
  while (version < current) {
    const step = steps[version]
    if (!step) break
    version += 1
    out = { ...step(out), version }
  }
  return { raw: out, version }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A settings file, read. Each field is checked on its own: a bad one falls
 * back to its default and is listed in `problems`, the rest are kept. Keys
 * this app does not know are not reported (a newer app wrote them).
 *
 * `raw` is the file after migration, unknown keys and all: the main process
 * keeps it and writes changes into it, so nothing it doesn't know is lost.
 * `version` is the file's own (it may be newer than SETTINGS_VERSION).
 */
export function parseSettings(input: unknown): {
  settings: Settings
  problems: SettingsProblem[]
  version: number
  raw: Raw
} {
  const settings = structuredClone(DEFAULT_SETTINGS) as Settings
  const problems: SettingsProblem[] = []
  if (input === undefined) return { settings, problems, version: SETTINGS_VERSION, raw: {} }
  if (!isRecord(input)) {
    problems.push({ key: 'file', message: 'the settings file does not hold settings; the defaults are used' })
    return { settings, problems, version: SETTINGS_VERSION, raw: {} }
  }
  if (has(input, 'version') && versionOf(input) === undefined) {
    problems.push({ key: 'version', message: `version ${shown(input.version)} is not a whole number from 1 up; read as 1` })
  }
  const { raw, version } = migrate(input)
  for (const section of SECTIONS) {
    if (!has(raw, section)) continue
    const values = raw[section]
    if (!isRecord(values)) {
      problems.push({ key: section, message: `${section} is not a group of settings; its defaults are used` })
      continue
    }
    const into = settings[section] as Record<string, unknown>
    for (const [field, rule] of Object.entries(RULES[section] as Record<string, Rule>)) {
      if (!has(values, field)) continue
      const value = values[field]
      if (rule.ok(value)) into[field] = value
      else problems.push({ key: `${section}.${field}`, message: `${shown(value)} is not ${rule.wants}; the default is used` })
    }
  }
  return { settings, problems, version, raw }
}

/**
 * One `{ key, value }` from the renderer, checked: a known setting and a value
 * its rule accepts. Anything else is refused, with the reason.
 */
export function checkSetting(
  request: unknown,
): { key: SettingKey; value: SettingValue<SettingKey> } | { refused: string } {
  if (!isRecord(request)) return { refused: 'no setting' }
  const { key, value } = request
  if (typeof key !== 'string' || !KEY_SET.has(key)) return { refused: 'unknown setting' }
  const rule = ruleFor(key as SettingKey)
  if (!has(request, 'value') || !rule.ok(value)) return { refused: `${key} must be ${rule.wants}` }
  return { key: key as SettingKey, value: value as SettingValue<SettingKey> }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The version to write: the current one, or the file's own if it is newer. */
function writtenVersion(raw: Raw): number {
  return Math.max(versionOf(raw) ?? SETTINGS_VERSION, SETTINGS_VERSION)
}

/**
 * The file with one setting changed, and everything else - known or not - as
 * it was. A value equal to its default is removed (the file holds only what
 * differs), and so is a section left empty. The value must already have
 * passed `checkSetting`.
 */
export function withSetting<K extends SettingKey>(raw: Raw, key: K, value: SettingValue<K>): Raw {
  const [section, field] = splitKey(key)
  const current = has(raw, section) && isRecord(raw[section]) ? (raw[section] as Raw) : {}
  const next: Raw = { ...current }
  if (Object.is(value, settingOf(DEFAULT_SETTINGS, key))) delete next[field]
  else next[field] = value
  const out: Raw = { ...raw, version: writtenVersion(raw) }
  if (Object.keys(next).length > 0) out[section] = next
  else delete out[section]
  return out
}

/**
 * The file with a section's settings (or every section's) back to their
 * defaults, which means removed. Keys this app does not know are kept.
 */
export function withoutSettings(raw: Raw, section?: SettingsSection): Raw {
  const out: Raw = { ...raw, version: writtenVersion(raw) }
  for (const s of section ? [section] : SECTIONS) {
    if (!has(out, s)) continue
    const values = out[s]
    if (!isRecord(values)) {
      delete out[s]
      continue
    }
    const kept: Raw = { ...values }
    for (const field of Object.keys(RULES[s])) delete kept[field]
    if (Object.keys(kept).length > 0) out[s] = kept
    else delete out[s]
  }
  return out
}

// ---------------------------------------------------------------------------
// Settings + request
// ---------------------------------------------------------------------------

/** What a conversion runs with: the settings, with the request's shown controls on top. */
export interface EffectiveOptions {
  pictureFormat: PictureFormat
  fetchPictures: boolean
  allowLocalNetwork: boolean
  renderedFormat: RenderFormat
  codeColour: boolean
  pdf: PdfRenderOptions & { pageSize: PdfPageSize }
  read: ReadOptions & { transcriptTimestamps: boolean; sqliteViews: boolean }
  ocrLanguage: string
}

/**
 * `settings ← request` (spec 5.6). The renderer sends only the options of the
 * controls it shows (`appliedOptions`), so a value present here is one the
 * user can see, and it wins for this conversion; everything else comes from
 * the settings. The request is not trusted: a value that is not valid is
 * ignored and the setting used. Picture format, web and code colour have no
 * control on the conversion screen, so they are never taken from a request -
 * a stale or hostile page cannot override them.
 *
 * Landscape and the JSON choice are per document and have no setting; they
 * come from the request alone (portrait, and the reader's own default).
 */
export function mergeSettings(settings: Readonly<Settings>, request: unknown): EffectiveOptions {
  const req = isRecord(request) ? request : {}
  const pdfReq = isRecord(req.pdf) ? req.pdf : {}
  const readReq = isRecord(req.read) ? req.read : {}
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

  const scale =
    typeof pdfReq.scale === 'number' && Number.isFinite(pdfReq.scale)
      ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, pdfReq.scale))
      : settings.pdf.scale
  const pageSize = RULES.pdf.pageSize.ok(pdfReq.pageSize) ? (pdfReq.pageSize as PdfPageSize) : settings.pdf.pageSize

  const read: EffectiveOptions['read'] = {
    transcriptTimestamps: bool(readReq.transcriptTimestamps, settings.read.transcriptTimestamps),
    sqliteViews: bool(readReq.sqliteViews, settings.read.sqliteViews),
  }
  if (readReq.jsonAs === 'table' || readReq.jsonAs === 'text') read.jsonAs = readReq.jsonAs

  return {
    pictureFormat: settings.pictures.format,
    fetchPictures: settings.web.fetchPictures,
    allowLocalNetwork: settings.web.allowLocalNetwork,
    renderedFormat: RULES.rendered.format.ok(req.renderedFormat)
      ? (req.renderedFormat as RenderFormat)
      : settings.rendered.format,
    codeColour: settings.code.colour,
    pdf: {
      pageSize,
      scale,
      headerFooter: bool(pdfReq.headerFooter, settings.pdf.headerFooter),
      landscape: bool(pdfReq.landscape, false),
    },
    read,
    ocrLanguage: RULES.ocr.language.ok(req.ocrLanguage) ? (req.ocrLanguage as string) : settings.ocr.language,
  }
}
