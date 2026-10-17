import { describe, it, expect } from 'vitest'
import { conversionOptions } from '../../src/main/conversion-options'
import { DEFAULT_SETTINGS, parseSettings } from '../../src/core/settings'

/**
 * What a conversion started from the window runs with (settings spec 5.6):
 * the saved settings, with the conversion screen's shown controls on top.
 */
describe('conversionOptions (settings + request)', () => {
  const saved = parseSettings({
    pictures: { format: 'png' },
    rendered: { format: 'png' },
    pdf: { pageSize: 'A4', scale: 1.1, headerFooter: true },
    read: { transcriptTimestamps: false, sqliteViews: true },
    ocr: { language: 'deu' },
    code: { colour: false },
    web: { fetchPictures: false, allowLocalNetwork: false },
  }).settings

  it('takes every option from the settings when the request carries none', () => {
    expect(conversionOptions(saved, {})).toEqual({
      pdf: { pageSize: 'A4', scale: 1.1, headerFooter: true, landscape: false },
      slides: { splitOn: 'auto' },
      renderedFormat: 'png',
      pictureFormat: 'png',
      ocr: false,
      ocrLanguage: 'deu',
      read: { transcriptTimestamps: false, sqliteViews: true },
      codeColour: false,
      web: { fetchPictures: false, allowLocalNetwork: false },
    })
  })

  it('pictures are JPG by default (owner decision 1)', () => {
    expect(conversionOptions(DEFAULT_SETTINGS, {}).pictureFormat).toBe('jpeg')
  })

  it("a shown control's value wins for this conversion", () => {
    const opts = conversionOptions(saved, {
      pdf: { pageSize: 'Legal', scale: 0.75, landscape: true },
      slides: { splitOn: 'h2' },
      renderedFormat: 'svg',
      ocr: true,
      ocrLanguage: 'fra',
      read: { transcriptTimestamps: true, jsonAs: 'text' },
    })
    expect(opts.pdf).toEqual({ pageSize: 'Legal', scale: 0.75, headerFooter: true, landscape: true })
    expect(opts.slides).toEqual({ splitOn: 'h2' })
    expect(opts.renderedFormat).toBe('svg')
    expect(opts.ocr).toBe(true)
    expect(opts.ocrLanguage).toBe('fra')
    expect(opts.read).toEqual({ transcriptTimestamps: true, sqliteViews: true, jsonAs: 'text' })
  })

  it('picture format and code colour in a request are ignored: there are no such controls', () => {
    const opts = conversionOptions(saved, { pictureFormat: 'jpeg', codeColour: true })
    expect(opts.pictureFormat).toBe('png')
    expect(opts.codeColour).toBe(false)
  })

  it('code is coloured and web pictures fetched, the intranet included, by default', () => {
    expect(conversionOptions(DEFAULT_SETTINGS, {})).toMatchObject({
      codeColour: true,
      web: { fetchPictures: true, allowLocalNetwork: true },
    })
  })

  it('the web settings are never taken from a request', () => {
    const opts = conversionOptions(saved, { web: { fetchPictures: true, allowLocalNetwork: true }, fetchPictures: true })
    expect(opts.web).toEqual({ fetchPictures: false, allowLocalNetwork: false })
  })

  it('a bad value in a request is ignored and the setting used', () => {
    const opts = conversionOptions(saved, { pdf: { pageSize: 'Huge', scale: 'big' }, renderedFormat: 'gif', ocr: 'yes', read: 7 })
    expect(opts.pdf).toEqual({ pageSize: 'A4', scale: 1.1, headerFooter: true, landscape: false })
    expect(opts.renderedFormat).toBe('png')
    expect(opts.ocr).toBe(false)
    expect(opts.read).toEqual({ transcriptTimestamps: false, sqliteViews: true })
  })
})
