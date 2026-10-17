import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import JSZip from 'jszip'
import { detect, misnamedNotice, unmistakablyBinary } from '../../src/core/detect'

// Owner, 2026-10-17: a file whose bytes are beyond doubt a picture or a binary
// document is read by them even when its name says text; anything that could
// be text keeps its name.

const corpus = (name: string): Buffer => readFileSync(join(__dirname, '../corpus', name))
const fixture = (name: string): Buffer => readFileSync(join(__dirname, '../fixtures', name))
const b64 = (s: string): Buffer => Buffer.from(s, 'base64')

const GIF = b64('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==')
const WEBP = b64('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==')
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'latin1'),
  Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]),
])
// An ftyp box with the avif brand, then an empty meta box: the signature and header only.
const AVIF = Buffer.concat([
  Buffer.from([0, 0, 0, 0x1c]),
  Buffer.from('ftypavif\0\0\0\0avifmif1miaf', 'latin1'),
  Buffer.from([0, 0, 0, 8]),
  Buffer.from('meta', 'latin1'),
])

async function zipOf(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, body] of Object.entries(parts)) zip.file(name, body)
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
}

describe('pictures named as text are read as pictures', () => {
  const pictures: Array<[string, Buffer, 'image' | 'metafile', string]> = [
    ['TIFF', corpus('reading-room-lease.tiff'), 'image', 'a TIFF picture'],
    ['EMF', corpus('reading-room-floor-plan.emf'), 'metafile', 'an EMF drawing'],
    ['WMF', corpus('reading-room-shelf-label.wmf'), 'metafile', 'a WMF drawing'],
    ['PNG', fixture('sample.png'), 'image', 'a PNG picture'],
    ['JPEG', JPEG, 'image', 'a JPEG picture'],
    ['GIF', GIF, 'image', 'a GIF picture'],
    ['WebP', WEBP, 'image', 'a WebP picture'],
    ['BMP', corpus('reading-room-sign.bmp'), 'image', 'a BMP picture'],
    ['ICO', corpus('reading-room-marker.ico'), 'image', 'an icon (ICO) picture'],
    ['AVIF', AVIF, 'image', 'an AVIF picture'],
  ]
  for (const [type, bytes, format, what] of pictures) {
    it(`reads ${type} named .txt, .md and .csv by its bytes, and says so`, () => {
      for (const name of ['scan.txt', 'scan.md', 'scan.csv', 'scan.json', 'scan.py']) {
        expect(detect(bytes, name)).toEqual({ kind: 'ok', format })
      }
      expect(misnamedNotice(bytes, 'scan.txt', format)).toBe(`This file is named .txt but is ${what}; read as a picture.`)
    })
  }

  it('names a whole-name code file by its name in the notice', () => {
    const tiff = corpus('reading-room-lease.tiff')
    expect(detect(tiff, 'Makefile')).toEqual({ kind: 'ok', format: 'image' })
    expect(misnamedNotice(tiff, 'Makefile', 'image')).toBe('This file is named Makefile but is a TIFF picture; read as a picture.')
  })
})

describe('binary documents named as text are read by their bytes', () => {
  it('a PDF', () => {
    const pdf = corpus('visitor-handbook.pdf')
    expect(detect(pdf, 'handbook.txt')).toEqual({ kind: 'ok', format: 'pdf' })
    expect(misnamedNotice(pdf, 'handbook.txt', 'pdf')).toBe('This file is named .txt but is a PDF document; read as one.')
  })

  it('an all-text PDF, by the %%EOF at its end', () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\nstartxref\n0\n%%EOF\n', 'latin1')
    expect(detect(pdf, 'plain.md')).toEqual({ kind: 'ok', format: 'pdf' })
  })

  it('Office and OpenDocument files and EPUBs', () => {
    expect(detect(fixture('sample.docx'), 'report.txt')).toEqual({ kind: 'ok', format: 'docx' })
    expect(detect(fixture('sample.xlsx'), 'figures.csv')).toEqual({ kind: 'ok', format: 'xlsx' })
    expect(detect(fixture('sample.pptx'), 'deck.md')).toEqual({ kind: 'ok', format: 'pptx' })
    expect(detect(fixture('sample.epub'), 'book.txt')).toEqual({ kind: 'ok', format: 'epub' })
    expect(detect(fixture('sample.odt'), 'letter.txt')).toEqual({ kind: 'ok', format: 'odt' })
    expect(detect(fixture('sample.odp'), 'talk.txt')).toEqual({ kind: 'ok', format: 'odp' })
    expect(detect(corpus('stock-formatting.ods'), 'stock.csv')).toEqual({ kind: 'ok', format: 'xlsx' })
    expect(misnamedNotice(fixture('sample.docx'), 'report.txt', 'docx')).toBe(
      'This file is named .txt but is a Word document; read as one.',
    )
  })

  it('legacy Word and Excel files and Outlook messages, by the streams in their directory', () => {
    expect(detect(corpus('definitions.doc'), 'definitions.txt')).toEqual({ kind: 'ok', format: 'doc' })
    expect(detect(corpus('form-with-merged-cells.xls'), 'form.csv')).toEqual({ kind: 'ok', format: 'xlsx' })
    expect(detect(corpus('internal-exchange-thread.msg'), 'mail.txt')).toEqual({ kind: 'ok', format: 'msg' })
    expect(misnamedNotice(corpus('internal-exchange-thread.msg'), 'mail.txt', 'msg')).toBe(
      'This file is named .txt but is an Outlook message; read as one.',
    )
  })

  it('a SQLite database, as before', () => {
    const db = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(100)])
    expect(detect(db, 'data.txt')).toEqual({ kind: 'ok', format: 'sqlite' })
  })
})

