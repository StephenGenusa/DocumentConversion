import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { msgToHub } from '../../src/core/readers/msg'
import { readMsg } from '../../src/core/readers/msg'
import { detect } from '../../src/core/detect'

const CORPUS = join(__dirname, '../corpus')

/** Wrap raw RTF bytes in the MELA (uncompressed) PidTagRtfCompressed container. */
function melaWrap(rtf: string): Uint8Array {
  const raw = Buffer.from(rtf, 'latin1')
  const header = Buffer.alloc(16)
  header.writeUInt32LE(raw.length + 12, 0)
  header.writeUInt32LE(raw.length, 4)
  header.writeUInt32LE(0x414c454d, 8)
  header.writeUInt32LE(0, 12)
  return Buffer.concat([header, raw])
}

const ENCAP_HTML = String.raw`{\rtf1\ansi\ansicpg1252\fromhtml1\deff0{\fonttbl{\f0\fswiss Arial;}}
{\*\htmltag64 <html>}{\*\htmltag64 <body>}{\*\htmltag64 <p>}
\htmlrtf {\f0 \htmlrtf0 Vendor limit: {\*\htmltag84 <b>}\htmlrtf \b \htmlrtf0 100 req/s{\*\htmltag92 </b>}\htmlrtf \b0 \htmlrtf0 \htmlrtf }\htmlrtf0
{\*\htmltag72 </p>}{\*\htmltag58 </body>}{\*\htmltag58 </html>}}`

const base = {
  subject: 'Q3 limits',
  senderName: 'Alice',
  senderEmail: 'alice@example.com',
  recipients: [{ name: 'Bob', email: 'bob@example.com' }],
  attachments: [],
}

describe('msgToHub (three-step body pipeline)', () => {
  it('uses a direct html body when present', async () => {
    const hub = await msgToHub({ ...base, bodyHtml: '<p>Direct <b>html</b></p>' })
    expect(hub.html).toContain('<b>html</b>')
    expect(hub.html).toContain('alice@example.com')
    expect(hub.title).toBe('Q3 limits')
  })

  it('de-encapsulates RTF-encapsulated HTML (the common Outlook case)', async () => {
    const hub = await msgToHub({ ...base, compressedRtf: melaWrap(ENCAP_HTML) })
    expect(hub.html).toContain('<b>100 req/s</b>')
  })

  it('falls back to the RTF converter for genuine RTF bodies', async () => {
    const hub = await msgToHub({
      ...base,
      compressedRtf: melaWrap('{\\rtf1\\ansi Plain \\b bold\\b0  body\\par}'),
    })
    expect(hub.html).toContain('<strong>bold</strong>')
  })

  it('paragraph-ifies plain text bodies', async () => {
    const hub = await msgToHub({ ...base, bodyText: 'One.\n\nTwo.' })
    expect(hub.html).toContain('<p>One.</p>')
  })

  it('lists attachments without converting them', async () => {
    const hub = await msgToHub({
      ...base,
      bodyText: 'x',
      attachments: [{ fileName: 'spec.docx', contentLength: 12345 }],
    })
    expect(hub.html).toContain('spec.docx')
    expect(hub.html).toContain('12345')
  })
})

/**
 * Exchange stores an internal party's PidTagEmailAddress as an X.500
 * distinguished name, not an address. Printed verbatim it opened with `<` in
 * visible prose (reading as a broken close tag) and blew the header table out
 * to five wrapped lines per recipient. The real address lives in
 * PidTagSenderSmtpAddress / PidTagSmtpAddress.
 */
describe('msg header addresses (X.500 distinguished names)', () => {
  const DN = '/O=EXAMPLECORP/OU=EXCHANGE ADMINISTRATIVE GROUP (FYDIBOHF23SPDLT)/CN=RECIPIENTS/CN=U3UE6D2'

  it('prefers the sender SMTP address over the X.500 DN', async () => {
    const hub = await msgToHub({
      subject: 's',
      senderName: 'Ashcombe, Nils',
      senderEmail: DN,
      senderSmtpAddress: 'nils.ashcombe@example.com',
      recipients: [],
      attachments: [],
      bodyText: 'x',
    })
    expect(hub.html).toContain('Ashcombe, Nils &lt;nils.ashcombe@example.com&gt;')
    expect(hub.html).not.toContain('EXCHANGE ADMINISTRATIVE GROUP')
  })

  it('prefers the recipient SMTP address over the X.500 DN', async () => {
    const hub = await msgToHub({
      subject: 's',
      recipients: [
        {
          name: 'Ferrow, Petra',
          email: '/o=Example/ou=Exchange Administrative Group (x)/cn=Recipients/cn=Dana.Rivera',
          smtpAddress: 'petra.ferrow@example.com',
          recipType: 'to',
        },
      ],
      attachments: [],
      bodyText: 'x',
    })
    expect(hub.html).toContain('Ferrow, Petra &lt;petra.ferrow@example.com&gt;')
    expect(hub.html).not.toContain('cn=Recipients')
  })

  it('falls back to the display name alone when only a DN is available', async () => {
    const hub = await msgToHub({
      subject: 's',
      senderName: 'Sorrel, Devi',
      senderEmail: DN,
      recipients: [{ name: 'Hamilton, D’anna', email: DN, recipType: 'to' }],
      attachments: [],
      bodyText: 'x',
    })
    expect(hub.html).toContain('<td>Sorrel, Devi</td>')
    expect(hub.html).toContain('Hamilton, D’anna</td>')
    expect(hub.html).not.toContain('/CN=RECIPIENTS')
    expect(hub.html).not.toContain('&lt;')
  })

  it('drops a bare DN with no display name rather than printing it', async () => {
    const hub = await msgToHub({
      subject: 's',
      senderEmail: DN,
      recipients: [],
      attachments: [],
      bodyText: 'x',
    })
    expect(hub.html).not.toContain('EXAMPLECORP')
    expect(hub.html).not.toContain('<td>From</td>')
  })

  it('leaves an ordinary SMTP address in PidTagEmailAddress untouched', async () => {
    const hub = await msgToHub({
      subject: 's',
      senderName: 'Ostrander, Mireille',
      senderEmail: 'mireille.ostrander@example.com',
      recipients: [{ name: 'Hollis Tamm', email: 'hollis.tamm@example.net', recipType: 'cc' }],
      attachments: [],
      bodyText: 'x',
    })
    expect(hub.html).toContain('Ostrander, Mireille &lt;mireille.ostrander@example.com&gt;')
    expect(hub.html).toContain('Hollis Tamm &lt;hollis.tamm@example.net&gt;')
  })
})

