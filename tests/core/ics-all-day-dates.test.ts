import { describe, it, expect, afterEach } from 'vitest'
import { readIcs } from '../../src/core/readers/ics'

/**
 * D11: an all-day event (`DTSTART;VALUE=DATE:20240315`) is a calendar date with
 * no time and no timezone. node-ical builds it as LOCAL midnight, so pushing it
 * through `toISOString()` moves it a day earlier east of UTC and invents a
 * clock time west of it. The bug is invisible in UTC, so every assertion here
 * runs in a zone east of UTC (Europe/Berlin, +01) and one west of it
 * (America/Chicago, -05), with UTC kept only as a control.
 */

const EAST = 'Europe/Berlin'
const WEST = 'America/Chicago'
const originalTz = process.env.TZ

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

function calendar(...events: string[][]): { bytes: Buffer; filename: string } {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN']
  for (const event of events) lines.push('BEGIN:VEVENT', ...event, 'END:VEVENT')
  lines.push('END:VCALENDAR')
  return { bytes: Buffer.from(lines.join('\r\n'), 'utf8'), filename: 'cal.ics' }
}

/** Read the same calendar in a fixed zone, whatever zone the machine is in. */
async function readIn(tz: string, src: { bytes: Buffer; filename: string }): Promise<string> {
  process.env.TZ = tz
  const { html } = await readIcs(src)
  return html
}

describe('all-day events (DTSTART;VALUE=DATE)', () => {
  const holiday = calendar([
    'UID:1',
    'DTSTAMP:20240101T000000Z',
    'DTSTART;VALUE=DATE:20240315',
    'DTEND;VALUE=DATE:20240316',
    'SUMMARY:Holiday',
  ])

  for (const tz of [EAST, WEST, 'UTC']) {
    it(`prints the calendar date itself in ${tz}`, async () => {
      const html = await readIn(tz, holiday)
      expect(html).toContain('2024-03-15')
      // East of UTC the old code rendered the day before.
      expect(html).not.toContain('2024-03-14')
      // DTEND on an all-day event is exclusive, so the 16th is not part of it.
      expect(html).not.toContain('2024-03-16')
    })

    it(`prints no clock time for an all-day event in ${tz}`, async () => {
      const html = await readIn(tz, holiday)
      // West of UTC the old code invented "05:00" on an event with no time.
      expect(html).not.toMatch(/\d{2}:\d{2}/)
      expect(html).not.toContain('UTC')
    })
  }

  it('shows an inclusive range for a multi-day all-day event', async () => {
    const html = await readIn(
      EAST,
      calendar([
        'UID:1',
        'DTSTAMP:20240101T000000Z',
        'DTSTART;VALUE=DATE:20240315',
        'DTEND;VALUE=DATE:20240318',
        'SUMMARY:Conference',
      ]),
    )
    expect(html).toContain('2024-03-15')
    expect(html).toContain('2024-03-17')
    expect(html).not.toContain('2024-03-18')
  })

  it('handles an all-day event with no DTEND', async () => {
    const html = await readIn(
      WEST,
      calendar(['UID:1', 'DTSTAMP:20240101T000000Z', 'DTSTART;VALUE=DATE:20240315', 'SUMMARY:Solo']),
    )
    expect(html).toContain('2024-03-15')
    expect(html).not.toMatch(/\d{2}:\d{2}/)
  })
})

describe('dated events keep their time', () => {
  for (const tz of [EAST, WEST, 'UTC']) {
    it(`renders a UTC DTSTART unchanged in ${tz}`, async () => {
      const html = await readIn(
        tz,
        calendar([
          'UID:1',
          'DTSTAMP:20240101T000000Z',
          'DTSTART:20240315T140000Z',
          'DTEND:20240315T150000Z',
          'SUMMARY:Design review',
        ]),
      )
      expect(html).toContain('2024-03-15 14:00')
      expect(html).toContain('15:00')
      expect(html).toContain('UTC')
    })

    /**
     * The reason date-only detection must come from node-ical's `dateOnly`
     * flag / `datetype`, not from "the time is midnight": a real meeting at
     * 00:00 UTC exists, and it must still print its time.
     */
    it(`keeps 00:00 on a real midnight meeting in ${tz}`, async () => {
      const html = await readIn(
        tz,
        calendar([
          'UID:1',
          'DTSTAMP:20240101T000000Z',
          'DTSTART:20240315T000000Z',
          'DTEND:20240315T010000Z',
          'SUMMARY:Midnight cutover',
        ]),
      )
      expect(html).toContain('2024-03-15 00:00')
      expect(html).toContain('UTC')
    })
  }
})

describe('a malformed DTSTART does not cost the rest of the calendar', () => {
  const mixed = calendar(
    ['UID:1', 'DTSTAMP:20240101T000000Z', 'DTSTART:not-a-date', 'SUMMARY:BROKEN-EVENT'],
    ['UID:2', 'DTSTAMP:20240101T000000Z', 'DTSTART:20240315T140000Z', 'SUMMARY:GOOD-EVENT'],
  )

  for (const tz of [EAST, WEST]) {
    it(`still renders every other event in ${tz}`, async () => {
      const html = await readIn(tz, mixed)
      expect(html).toContain('GOOD-EVENT')
      expect(html).toContain('BROKEN-EVENT')
      expect(html).toContain('2024-03-15 14:00')
    })
  }

  it('shows the unparsed text rather than guessing or dropping it', async () => {
    const html = await readIn(EAST, mixed)
    expect(html).toContain('not-a-date')
    expect(html).toMatch(/unrecognized date/i)
    expect(html).not.toMatch(/Invalid Date|NaN|undefined/)
  })

  it('survives a calendar whose only event has a malformed DTSTART', async () => {
    const html = await readIn(
      WEST,
      calendar(['UID:1', 'DTSTAMP:20240101T000000Z', 'DTSTART:garbage', 'SUMMARY:Lonely']),
    )
    expect(html).toContain('Lonely')
    expect(html).not.toMatch(/Invalid Date|NaN|undefined/)
  })
})
