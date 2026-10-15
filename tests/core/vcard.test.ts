import { describe, it, expect, vi, afterEach } from 'vitest'
import { readVcard, readVcardRows, parseVcards } from '../../src/core/readers/vcard'
import { detect } from '../../src/core/detect'
import { createConverter } from '../../src/core/convert'
import type { ReadContext } from '../../src/core/types'

const src = (text: string | Buffer, filename = 'contacts.vcf') => ({
  bytes: Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'),
  filename,
})

const HEADER = ['Name', 'Organization', 'Title', 'Email', 'Phone', 'Address', 'Birthday', 'URL', 'Note']

// Invented people, example.com addresses, 555-01xx numbers.
const V30 = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:Ferrow;Petra;;Dr.;',
  'FN:Dr. Petra Ferrow',
  'ORG:Example Labs;Research',
  'TITLE:Lead\\, Platform',
  'EMAIL;TYPE=INTERNET,WORK:petra@example.com',
  'EMAIL;TYPE=INTERNET,HOME,pref:p.ferrow@example.org',
  'TEL;TYPE=CELL:+1 555 0100',
  'TEL;TYPE=WORK,VOICE:+1 555 0101',
  'item1.ADR;TYPE=WORK:;;1 Main St;Springfield;IL;62701;USA',
  'item1.X-ABLabel:_$!<Work>!$_',
  'item2.TEL:+1 555 0102',
  'item2.X-ABLabel:Studio',
  'BDAY:19850412',
  'URL:https://example.com/petra',
  'NOTE:First line\\nsecond line\\; with a semicolon and a long fold',
  '  that continues here',
  'PHOTO;VALUE=URI:https://example.com/photo.jpg',
  'END:VCARD',
  '',
].join('\r\n')

describe('vCard 3.0', () => {
  it('reads one row per contact, with labelled values on their own lines', () => {
    const { header, rows } = parseVcards(V30)
    expect(header).toEqual(HEADER)
    expect(rows).toHaveLength(1)
    const [name, org, title, email, phone, adr, bday, url, note] = rows[0]
    expect(name).toBe('Dr. Petra Ferrow')
    expect(org).toBe('Example Labs, Research')
    expect(title).toBe('Lead, Platform')
    expect(email).toBe('work: petra@example.com\nhome: p.ferrow@example.org')
    expect(phone).toBe('cell: +1 555 0100\nwork: +1 555 0101\nstudio: +1 555 0102')
    expect(adr).toBe('work: 1 Main St, Springfield, IL 62701, USA')
    expect(bday).toBe('1985-04-12')
    expect(url).toBe('https://example.com/petra')
    expect(note).toBe('First line\nsecond line; with a semicolon and a long fold that continues here')
  })

  it('prints the table with line breaks in cells and says how many photos were left out', async () => {
    const advice: string[] = []
    const ctx: ReadContext = { onAdvice: (_k, m) => advice.push(m) }
    const hub = await readVcard(src(V30), ctx)
    expect(hub.title).toBe('contacts.vcf')
    expect(hub.html).toContain('<td>work: petra@example.com<br>home: p.ferrow@example.org</td>')
    expect(hub.html).not.toContain('photo.jpg')
    expect(advice).toContain('1 contact photo was left out. Photos are never downloaded or embedded.')
  })

  it('prints only the columns some contact fills, and exports all of them', async () => {
    const one = 'BEGIN:VCARD\nVERSION:3.0\nFN:Nils Ashcombe\nTEL:555-0130\nEND:VCARD\n'
    const hub = await readVcard(src(one))
    expect(hub.html).toContain('<thead><tr><th>Name</th><th>Phone</th></tr></thead>')
    const rows = await readVcardRows(src(one))
    expect(rows![0].header).toEqual(HEADER)
  })

  it('never fetches a photo', async () => {
    const fetchSpy = vi.fn()
    const lookup = vi.fn(async () => ['93.184.216.34'])
    vi.stubGlobal('fetch', fetchSpy)
    const converter = createConverter(async () => Buffer.from(''), { fetchImages: { fetch: fetchSpy, lookup } })
    await converter.convert(src(V30), 'vcard', 'html')
    await converter.convert(src(V30), 'vcard', 'csv')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })
  afterEach(() => vi.unstubAllGlobals())
})

