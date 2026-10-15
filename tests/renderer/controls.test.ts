import { describe, it, expect } from 'vitest'
import { TARGET_FORMATS, SOURCE_FORMATS } from '../../src/core/types'
import {
  showsOutput,
  showsInput,
  appliedOptions,
  appliedReadOptions,
  editedCopyNote,
  SESSION_DEFAULTS,
  type ControlInput,
} from '../../src/renderer/src/lib/controls'

/**
 * Spec 2a: a control that is visible must change the result, and one that
 * would do nothing is hidden. These are the rules the conversion screen
 * shows controls by; the options sent with a conversion follow the same
 * rules, so a hidden control's remembered value is never applied.
 */
const doc: ControlInput = { source: 'docx' }

describe('output controls', () => {
  it('shows PDF options for pdf only', () => {
    for (const t of TARGET_FORMATS) expect(showsOutput('pdfOptions', t, [doc]), t).toBe(t === 'pdf')
  })

  it('shows the slide split for reveal.js slides only', () => {
    for (const t of TARGET_FORMATS) expect(showsOutput('slideSplit', t, [doc]), t).toBe(t === 'revealjs')
  })

  it('applies only the options that are shown', () => {
    const values = { pdf: { scale: 1.2 }, slides: { splitOn: 'h2' as const } }
    expect(appliedOptions('pdf', [doc], values)).toEqual({ pdf: { scale: 1.2 } })
    expect(appliedOptions('revealjs', [doc], values)).toEqual({ slides: { splitOn: 'h2' } })
    expect(appliedOptions('docx', [doc], values)).toEqual({})
  })
})

describe('the Diagrams choice (spec B4)', () => {
  const drawn: ControlInput = { source: 'md', features: { diagrams: true, math: false } }
  const plain: ControlInput = { source: 'md', features: { diagrams: false, math: false } }
  const svgTargets = ['pdf', 'html', 'revealjs', 'epub', 'azw4']

  it('shows for the outputs that take SVG, when an input has a diagram', () => {
    for (const t of TARGET_FORMATS) expect(showsOutput('renderedFormat', t, [plain, drawn]), t).toBe(svgTargets.includes(t))
  })

  it('stays hidden when no input has a diagram, or nothing is known yet', () => {
    for (const t of TARGET_FORMATS) {
      expect(showsOutput('renderedFormat', t, [plain]), t).toBe(false)
      expect(showsOutput('renderedFormat', t, [doc]), t).toBe(false)
      expect(showsOutput('renderedFormat', t, []), t).toBe(false)
    }
  })

  it('counts formulas: they are drawn too (MathJax, step 18)', () => {
    expect(showsOutput('renderedFormat', 'pdf', [{ source: 'md', features: { diagrams: false, math: true } }])).toBe(true)
    expect(showsOutput('renderedFormat', 'docx', [{ source: 'md', features: { diagrams: false, math: true } }])).toBe(false)
  })

  it('is sent only while shown, so a value kept while hidden is not applied', () => {
    const values = { pdf: { scale: 1 }, slides: { splitOn: 'auto' as const }, renderedFormat: 'png' as const }
    expect(appliedOptions('html', [drawn], values)).toEqual({ renderedFormat: 'png' })
    expect(appliedOptions('pdf', [drawn], values)).toEqual({ pdf: { scale: 1 }, renderedFormat: 'png' })
    expect(appliedOptions('docx', [drawn], values)).toEqual({})
    expect(appliedOptions('html', [plain], values)).toEqual({})
    // Back to an output that takes it: the value kept while hidden is there again.
    expect(appliedOptions('epub', [drawn], values)).toEqual({ renderedFormat: 'png' })
  })

  it('starts as Sharp (SVG) in every session: it is never saved, so a restart resets it', () => {
    expect(SESSION_DEFAULTS.renderedFormat).toBe('svg')
  })
})

describe('input controls', () => {
  it('shows embed/OCR on images only', () => {
    for (const s of SOURCE_FORMATS) expect(showsInput('imageMode', { source: s }), s).toBe(s === 'image')
  })

  it('shows the OCR language only when an image is set to OCR', () => {
    expect(showsInput('ocrLanguage', { source: 'image', imageMode: 'ocr' })).toBe(true)
    expect(showsInput('ocrLanguage', { source: 'image', imageMode: 'embed' })).toBe(false)
    expect(showsInput('ocrLanguage', { source: 'pdf', imageMode: 'ocr' })).toBe(false)
  })

  it('shows Include timestamps on transcripts only', () => {
    for (const s of SOURCE_FORMATS) expect(showsInput('timestamps', { source: s }), s).toBe(s === 'subtitles')
  })

  it('shows Include view results only on a database with views', () => {
    for (const s of SOURCE_FORMATS) expect(showsInput('sqliteViews', { source: s, viewCount: 2 }), s).toBe(s === 'sqlite')
    expect(showsInput('sqliteViews', { source: 'sqlite', viewCount: 0 })).toBe(false)
    expect(showsInput('sqliteViews', { source: 'sqlite' })).toBe(false)
  })
})

describe('the edited-copy note', () => {
  it('uses the SQLite wording for a database, and the records wording otherwise', () => {
    expect(editedCopyNote('sqlite')).toBe('This edited copy holds the first 5,000 rows of each table. Exporting it to CSV, JSON or Excel writes only those; to export every row, remove it and add the file again without opening it in the editor.')
    expect(editedCopyNote('json')).toMatch(/^This edited copy holds the first 5,000 records\./)
    expect(editedCopyNote('vcard')).toBe(editedCopyNote('json'))
  })
})

describe('reading choices sent with an input', () => {
  it('sends each choice only for its kind of input, with its default', () => {
    expect(appliedReadOptions('subtitles')).toEqual({ transcriptTimestamps: true })
    expect(appliedReadOptions('subtitles', { transcriptTimestamps: false, jsonAs: 'text' })).toEqual({ transcriptTimestamps: false })
    expect(appliedReadOptions('json', { transcriptTimestamps: false })).toEqual({ jsonAs: 'table' })
    expect(appliedReadOptions('docx', { transcriptTimestamps: false, jsonAs: 'text' })).toEqual({})
    expect(appliedReadOptions('sqlite')).toEqual({ sqliteViews: false })
    expect(appliedReadOptions('sqlite', { sqliteViews: true, jsonAs: 'text' })).toEqual({ sqliteViews: true })
    expect(appliedReadOptions('json', { sqliteViews: true })).toEqual({ jsonAs: 'table' })
  })
})
