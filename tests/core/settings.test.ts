import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SETTING_KEYS,
  checkSetting,
  mergeSettings,
  migrate,
  parseSettings,
  settingOf,
  withSetting,
  withoutSettings,
  type Migration,
  type SettingKey,
} from '../../src/core/settings'

/**
 * The settings schema (settings spec 5.2-5.4): what a settings file holds,
 * what a bad one falls back to, and how a conversion's options are built from
 * the settings and the request. Pure: no Electron, no disk.
 */

/** A copy of the defaults, for comparing against. */
const defaults = () => structuredClone(DEFAULT_SETTINGS)

describe('defaults', () => {
  it('are the owner decisions: JPG pictures, Letter, SVG drawings, fetching on', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1,
      pictures: { format: 'jpeg' },
      web: { fetchPictures: true, allowLocalNetwork: true },
      rendered: { format: 'svg' },
      code: { colour: true },
      pdf: { pageSize: 'Letter', scale: 0.9, headerFooter: false },
      read: { transcriptTimestamps: true, sqliteViews: false },
      ocr: { language: 'eng' },
    })
    expect(SETTINGS_VERSION).toBe(1)
  })

  it('come from nothing, an empty file and a file that is only a version', () => {
    for (const raw of [undefined, {}, { version: 1 }]) {
      expect(parseSettings(raw)).toMatchObject({ settings: defaults(), problems: [] })
    }
  })

  it('are frozen, so no caller can change them for everyone', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SETTINGS.pdf)).toBe(true)
  })

  it('are a fresh object each parse, never the defaults themselves', () => {
    const { settings } = parseSettings({})
    settings.pdf.pageSize = 'A4'
    expect(DEFAULT_SETTINGS.pdf.pageSize).toBe('Letter')
  })
})

