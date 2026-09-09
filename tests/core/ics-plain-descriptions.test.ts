import { describe, it, expect } from 'vitest'
import { readIcs } from '../../src/core/readers/ics'

describe('plain-text ics descriptions', () => {
  const ics = (description: string): { bytes: Buffer } => ({
    bytes: Buffer.from(
      ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Planning', `DESCRIPTION:${description}`, 'END:VEVENT', 'END:VCALENDAR'].join(
        '\r\n',
      ),
      'utf8',
    ),
  })

  it('keeps each line of a multi-line description on its own line', async () => {
    const { html } = await readIcs(ics('Agenda:\\nReview budget\\nPick a date'))
    expect(html).toContain('Agenda:')
    expect(html).toContain('Review budget')
    expect(html).toContain('Pick a date')
    // The defect: all three fused into one <p>, so "budget" ran into "Pick".
    expect(html).not.toMatch(/Review budget\s+Pick a date/)
  })

  // A description that really does carry markup takes the HTML branch by
  // design; this pins the PLAIN branch, where stray angle brackets are content.
  it('escapes stray angle brackets in a plain description', async () => {
    const { html } = await readIcs(ics('budget < 5000 & scope > agreed\\nsecond line'))
    expect(html).toContain('&lt; 5000')
    expect(html).toContain('&amp; scope')
  })

  it('still renders a single-line description as one paragraph', async () => {
    const { html } = await readIcs(ics('Just one line'))
    expect(html).toContain('Just one line')
  })
})
