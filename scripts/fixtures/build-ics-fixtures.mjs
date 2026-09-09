#!/usr/bin/env node
/**
 * Builds the two .ics corpus fixtures from the shared vocabulary.
 *
 * They were static files, so their wording sat outside the one reviewed list
 * the rest of the corpus answers to. The DESCRIPTION deliberately carries the
 * HTML-in-a-calendar-field shape real invitations use, folded across lines the
 * way RFC 5545 requires, because that is what the reader has to unpick.
 *
 *   node scripts/fixtures/build-ics-fixtures.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as V from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus')

/** RFC 5545 escaping: commas and semicolons are field separators. */
const esc = (s) => s.replace(/([,;\\])/g, '\\$1')

/** Fold to 75 octets with a leading space on continuations, as the spec says. */
const fold = (line) => {
  const out = [line.slice(0, 74)]
  for (let i = 74; i < line.length; i += 73) out.push(` ${line.slice(i, i + 73)}`)
  return out.join('\r\n')
}

V.CALENDAR.events.forEach((e, i) => {
  const description = e.lines.map((t) => `<span><b>${esc(t)}</b></span\\n>`).join('\\n')
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${V.CALENDAR.producer}`,
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    'DTSTAMP:20260301T090000Z',
    `DTSTART:${e.start}`,
    `DTEND:${e.end}`,
    `SUMMARY:${esc(e.summary)}`,
    fold(`DESCRIPTION:${description}`),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\n')
  const name = `lesson-notes-${i + 1}.ics`
  writeFileSync(join(OUT, name), ics)
  console.log('wrote', name)
})