describe('parseSettings', () => {
  it('reads every field', () => {
    const raw = {
      version: 1,
      pictures: { format: 'png' },
      web: { fetchPictures: false, allowLocalNetwork: false },
      rendered: { format: 'png' },
      code: { colour: false },
      pdf: { pageSize: 'A4', scale: 1.25, headerFooter: true },
      read: { transcriptTimestamps: false, sqliteViews: true },
      ocr: { language: 'deu' },
    }
    expect(parseSettings(raw)).toMatchObject({ settings: raw, problems: [] })
  })

  it('takes the default for a missing field and keeps the rest of its section', () => {
    const { settings, problems } = parseSettings({ pdf: { pageSize: 'A4' } })
    expect(settings.pdf).toEqual({ pageSize: 'A4', scale: 0.9, headerFooter: false })
    expect(problems).toEqual([])
  })

  it.each<[SettingKey, unknown]>([
    ['pictures.format', 'webp'],
    ['pictures.format', 'PNG'],
    ['web.fetchPictures', 'yes'],
    ['web.allowLocalNetwork', 0],
    ['rendered.format', 'jpeg'],
    ['code.colour', null],
    ['pdf.pageSize', 'a4'],
    ['pdf.scale', 0],
    ['pdf.scale', 7],
    ['pdf.scale', Number.NaN],
    ['pdf.scale', '0.9'],
    ['pdf.headerFooter', 'true'],
    ['read.transcriptTimestamps', 1],
    ['read.sqliteViews', {}],
    ['ocr.language', 'klingon'],
    ['ocr.language', '../../etc'],
  ])('a bad %s (%j) falls back alone and is reported', (key, bad) => {
    // Every other field set to a non-default value, to show they survive.
    const good = {
      pictures: { format: 'png' },
      web: { fetchPictures: false, allowLocalNetwork: false },
      rendered: { format: 'png' },
      code: { colour: false },
      pdf: { pageSize: 'A3', scale: 1.5, headerFooter: true },
      read: { transcriptTimestamps: false, sqliteViews: true },
      ocr: { language: 'fra' },
    }
    const [section, field] = key.split('.') as [keyof typeof good, string]
    const raw = structuredClone(good) as Record<string, Record<string, unknown>>
    raw[section][field] = bad
    const { settings, problems } = parseSettings(raw)
    expect(settingOf(settings, key)).toEqual(settingOf(DEFAULT_SETTINGS, key))
    for (const other of SETTING_KEYS.filter((k) => k !== key)) {
      const [s, f] = other.split('.')
      expect(settingOf(settings, other)).toEqual((good as Record<string, Record<string, unknown>>)[s][f])
    }
    expect(problems).toHaveLength(1)
    expect(problems[0].key).toBe(key)
    expect(problems[0].message).toMatch(/\S/)
  })

  it('a section that is not an object falls back whole, the others are kept', () => {
    const { settings, problems } = parseSettings({ pdf: 'A4', code: { colour: false } })
    expect(settings.pdf).toEqual(DEFAULT_SETTINGS.pdf)
    expect(settings.code.colour).toBe(false)
    expect(problems.map((p) => p.key)).toEqual(['pdf'])
  })

  it('a file that is not an object gives the defaults and says so', () => {
    for (const raw of [null, 'settings', 42, [1, 2]]) {
      const { settings, problems } = parseSettings(raw)
      expect(settings).toEqual(defaults())
      expect(problems).toHaveLength(1)
    }
  })

  it('ignores keys it does not know, and does not report them', () => {
    const { settings, problems } = parseSettings({
      theme: 'dark',
      pdf: { pageSize: 'A4', margins: 'narrow' },
    })
    expect(settings).not.toHaveProperty('theme')
    expect(settings.pdf).not.toHaveProperty('margins')
    expect(settings.pdf.pageSize).toBe('A4')
    expect(problems).toEqual([])
  })

  it('reads a file from a newer version field by field, and never lowers its version', () => {
    const { settings, problems, version } = parseSettings({
      version: 7,
      pictures: { format: 'avif' }, // a value a later app may offer
      pdf: { pageSize: 'A4', margins: 'narrow' },
      appearance: { theme: 'dark' },
    })
    expect(version).toBe(7)
    expect(settings.version).toBe(SETTINGS_VERSION)
    expect(settings.pdf.pageSize).toBe('A4')
    expect(settings.pictures.format).toBe('jpeg')
    expect(problems.map((p) => p.key)).toEqual(['pictures.format'])
  })

  it('reads a missing or broken version as version 1', () => {
    expect(parseSettings({ pdf: { pageSize: 'A4' } }).version).toBe(1)
    const broken = parseSettings({ version: 'two', pdf: { pageSize: 'A4' } })
    expect(broken.version).toBe(1)
    expect(broken.settings.pdf.pageSize).toBe('A4')
    expect(broken.problems.map((p) => p.key)).toEqual(['version'])
    for (const version of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(parseSettings({ version }).problems.map((p) => p.key)).toEqual(['version'])
    }
  })

  it('does not let a __proto__ key in the file reach any object', () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "pdf": {"__proto__": {"pageSize": "A4"}}}')
    const { settings } = parseSettings(raw)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(settings.pdf.pageSize).toBe('Letter')
  })

  it('accepts any zoom between 10% and 200%, the range a PDF can be printed at', () => {
    expect(parseSettings({ pdf: { scale: 0.1 } }).settings.pdf.scale).toBe(0.1)
    expect(parseSettings({ pdf: { scale: 2 } }).settings.pdf.scale).toBe(2)
    expect(parseSettings({ pdf: { scale: 0.85 } }).settings.pdf.scale).toBe(0.85)
    expect(parseSettings({ pdf: { scale: 0.09 } }).problems).toHaveLength(1)
    expect(parseSettings({ pdf: { scale: 2.01 } }).problems).toHaveLength(1)
  })
})

describe('migrate', () => {
  it('leaves a current file alone', () => {
    const raw = { version: 1, pdf: { pageSize: 'A4' }, theme: 'dark' }
    expect(migrate(raw)).toEqual({ raw, version: 1 })
  })

  it('runs each step in order from the file version to the current one', () => {
    // As if the app were at version 3: 1 -> 2 renames a field, 2 -> 3 moves a section.
    const steps: Record<number, Migration> = {
      1: (raw) => {
        const { pdfZoom, ...rest } = raw as Record<string, unknown>
        return { ...rest, pdf: { scale: pdfZoom } }
      },
      2: (raw) => {
        const { pdf, ...rest } = raw as Record<string, unknown>
        return { ...rest, print: pdf }
      },
    }
    expect(migrate({ version: 1, pdfZoom: 1.1 }, steps, 3)).toEqual({ raw: { version: 3, print: { scale: 1.1 } }, version: 3 })
    expect(migrate({ version: 2, pdf: { scale: 1.1 } }, steps, 3)).toEqual({ raw: { version: 3, print: { scale: 1.1 } }, version: 3 })
  })

  it('never runs a step down: a newer file is returned as it is', () => {
    const steps: Record<number, Migration> = { 1: () => ({ wiped: true }) }
    const raw = { version: 9, pdf: { pageSize: 'A4' } }
    expect(migrate(raw, steps, 2)).toEqual({ raw, version: 9 })
  })

  it('treats a file with no version as version 1', () => {
    const steps: Record<number, Migration> = { 1: (raw) => ({ ...raw, migrated: true }) }
    expect(migrate({ pdf: {} }, steps, 2)).toEqual({ raw: { pdf: {}, migrated: true, version: 2 }, version: 2 })
  })

  it('stops at a missing step rather than claiming a version it did not reach', () => {
    expect(migrate({ version: 1, a: 1 }, {}, 2)).toEqual({ raw: { version: 1, a: 1 }, version: 1 })
  })

  it('does not change the object it was given', () => {
    const raw = { version: 1, pdfZoom: 1 }
    const steps: Record<number, Migration> = { 1: (r) => ({ ...r, extra: true }) }
    migrate(raw, steps, 2)
    expect(raw).toEqual({ version: 1, pdfZoom: 1 })
  })

  it('has no steps yet: version 1 is the first', () => {
    expect(migrate({ version: 1 }).version).toBe(1)
  })
})

