import { describe, it, expect } from 'vitest'
import { readAsciidoc } from '../../src/core/readers/asciidoc'
import { readRst } from '../../src/core/readers/rst'
import { readIcs } from '../../src/core/readers/ics'
import { detect } from '../../src/core/detect'

const src = (text: string, filename?: string) => ({ bytes: Buffer.from(text, 'utf8'), filename })

const ADOC = `= Framing Protocol
:author: Alice

The handshake begins with a *HELLO* frame and _negotiated_ versions.

== Flow control

* Credits are granted in batches
* Senders must not exceed the window

|===
| Stage | Owner

| Readers | Alice
| Writers | Bob
|===
`

const RST = `Framing Protocol
================

The handshake begins with a **HELLO** frame and *negotiated* versions.

Flow control
------------

- Credits are granted in batches
- Senders must not exceed the window
`

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:evt-1',
  'SUMMARY:Design review',
  'DTSTART:20260901T150000Z',
  'DTEND:20260901T160000Z',
  'LOCATION:Room 4',
  'DESCRIPTION:Walk through the framing spec',
  'ORGANIZER;CN=Alice:mailto:alice@example.com',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-2',
  'SUMMARY:Retro',
  'DTSTART:20260902T090000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

describe('readAsciidoc', () => {
  it('renders headings, inline formatting, lists and tables', async () => {
    const hub = await readAsciidoc(src(ADOC, 'spec.adoc'))
    expect(hub.html).toContain('<strong>HELLO</strong>')
    expect(hub.html).toContain('<em>negotiated</em>')
    expect(hub.html).toContain('Flow control')
    expect(hub.html).toContain('<li>')
    expect(hub.html).toContain('<table')
    expect(hub.html).toContain('Readers')
  })
  it('uses the document title', async () => {
    expect((await readAsciidoc(src(ADOC))).title).toBe('Framing Protocol')
  })
})

describe('readRst', () => {
  it('renders sections, inline formatting and lists', async () => {
    const hub = await readRst(src(RST, 'spec.rst'))
    expect(hub.html).toContain('Framing Protocol')
    expect(hub.html).toContain('<strong>HELLO</strong>')
    expect(hub.html).toContain('<em>negotiated</em>')
    expect(hub.html).toContain('<li>Credits are granted in batches</li>')
    expect(hub.title).toBe('Framing Protocol')
  })
  it('escapes raw markup in text', async () => {
    const hub = await readRst(src('Title\n=====\n\nA <script>tag</script> here.\n'))
    expect(hub.html).not.toContain('<script>')
    expect(hub.html).toContain('&lt;script&gt;')
  })
})

describe('readIcs', () => {
  it('renders one section per event with its details', async () => {
    const hub = await readIcs(src(ICS, 'invites.ics'))
    expect(hub.html).toContain('Design review')
    expect(hub.html).toContain('Room 4')
    expect(hub.html).toContain('Walk through the framing spec')
    expect(hub.html).toContain('Retro')
    expect(hub.html).toContain('2026')
  })
  it('orders events by start time', async () => {
    const hub = await readIcs(src(ICS))
    expect(hub.html.indexOf('Design review')).toBeLessThan(hub.html.indexOf('Retro'))
  })
  it('rejects a calendar with no events', async () => {
    await expect(readIcs(src('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'))).rejects.toMatchObject({
      code: 'read-failed',
    })
  })
})

describe('markup detection', () => {
  it('maps adoc/asciidoc/rst/ics extensions', () => {
    expect(detect(Buffer.from(ADOC), 'a.adoc')).toEqual({ kind: 'ok', format: 'asciidoc' })
    expect(detect(Buffer.from(ADOC), 'a.asciidoc')).toEqual({ kind: 'ok', format: 'asciidoc' })
    expect(detect(Buffer.from(RST), 'a.rst')).toEqual({ kind: 'ok', format: 'rst' })
    expect(detect(Buffer.from(ICS), 'a.ics')).toEqual({ kind: 'ok', format: 'ics' })
  })
  it('sniffs an ics calendar without its extension', () => {
    expect(detect(Buffer.from(ICS))).toEqual({ kind: 'ok', format: 'ics' })
  })
})
