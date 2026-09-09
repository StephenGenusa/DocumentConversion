import { describe, it, expect } from 'vitest'
import { writeTxt } from '../../src/core/writers/txt'

describe('writeTxt tables', () => {
  it('keeps cells separated instead of running them together', async () => {
    const html =
      '<table><tbody><tr><td>From</td><td>Alice</td></tr><tr><td>Subject</td><td>Vendor limits</td></tr></tbody></table>'
    const text = (await writeTxt({ html })).toString('utf8')
    expect(text).not.toContain('FromAlice')
    expect(text).toMatch(/From\s+Alice/)
    expect(text).toMatch(/Subject\s+Vendor limits/)
  })

  it('keeps data table rows on separate lines', async () => {
    const html =
      '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Widget</td><td>3</td></tr><tr><td>Gadget</td><td>7</td></tr></tbody></table>'
    const text = (await writeTxt({ html })).toString('utf8')
    expect(text).not.toContain('Widget3')
    const widgetLine = text.split('\n').find((l) => l.includes('Widget'))
    expect(widgetLine).toBeDefined()
    expect(widgetLine).not.toContain('Gadget')
  })
})

/**
 * Attachment lists reach this writer as a two-column table (see
 * renderAttachmentList in the email readers): the name in column one, the size
 * in column two. html-to-text's built-in `table` selector carries
 * maxColumnWidth: 60, which our `{ selector: 'table', format: 'dataTable' }`
 * entry inherits, and the cell's InlineTextBuilder reads that width in
 * preference to the global `wordwrap: false`. A name longer than 60 characters
 * was therefore folded inside its own cell, leaving the size beside the first
 * fragment and the rest of the name alone on the next line - one attachment
 * that reads as two.
 */
describe('writeTxt attachment lists', () => {
  const attachment = (name: string, size: string) =>
    `<h3>Attachments (not converted)</h3><table><tbody><tr><td>${name}</td><td>${size}</td></tr>` +
    '<tr><td>short.pdf</td><td>1024 bytes</td></tr></tbody></table>'

  it('keeps a long attachment name on one line with its size', async () => {
    // 75 characters, spaces and all - an ordinary attachment name.
    const name = 'ELMWOOD LIBRARIES NORTHGATE ANNEX RE-SHELVING SURVEY 4 RM BG 0123456789.msg'
    const text = (await writeTxt({ html: attachment(name, '141824 bytes') })).toString('utf8')
    const line = text.split('\n').find((l) => l.includes('ELMWOOD'))
    expect(line).toBeDefined()
    expect(line).toContain(name)
    expect(line).toContain('141824 bytes')
  })

  it('does not leave an orphaned fragment of a name on its own line', async () => {
    const name = 'RE_ REQ_ 2088-NGA ELMWOOD LIBRARIES NORTHGATE ADDED STOCK Req 2026_0123456789.msg'
    const text = (await writeTxt({ html: attachment(name, '526848 bytes') })).toString('utf8')
    // Every line that carries part of the name must carry all of it.
    const touching = text.split('\n').filter((l) => l.trim() && name.includes(l.trim().split(/\s{2,}/)[0]))
    expect(touching).toHaveLength(1)
    expect(touching[0]).toContain(name)
  })

  it('still separates the two columns of a short attachment row', async () => {
    const text = (await writeTxt({ html: attachment('a.pdf', '10 bytes') })).toString('utf8')
    expect(text).not.toContain('a.pdf10 bytes')
    expect(text).toMatch(/a\.pdf\s+10 bytes/)
  })
})