describe('near-misses keep their text name', () => {
  const text = (s: string): Buffer => Buffer.from(s, 'utf8')
  const cases: Array<[string, Buffer]> = [
    ['notes that start with "GIF89a"', text('GIF89a is the animated GIF version.\nMore notes.\n')],
    ['notes that start with "BM"', text('BMW club minutes\nAttendance: 12\n')],
    ['notes that start with "RIFF....WEBP"', text('RIFF0000WEBPVP8 is a container\n')],
    ['notes that start with "%PDF-1.7" and no end', text('%PDF-1.7 is the version our printer accepts.\n')],
    ['a PNG signature cut short (no IHDR)', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41, 0x42, 0x43, 0x44])],
    ['"II*" and a NUL with no directory', Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.from([0xff, 0xff, 0, 0]), text('hello')])],
    ['the CFB magic with no directory', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)])],
    ['"PK\\x03\\x04" and text', text('PK\x03\x04 is how a zip starts; word/document.xml is inside.\n')],
    ['an SVG drawing', text('<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>')],
    ['an HTML page', text('<!DOCTYPE html><html><body>hi</body></html>')],
    ['RTF', text('{\\rtf1 hello}')],
    ['UTF-16 text with a byte order mark', Buffer.from('﻿hello world', 'utf16le')],
  ]
  for (const [what, bytes] of cases) {
    it(what, () => {
      expect(unmistakablyBinary(bytes)).toBeNull()
      expect(detect(bytes, 'notes.txt')).toEqual({ kind: 'ok', format: 'txt' })
      expect(misnamedNotice(bytes, 'notes.txt', 'txt')).toBeNull()
    })
  }

  it('a plain zip named .txt is not expanded', async () => {
    const zip = await zipOf({ 'a.txt': 'a', 'b.txt': 'b' })
    expect(detect(zip, 'bundle.txt')).toEqual({ kind: 'ok', format: 'txt' })
  })

  it('a zip without its end record is not a document', async () => {
    const docx = await zipOf({ 'word/document.xml': '<w:document/>' })
    const cut = docx.subarray(0, docx.length - 22)
    expect(unmistakablyBinary(cut)).toBeNull()
  })

  it('gives no notice where the name already says the format', () => {
    expect(misnamedNotice(corpus('reading-room-lease.tiff'), 'lease.tiff', 'image')).toBeNull()
    expect(misnamedNotice(fixture('sample.pdf'), 'sample.pdf', 'pdf')).toBeNull()
  })

  it('a legacy PowerPoint named .txt is refused, not read as text', () => {
    // No .ppt in the corpus: a Compound File whose directory names the stream is built here.
    const sector = 512
    const bytes = Buffer.alloc(sector * 3)
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(bytes)
    bytes.writeUInt16LE(9, 0x1e)
    bytes.writeUInt32LE(1, 0x30) // directory in sector 1
    bytes.writeUInt32LE(0, 0x4c) // FAT in sector 0
    for (let i = 109; i > 0; i--) bytes.writeUInt32LE(0xffffffff, 0x4c + i * 4)
    const fat = sector
    bytes.writeUInt32LE(0xfffffffd, fat) // sector 0: FAT
    bytes.writeUInt32LE(0xfffffffe, fat + 4) // sector 1: end of the directory chain
    const entry = (at: number, name: string, type: number): void => {
      bytes.write(name, at, 'utf16le')
      bytes.writeUInt16LE((name.length + 1) * 2, at + 64)
      bytes[at + 66] = type
    }
    entry(sector * 2, 'Root Entry', 5)
    entry(sector * 2 + 128, 'PowerPoint Document', 2)
    bytes.writeUInt32LE(1, sector * 2 + 76) // the root's child: entry 1
    bytes.writeUInt32LE(0xffffffff, sector * 2 + 128 + 68)
    bytes.writeUInt32LE(0xffffffff, sector * 2 + 128 + 72)
    expect(detect(bytes, 'talk.txt')).toEqual({ kind: 'unsupported', reason: 'Legacy PowerPoint (.ppt) is not supported' })
  })
})

describe('the converter says when a name and the contents disagree', () => {
  it('gives the notice once, on reading a TIFF named .txt', async () => {
    const { createConverter } = await import('../../src/core/convert')
    const conv = createConverter(async () => Buffer.from('%PDF'))
    const seen: Array<[string, string]> = []
    const bytes = corpus('reading-room-lease.tiff')
    await conv.convert({ bytes, filename: 'lease.txt' }, 'image', 'html', undefined, { onAdvice: (k, m) => seen.push([k, m]) })
    // (No render host here: the pictures' own notices follow; only this one is about the name.)
    expect(seen.filter(([k]) => k === 'misnamed')).toEqual([['misnamed', 'This file is named .txt but is a TIFF picture; read as a picture.']])
  })

  it('gives none for a text file read as text', async () => {
    const { createConverter } = await import('../../src/core/convert')
    const conv = createConverter(async () => Buffer.from('%PDF'))
    const seen: string[] = []
    await conv.convert({ bytes: Buffer.from('GIF89a notes'), filename: 'n.txt' }, 'txt', 'html', undefined, { onAdvice: (k) => seen.push(k) })
    expect(seen).toEqual([])
  })
})
