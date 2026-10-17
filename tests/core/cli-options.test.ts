import { describe, it, expect } from 'vitest'
import { parseArgs } from '../../src/cli/args'
import { cliConvertOptions } from '../../src/cli/options'
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '../../src/core/settings'

const req = (...argv: string[]) => {
  const r = parseArgs(argv)
  if (r.kind !== 'ok') throw new Error(`expected ok, got usage: ${r.message}`)
  return r.req
}
const onlyEnglish = (code: string) => code === 'eng'
const everyLanguage = () => true

const options = (settings: Readonly<Settings>, argv: string[], installed: (code: string) => boolean = everyLanguage) => {
  const r = cliConvertOptions(settings, req(...argv), installed)
  if (r.kind !== 'ok') throw new Error(`expected ok, got usage: ${r.message}`)
  return r
}

/** A settings file as the app writes it: only what differs from the defaults. */
const file = (raw: unknown): Settings => parseSettings(raw).settings

describe('cliConvertOptions: built-in defaults (settings spec 5.7)', () => {
  it('are DEFAULT_SETTINGS: JPG pictures, fetching on, intranet allowed, code colored', () => {
    const { options: o, notes } = options(DEFAULT_SETTINGS, ['a.md', '--to', 'pdf'])
    expect(notes).toEqual([])
    expect(o.pictureFormat).toBe('jpeg')
    expect(o.web).toEqual({ fetchPictures: true, allowLocalNetwork: true })
    expect(o.codeColor).toBe(true)
    expect(o.renderedFormat).toBe('svg')
    expect(o.pdf).toEqual({ pageSize: 'Letter', scale: 0.9, headerFooter: false, landscape: false })
    expect(o.read).toEqual({ transcriptTimestamps: true, sqliteViews: false })
    expect(o.ocr).toBe(false)
    expect(o.ocrLanguage).toBe('eng')
    expect(o.slides).toEqual({ splitOn: 'auto' })
  })

  it('take each flag', () => {
    const { options: o } = options(DEFAULT_SETTINGS, [
      'a.png', '--to', 'pdf', '--pictures', 'png', '--no-local-network', '--no-code-color', '--ocr', '--ocr-lang', 'deu',
      '--scale', '1.5', '--page', 'A4', '--landscape', '--header-footer', '--diagrams', 'png', '--no-timestamps',
      '--sqlite-views', '--json-as', 'text', '--split', 'h2',
    ])
    expect(o.pictureFormat).toBe('png')
    expect(o.web).toEqual({ fetchPictures: true, allowLocalNetwork: false })
    expect(o.codeColor).toBe(false)
    expect(o.ocr).toBe(true)
    expect(o.ocrLanguage).toBe('deu')
    expect(o.pdf).toEqual({ pageSize: 'A4', scale: 1.5, headerFooter: true, landscape: true })
    expect(o.renderedFormat).toBe('png')
    expect(o.read).toEqual({ transcriptTimestamps: false, sqliteViews: true, jsonAs: 'text' })
    expect(o.slides).toEqual({ splitOn: 'h2' })
    expect(options(DEFAULT_SETTINGS, ['a.md', '--to', 'pdf', '--no-fetch']).options.web).toEqual({
      fetchPictures: false,
      allowLocalNetwork: true,
    })
  })
})

