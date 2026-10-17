import { describe, it, expect } from 'vitest'
import { chooseOrientation, wideTablesDominate } from '../../src/core/orientation'
import { createPdfWriter } from '../../src/core/writers/pdf'
import { KINDLE_PAGE_INCHES, type PdfPrintOptions, type PdfRenderOptions } from '../../src/core/types'

/*
 * Automatic orientation (orientation.ts). Portrait and Landscape are exact;
 * Automatic turns the page for pictures alone that are wide (lone-picture
 * tests) and for a document that is mostly tables too wide for a portrait
 * page.
 */

/** A table of `columns` columns of `width`-letter words, `rows` rows. */
function table(columns: number, width: number, rows = 6): string {
  const word = 'abcdefghijklmnopqrstuvwxyz'.slice(0, width)
  const row = `<tr>${Array.from({ length: columns }, () => `<td>${word}</td>`).join('')}</tr>`
  return `<table><tbody>${row.repeat(rows)}</tbody></table>`
}

const prose = (words: number) => `<p>${Array.from({ length: words }, () => 'reading').join(' ')}</p>`

describe('chooseOrientation', () => {
  it('keeps Portrait and Landscape exactly as asked, whatever the document', () => {
    expect(chooseOrientation(table(20, 6), false, 'Letter')).toEqual({ landscape: false })
    expect(chooseOrientation(prose(10), true, 'Letter')).toEqual({ landscape: true })
  })

  it('prints a document that is mostly a too-wide table landscape', () => {
    // 20 columns of 6 letters need about 180 characters; Letter portrait holds about 95.
    expect(chooseOrientation(table(20, 6), 'auto', 'Letter')).toEqual({ landscape: true })
    expect(chooseOrientation(`<h1>Stock</h1>${prose(20)}${table(20, 6)}`, 'auto', 'A4')).toEqual({ landscape: true })
  })

  it('keeps portrait for a table that fits, prose, or a wide table among more prose', () => {
    expect(chooseOrientation(table(8, 6), 'auto', 'Letter')).toEqual({ landscape: false })
    expect(chooseOrientation(prose(50), 'auto', 'Letter')).toEqual({ landscape: false })
    // 20 x 6 cells of 6 letters (720) beside 200 words of 7 (1,400): the report is prose.
    expect(chooseOrientation(`${prose(100)}${table(20, 6)}${prose(100)}`, 'auto', 'Letter')).toEqual({ landscape: false })
  })

  it('measures against the paper chosen: what is too wide for Letter fits A3', () => {
    // 12 columns of 10 letters need about 156 characters, 9 about 117: Letter portrait holds 95, A3 132.
    expect(wideTablesDominate(table(12, 10), 'Letter')).toBe(true)
    expect(wideTablesDominate(table(12, 10), 'A3')).toBe(true)
    expect(wideTablesDominate(table(9, 10), 'Letter')).toBe(true)
    expect(wideTablesDominate(table(9, 10), 'A3')).toBe(false)
  })

  it('leaves a Kindle book of tables portrait: the table rule is for named paper only', () => {
    expect(chooseOrientation(table(20, 6), 'auto', KINDLE_PAGE_INCHES)).toEqual({ landscape: false })
  })
})

describe('the PDF writer', () => {
  async function printedWith(html: string, pdf?: PdfRenderOptions): Promise<PdfPrintOptions | undefined> {
    let seen: PdfPrintOptions | undefined
    await createPdfWriter(async (_h, o) => {
      seen = o
      return Buffer.from('%PDF-1.7\n%%EOF', 'latin1')
    })({ html, title: 'T' }, pdf ? { pdf } : undefined)
    return seen
  }

  it('prints a wide spreadsheet landscape in Automatic, and as chosen otherwise', async () => {
    expect((await printedWith(table(20, 6)))?.landscape).toBe(true)
    const asked: PdfRenderOptions = { scale: 0.9, pageSize: 'Letter', landscape: false, headerFooter: false }
    expect((await printedWith(table(20, 6), asked))?.landscape).toBe(false)
    expect((await printedWith(prose(10), { ...asked, landscape: true }))?.landscape).toBe(true)
    expect((await printedWith(prose(10), { ...asked, landscape: 'auto' }))?.landscape).toBe(false)
  })
})
