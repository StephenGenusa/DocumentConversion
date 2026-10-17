import * as iconv from 'iconv-lite'
import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import { decodeTextBytes } from './txt'
import { MAX_RECORD_SOURCE_BYTES, PRINT_RECORD_LIMIT, limitMessage, recordsTableHtml, type RowSource } from '../records'
import type { HubDocument, ReadContext, SourceInput } from '../types'

/**
 * vCard contacts (spec D14): 2.1, 3.0 and 4.0, any number per file. A record
 * source: one row per contact, printed up to PRINT_RECORD_LIMIT, exported in
 * full.
 *
 * Photos are never fetched or embedded. A photo URL can tell its owner when
 * the card was opened, the same reason email and calendar images are not
 * fetched, and an inline photo would make the table unprintable. Only the
 * count is reported.
 */

export const VCARD_HEADER = ['Name', 'Organization', 'Title', 'Email', 'Phone', 'Address', 'Birthday', 'URL', 'Note']

interface Prop {
  group?: string
  name: string
  params: Map<string, string[]>
  /** TYPE values, and 2.1's bare parameters (`TEL;WORK;VOICE`), lower-cased. */
  types: string[]
  value: string
}

/** Split on `sep` where it is not escaped with a backslash; escapes are kept. */
function splitUnescaped(value: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '\\' && i + 1 < value.length) cur += c + value[++i]
    else if (c === sep) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

