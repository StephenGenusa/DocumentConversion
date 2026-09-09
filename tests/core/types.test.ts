import { describe, it, expect } from 'vitest'
import { SOURCE_FORMATS, TARGET_FORMATS, EXTENSIONS } from '../../src/core/types'
import { ConversionError } from '../../src/core/errors'

describe('core types', () => {
  it('lists the writable target formats', () => {
    expect(TARGET_FORMATS).toEqual(['txt', 'md', 'docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4', 'csv', 'json', 'xlsx'])
  })
  it('lists every source format including read-only ones', () => {
    expect(SOURCE_FORMATS).toEqual(
      expect.arrayContaining(['txt', 'md', 'docx', 'pdf', 'html', 'eml', 'msg', 'csv', 'xlsx', 'rtf', 'image', 'code']),
    )
  })
  it('maps every target format to an extension', () => {
    expect(Object.keys(EXTENSIONS).sort()).toEqual([...TARGET_FORMATS].sort())
    expect(EXTENSIONS.pdf).toBe('.pdf')
  })
  it('ConversionError carries a code', () => {
    const e = new ConversionError('scanned-pdf', 'no text')
    expect(e.code).toBe('scanned-pdf')
    expect(e).toBeInstanceOf(Error)
  })
})
