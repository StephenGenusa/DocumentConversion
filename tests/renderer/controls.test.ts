import { describe, it, expect } from 'vitest'
import { TARGET_FORMATS, SOURCE_FORMATS } from '../../src/core/types'
import { showsOutput, showsInput, appliedOptions, appliedReadOptions, editedCopyNote, type ControlInput } from '../../src/renderer/src/lib/controls'

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
    expect(editedCopyNote('sqlite')).toBe('Edited copy: tables are limited to 5,000 rows. Discard edits to export every row.')
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