describe('vCard 2.1 from Outlook and Android', () => {
  it('decodes quoted-printable in its charset, with soft line breaks, and bare type parameters', () => {
    // "Zoë Brandt" in UTF-8, and a Windows-1252 note, both quoted-printable.
    const v21 = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Brandt;Zo=C3=AB;;;',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Zo=C3=AB Brandt',
      'TEL;WORK;VOICE:555-0110',
      'TEL;CELL:555-0111',
      'EMAIL;PREF;INTERNET:zoe@example.com',
      'NOTE;CHARSET=WINDOWS-1252;QUOTED-PRINTABLE:Caf=E9 meeting, a long note th=',
      'at was folded',
      'PHOTO;ENCODING=BASE64;TYPE=JPEG:',
      ' /9j/4AAQSkZJRgABAQ',
      ' AAAQABAAD',
      '',
      'END:VCARD',
    ].join('\r\n')
    const { rows } = parseVcards(v21)
    expect(rows[0][0]).toBe('Zoë Brandt')
    expect(rows[0][4]).toBe('work: 555-0110\ncell: 555-0111')
    expect(rows[0][3]).toBe('zoe@example.com')
    expect(rows[0][8]).toBe('Café meeting, a long note that was folded')
  })
})

describe('vCard 4.0', () => {
  it('reads quoted type lists, tel: URIs, and assembles a name from N when there is no FN', () => {
    const v40 = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'N:Halloway;Juno;Ann;;Jr.',
      'TEL;VALUE=uri;TYPE="voice,home":tel:+1-555-0120',
      'EMAIL;TYPE=work:juno@example.com',
      'BDAY:--0412',
      'END:VCARD',
    ].join('\n')
    const { rows } = parseVcards(v40)
    expect(rows[0][0]).toBe('Juno Ann Halloway Jr.')
    expect(rows[0][4]).toBe('home: +1-555-0120')
    expect(rows[0][6]).toBe('--0412')
  })
})

describe('many contacts', () => {
  const card = (i: number) => `BEGIN:VCARD\nVERSION:3.0\nFN:Contact ${i}\nEMAIL:c${i}@example.com\nEND:VCARD\n`
  const many = Array.from({ length: 6000 }, (_, i) => card(i)).join('')

  it('prints 5,000 and says so', async () => {
    const advice: string[] = []
    const hub = await readVcard(src(many), { onAdvice: (_k, m) => advice.push(m) })
    expect(hub.limited).toBe(true)
    expect(hub.html.match(/<tr>/g)).toHaveLength(5001)
    expect(hub.html).toContain('Showing the first 5,000 of 6,000 contacts.')
    expect(advice.join(' ')).toMatch(/5,000 of 6,000/)
  })

  it('exports all 6,000', async () => {
    const out = await readVcardRows(src(many))
    expect(out).toHaveLength(1)
    expect(out![0].name).toBe('contacts')
    expect([...(out![0].rows as string[][])]).toHaveLength(6000)
    const csv = await createConverter(async () => Buffer.from('')).convert(src(many), 'vcard', 'csv')
    expect(csv.parts[0].bytes.toString('utf8').trim().split('\n')).toHaveLength(6001)
  })
})

describe('detecting vCards', () => {
  it('reads a .vcf with BEGIN:VCARD as contacts', () => {
    const d = detect(Buffer.from('﻿BEGIN:VCARD\r\nVERSION:3.0\r\n'), 'a.vcf')
    expect(d.kind === 'ok' && d.format).toBe('vcard')
    const v = detect(Buffer.from('BEGIN:VCARD\n'), 'a.vcard')
    expect(v.kind === 'ok' && v.format).toBe('vcard')
  })

  it('reads a genomics .vcf (Variant Call Format) as text', () => {
    const vcf = '##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\n1\t100\t.\tA\tG\n'
    const d = detect(Buffer.from(vcf), 'sample.vcf')
    expect(d.kind === 'ok' && d.format).toBe('txt')
  })

  it('sniffs a vCard with no extension', () => {
    const d = detect(Buffer.from('BEGIN:VCARD\nVERSION:4.0\nFN:x\nEND:VCARD\n'), 'contact')
    expect(d.kind === 'ok' && d.format).toBe('vcard')
  })
})
