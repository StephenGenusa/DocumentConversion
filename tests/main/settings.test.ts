import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SETTINGS_FILE,
  SETTINGS_IPC_CHANNELS,
  openSettings,
  pageSizeForRegion,
  readSettingsFile,
  regionOf,
  settingsIpcHandlers,
  type SettingsStore,
  type SettingsStoreOptions,
} from '../../src/main/settings'
import { DEFAULT_SETTINGS } from '../../src/core/settings'

/**
 * The settings file (settings spec 5.1, 5.3, 5.5, 5.6): where it lives, how it
 * is written, what happens to a bad one, and the `settings:*` channels.
 *
 * Real files in a temp directory standing in for userData; nothing here
 * touches the real one.
 */
let dir: string
let file: string
let installed: Set<string>
/** Every store a test opened: each may still be writing (a first run writes at once) when the test ends. */
let opened: SettingsStore[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docconv-settings-'))
  file = join(dir, SETTINGS_FILE)
  installed = new Set(['eng', 'deu'])
  opened = []
})

afterEach(async () => {
  // A write still under way would make the folder again (it creates its
  // folder) after it was removed, and leave it behind.
  await Promise.all(opened.map((s) => s.flushed()))
  await rm(dir, { recursive: true, force: true })
})

function open(extra: Partial<SettingsStoreOptions> = {}): SettingsStore {
  return track(
    openSettings({
      dir,
      region: () => 'US',
      ocrInstalled: (code) => installed.has(code),
      now: () => new Date(Date.UTC(2026, 9, 16, 12, 30, 45, 6)),
      ...extra,
    }),
  )
}
function track(store: SettingsStore): SettingsStore {
  opened.push(store)
  return store
}

const onDisk = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'))

