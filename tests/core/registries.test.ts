import { describe, it, expect, vi } from 'vitest'
import { getReader } from '../../src/core/readers'
import { createWriters } from '../../src/core/writers'
import { createPdfWriter } from '../../src/core/writers/pdf'
import { SOURCE_FORMATS, TARGET_FORMATS } from '../../src/core/types'
import { ConversionError } from '../../src/core/errors'

describe('registries', () => {
  it('has a reader for every source format', () => {
    for (const f of SOURCE_FORMATS) {
      expect(typeof getReader(f)).toBe('function')
    }
  })
  it('throws a typed error for an unknown source format', () => {
    const bogus = 'nope' as Parameters<typeof getReader>[0]
    expect(() => getReader(bogus)).toThrowError(ConversionError)
    try {
      getReader(bogus)
    } catch (e) {
      expect((e as ConversionError).code).toBe('read-failed')
    }
  })
  it('has a writer for every target format', () => {
    const render = vi.fn(async () => Buffer.from('%PDF-fake'))
    const writers = createWriters(render)
    for (const f of TARGET_FORMATS) expect(typeof writers[f]).toBe('function')
  })
})

describe('createPdfWriter', () => {
  it('renders the shelled html via the injected renderer', async () => {
    const render = vi.fn(async (html: string) => Buffer.from('PDF:' + html.length))
    const writer = createPdfWriter(render)
    const out = await writer({ html: '<p>hi</p>', title: 'T' })
    expect(render).toHaveBeenCalledOnce()
    expect(render.mock.calls[0][0]).toContain('<!doctype html>')
    expect(out.toString()).toContain('PDF:')
  })
})
