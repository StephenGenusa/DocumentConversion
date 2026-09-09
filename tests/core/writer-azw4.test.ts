import { describe, it, expect } from 'vitest'
import { createAzw4Writer, extractAzw4Pdf } from '../../src/core/writers/azw4'
import { KINDLE_PAGE_INCHES, type PdfRenderOptions } from '../../src/core/types'

/**
 * There is no JS AZW4 reader, so unlike AZW3 this cannot be round-tripped
 * through an independent parser. The properties that ARE checkable are checked
 * instead: the container identifies itself, the bytes handed to the writer come
 * back out intact, and the page is the one this app forces rather than the one
 * the user asked for.
 *
 * NOT established here: that a Kindle renders it. Nothing in a suite can, and
 * section 0's rule - open the output and look at it - still applies before
 * this ships.
 */
const FAKE_PDF = Buffer.from('%PDF-1.7\nfake pdf body\n%%EOF', 'latin1')

function writerCapturing(seen: { opts?: PdfRenderOptions }) {
  return createAzw4Writer(async (_html, opts) => {
    seen.opts = opts
    return FAKE_PDF
  })
}

describe('the AZW4 writer', () => {
  it('forces the Kindle page, whatever the user chose', async () => {
    const seen: { opts?: PdfRenderOptions } = {}
    await writerCapturing(seen)(
      { html: '<p>a</p>', title: 'T' },
      { pdf: { scale: 2, pageSize: 'A3', landscape: true, headerFooter: true } },
    )
    expect(seen.opts?.pageSize).toEqual(KINDLE_PAGE_INCHES)
    // Scale and orientation are as meaningless as paper size for a fixed page.
    expect(seen.opts?.scale).toBe(1)
    expect(seen.opts?.landscape).toBe(false)
    expect(seen.opts?.headerFooter).toBe(false)
  })

  it('is 3.6 x 4.8 inches - the 6-inch screen measured out', () => {
    expect(KINDLE_PAGE_INCHES).toEqual({ width: 3.6, height: 4.8 })
    const diagonal = Math.hypot(KINDLE_PAGE_INCHES.width, KINDLE_PAGE_INCHES.height)
    expect(diagonal).toBeCloseTo(6, 5)
  })

  it('identifies itself as a Kindle container', async () => {
    const bytes = await writerCapturing({})({ html: '<p>a</p>', title: 'T' })
    expect(bytes.subarray(60, 64).toString('latin1')).toBe('BOOK')
    expect(bytes.subarray(64, 68).toString('latin1')).toBe('MOBI')
  })

  it('gives back the exact PDF it was handed', async () => {
    const bytes = await writerCapturing({})({ html: '<p>a</p>', title: 'T' })
    expect(extractAzw4Pdf(bytes)).toEqual(FAKE_PDF)
  })

  it('marks itself a print replica, not a reflowable book', async () => {
    const bytes = await writerCapturing({})({ html: '<p>a</p>', title: 'T' })
    // PDOC, not EBOK: claiming EBOK promises a reflow this format cannot do.
    expect(bytes.includes(Buffer.from('PDOC', 'latin1'))).toBe(true)
    expect(bytes.includes(Buffer.from('EBOK', 'latin1'))).toBe(false)
  })

  it('survives a PDF larger than one record', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(20_000, 0x41), Buffer.from('\n%%EOF')])
    const writer = createAzw4Writer(async () => big)
    const bytes = await writer({ html: '<p>a</p>', title: 'T' })
    expect(extractAzw4Pdf(bytes)).toEqual(big)
  })
})
