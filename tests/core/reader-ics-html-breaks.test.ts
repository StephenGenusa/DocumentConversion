/**
 * ICS folds every DESCRIPTION line break into a literal `\n`. node-ical
 * unescapes those to real newlines, but an HTML description then goes straight
 * to the sanitizer, where a newline is ordinary collapsing whitespace — so
 * three separate `<span><b>…</b></span>` items rendered as one glued sentence:
 *
 *   "…single-vector embeddings great, until they aren't Where retrieval still
 *    breaks, and what's next"
 *
 * Calendar clients treat those newlines as line breaks. So must we — but only
 * the ones in content position: Google Calendar also emits `</span\n>`, where
 * the newline is markup whitespace, not a break.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readIcs } from '../../src/core/readers/ics'

const CORPUS = join(__dirname, '../corpus')

function ics(lines: string[]): Buffer {
  return Buffer.from(
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:1', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260301T090000Z', 'SUMMARY:Lesson', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
  )
}

describe('ics html descriptions keep their line breaks', () => {
  it('breaks between sibling spans separated by an escaped newline', async () => {
    const hub = await readIcs({
      bytes: ics([
        String.raw`DESCRIPTION:<span><b>What makes single-vector embeddings great\, until they` +
          String.raw` aren't</b></span>\n<span><b>Where retrieval still breaks\, and what's next</b></span>`,
      ]),
      filename: 'cal.ics',
    })
    // The two items must not run together as one sentence.
    expect(hub.html).not.toMatch(/aren't<\/b><\/span>\s*<span><b>Where/)
    expect(hub.html).toMatch(/aren't<\/b><\/span>\s*<br\s*\/?>\s*<span><b>Where/)
  })

  it('treats a newline INSIDE a tag as markup whitespace, not a break', async () => {
    // Google Calendar really emits `</span\n>` in these descriptions.
    const hub = await readIcs({
      bytes: ics([String.raw`DESCRIPTION:<span><b>Item one</b></span\n>\n<span><b>Item two</b></span\n>`]),
      filename: 'cal.ics',
    })
    // A <br> injected inside the end tag would produce this wreckage.
    expect(hub.html).not.toContain('</span<br>')
    expect(hub.html).not.toContain('&lt;br&gt;')
    expect(hub.html).toMatch(/Item one<\/b><\/span>\s*<br\s*\/?>\s*<span><b>Item two/)
  })

  it('leaves a newline inside an attribute value alone', async () => {
    const hub = await readIcs({
      bytes: ics([
        String.raw`DESCRIPTION:<p>See <a href="https://example.com/a\nb" title="one\ntwo">the page</a>.</p>`,
      ]),
      filename: 'cal.ics',
    })
    expect(hub.html).toContain('the page</a>')
    expect(hub.html).not.toMatch(/href="[^"]*<br>/)
    expect(hub.html).not.toMatch(/title="[^"]*<br>/)
  })

  /**
   * SUPERSEDED: this pinned the plain-text path's newline collapse as
   * "unchanged behaviour" while only the HTML path was being fixed. It was the
   * same defect — a literal newline inside a <p> renders as a space, so a
   * multi-line agenda arrived as one run-on sentence — and is now fixed too:
   * one paragraph per line, which keeps the break in the hub and therefore in
   * txt, md and docx as well as html. Escaping is still asserted below.
   */
  it('gives each line of a plain-text description its own paragraph', async () => {
    const hub = await readIcs({
      bytes: ics([String.raw`DESCRIPTION:Line one\nLine two\, with comma\; and semicolon`]),
      filename: 'cal.ics',
    })
    expect(hub.html).toContain('<p>Line one</p>')
    expect(hub.html).toContain('<p>Line two, with comma; and semicolon</p>')
    // Was: a single <p> holding a raw "\n", which HTML renders as a space.
    expect(hub.html).not.toContain('<p>Line one\nLine two')
    expect(hub.html).not.toContain('<br>')
  })

  it('does not glue the real corpus lesson-notes-1.ics bullet list into one sentence', async () => {
    const file = join(CORPUS, 'lesson-notes-1.ics')
    if (!existsSync(file)) return
    const bytes = await readFile(file)
    const hub = await readIcs({ bytes, filename: 'lesson-notes-1.ics' })
    expect(hub.html).toContain("stick, until it doesn't")
    expect(hub.html).toContain('Where the routine actually breaks down')
    expect(hub.html).not.toMatch(/doesn't<\/b><\/span>\s*<span>/)
    expect(hub.html).not.toContain('</span<br>')
  })

  it('does not glue the real corpus lesson-notes-2.ics bullet list into one sentence', async () => {
    const file = join(CORPUS, 'lesson-notes-2.ics')
    if (!existsSync(file)) return
    const bytes = await readFile(file)
    const hub = await readIcs({ bytes, filename: 'lesson-notes-2.ics' })
    expect(hub.html).not.toMatch(/overpaying<\/b><\/span>\s*<span>/)
    expect(hub.html).not.toMatch(/pipeline<\/b><\/span>\s*<span>/)
  })
})
