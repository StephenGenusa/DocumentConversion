import { describe, it, expect, vi } from 'vitest'
import { readMbox, splitMbox } from '../../src/core/readers/mbox'
import { docBodyToHub } from '../../src/core/readers/doc'
import { readDoc } from '../../src/core/readers/doc'
import { detect } from '../../src/core/detect'

const MBOX = [
  'From alice@example.com Mon Aug 31 10:00:00 2026',
  'From: Alice <alice@example.com>',
  'To: Bob <bob@example.com>',
  'Subject: First message',
  '',
  'Body of the first message.',
  '>From a quoted line that must not split',
  '',
  'From bob@example.com Mon Aug 31 11:00:00 2026',
  'From: Bob <bob@example.com>',
  'To: Alice <alice@example.com>',
  'Subject: Second message',
  '',
  'Body of the second message.',
  '',
].join('\n')

describe('splitMbox', () => {
  it('splits on From_ separator lines only', () => {
    const messages = splitMbox(MBOX)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('First message')
    expect(messages[0]).toContain('From a quoted line that must not split')
    expect(messages[1]).toContain('Second message')
  })
  it('unescapes >From quoting', () => {
    expect(splitMbox(MBOX)[0]).not.toContain('>From a quoted')
  })
})

describe('readMbox', () => {
  it('renders every message with its headers', async () => {
    const hub = await readMbox({ bytes: Buffer.from(MBOX, 'utf8'), filename: 'archive.mbox' })
    expect(hub.html).toContain('First message')
    expect(hub.html).toContain('Second message')
    expect(hub.html).toContain('alice@example.com')
    expect(hub.html).toContain('Body of the second message.')
    expect(hub.title).toBe('archive.mbox')
  })
  it('rejects input with no messages', async () => {
    await expect(readMbox({ bytes: Buffer.from('nothing here', 'utf8') })).rejects.toMatchObject({
      code: 'eml-parse-failed',
    })
  })
})

describe('mbox detection', () => {
  it('detects by extension and by From_ line plus headers', () => {
    expect(detect(Buffer.from('x'), 'mail.mbox')).toEqual({ kind: 'ok', format: 'mbox' })
    expect(detect(Buffer.from(MBOX, 'utf8'))).toEqual({ kind: 'ok', format: 'mbox' })
  })
  it('does not claim prose starting with the word From', () => {
    const prose = 'From the desk of the architect.\n\nThis is an ordinary note.'
    expect(detect(Buffer.from(prose, 'utf8'))).toEqual({ kind: 'ok', format: 'txt' })
  })
})

describe('docBodyToHub', () => {
  it('turns extracted text into paragraphs, escaping markup', () => {
    const hub = docBodyToHub('First paragraph.\n\nSecond <b>paragraph</b>.', 'legacy.doc')
    expect(hub.html).toContain('<p>First paragraph.</p>')
    expect(hub.html).toContain('&lt;b&gt;')
    expect(hub.title).toBe('legacy.doc')
  })
  it('treats every newline as a paragraph break', () => {
    // word-extractor maps the Word paragraph mark (0x0D) to a single "\n", so
    // splitting on blank lines would collapse a whole document into one <p>.
    const hub = docBodyToHub('line one\nline two')
    expect(hub.html).toBe('<p>line one</p>\n<p>line two</p>')
  })

  it('strips Word control characters', () => {
    expect(docBodyToHub('clean' + String.fromCharCode(7) + 'text').html).toContain('cleantext')
  })
})

describe('readDoc', () => {
  it('uses the injected extractor and wraps failures', async () => {
    const ok = vi.fn(async () => 'Extracted body text.')
    const hub = await readDoc({ bytes: Buffer.from('x'), filename: 'old.doc' }, undefined, ok)
    expect(hub.html).toContain('Extracted body text.')
    const bad = vi.fn(async () => {
      throw new Error('not a word file')
    })
    await expect(readDoc({ bytes: Buffer.from('x') }, undefined, bad)).rejects.toMatchObject({
      code: 'read-failed',
    })
  })
})

describe('doc detection', () => {
  const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
  it('routes CFB + .doc to the legacy Word reader', () => {
    expect(detect(CFB, 'report.doc')).toEqual({ kind: 'ok', format: 'doc' })
    expect(detect(CFB, 'sheet.xls')).toEqual({ kind: 'ok', format: 'xlsx' })
    expect(detect(CFB).kind).toBe('unsupported')
  })
})