describe('the file', () => {
  it('is settings.json in the folder given (userData)', async () => {
    const store = open()
    await store.set({ key: 'code.color', value: false })
    expect(await onDisk()).toEqual({ version: 1, code: { color: false } })
  })

  it('is pretty-printed UTF-8 JSON, ending in a newline', async () => {
    const store = open()
    await store.set({ key: 'pdf.pageSize', value: 'A4' })
    const text = await readFile(file, 'utf8')
    expect(text).toBe('{\n  "version": 1,\n  "pdf": {\n    "pageSize": "A4"\n  }\n}\n')
  })

  it('is read once, when the store opens', async () => {
    await writeFile(file, JSON.stringify({ version: 1, pdf: { pageSize: 'A3' } }))
    const store = open()
    await writeFile(file, JSON.stringify({ version: 1, pdf: { pageSize: 'Legal' } }))
    expect(store.get().pdf.pageSize).toBe('A3')
  })

  it('is written atomically: a temporary file, then a rename, and no temporary file left', async () => {
    await writeFile(file, JSON.stringify({ version: 1, pdf: { pageSize: 'A3' } }))
    const seen: string[] = []
    const store = open({
      fs: {
        rename: async (from, to) => {
          seen.push(`rename ${from.slice(dir.length + 1)} -> ${to.slice(dir.length + 1)}`)
          // At the moment of the rename, the real file still holds the old settings.
          expect(JSON.parse(await readFile(to, 'utf8'))).toEqual({ version: 1, pdf: { pageSize: 'A3' } })
          const { rename } = await import('node:fs/promises')
          await rename(from, to)
        },
      },
    })
    await store.set({ key: 'pdf.pageSize', value: 'A4' })
    expect(seen).toEqual(['rename settings.json.tmp -> settings.json'])
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('a failed write leaves the old file and the settings in memory as they were', async () => {
    await writeFile(file, JSON.stringify({ version: 1, pdf: { pageSize: 'A3' } }))
    const store = open({
      fs: {
        rename: async () => {
          throw new Error('EACCES: permission denied')
        },
      },
    })
    const result = await store.set({ key: 'pdf.pageSize', value: 'A4' })
    expect(result).toMatchObject({ ok: false })
    expect((result as { message: string }).message).toMatch(/could not be saved/)
    expect(store.get().pdf.pageSize).toBe('A3')
    expect(await onDisk()).toEqual({ version: 1, pdf: { pageSize: 'A3' } })
  })

  it('creates the folder if it is not there yet', async () => {
    const nested = join(dir, 'not', 'yet')
    const store = track(openSettings({ dir: nested, region: () => 'US', ocrInstalled: () => true }))
    await store.set({ key: 'code.color', value: false })
    expect(JSON.parse(await readFile(join(nested, SETTINGS_FILE), 'utf8'))).toEqual({ version: 1, code: { color: false } })
  })

  it('writes one change after another, never two at once, and each sees the last', async () => {
    const store = open()
    await Promise.all([
      store.set({ key: 'pdf.pageSize', value: 'A4' }),
      store.set({ key: 'pdf.scale', value: 1.25 }),
      store.set({ key: 'code.color', value: false }),
    ])
    expect(await onDisk()).toEqual({ version: 1, pdf: { pageSize: 'A4', scale: 1.25 }, code: { color: false } })
  })
})

describe('first run', () => {
  it.each(['US', 'CA', 'MX', 'PH'])('in %s keeps Letter, and marks the first run done', async (region) => {
    const store = open({ region: () => region })
    await store.flushed()
    expect(store.get().pdf.pageSize).toBe('Letter')
    expect(await onDisk()).toEqual({ version: 1 })
  })

  it.each(['GB', 'DE', 'FR', 'IN', 'AU', 'JP', 'BR'])('in %s saves A4 as a normal setting', async (region) => {
    const store = open({ region: () => region })
    await store.flushed()
    expect(store.get().pdf.pageSize).toBe('A4')
    expect(await onDisk()).toEqual({ version: 1, pdf: { pageSize: 'A4' } })
  })

  it('with no region known keeps the built-in Letter', async () => {
    const store = open({ region: () => '' })
    await store.flushed()
    expect(store.get().pdf.pageSize).toBe('Letter')
  })

  it('happens once: a later start does not apply the region again', async () => {
    await (async () => {
      const first = open({ region: () => 'GB' })
      await first.flushed()
      await first.set({ key: 'pdf.pageSize', value: 'Letter' })
    })()
    const later = open({ region: () => 'GB' })
    await later.flushed()
    expect(later.get().pdf.pageSize).toBe('Letter')
  })

  it('a region that throws is no region', async () => {
    const store = open({
      region: () => {
        throw new Error('no locale')
      },
    })
    await store.flushed()
    expect(store.get().pdf.pageSize).toBe('Letter')
  })
})

describe('regionOf and pageSizeForRegion', () => {
  it("takes the system's country code first", () => {
    expect(regionOf('gb', ['en-US'])).toBe('GB')
  })

  it("falls back to the system locale's region, in any common spelling", () => {
    expect(regionOf('', ['en-GB'])).toBe('GB')
    expect(regionOf('', ['de_DE.UTF-8'])).toBe('DE')
    expect(regionOf('', ['fr'])).toBe('FR')
    expect(regionOf('', ['en'])).toBe('US')
    expect(regionOf('', ['', 'C', 'pt-BR'])).toBe('BR')
  })

  it('is empty when nothing says', () => {
    expect(regionOf('', [])).toBe('')
    expect(regionOf(undefined, ['C', 'POSIX', '!!'])).toBe('')
    expect(regionOf('USA', [])).toBe('')
  })

  it('gives Letter in US, CA, MX and PH, and when the region is unknown', () => {
    for (const r of ['US', 'CA', 'MX', 'PH', '']) expect(pageSizeForRegion(r)).toBe('Letter')
    for (const r of ['GB', 'DE', 'CN', 'ZA']) expect(pageSizeForRegion(r)).toBe('A4')
  })
})

describe('a bad file', () => {
  it('that is not JSON is renamed aside, the defaults used, and the window told once', async () => {
    await writeFile(file, '{"version": 1, "pdf": {')
    const store = open({ region: () => 'US' })
    await store.flushed()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(store.takeNotice()).toBe('Your settings file could not be read and was reset.')
    expect(store.takeNotice()).toBeUndefined()
    const names = (await readdir(dir)).sort()
    expect(names).toEqual(['settings.json', 'settings.json.bad-2026-10-16T12-30-45-006Z'])
    expect(await readFile(join(dir, names[1]), 'utf8')).toBe('{"version": 1, "pdf": {')
    expect(await onDisk()).toEqual({ version: 1 })
  })

  it('that is JSON but not settings (a list, a string) is treated the same', async () => {
    await writeFile(file, '[1, 2, 3]')
    const store = open()
    await store.flushed()
    expect(store.takeNotice()).toMatch(/reset/)
    expect((await readdir(dir)).some((n) => n.startsWith('settings.json.bad-'))).toBe(true)
  })

  it('reset after being renamed aside gets the regional page size again', async () => {
    await writeFile(file, 'not json')
    const store = open({ region: () => 'DE' })
    await store.flushed()
    expect(store.get().pdf.pageSize).toBe('A4')
  })

  it('with one bad value keeps the file and every other value, and tells no one', async () => {
    const text = JSON.stringify({ version: 1, pdf: { pageSize: 'B5', scale: 1.25 }, code: { color: false } })
    await writeFile(file, text)
    const store = open()
    await store.flushed()
    expect(store.get().pdf).toEqual({ pageSize: 'Letter', scale: 1.25, headerFooter: false })
    expect(store.get().code.color).toBe(false)
    expect(store.takeNotice()).toBeUndefined()
    expect(store.problems().map((p) => p.key)).toEqual(['pdf.pageSize'])
    expect(await readFile(file, 'utf8')).toBe(text)
  })

  it('that cannot be read at all (a folder in its place) gives the defaults and is left alone', async () => {
    await mkdir(file)
    const store = open({ region: () => 'DE' })
    await store.flushed()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(store.takeNotice()).toMatch(/could not be read/)
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('a temporary file left by a crash is ignored, then replaced', async () => {
    await writeFile(join(dir, 'settings.json.tmp'), '{"half": ')
    await writeFile(file, JSON.stringify({ version: 1, pdf: { pageSize: 'A3' } }))
    const store = open()
    expect(store.get().pdf.pageSize).toBe('A3')
    await store.set({ key: 'code.color', value: false })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })
})

describe('keeping what this app does not know', () => {
  it('keeps unknown keys, and a newer version, through a change and a reset', async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 3, appearance: { theme: 'dark' }, pdf: { pageSize: 'A4', margins: 'narrow' } }),
    )
    const store = open()
    expect(store.get().pdf.pageSize).toBe('A4')
    await store.set({ key: 'code.color', value: false })
    expect(await onDisk()).toEqual({
      version: 3,
      appearance: { theme: 'dark' },
      pdf: { pageSize: 'A4', margins: 'narrow' },
      code: { color: false },
    })
    await store.reset({})
    expect(await onDisk()).toEqual({ version: 3, appearance: { theme: 'dark' }, pdf: { margins: 'narrow' } })
  })
})