describe('checkSetting (what settings:set accepts)', () => {
  it('accepts every key with a good value', () => {
    expect(checkSetting({ key: 'pictures.format', value: 'png' })).toEqual({ key: 'pictures.format', value: 'png' })
    expect(checkSetting({ key: 'pdf.scale', value: 1.1 })).toEqual({ key: 'pdf.scale', value: 1.1 })
    expect(checkSetting({ key: 'ocr.language', value: 'deu' })).toEqual({ key: 'ocr.language', value: 'deu' })
  })

  it.each([
    ['nothing', undefined],
    ['a string', 'pdf.scale'],
    ['an unknown key', { key: 'pdf.margins', value: 'narrow' }],
    ['a section, not a field', { key: 'pdf', value: { scale: 1 } }],
    ['the version', { key: 'version', value: 2 }],
    ['a key that is not a string', { key: ['pdf', 'scale'], value: 1 }],
    ['an inherited name', { key: 'pdf.constructor', value: 1 }],
    ['a prototype path', { key: '__proto__.polluted', value: true }],
    ['a bad value', { key: 'pdf.pageSize', value: 'B5' }],
    ['a missing value', { key: 'code.colour' }],
    ['a value of the wrong type', { key: 'code.colour', value: 'false' }],
  ])('refuses %s', (_name, req) => {
    expect(checkSetting(req)).toHaveProperty('refused')
  })
})

describe('withSetting and withoutSettings (what is written)', () => {
  it('sets one field and keeps everything else, known or not', () => {
    const raw = { version: 1, theme: 'dark', pdf: { margins: 'narrow', scale: 1.1 } }
    expect(withSetting(raw, 'pdf.pageSize', 'A4')).toEqual({
      version: 1,
      theme: 'dark',
      pdf: { margins: 'narrow', scale: 1.1, pageSize: 'A4' },
    })
    expect(raw.pdf).toEqual({ margins: 'narrow', scale: 1.1 })
  })

  it('removes a field set back to its default, and a section left empty', () => {
    expect(withSetting({ version: 1, pdf: { pageSize: 'A4' } }, 'pdf.pageSize', 'Letter')).toEqual({ version: 1 })
    expect(withSetting({ version: 1, pdf: { pageSize: 'A4', x: 1 } }, 'pdf.pageSize', 'Letter')).toEqual({
      version: 1,
      pdf: { x: 1 },
    })
  })

  it('replaces a section that was not an object', () => {
    expect(withSetting({ version: 1, pdf: 'A4' }, 'pdf.pageSize', 'A4')).toEqual({ version: 1, pdf: { pageSize: 'A4' } })
  })

  it('writes the current version into a file that had none, and keeps a newer one', () => {
    expect(withSetting({}, 'code.colour', false)).toEqual({ version: 1, code: { colour: false } })
    expect(withSetting({ version: 4 }, 'code.colour', false)).toEqual({ version: 4, code: { colour: false } })
  })

  it('resets one section, keeping its unknown keys', () => {
    const raw = { version: 1, pdf: { pageSize: 'A4', margins: 'narrow' }, code: { colour: false } }
    expect(withoutSettings(raw, 'pdf')).toEqual({ version: 1, pdf: { margins: 'narrow' }, code: { colour: false } })
  })

  it('resets everything it knows, keeping what a newer app wrote', () => {
    const raw = { version: 3, pdf: { pageSize: 'A4', margins: 'narrow' }, code: { colour: false }, theme: 'dark' }
    expect(withoutSettings(raw)).toEqual({ version: 3, pdf: { margins: 'narrow' }, theme: 'dark' })
  })

  it('a value written reads back as written', () => {
    let raw: Record<string, unknown> = {}
    raw = withSetting(raw, 'pictures.format', 'png')
    raw = withSetting(raw, 'pdf.scale', 1.25)
    raw = withSetting(raw, 'ocr.language', 'spa')
    const { settings } = parseSettings(JSON.parse(JSON.stringify(raw)))
    expect(settings.pictures.format).toBe('png')
    expect(settings.pdf.scale).toBe(1.25)
    expect(settings.ocr.language).toBe('spa')
  })
})

