import { describe, it, expect } from 'vitest'
import { installedLanguages, resolveLanguage, resolvePack } from '../../src/ocr/resolve-pack'

const on = (...paths: string[]) => (p: string) => paths.includes(p)
const base = { bundledDir: '/app/ocr', userDir: '/user/ocr', set: 'fast' as const }

describe('resolvePack', () => {
  it('finds the bundled English pack in its gzipped form', () => {
    expect(resolvePack({ ...base, language: 'eng', exists: on('/app/ocr/eng.traineddata.gz') })).toEqual({
      dir: '/app/ocr',
      file: 'eng.traineddata.gz',
      source: 'bundled',
    })
  })

  it('finds a downloaded pack, which is not gzipped', () => {
    expect(resolvePack({ ...base, language: 'deu', exists: on('/user/ocr/deu.traineddata') })).toEqual({
      dir: '/user/ocr',
      file: 'deu.traineddata',
      source: 'downloaded',
    })
  })

  it('prefers the bundled pack over a downloaded one of the same language', () => {
    // The offline guarantee must not depend on what sits in a writable dir.
    const r = resolvePack({
      ...base,
      language: 'eng',
      exists: on('/app/ocr/eng.traineddata.gz', '/user/ocr/eng.traineddata'),
    })
    expect(r?.source).toBe('bundled')
  })

  it('keeps the model sets apart', () => {
    const exists = on('/user/ocr/deu.best.traineddata')
    expect(resolvePack({ ...base, set: 'best', language: 'deu', exists })?.file).toBe('deu.best.traineddata')
    expect(resolvePack({ ...base, set: 'fast', language: 'deu', exists })).toBeNull()
  })

  it('reports nothing for a language that is not installed', () => {
    expect(resolvePack({ ...base, language: 'jpn', exists: () => false })).toBeNull()
  })
})

describe('resolveLanguage (which model OCR reads with)', () => {
  const dirs = { bundledDir: '/app/ocr', userDir: '/user/ocr' }

  it('uses the fast model the app downloads', () => {
    expect(resolveLanguage({ ...dirs, language: 'deu', exists: on('/user/ocr/deu.traineddata') })).toEqual({
      dir: '/user/ocr',
      file: 'deu.traineddata',
      source: 'downloaded',
      set: 'fast',
    })
  })

  it('uses a best model that is the only one there', () => {
    expect(resolveLanguage({ ...dirs, language: 'deu', exists: on('/user/ocr/deu.best.traineddata') })).toEqual({
      dir: '/user/ocr',
      file: 'deu.best.traineddata',
      source: 'downloaded',
      set: 'best',
    })
  })

  it('prefers best over fast when both are downloaded, since the app never fetches best itself', () => {
    const exists = on('/user/ocr/deu.traineddata', '/user/ocr/deu.best.traineddata')
    expect(resolveLanguage({ ...dirs, language: 'deu', exists })?.set).toBe('best')
  })

  it('still lets nothing in the writable directory shadow the bundled pack', () => {
    const exists = on('/app/ocr/eng.traineddata.gz', '/user/ocr/eng.best.traineddata')
    expect(resolveLanguage({ ...dirs, language: 'eng', exists })).toEqual({
      dir: '/app/ocr',
      file: 'eng.traineddata.gz',
      source: 'bundled',
      set: 'fast',
    })
  })

  it('finds a gzipped best model too', () => {
    const exists = on('/user/ocr/deu.best.traineddata.gz')
    expect(resolveLanguage({ ...dirs, language: 'deu', exists })?.file).toBe('deu.best.traineddata.gz')
  })

  it('reports nothing when neither model is there', () => {
    expect(resolveLanguage({ ...dirs, language: 'deu', exists: () => false })).toBeNull()
  })
})

describe('installedLanguages', () => {
  it('counts a language installed only as the best model', () => {
    const list = installedLanguages(['eng', 'deu', 'fra'], {
      bundledDir: '/app/ocr',
      userDir: '/user/ocr',
      exists: on('/app/ocr/eng.traineddata.gz', '/user/ocr/deu.best.traineddata'),
    })
    expect(list).toEqual([
      { code: 'eng', source: 'bundled' },
      { code: 'deu', source: 'downloaded' },
    ])
  })

  it('lists what is actually present, with where it came from', () => {
    const list = installedLanguages(['eng', 'deu', 'jpn'], {
      ...base,
      exists: on('/app/ocr/eng.traineddata.gz', '/user/ocr/deu.traineddata'),
    })
    expect(list).toEqual([
      { code: 'eng', source: 'bundled' },
      { code: 'deu', source: 'downloaded' },
    ])
  })

  it('never reports an empty list, because that would hide a broken install', () => {
    const list = installedLanguages(['eng', 'deu'], { ...base, exists: () => false })
    expect(list).toEqual([{ code: 'eng', source: 'bundled' }])
  })
})

describe('packIsGzipped', () => {
  it('tells the bundled pack from a downloaded one', async () => {
    const { packIsGzipped } = await import('../../src/ocr/resolve-pack')
    // The bundled English data ships gzipped; upstream tessdata serves plain
    // files. tesseract.js appends .gz itself when told to, and gets ENOENT
    // when told wrongly - which is how German failed while English worked.
    expect(packIsGzipped('eng.traineddata.gz')).toBe(true)
    expect(packIsGzipped('deu.traineddata')).toBe(false)
    expect(packIsGzipped('deu.best.traineddata')).toBe(false)
  })

  it('agrees with what resolvePack actually found', async () => {
    const { packIsGzipped, resolvePack } = await import('../../src/ocr/resolve-pack')
    const bundled = resolvePack({
      language: 'eng',
      set: 'fast',
      bundledDir: '/app/ocr',
      userDir: '/user/ocr',
      exists: (p) => p === '/app/ocr/eng.traineddata.gz',
    })
    expect(packIsGzipped(bundled!.file)).toBe(true)
    const downloaded = resolvePack({
      language: 'deu',
      set: 'fast',
      bundledDir: '/app/ocr',
      userDir: '/user/ocr',
      exists: (p) => p === '/user/ocr/deu.traineddata',
    })
    expect(packIsGzipped(downloaded!.file)).toBe(false)
  })
})
