import { describe, it, expect } from 'vitest'
import { allowedMergeTargets, allowedTargets, BINARY_TARGETS, isBinaryTarget } from '../../src/core/target-validity'
import { TARGET_FORMATS } from '../../src/core/types'

describe('allowedTargets', () => {
  it('allows everything for a plain text-ish source', () => {
    expect(allowedTargets([{ format: 'md' }])).toEqual([
      'txt',
      'md',
      'docx',
      'pdf',
      'html',
      'epub',
      'revealjs',
      'azw3',
      'azw4',
      'csv',
      'json',
      'xlsx',
    ])
  })

  it('excludes table-extraction targets when merging', () => {
    expect(allowedMergeTargets([{ format: 'md' }])).toEqual(['txt', 'md', 'docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4'])
  })

  it('restricts embedded images to pdf/docx/html', () => {
    expect(allowedTargets([{ format: 'image', imageMode: 'embed' }])).toEqual(['docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4'])
  })

  // Supersedes "allows text targets for OCRed images, excluding csv": that
  // ruling held only while OCR could produce nothing but paragraphs. The OCR
  // pipeline now reconstructs tables from word boxes, so csv/json/xlsx are
  // reachable and blocking them would make the capability unusable.
  it('allows every target for OCRed images, table targets included', () => {
    expect(allowedTargets([{ format: 'image', imageMode: 'ocr' }])).toEqual([
      'txt',
      'md',
      'docx',
      'pdf',
      'html',
      'epub',
      'revealjs',
      'azw3',
      'azw4',
      'csv',
      'json',
      'xlsx',
    ])
  })

  it('still excludes table targets when merging OCRed images', () => {
    expect(allowedMergeTargets([{ format: 'image', imageMode: 'ocr' }])).toEqual([
      'txt',
      'md',
      'docx',
      'pdf',
      'html',
      'epub',
      'revealjs',
      'azw3',
      'azw4',
    ])
  })

  it('intersects across multiple inputs', () => {
    const targets = allowedTargets([{ format: 'md' }, { format: 'image', imageMode: 'embed' }])
    expect(targets).toEqual(['docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4'])
  })
})

/**
 * Which targets are binary is asked in more than one place — the clipboard
 * refuses them (src/main/index.ts) and the UI hides the "copy" button for them
 * (OutputPicker.tsx) — and each place used to answer from its own hand-written
 * list of two names. epub and xlsx are both zip containers; writing one through
 * `Buffer.toString('utf8')` puts mojibake on the clipboard and calls it a
 * success. One list, so a new binary target cannot be added to half of them.
 */
describe('BINARY_TARGETS', () => {
  it('names every target whose bytes are not text', () => {
    expect([...BINARY_TARGETS].sort()).toEqual(['azw3', 'azw4', 'docx', 'epub', 'pdf', 'xlsx'])
  })

  it('classifies every declared target one way or the other', () => {
    for (const t of TARGET_FORMATS) expect(typeof isBinaryTarget(t)).toBe('boolean')
    // revealjs is a single HTML file, so it is text and can go to the clipboard.
    expect(TARGET_FORMATS.filter((t) => !isBinaryTarget(t))).toEqual([
      'txt',
      'md',
      'html',
      'revealjs',
      'csv',
      'json',
    ])
  })

  it('holds only declared targets', () => {
    for (const t of BINARY_TARGETS) expect(TARGET_FORMATS).toContain(t)
  })
})

describe('isClipboardTarget', () => {
  it('refuses binary targets, as before', async () => {
    const { isClipboardTarget } = await import('../../src/core/target-validity')
    for (const t of ['docx', 'pdf', 'epub', 'xlsx', 'azw3', 'azw4'] as const) {
      expect(isClipboardTarget(t), t).toBe(false)
    }
  })

  it('refuses a slide deck even though its bytes are text', async () => {
    const { isBinaryTarget, isClipboardTarget } = await import('../../src/core/target-validity')
    // Not binary - the clipboard handler would not mangle it - but it is a
    // whole standalone document with the engine inlined, so pasting it into
    // Word gives a wall of minified JavaScript rather than a presentation.
    expect(isBinaryTarget('revealjs')).toBe(false)
    expect(isClipboardTarget('revealjs')).toBe(false)
  })

  it('still allows the targets people actually paste', async () => {
    const { isClipboardTarget } = await import('../../src/core/target-validity')
    for (const t of ['txt', 'md', 'html', 'csv', 'json'] as const) {
      expect(isClipboardTarget(t), t).toBe(true)
    }
  })
})
