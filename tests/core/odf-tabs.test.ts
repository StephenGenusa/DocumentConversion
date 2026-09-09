import { describe, it, expect } from 'vitest'
import { odfText } from '../../src/core/readers/odf-common'

/**
 * ODF had the same defect the docx reader just had: `<text:tab/>` became a raw
 * tab, and HTML collapses a tab to a single space, so a table-of-contents entry
 * fused with its page number. Four non-breaking spaces instead, matching the
 * docx reader, so the separation survives into the CSS-less targets too.
 */
describe('odfText tab stops', () => {
  const GAP = ' '.repeat(4)

  it('keeps a tab stop visible instead of collapsing it to one space', () => {
    expect(odfText('<text:p>How to Catalogue<text:tab/>Page 3</text:p>')).toBe(`How to Catalogue${GAP}Page 3`)
  })

  it('handles the non-self-closing spelling', () => {
    expect(odfText('<text:p>A<text:tab></text:tab>B</text:p>')).toBe(`A${GAP}B`)
  })

  it('keeps consecutive tab stops distinct', () => {
    expect(odfText('<text:p>A<text:tab/><text:tab/>B</text:p>')).toBe(`A${GAP}${GAP}B`)
  })

  it('still collapses ordinary runs of whitespace', () => {
    expect(odfText('<text:p>one   two\n\nthree</text:p>')).toBe('one two three')
  })

  it('does not leave a tab gap dangling at either end', () => {
    expect(odfText('<text:p><text:tab/>indented</text:p>')).toBe('indented')
  })

  it('still separates words across a line break and a space run', () => {
    expect(odfText('<text:p>a<text:line-break/>b<text:s text:c="3"/>c</text:p>')).toBe('a b c')
  })
})

/**
 * The HTML branch of an .ics description was fixed to keep its line breaks; the
 * plain-text branch had the same defect and was pinned rather than fixed. A
 * literal newline inside a <p> renders as a space, so a multi-line agenda
 * arrived as one run-on sentence.
 */