describe('mergeSettings (settings + request)', () => {
  const saved = parseSettings({
    pictures: { format: 'png' },
    web: { fetchPictures: false, allowLocalNetwork: false },
    rendered: { format: 'png' },
    code: { colour: false },
    pdf: { pageSize: 'A4', scale: 1.1, headerFooter: true },
    read: { transcriptTimestamps: false, sqliteViews: true },
    ocr: { language: 'deu' },
  }).settings

  it('uses the settings for every control the request does not carry', () => {
    expect(mergeSettings(saved, {})).toEqual({
      pictureFormat: 'png',
      fetchPictures: false,
      allowLocalNetwork: false,
      renderedFormat: 'png',
      codeColour: false,
      pdf: { pageSize: 'A4', scale: 1.1, headerFooter: true, landscape: false },
      read: { transcriptTimestamps: false, sqliteViews: true },
      ocrLanguage: 'deu',
    })
  })

  it('a request carries only the controls that were shown, and those win', () => {
    const merged = mergeSettings(saved, {
      renderedFormat: 'svg',
      pdf: { pageSize: 'Legal', scale: 0.75, headerFooter: false, landscape: true },
      read: { transcriptTimestamps: true },
      ocrLanguage: 'fra',
    })
    expect(merged.renderedFormat).toBe('svg')
    expect(merged.pdf).toEqual({ pageSize: 'Legal', scale: 0.75, headerFooter: false, landscape: true })
    expect(merged.read).toEqual({ transcriptTimestamps: true, sqliteViews: true })
    expect(merged.ocrLanguage).toBe('fra')
  })

  it('fills a field a shown control left out from the settings', () => {
    expect(mergeSettings(saved, { pdf: { landscape: true } }).pdf).toEqual({
      pageSize: 'A4',
      scale: 1.1,
      headerFooter: true,
      landscape: true,
    })
  })

  it('never takes a settings-only choice from the request', () => {
    const merged = mergeSettings(saved, {
      pictureFormat: 'jpeg',
      fetchPictures: true,
      allowLocalNetwork: true,
      codeColour: true,
    } as Record<string, unknown>)
    expect(merged).toMatchObject({ pictureFormat: 'png', fetchPictures: false, allowLocalNetwork: false, codeColour: false })
  })

  it('ignores a request value that is not valid, and keeps the setting', () => {
    const merged = mergeSettings(saved, {
      renderedFormat: 'gif',
      pdf: { pageSize: 'B5', scale: 'big', headerFooter: 'no', landscape: 'yes' },
      read: { transcriptTimestamps: 'no', sqliteViews: 0 },
      ocrLanguage: 'klingon',
    })
    expect(merged).toEqual(mergeSettings(saved, {}))
    expect(mergeSettings(saved, null)).toEqual(mergeSettings(saved, {}))
    expect(mergeSettings(saved, { pdf: 'A4', read: [] })).toEqual(mergeSettings(saved, {}))
  })

  it('clamps a request zoom to the printable range, as normalizePdfOptions does', () => {
    expect(mergeSettings(saved, { pdf: { scale: 5 } }).pdf.scale).toBe(2)
    expect(mergeSettings(saved, { pdf: { scale: 0.01 } }).pdf.scale).toBe(0.1)
  })

  it('passes the JSON choice through: it is per input, not a setting', () => {
    expect(mergeSettings(saved, { read: { jsonAs: 'text' } }).read).toEqual({
      jsonAs: 'text',
      transcriptTimestamps: false,
      sqliteViews: true,
    })
  })

  it('with the defaults and an empty request gives what conversions use today, but JPG pictures', () => {
    expect(mergeSettings(defaults(), {})).toEqual({
      pictureFormat: 'jpeg',
      fetchPictures: true,
      allowLocalNetwork: true,
      renderedFormat: 'svg',
      codeColour: true,
      pdf: { pageSize: 'Letter', scale: 0.9, headerFooter: false, landscape: false },
      read: { transcriptTimestamps: true, sqliteViews: false },
      ocrLanguage: 'eng',
    })
  })
})
