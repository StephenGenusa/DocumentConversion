import { describe, it, expect } from 'vitest'
import { TARGET_FORMATS, SOURCE_FORMATS } from '../../src/core/types'
import { showsOutput, showsInput, appliedOptions, appliedReadOptions, type ControlInput } from '../../src/renderer/src/lib/controls'

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
})

describe('reading choices sent with an input', () => {
  it('sends each choice only for its kind of input, with its default', () => {
    expect(appliedReadOptions('subtitles')).toEqual({ transcriptTimestamps: true })
    expect(appliedReadOptions('subtitles', { transcriptTimestamps: false, jsonAs: 'text' })).toEqual({ transcriptTimestamps: false })
    expect(appliedReadOptions('json', { transcriptTimestamps: false })).toEqual({ jsonAs: 'table' })
    expect(appliedReadOptions('docx', { transcriptTimestamps: false, jsonAs: 'text' })).toEqual({})
  })
})
