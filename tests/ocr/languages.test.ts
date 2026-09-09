import { describe, it, expect } from 'vitest'
import {
  BUNDLED_LANGUAGE,
  CONFIDENCE_FLOOR,
  LANGUAGES,
  TESSDATA_TAG,
  confidenceFloorFor,
  downloadUrl,
  findLanguage,
  isKnownLanguage,
  packFilename,
} from '../../src/ocr/languages'

describe('the OCR language catalogue', () => {
  it('has no duplicate codes', () => {
    const codes = LANGUAGES.map((l) => l.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('includes the bundled language', () => {
    expect(isKnownLanguage(BUNDLED_LANGUAGE)).toBe(true)
  })

  it('gives every language a script with a declared floor', () => {
    for (const l of LANGUAGES) {
      expect(CONFIDENCE_FLOOR[l.script], `${l.code} has no floor`).toBeTypeOf('number')
    }
  })

  it('never sets an unmeasured script more permissive than the calibrated one', () => {
    // 55 is the number the English pipeline was actually tuned to. A script
    // nobody has measured must not be allowed to accept MORE than that.
    for (const [script, floor] of Object.entries(CONFIDENCE_FLOOR)) {
      expect(floor, `${script} is below the calibrated Latin floor`).toBeGreaterThanOrEqual(
        CONFIDENCE_FLOOR.latin,
      )
    }
  })

  it('reaches beyond Latin script, which is the point of the feature', () => {
    const scripts = new Set(LANGUAGES.map((l) => l.script))
    for (const required of ['han', 'arabic', 'devanagari', 'cyrillic']) {
      expect(scripts.has(required as never), `no ${required} language offered`).toBe(true)
    }
  })

  it('falls back to the Latin floor for a language it does not know', () => {
    expect(confidenceFloorFor('not-a-language')).toBe(CONFIDENCE_FLOOR.latin)
    expect(confidenceFloorFor('ara')).toBe(CONFIDENCE_FLOOR.arabic)
  })

  it('pins downloads to a tag, never a moving branch', () => {
    // A branch would mean the model a user gets depends on the day they asked.
    const url = downloadUrl('deu', 'fast')
    expect(url).toContain(`/${TESSDATA_TAG}/`)
    expect(url).not.toContain('/main/')
    expect(url).not.toContain('/master/')
    expect(TESSDATA_TAG).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('fetches over https, from the two upstream repositories', () => {
    expect(downloadUrl('deu', 'fast')).toBe(
      `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_TAG}/deu.traineddata`,
    )
    expect(downloadUrl('deu', 'best')).toContain('tessdata_best')
    for (const l of LANGUAGES) {
      for (const set of ['fast', 'best'] as const) {
        expect(downloadUrl(l.code, set).startsWith('https://')).toBe(true)
      }
    }
  })

  it('keeps the two model sets in separate files', () => {
    // Same code, different accuracy: one overwriting the other would silently
    // change how well a user's documents are read.
    expect(packFilename('deu', 'fast')).toBe('deu.traineddata')
    expect(packFilename('deu', 'best')).toBe('deu.best.traineddata')
    expect(packFilename('deu', 'fast')).not.toBe(packFilename('deu', 'best'))
  })

  it('states a size for both model sets, with best never smaller', () => {
    for (const l of LANGUAGES) {
      expect(l.size.fast, `${l.code} fast size`).toBeGreaterThan(0)
      expect(l.size.best, `${l.code} best size`).toBeGreaterThan(l.size.fast)
    }
  })

  it('finds a language by code and reports an unknown one as unknown', () => {
    expect(findLanguage('jpn')?.name).toBe('Japanese')
    expect(findLanguage('xyz')).toBeUndefined()
    expect(isKnownLanguage('xyz')).toBe(false)
  })

  it('has no code that could escape a path when used as a filename', () => {
    for (const l of LANGUAGES) {
      expect(l.code, `${l.code} is not a safe filename stem`).toMatch(/^[a-z_]+$/)
    }
  })
})