describe('set', () => {
  it('saves, and answers with the settings now in force', async () => {
    const store = open()
    const result = await store.set({ key: 'pictures.format', value: 'png' })
    expect(result).toEqual({ ok: true, settings: { ...structuredClone(DEFAULT_SETTINGS), pictures: { format: 'png' } } })
    expect(store.get().pictures.format).toBe('png')
  })

  it.each([
    ['nothing', undefined],
    ['an unknown key', { key: 'pdf.margins', value: 'narrow' }],
    ['the version', { key: 'version', value: 9 }],
    ['a whole section', { key: 'pdf', value: { pageSize: 'A4' } }],
    ['a prototype path', { key: '__proto__.polluted', value: true }],
    ['a bad value', { key: 'pictures.format', value: 'gif' }],
    ['a zoom out of range', { key: 'pdf.scale', value: 3 }],
    ['an unknown OCR language', { key: 'ocr.language', value: 'xx' }],
    ['an OCR language not installed', { key: 'ocr.language', value: 'fra' }],
  ])('refuses %s, and writes nothing', async (_name, req) => {
    const store = open()
    await store.flushed()
    const before = await readFile(file, 'utf8')
    const result = await store.set(req)
    expect(result).toMatchObject({ ok: false })
    expect((result as { message: string }).message).toMatch(/\S/)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('setting a value back to its default removes it from the file', async () => {
    const store = open()
    await store.set({ key: 'pdf.headerFooter', value: true })
    await store.set({ key: 'pdf.headerFooter', value: false })
    expect(await onDisk()).toEqual({ version: 1 })
  })

  it('tells listeners, after the file is written', async () => {
    const store = open()
    await store.flushed()
    const heard: unknown[] = []
    // What the file held when the listener was told, read then; awaited below rather than given a while to finish.
    const reads: Promise<unknown>[] = []
    const stop = store.onChange((s) => void reads.push(onDisk().then((d) => heard.push([s.code.color, d]))))
    await store.set({ key: 'code.color', value: false })
    await Promise.all(reads)
    expect(heard).toEqual([[false, { version: 1, code: { color: false } }]])
    stop()
    await store.set({ key: 'code.color', value: true })
    await Promise.all(reads)
    expect(heard).toHaveLength(1)
  })

  it('does not tell listeners about a refused change', async () => {
    const store = open()
    const heard: unknown[] = []
    store.onChange((s) => heard.push(s))
    await store.set({ key: 'pdf.pageSize', value: 'B5' })
    expect(heard).toEqual([])
  })

  it('hands out copies: changing what get() returned changes nothing', () => {
    const store = open()
    store.get().pdf.pageSize = 'A3'
    expect(store.get().pdf.pageSize).toBe('Letter')
  })
})

describe('the OCR language', () => {
  it('whose pack was removed reads as English, and comes back if it is installed again', async () => {
    await writeFile(file, JSON.stringify({ version: 1, ocr: { language: 'deu' } }))
    const store = open()
    expect(store.get().ocr.language).toBe('deu')
    installed.delete('deu')
    expect(store.get().ocr.language).toBe('eng')
    installed.add('deu')
    expect(store.get().ocr.language).toBe('deu')
  })

  it('tells the windows when a pack coming or going changes the language in force', async () => {
    await writeFile(file, JSON.stringify({ version: 1, ocr: { language: 'deu' } }))
    const store = open()
    const told: string[] = []
    store.onChange((s) => told.push(s.ocr.language))
    installed.delete('deu')
    store.packsChanged()
    expect(told).toEqual(['eng'])
    // The file still names German: it is the language again once it is back.
    expect(await onDisk()).toEqual({ version: 1, ocr: { language: 'deu' } })
    installed.add('deu')
    store.packsChanged()
    expect(told).toEqual(['eng', 'deu'])
  })

  it('says nothing when the pack that came or went is not the one in force', async () => {
    const store = open()
    const told: string[] = []
    store.onChange((s) => told.push(s.ocr.language))
    installed.delete('deu')
    store.packsChanged()
    installed.add('fra')
    store.packsChanged()
    expect(told).toEqual([])
  })
})

describe('reset', () => {
  it('one section removes its keys and leaves the others', async () => {
    const store = open()
    await store.set({ key: 'pdf.pageSize', value: 'A4' })
    await store.set({ key: 'code.color', value: false })
    const result = await store.reset({ section: 'pdf' })
    expect(result).toMatchObject({ ok: true })
    expect(store.get().pdf.pageSize).toBe('Letter')
    expect(await onDisk()).toEqual({ version: 1, code: { color: false } })
  })

  it('all of them, with no section given', async () => {
    const store = open()
    await store.set({ key: 'pdf.pageSize', value: 'A4' })
    await store.set({ key: 'ocr.language', value: 'deu' })
    await store.reset(undefined)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(await onDisk()).toEqual({ version: 1 })
  })

  it('refuses a section it does not know', async () => {
    const store = open()
    await store.set({ key: 'pdf.pageSize', value: 'A4' })
    for (const req of [{ section: 'theme' }, { section: 'version' }, { section: 42 }, 'pdf']) {
      expect(await store.reset(req)).toMatchObject({ ok: false })
    }
    expect(store.get().pdf.pageSize).toBe('A4')
  })
})

describe('readSettingsFile (for `--settings <path>` on the command line)', () => {
  it('reads a file without changing it or anything beside it', async () => {
    await writeFile(file, JSON.stringify({ version: 1, pictures: { format: 'png' }, pdf: { scale: 9 } }))
    const read = readSettingsFile(file)
    expect(read).toMatchObject({ ok: true })
    if (!read.ok) return
    expect(read.settings.pictures.format).toBe('png')
    expect(read.problems.map((p) => p.key)).toEqual(['pdf.scale'])
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('says why a file cannot be used, and leaves it where it is', async () => {
    expect(readSettingsFile(join(dir, 'missing.json'))).toMatchObject({ ok: false })
    await writeFile(file, 'not json')
    const read = readSettingsFile(file)
    expect(read).toMatchObject({ ok: false })
    expect((read as { message: string }).message).toMatch(/not valid JSON/)
    expect(await readdir(dir)).toEqual(['settings.json'])
  })
})

describe('the settings:* channels', () => {
  it('are get, set, reset and notice, and changed is the event', () => {
    const handlers = settingsIpcHandlers(open())
    expect(Object.keys(handlers).sort()).toEqual(['settings:get', 'settings:notice', 'settings:reset', 'settings:set'])
    expect(SETTINGS_IPC_CHANNELS.changed).toBe('settings:changed')
  })

  it('get answers the whole settings object', async () => {
    const handlers = settingsIpcHandlers(open())
    expect(await handlers['settings:get'](undefined, undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('set takes one { key, value } and refuses anything else', async () => {
    const store = open()
    const handlers = settingsIpcHandlers(store)
    expect(await handlers['settings:set'](undefined, { key: 'pdf.scale', value: 1.1 })).toMatchObject({ ok: true })
    expect(store.get().pdf.scale).toBe(1.1)
    expect(await handlers['settings:set'](undefined, { key: 'pdf.scale', value: '1.1' })).toMatchObject({ ok: false })
    expect(await handlers['settings:set'](undefined, [{ key: 'pdf.scale', value: 1 }])).toMatchObject({ ok: false })
    expect(await handlers['settings:set'](undefined, { version: 1, pdf: { scale: 1 } })).toMatchObject({ ok: false })
    expect(store.get().pdf.scale).toBe(1.1)
  })

  it('reset takes a section or nothing', async () => {
    const store = open()
    const handlers = settingsIpcHandlers(store)
    await store.set({ key: 'pdf.scale', value: 1.1 })
    expect(await handlers['settings:reset'](undefined, { section: 'pdf' })).toMatchObject({ ok: true })
    expect(store.get().pdf.scale).toBe(0.9)
  })

  it('notice answers the bad-file notice once', async () => {
    await writeFile(file, '{')
    const handlers = settingsIpcHandlers(open())
    expect(await handlers['settings:notice'](undefined, undefined)).toMatch(/reset/)
    expect(await handlers['settings:notice'](undefined, undefined)).toBeUndefined()
  })
})
