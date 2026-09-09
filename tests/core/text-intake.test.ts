import { describe, it, expect } from 'vitest'
import { renderEditableText } from '../../src/core/text-intake'
import { isEditableTextFormat } from '../../src/core/types'

/**
 * Pasted text that opens in the edit pane. Everything here is real — the same
 * markdown reader and the same hub sanitizer the converter runs — because the
 * point of the feature is that the pane previews what the conversion will
 * actually start from.
 */
describe('renderEditableText', () => {
  it('renders pasted markdown as formatted HTML, not as its source characters', async () => {
    const html = await renderEditableText('# Release notes\n\nShipped **today**.', 'md')
    expect(html).toContain('<h1>Release notes</h1>')
    expect(html).toContain('<strong>today</strong>')
    expect(html).not.toContain('#')
    expect(html).not.toContain('**')
  })

  it('renders markdown lists and tables as real structure', async () => {
    const html = await renderEditableText('- one\n- two\n', 'md')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>')
  })

  it('wraps pasted plain text in paragraphs, one per block', async () => {
    const html = await renderEditableText('First para.\n\nSecond para.', 'txt')
    expect(html).toContain('<p>First para.</p>')
    expect(html).toContain('<p>Second para.</p>')
  })

  it('escapes markup in pasted plain text rather than rendering it', async () => {
    const html = await renderEditableText('a <script>alert(1)</script> b', 'txt')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('strips script the markdown reader would otherwise pass through as inline HTML', async () => {
    const html = await renderEditableText('Hi <script>alert(1)</script>', 'md')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('refuses a format outside the editable set, so the channel cannot reach other readers', async () => {
    await expect(renderEditableText('BEGIN:VCALENDAR', 'ics')).rejects.toThrow(/not editable text/i)
    await expect(renderEditableText('<p>x</p>', 'html')).rejects.toThrow(/not editable text/i)
  })
})

describe('isEditableTextFormat', () => {
  it('accepts exactly markdown and plain text', () => {
    expect(isEditableTextFormat('md')).toBe(true)
    expect(isEditableTextFormat('txt')).toBe(true)
  })

  it('rejects the other formats pasted text can be detected as', () => {
    for (const format of ['ics', 'ipynb', 'mbox', 'eml', 'csv', 'html']) {
      expect(isEditableTextFormat(format)).toBe(false)
    }
  })
})
