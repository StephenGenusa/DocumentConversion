import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readEml } from '../../src/core/readers/eml'
import { detect } from '../../src/core/detect'

const load = () => readFile(join(__dirname, '../fixtures/sample.eml'))

describe('readEml', () => {
  it('renders a header table and the html body', async () => {
    const hub = await readEml({ bytes: await load(), filename: 'sample.eml' })
    expect(hub.html).toContain('alice@example.com')
    expect(hub.html).toContain('Q3 API spec')
    expect(hub.html).toContain('<b>100 req/s</b>')
    expect(hub.title).toBe('Q3 API spec')
  })

  it('inlines cid: images as data URIs', async () => {
    const hub = await readEml({ bytes: await load() })
    expect(hub.html).not.toContain('cid:diagram1')
    expect(hub.html).toContain('data:image/png;base64,iVBOR')
  })

  it('lists attachments by name and size without converting them', async () => {
    const hub = await readEml({ bytes: await load() })
    expect(hub.html).toContain('limits.pdf')
    expect(hub.html).toMatch(/limits\.pdf<\/td><td>\d+/)
  })

  it('paragraph-ifies text-only mail', async () => {
    const eml = 'From: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\n\r\nFirst para.\r\n\r\nSecond para.\r\n'
    const hub = await readEml({ bytes: Buffer.from(eml) })
    expect(hub.html).toContain('<p>First para.</p>')
    expect(hub.html).toContain('<p>Second para.</p>')
  })

  it('rejects unparseable input with eml-parse-failed', async () => {
    await expect(readEml({ bytes: Buffer.alloc(0) })).rejects.toMatchObject({ code: 'eml-parse-failed' })
  })

  /**
   * .eml shares renderEmailHeader/textToParagraphs with .msg. The msg reader
   * had to learn to drop Exchange X.500 distinguished names from its header;
   * .eml carries real RFC 5322 addresses and must keep printing them verbatim,
   * so pin the exact header rows the shared renderer produces.
   */
  it('prints RFC 5322 addresses verbatim in the shared header renderer', async () => {
    const eml =
      'From: "Quill, Marta" <marta.quill@example.com>\r\n' +
      'To: "Braddock, Sunil" <sbraddock@example.org>\r\n' +
      'Cc: bob@example.com\r\n' +
      'Subject: Header shape\r\n\r\nBody.\r\n'
    const hub = await readEml({ bytes: Buffer.from(eml) })
    expect(hub.html).toContain('<tr><td>From</td><td>Quill, Marta &lt;marta.quill@example.com&gt;</td></tr>')
    expect(hub.html).toContain('<tr><td>To</td><td>Braddock, Sunil &lt;sbraddock@example.org&gt;</td></tr>')
    expect(hub.html).toContain('<tr><td>Cc</td><td>bob@example.com</td></tr>')
  })
})

describe('eml detection heuristic', () => {
  it('detects header blocks with From: plus To:/Subject:/Received:', async () => {
    const eml = await load()
    expect(detect(eml)).toEqual({ kind: 'ok', format: 'eml' })
  })
  it('does not match bare key:value notes', () => {
    const notes = 'Speed: fast\nColor: blue\nShape: round\n\nSome text.'
    expect(detect(Buffer.from(notes)).kind === 'ok' && detect(Buffer.from(notes))).toEqual({
      kind: 'ok',
      format: 'txt',
    })
  })
  it('maps the .eml extension', () => {
    expect(detect(Buffer.from('x'), 'mail.eml')).toEqual({ kind: 'ok', format: 'eml' })
  })
})