describe('cliConvertOptions: a settings file', () => {
  const saved = file({
    version: 1,
    pictures: { format: 'png' },
    web: { fetchPictures: false },
    rendered: { format: 'png' },
    code: { color: false },
    pdf: { pageSize: 'A4', scale: 1.1, headerFooter: true },
    read: { transcriptTimestamps: false, sqliteViews: true },
    ocr: { language: 'fra' },
  })

  it('applies every value', () => {
    const { options: o } = options(saved, ['a.png', '--to', 'pdf', '--ocr'])
    expect(o.pictureFormat).toBe('png')
    expect(o.web).toEqual({ fetchPictures: false, allowLocalNetwork: true })
    expect(o.codeColor).toBe(false)
    expect(o.renderedFormat).toBe('png')
    expect(o.pdf).toEqual({ pageSize: 'A4', scale: 1.1, headerFooter: true, landscape: false })
    expect(o.read).toEqual({ transcriptTimestamps: false, sqliteViews: true })
    expect(o.ocrLanguage).toBe('fra')
  })

  it('loses to a flag', () => {
    const { options: o } = options(saved, [
      'a.png', '--to', 'pdf', '--pictures', 'jpg', '--diagrams', 'svg', '--page', 'Legal', '--scale', '0.5',
      '--ocr', '--ocr-lang', 'deu',
    ])
    expect(o.pictureFormat).toBe('jpeg')
    expect(o.renderedFormat).toBe('svg')
    expect(o.pdf.pageSize).toBe('Legal')
    expect(o.pdf.scale).toBe(0.5)
    expect(o.ocrLanguage).toBe('deu')
    const turnedOff = options(file({ web: { allowLocalNetwork: true } }), ['a.md', '--to', 'pdf', '--no-local-network'])
    expect(turnedOff.options.web.allowLocalNetwork).toBe(false)
  })

  it('--fetch and --code-color turn back on what the file turned off', () => {
    const { options: o } = options(saved, ['a.md', '--to', 'pdf', '--fetch', '--code-color'])
    expect(o.web).toEqual({ fetchPictures: true, allowLocalNetwork: true })
    expect(o.codeColor).toBe(true)
    // Each turns on only its own setting.
    expect(options(saved, ['a.md', '--to', 'pdf', '--fetch']).options.codeColor).toBe(false)
    expect(options(saved, ['a.md', '--to', 'pdf', '--code-color']).options.web.fetchPictures).toBe(false)
  })

  it("--fetch keeps the file's intranet rule, and goes with --no-local-network", () => {
    const lanOff = file({ version: 1, web: { fetchPictures: false, allowLocalNetwork: false } })
    expect(options(lanOff, ['a.md', '--to', 'pdf', '--fetch']).options.web).toEqual({ fetchPictures: true, allowLocalNetwork: false })
    expect(options(saved, ['a.md', '--to', 'pdf', '--fetch', '--no-local-network']).options.web).toEqual({
      fetchPictures: true,
      allowLocalNetwork: false,
    })
  })

  it('--fetch, --local-network and --code-color change nothing on the built-in defaults', () => {
    const { options: o } = options(DEFAULT_SETTINGS, ['a.md', '--to', 'pdf', '--fetch', '--local-network', '--code-color'])
    expect(o).toEqual(options(DEFAULT_SETTINGS, ['a.md', '--to', 'pdf']).options)
  })

  it('--local-network turns back on the intranet the file refused', () => {
    const lanOff = file({ version: 1, web: { allowLocalNetwork: false } })
    expect(options(lanOff, ['a.md', '--to', 'pdf']).options.web).toEqual({ fetchPictures: true, allowLocalNetwork: false })
    expect(options(lanOff, ['a.md', '--to', 'pdf', '--local-network']).options.web).toEqual({ fetchPictures: true, allowLocalNetwork: true })
  })

  it('--no-header-footer turns off the header and footer the file turned on', () => {
    expect(options(saved, ['a.md', '--to', 'pdf', '--no-header-footer']).options.pdf.headerFooter).toBe(false)
    expect(options(DEFAULT_SETTINGS, ['a.md', '--to', 'pdf', '--no-header-footer']).options.pdf.headerFooter).toBe(false)
  })

  it('a flag left off does not undo the file: --header-footer absent keeps the saved one', () => {
    expect(options(saved, ['a.md', '--to', 'pdf']).options.pdf.headerFooter).toBe(true)
  })

  it('an OCR language that is not installed falls back to English, said only when OCR runs', () => {
    expect(options(saved, ['a.png', '--to', 'txt'], onlyEnglish)).toMatchObject({ options: { ocrLanguage: 'eng' }, notes: [] })
    const withOcr = options(saved, ['a.png', '--to', 'txt', '--ocr'], onlyEnglish)
    expect(withOcr.options.ocrLanguage).toBe('eng')
    expect(withOcr.notes).toEqual(['The settings file\'s OCR language (fra) is not installed; English is used.'])
  })

  it('--ocr-lang for a language that is not installed is a usage error', () => {
    const r = cliConvertOptions(DEFAULT_SETTINGS, req('a.png', '--to', 'txt', '--ocr', '--ocr-lang', 'deu'), onlyEnglish)
    expect(r.kind).toBe('usage')
    if (r.kind === 'usage') expect(r.message).toMatch(/^--ocr-lang: deu is not installed/)
  })
})
