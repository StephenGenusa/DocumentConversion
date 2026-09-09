import { describe, it, expect } from 'vitest'
import { normalizePdfOptions, PDF_PAGE_SIZES } from '../../src/core/pdf-options'

describe('normalizePdfOptions', () => {
  it('returns defaults for undefined input', () => {
    expect(normalizePdfOptions(undefined)).toEqual({
      scale: 1,
      pageSize: 'Letter',
      landscape: false,
      headerFooter: false,
    })
  })

  it('returns defaults for an empty object', () => {
    expect(normalizePdfOptions({})).toEqual({ scale: 1, pageSize: 'Letter', landscape: false, headerFooter: false })
  })

  it('passes through valid values', () => {
    expect(normalizePdfOptions({ scale: 1.5, pageSize: 'A4', landscape: true, headerFooter: true })).toEqual({
      scale: 1.5,
      pageSize: 'A4',
      landscape: true,
      headerFooter: true,
    })
  })

  it('treats non-boolean headerFooter as false', () => {
    expect(normalizePdfOptions({ headerFooter: 'yes' }).headerFooter).toBe(false)
    expect(normalizePdfOptions({ headerFooter: 1 }).headerFooter).toBe(false)
  })

  it('never accepts headerText from the caller (derived main-side only)', () => {
    const norm = normalizePdfOptions({ headerText: '<img onerror=x>' })
    expect(norm.headerText).toBeUndefined()
  })

  it('clamps scale above the Chromium maximum to 2', () => {
    expect(normalizePdfOptions({ scale: 5 }).scale).toBe(2)
  })

  it('clamps scale below the Chromium minimum to 0.1', () => {
    expect(normalizePdfOptions({ scale: 0.01 }).scale).toBe(0.1)
  })

  it('falls back to scale 1 for non-numeric scale', () => {
    expect(normalizePdfOptions({ scale: 'big' }).scale).toBe(1)
    expect(normalizePdfOptions({ scale: NaN }).scale).toBe(1)
    expect(normalizePdfOptions({ scale: Infinity }).scale).toBe(1)
  })

  it('falls back to Letter for an unknown page size', () => {
    expect(normalizePdfOptions({ pageSize: 'B5' }).pageSize).toBe('Letter')
    expect(normalizePdfOptions({ pageSize: 42 }).pageSize).toBe('Letter')
  })

  it('accepts every whitelisted page size', () => {
    for (const size of PDF_PAGE_SIZES) {
      expect(normalizePdfOptions({ pageSize: size }).pageSize).toBe(size)
    }
  })

  it('treats non-boolean landscape as false', () => {
    expect(normalizePdfOptions({ landscape: 'yes' }).landscape).toBe(false)
    expect(normalizePdfOptions({ landscape: 1 }).landscape).toBe(false)
  })

  it('returns defaults for non-object input', () => {
    expect(normalizePdfOptions('junk')).toEqual({ scale: 1, pageSize: 'Letter', landscape: false, headerFooter: false })
    expect(normalizePdfOptions(null)).toEqual({ scale: 1, pageSize: 'Letter', landscape: false, headerFooter: false })
  })
})