describe('readMsg over the real corpus', () => {
  const dnFragments = [/ou=Exchange Administrative Group/i, /cn=Recipients/i, /FYDIBOHF23SPDLT/i]

  it('prints SMTP addresses, not X.500 DNs, for an internal Exchange thread', async () => {
    const file = join(CORPUS, 'internal-exchange-thread.msg')
    if (!existsSync(file)) return
    const bytes = await readFile(file)
    const hub = await readMsg({ bytes, filename: 'x.msg' })
    const header = hub.html.slice(0, hub.html.indexOf('</table>'))
    for (const frag of dnFragments) expect(header).not.toMatch(frag)
    expect(header).toContain('nils.ashcombe@example.com')
    expect(header).toContain('odile.larkspur@example.com')
    expect(header).toContain('ilva.brandt@example.com')
    // The external Cc address was already correct and must stay.
    expect(header).toContain('juno.halloway@example.org')
  })

  it('prints SMTP addresses for a distribution-list thread', async () => {
    const file = join(CORPUS, 'distribution-list-thread.msg')
    if (!existsSync(file)) return
    const bytes = await readFile(file)
    const hub = await readMsg({ bytes, filename: 'x.msg' })
    const header = hub.html.slice(0, hub.html.indexOf('</table>'))
    for (const frag of dnFragments) expect(header).not.toMatch(frag)
    expect(header).toContain('opscenter@example.com')
    expect(header).toContain('marta.quill@example.com')
  })

  it('degrades to display names when the msg carries no SMTP address at all', async () => {
    const file = join(CORPUS, 'display-name-only-thread.msg')
    if (!existsSync(file)) return
    const bytes = await readFile(file)
    const hub = await readMsg({ bytes, filename: 'x.msg' })
    const header = hub.html.slice(0, hub.html.indexOf('</table>'))
    for (const frag of dnFragments) expect(header).not.toMatch(frag)
    expect(header).toContain('Sorrel, Devi')
  })
})

describe('readMsg', () => {
  it('rejects non-CFB bytes with msg-parse-failed', async () => {
    await expect(readMsg({ bytes: Buffer.from('definitely not a msg') })).rejects.toMatchObject({
      code: 'msg-parse-failed',
    })
  })
})

describe('msg detection', () => {
  const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
  it('CFB with .msg extension detects as msg', () => {
    expect(detect(CFB, 'mail.msg')).toEqual({ kind: 'ok', format: 'msg' })
  })
  it('CFB without .msg stays unsupported', () => {
    expect(detect(CFB).kind).toBe('unsupported')
  })
})

/**
 * PidTagHtml is a BINARY property, so msgreader returns `html` as a Uint8Array.
 * The reader cast it straight to `string`, which meant every .msg carrying an
 * HTML body — the ordinary Outlook case — threw `out.split is not a function`
 * inside inlineMsgImages. The private corpus never caught it because those
 * messages carried RTF bodies instead; the synthetic fixture does.
 */
describe.skipIf(!existsSync(join(CORPUS, 'inline-images-thread.msg')))('msg: an HTML body with inline images', () => {
  async function body(): Promise<string> {
    const bytes = await readFile(join(CORPUS, 'inline-images-thread.msg'))
    return (await readMsg({ bytes, filename: 'inline-images-thread.msg' })).html
  }

  it('reads the HTML body at all', async () => {
    expect(await body()).toContain('Photographs from the branch visit.')
  })

  it('inlines a cid reference whose attachment declares its type', async () => {
    expect(await body()).toMatch(/<img[^>]+src="data:image\/png;base64,[A-Za-z0-9+/=]+"[^>]*alt="shelving"/)
  })

  it('guesses the type from the filename when the attachment declares none', async () => {
    // aisle.jpg carries no PidTagAttachMimeTag, so guessMime(".jpg") decides.
    expect(await body()).toContain('data:image/jpeg;base64,')
  })

  it('also resolves an image referenced by bare filename rather than cid', async () => {
    expect(await body()).toContain('data:image/gif;base64,')
  })

  it('degrades a cid with no matching attachment to its alt text', async () => {
    const html = await body()
    // Not a dead cid: URL and not a broken-image icon — the alt survives.
    // (The epub reader does NOT do this for an unresolvable relative src; see
    //  the note in epub-links.test.ts and remaining_work.md section 3.)
    expect(html).toContain('[never sent]')
    expect(html).not.toContain('cid:')
  })

  it('does not inline a non-image attachment', async () => {
    expect(await body()).not.toContain('data:text/plain')
  })
})
