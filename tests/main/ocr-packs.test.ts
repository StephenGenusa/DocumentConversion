import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The pack manager's view of what is installed, against a real directory.
 *
 * userData and the installation are both temporary folders, so nothing here
 * touches the packs on this machine. The files are stand-ins: only their
 * names matter to the manager.
 */
let root: string
const userData = (): string => join(root, 'user')
const userPacks = (): string => join(userData(), 'ocr')

vi.mock('electron', () => ({
  app: { getPath: () => userData(), getAppPath: () => join(root, 'app') },
}))

type Packs = typeof import('../../src/main/ocr-packs')
const packs = (): Promise<Packs> => import('../../src/main/ocr-packs')

function place(...files: string[]): void {
  mkdirSync(userPacks(), { recursive: true })
  for (const f of files) writeFileSync(join(userPacks(), f), 'model')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ocr-packs-'))
  mkdirSync(join(root, 'resources', 'ocr'), { recursive: true })
  writeFileSync(join(root, 'resources', 'ocr', 'eng.traineddata.gz'), 'model')
  ;(process as unknown as { resourcesPath: string }).resourcesPath = join(root, 'resources')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('a language installed only as the best model', () => {
  it('counts as installed, so it can be the default and --ocr-lang takes it', async () => {
    place('deu.best.traineddata')
    const { installedCodes } = await packs()
    expect(installedCodes()).toContainEqual({ code: 'deu', source: 'downloaded' })
  })

  it('is what OCR reads with', async () => {
    place('deu.best.traineddata')
    const { langPathFor } = await packs()
    expect(langPathFor('deu')).toEqual({ dir: userPacks(), gzip: false, set: 'best' })
  })

  it('is listed with its own size', async () => {
    place('deu.best.traineddata')
    const { listPacks } = await packs()
    const deu = listPacks().find((l) => l.code === 'deu')!
    expect(deu).toMatchObject({ installed: true, source: 'downloaded', set: 'best', downloaded: ['best'] })
    expect(deu.onDisk).toBe(deu.size.best)
  })
})

describe('both models downloaded', () => {
  it('reads with best, and lists both with their combined size', async () => {
    place('deu.traineddata', 'deu.best.traineddata')
    const { langPathFor, listPacks } = await packs()
    expect(langPathFor('deu').set).toBe('best')
    const deu = listPacks().find((l) => l.code === 'deu')!
    expect(deu.set).toBe('best')
    expect(deu.downloaded).toEqual(['fast', 'best'])
    expect(deu.onDisk).toBe(deu.size.fast + deu.size.best)
  })

  it('removes both, so Remove takes the language away rather than swapping models', async () => {
    place('deu.traineddata', 'deu.best.traineddata')
    const { installedCodes, removePack } = await packs()
    expect(await removePack('deu')).toEqual({ ok: true })
    expect(existsSync(join(userPacks(), 'deu.traineddata'))).toBe(false)
    expect(existsSync(join(userPacks(), 'deu.best.traineddata'))).toBe(false)
    expect(installedCodes().map((c) => c.code)).toEqual(['eng'])
  })
})

describe('removePack', () => {
  it('removes a best-only language', async () => {
    place('deu.best.traineddata')
    const { removePack } = await packs()
    expect(await removePack('deu')).toEqual({ ok: true })
    expect(existsSync(join(userPacks(), 'deu.best.traineddata'))).toBe(false)
  })

  it('says so when nothing of the language was downloaded', async () => {
    const { removePack } = await packs()
    expect(await removePack('deu')).toEqual({ ok: false, message: 'That pack is not installed as a download.' })
  })

  it('still refuses a code outside the catalog', async () => {
    const { removePack } = await packs()
    expect(await removePack('../../victim')).toEqual({ ok: false, message: 'Unknown OCR language "../../victim".' })
  })
})

describe('a language with only the fast model', () => {
  it('reads with fast, as before', async () => {
    place('deu.traineddata')
    const { langPathFor, listPacks } = await packs()
    expect(langPathFor('deu')).toEqual({ dir: userPacks(), gzip: false, set: 'fast' })
    expect(listPacks().find((l) => l.code === 'deu')).toMatchObject({ set: 'fast', downloaded: ['fast'] })
  })

  it('leaves English bundled and the default model', async () => {
    const { langPathFor, listPacks } = await packs()
    expect(langPathFor('eng')).toEqual({ dir: join(root, 'resources', 'ocr'), gzip: true, set: 'fast' })
    expect(listPacks().find((l) => l.code === 'eng')).toMatchObject({ source: 'bundled', downloaded: [] })
  })
})
