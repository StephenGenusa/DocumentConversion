import { ConversionError } from '../errors'
import { sanitizeToHub } from '../allowlist'
import { escapeHtml } from '../shell'
import type { HubDocument, SourceInput } from '../types'

function looksLikeHtml(text: string): boolean {
  return /<(a|p|br|div|span|ul|ol|li|strong|em|b|i|table)\b[^>]*>/i.test(text)
}

/**
 * A complete tag, quote-aware so a `>` inside an attribute value does not end
 * it early — or a single line ending.
 */
const TAG_OR_NEWLINE = /<[/!?]?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|\r\n|\r|\n/g

/**
 * ICS folds every DESCRIPTION line break into a literal `\n`, which node-ical
 * unescapes to a real newline. Calendar clients render those as line breaks,
 * but HTML collapses them as ordinary whitespace — so a description built from
 * one `<span><b>…</b></span>` per bullet arrived as a single glued sentence
 * ("…until they aren't Where retrieval still breaks…").
 *
 * Only newlines in content position are breaks. Google Calendar also emits
 * `</span\n>`, and an invite may carry a newline inside an attribute value;
 * those are markup whitespace, and turning them into `<br>` would wreck the
 * tag. So walk tags and text separately and convert only the latter.
 */
function newlinesToBreaks(html: string): string {
  return html.replace(TAG_OR_NEWLINE, (match) =>
    match.startsWith('<') ? match.replace(/[\r\n]+/g, ' ') : '<br>',
  )
}

/**
 * A plain-text DESCRIPTION has exactly the same problem as the HTML one: its
 * newlines are real line breaks to every calendar client, and dropping the
 * whole thing into one `<p>` renders them as spaces, so a three-line agenda
 * arrives as one run-on sentence. One paragraph per line keeps the breaks in
 * the hub itself, so they survive into txt, md and docx as well as html.
 */
function plainDescriptionToHtml(description: string): string {
  return description
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('')
}

/**
 * node-ical hands back a `Date` for a DTSTART it understood and the raw string
 * for one it did not, so every consumer here has to check before it calls a
 * Date method. It also tags a `VALUE=DATE` value with `dateOnly` (and records
 * `datetype: 'date'` on the event), which is the only trustworthy signal for
 * an all-day event.
 */
type IcsDate = (Date & { dateOnly?: boolean }) | string

interface IcsEvent {
  type?: string
  summary?: string
  location?: string
  description?: string
  start?: IcsDate
  end?: IcsDate
  /** 'date' for `DTSTART;VALUE=DATE`, 'date-time' otherwise. */
  datetype?: string
  organizer?: { params?: { CN?: string }; val?: string } | string
}

function isUsableDate(value?: IcsDate): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

/**
 * An all-day event is a calendar date: no time, no timezone. node-ical builds
 * it with `new Date(y, m, d)` — LOCAL midnight — so `toISOString()` reports the
 * day before east of UTC and invents a clock time west of it (a holiday on the
 * 15th printed as "2024-03-14 23:00 UTC" in Berlin and "2024-03-15 05:00 UTC"
 * in Chicago). Local getters are the correct readers for such a value.
 *
 * Detection comes from node-ical's `dateOnly` flag, falling back to the
 * event's `datetype`. It deliberately does NOT infer date-only from the clock
 * reading midnight: a real 00:00 meeting exists and must keep its time.
 */
function isAllDay(value: IcsDate | undefined, datetype?: string): value is Date {
  if (!isUsableDate(value)) return false
  return value.dateOnly === true || datetype === 'date'
}

function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const UNRECOGNIZED = 'unrecognized date'

/**
 * What a DTSTART we could not parse becomes. Dropping the row would hide that
 * the file said something; guessing a date would be a lie. Showing the raw
 * text under a plain label is the honest degradation, and it keeps one bad
 * event from costing the whole calendar.
 */
function unparsedWhen(value: IcsDate): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw ? `${raw} (${UNRECOGNIZED})` : `(${UNRECOGNIZED})`
}

function formatAllDay(start: Date, end?: IcsDate): string {
  const from = localDate(start)
  // RFC 5545 3.8.2.2: DTEND is exclusive, so a one-day holiday carries the
  // NEXT day. Printing it verbatim would name a day the event does not cover.
  if (!isAllDay(end, undefined)) return `${from} (all day)`
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1)
  const to = localDate(last)
  return to === from || last.getTime() < start.getTime() ? `${from} (all day)` : `${from} – ${to} (all day)`
}

function formatWhen(start?: IcsDate, end?: IcsDate, datetype?: string): string {
  if (!start) return ''
  if (isAllDay(start, datetype)) return formatAllDay(start, end)
  if (!isUsableDate(start)) return unparsedWhen(start)
  const date = start.toISOString().slice(0, 10)
  const time = start.toISOString().slice(11, 16)
  if (!isUsableDate(end)) return `${date} ${time} UTC`
  const sameDay = end.toISOString().slice(0, 10) === date
  const endText = sameDay ? end.toISOString().slice(11, 16) : `${end.toISOString().slice(0, 10)} ${end.toISOString().slice(11, 16)}`
  return `${date} ${time}–${endText} UTC`
}

function organizerName(organizer: IcsEvent['organizer']): string | undefined {
  if (!organizer) return undefined
  if (typeof organizer === 'string') return organizer
  return organizer.params?.CN ?? organizer.val?.replace(/^mailto:/i, '')
}

/** Calendar invites: one section per event, sorted by start time. */
export async function readIcs(src: SourceInput): Promise<HubDocument> {
  let events: IcsEvent[]
  try {
    const ical = await import('node-ical')
    const parsed = ical.parseICS(src.bytes.toString('utf8')) as Record<string, IcsEvent>
    events = Object.values(parsed).filter((e) => e.type === 'VEVENT')
  } catch (err) {
    throw new ConversionError('read-failed', `Could not parse calendar: ${(err as Error).message}`)
  }
  if (events.length === 0) throw new ConversionError('read-failed', 'This calendar contains no events')

  // An event whose DTSTART we could not parse has no position on a timeline;
  // it keeps the undated event's slot (the front) rather than crashing the sort.
  const startTime = (e: IcsEvent): number => (isUsableDate(e.start) ? e.start.getTime() : 0)
  events.sort((a, b) => startTime(a) - startTime(b))
  const sections = events.map((e) => {
    const rows: string[] = []
    const add = (label: string, value?: string): void => {
      if (value && value.trim()) rows.push(`<tr><td>${label}</td><td>${escapeHtml(value)}</td></tr>`)
    }
    add('When', formatWhen(e.start, e.end, e.datetype))
    add('Location', e.location)
    add('Organizer', organizerName(e.organizer))
    const parts = [`<h2>${escapeHtml(e.summary ?? 'Untitled event')}</h2>`]
    if (rows.length > 0) parts.push(`<table><tbody>${rows.join('')}</tbody></table>`)
    const description = e.description?.trim()
    if (description) {
      // Invite descriptions from Outlook/Google routinely contain real HTML;
      // escaping it showed users raw <span> and &amp;amp; markup.
      parts.push(
        looksLikeHtml(description)
          ? sanitizeToHub(newlinesToBreaks(description))
          : plainDescriptionToHtml(description),
      )
    }
    return parts.join('\n')
  })

  return { html: sections.join('\n'), title: src.filename?.split(/[\\/]/).pop() }
}