function unescape(value: string): string {
  return value.replace(/\\([nN,;:\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

/** Quoted-printable to bytes, then decoded in the property's charset (UTF-8 by default). */
function decodeQp(value: string, charset?: string): string {
  const raw = value.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const hex = raw.slice(i + 1, i + 3)
    if (raw[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      i += 2
    } else bytes.push(raw.charCodeAt(i) & 0xff)
  }
  const cs = charset && iconv.encodingExists(charset) ? charset : 'utf8'
  return iconv.decode(Buffer.from(bytes), cs)
}

/** Where the name and parameters end: the first colon not inside a quoted parameter value. */
function valueColon(line: string): number {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) return i
  }
  return -1
}

/** Parameters split on `;` outside quotes. */
function splitParams(head: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const c of head) {
    if (c === '"') quoted = !quoted
    if (c === ';' && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

function parseLine(line: string): Prop | null {
  const colon = valueColon(line)
  if (colon < 0) return null
  const [namePart, ...paramParts] = splitParams(line.slice(0, colon))
  const dot = namePart.lastIndexOf('.')
  const group = dot >= 0 ? namePart.slice(0, dot).toLowerCase() : undefined
  const name = namePart.slice(dot + 1).toUpperCase()
  const params = new Map<string, string[]>()
  const types: string[] = []
  for (const p of paramParts) {
    const eq = p.indexOf('=')
    if (eq < 0) {
      types.push(p.trim().toLowerCase())
      continue
    }
    const key = p.slice(0, eq).trim().toUpperCase()
    const values = p
      .slice(eq + 1)
      .replace(/"/g, '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '')
    params.set(key, [...(params.get(key) ?? []), ...values])
    if (key === 'TYPE') types.push(...values.map((v) => v.toLowerCase()))
  }
  return { ...(group !== undefined ? { group } : {}), name, params, types, value: line.slice(colon + 1) }
}

const isQp = (p: Prop): boolean =>
  p.types.includes('quoted-printable') || (p.params.get('ENCODING') ?? []).some((e) => e.toUpperCase() === 'QUOTED-PRINTABLE')

/**
 * Logical lines: folded lines (a leading space or tab) are joined, and so is
 * a quoted-printable value's soft line break (`=` at the end of a line),
 * which 2.1 writers use instead of folding.
 */
function logicalLines(text: string): string[] {
  const lines: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const prev = lines.length - 1
    if (prev >= 0 && (raw.startsWith(' ') || raw.startsWith('\t'))) {
      lines[prev] += raw.slice(1)
    } else if (prev >= 0 && lines[prev].endsWith('=') && /QUOTED-PRINTABLE/i.test(lines[prev].slice(0, valueColon(lines[prev])))) {
      lines[prev] = lines[prev] + '\n' + raw
    } else lines.push(raw)
  }
  return lines
}

/** The value as text: quoted-printable decoded; escapes left for the caller (structured values split first). */
function rawValue(p: Prop): string {
  return isQp(p) ? decodeQp(p.value, p.params.get('CHARSET')?.[0]) : p.value
}

const text = (p: Prop): string => unescape(rawValue(p)).trim()

/** Types that say nothing a reader needs. */
const QUIET_TYPES = new Set(['internet', 'pref', 'voice', 'x400', 'quoted-printable', 'uri', 'text'])

/** "work: …" from TYPE, or from an Apple `itemN.X-ABLabel` in the same group. */
function labeled(p: Prop, value: string, labels: Map<string, string>): string {
  const apple = p.group !== undefined ? labels.get(p.group) : undefined
  const label = apple ?? p.types.find((t) => !QUIET_TYPES.has(t) && !t.includes('='))
  return label ? `${label}: ${value}` : value
}

/** One card's row; `photos` counts what was left out. */
function cardRow(props: Prop[]): { row: string[]; photos: number } {
  const labels = new Map<string, string>()
  for (const p of props) {
    if (p.name === 'X-ABLABEL' && p.group !== undefined) {
      labels.set(p.group, text(p).replace(/^_\$!<(.*)>!\$_$/, '$1').toLowerCase())
    }
  }
  let fn = ''
  let n = ''
  const org: string[] = []
  const title: string[] = []
  const email: string[] = []
  const tel: string[] = []
  const adr: string[] = []
  const url: string[] = []
  const note: string[] = []
  let bday = ''
  let photos = 0
  for (const p of props) {
    switch (p.name) {
      case 'FN':
        fn ||= text(p)
        break
      case 'N': {
        // Family; Given; Additional; Prefix; Suffix
        const [family = '', given = '', extra = '', prefix = '', suffix = ''] = splitUnescaped(rawValue(p), ';').map((s) => unescape(s).trim())
        n ||= [prefix, given, extra, family, suffix].filter((s) => s !== '').join(' ')
        break
      }
      case 'ORG':
        org.push(splitUnescaped(rawValue(p), ';').map((s) => unescape(s).trim()).filter((s) => s !== '').join(', '))
        break
      case 'TITLE':
        title.push(text(p))
        break
      case 'EMAIL':
        email.push(labeled(p, text(p).replace(/^mailto:/i, ''), labels))
        break
      case 'TEL':
        tel.push(labeled(p, text(p).replace(/^tel:/i, ''), labels))
        break
      case 'ADR': {
        // PO box; extended; street; locality; region; postal code; country
        const [po = '', ext = '', street = '', city = '', region = '', code = '', country = ''] = splitUnescaped(rawValue(p), ';').map((s) =>
          unescape(s).trim(),
        )
        const regionCode = [region, code].filter((s) => s !== '').join(' ')
        const parts = [po, ext, street, city, regionCode, country].filter((s) => s !== '')
        if (parts.length > 0) adr.push(labeled(p, parts.join(', '), labels))
        break
      }
      case 'BDAY': {
        const b = text(p)
        bday ||= /^\d{8}$/.test(b) ? `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6)}` : b
        break
      }
      case 'URL':
        url.push(text(p))
        break
      case 'NOTE':
        note.push(text(p))
        break
      case 'PHOTO':
        photos++
        break
    }
  }
  const lines = (xs: string[]): string => xs.filter((x) => x !== '').join('\n')
  return { row: [fn || n, lines(org), lines(title), lines(email), lines(tel), lines(adr), bday, lines(url), lines(note)], photos }
}

/** Every card in the text, as rows, and the number of photos left out. */
export function parseVcards(text: string): { header: string[]; rows: string[][]; photos: number } {
  const rows: string[][] = []
  let photos = 0
  let props: Prop[] | null = null
  // A 2.1 AGENT property may embed a whole card; its lines belong to it, not to a new contact.
  let depth = 0
  for (const line of logicalLines(text.replace(/^﻿/, ''))) {
    const t = line.trim()
    if (/^BEGIN:VCARD$/i.test(t)) {
      if (depth++ === 0) props = []
      continue
    }
    if (/^END:VCARD$/i.test(t)) {
      if (depth > 0 && --depth === 0 && props) {
        const card = cardRow(props)
        rows.push(card.row)
        photos += card.photos
        props = null
      }
      continue
    }
    if (depth !== 1 || !props || t === '') continue
    const p = parseLine(line)
    if (p) props.push(p)
  }
  return { header: VCARD_HEADER, rows, photos }
}

const baseName = (filename?: string): string => (filename ?? 'contacts.vcf').split(/[\\/]/).pop() ?? 'contacts.vcf'

function contactsOf(src: SourceInput): ReturnType<typeof parseVcards> {
  if (src.bytes.length > MAX_RECORD_SOURCE_BYTES) {
    const mb = (src.bytes.length / 1024 / 1024).toFixed(0)
    throw new ConversionError('read-failed', `${baseName(src.filename)} is ${mb} MB, over the 200 MB limit for record files.`)
  }
  return parseVcards(decodeTextBytes(src.bytes))
}

function photoNotice(photos: number, ctx?: ReadContext): void {
  if (photos === 0) return
  const what = photos === 1 ? '1 contact photo was' : `${photos.toLocaleString('en-US')} contact photos were`
  ctx?.onAdvice?.('photos-omitted', `${what} left out. Photos are never downloaded or embedded.`)
}

export async function readVcard(src: SourceInput, ctx?: ReadContext): Promise<HubDocument> {
  const name = baseName(src.filename)
  const { header, rows, photos } = contactsOf(src)
  photoNotice(photos, ctx)
  const shown = rows.slice(0, PRINT_RECORD_LIMIT)
  const limited = rows.length > shown.length
  if (limited) {
    ctx?.onAdvice?.('records-limited', `${limitMessage(shown.length, rows.length, 'contacts')} Export to CSV, JSON or Excel for every contact.`)
  }
  // Printed, a column no contact fills only squeezes the others: nine
  // columns on a portrait page break words mid-letter. Exports keep all nine,
  // so a CSV always has the same columns.
  const used = header.map((_h, i) => shown.some((r) => r[i] !== ''))
  const keep = <T,>(xs: T[]): T[] => xs.filter((_x, i) => used[i])
  return {
    html: `<h1>${escapeHtml(name)}</h1>\n${recordsTableHtml(keep(header), shown.map(keep), rows.length, 'contacts')}`,
    title: name,
    ...(limited ? { limited: true } : {}),
  }
}

/** Every contact, for csv/json/xlsx export. */
export async function readVcardRows(src: SourceInput, ctx?: ReadContext): Promise<RowSource[] | null> {
  const { header, rows, photos } = contactsOf(src)
  photoNotice(photos, ctx)
  return [{ name: baseName(src.filename).replace(/\.[^.]+$/, ''), header, rows }]
}
