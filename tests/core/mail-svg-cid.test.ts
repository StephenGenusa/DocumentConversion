import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { readEml } from '../../src/core/readers/eml'
import { readMbox } from '../../src/core/readers/mbox'
import { msgToHub } from '../../src/core/readers/msg'
import { inlineCidPictures } from '../../src/core/readers/email-common'

/*
 * A picture an SVG in a message names by cid: (<image href="cid:…">) is
 * the message's own part, as an <img src="cid:…"> is: resolved from the
 * message's parts in .eml, .mbox and .msg, never fetched.
 */

const png = (color: string): Buffer => {
  const c = createCanvas(8, 6)
  const g = c.getContext('2d')
  g.fillStyle = color
  g.fillRect(0, 0, 8, 6)
  return Buffer.from(c.toBuffer('image/png'))
}
const SIGN = png('#3a6ea5')
const MARK = png('#8c3c28')

const drawing =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="80" height="60" aria-label="Reading room plan">' +
  '<rect width="80" height="60" fill="#eee"/><image href="cid:sign-1" width="40" height="30"/>' +
  '<image xlink:href="CID:mark%2D2" x="40" width="40" height="30"/></svg>'

/** The pictures inside each SVG image in the hub, as their bytes in base64. */
function svgPictures(html: string): string[][] {
  return [...html.matchAll(/src="data:image\/svg\+xml;base64,([^"]+)"/g)].map((m) =>
    [...Buffer.from(m[1], 'base64').toString('utf8').matchAll(/href="data:image\/png;base64,([^"]+)"/g)].map((n) => n[1]),
  )
}

function eml(html: string, parts: { id: string; type: string; bytes: Buffer }[]): string {
  return [
    'From: a@example.com',
    'To: b@example.com',
    'Subject: The plan',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    ...parts.flatMap((p) => ['--b1', `Content-Type: ${p.type}`, `Content-ID: <${p.id}>`, 'Content-Transfer-Encoding: base64', 'Content-Disposition: inline', '', p.bytes.toString('base64')]),
    '--b1--',
    '',
  ].join('\r\n')
}

const PARTS = [
  { id: 'sign-1', type: 'image/png', bytes: SIGN },
  { id: 'mark-2', type: 'image/png', bytes: MARK },
]

describe('cid: pictures inside an SVG in mail', () => {
  it('.eml: an SVG drawn in the body, href and xlink:href, %-encoded and in another case', async () => {
    const hub = await readEml({ bytes: Buffer.from(eml(`<p>Plan:</p>${drawing}`, PARTS)), filename: 'a.eml' })
    expect(svgPictures(hub.html)).toEqual([[SIGN.toString('base64'), MARK.toString('base64')]])
    expect(hub.html).not.toMatch(/cid:/i)
  })

  it('.eml: an SVG part named by an <img>, whose own pictures are other parts', async () => {
    const parts = [...PARTS, { id: 'plan-3', type: 'image/svg+xml', bytes: Buffer.from(drawing) }]
    const hub = await readEml({ bytes: Buffer.from(eml('<p><img src="cid:plan-3" alt="Plan"></p>', parts)), filename: 'a.eml' })
    expect(svgPictures(hub.html)).toEqual([[SIGN.toString('base64'), MARK.toString('base64')]])
  })

  it('.mbox: the same, message by message', async () => {
    const mbox = `From a@example.com Mon Jan  1 00:00:00 2024\n${eml(drawing, PARTS).replace(/\r\n/g, '\n')}\n`
    const hub = await readMbox({ bytes: Buffer.from(mbox), filename: 'a.mbox' })
    expect(svgPictures(hub.html)).toEqual([[SIGN.toString('base64'), MARK.toString('base64')]])
  })

  it('.msg: an SVG in the body, by Content-ID', async () => {
    const hub = await msgToHub({
      subject: 'The plan',
      recipients: [],
      bodyHtml: `<p>Plan:</p>${drawing}`,
      attachments: [
        { fileName: 'sign.png', contentId: 'sign-1', mimeType: 'image/png', content: new Uint8Array(SIGN) },
        { fileName: 'mark.png', contentId: 'mark-2', content: new Uint8Array(MARK) },
      ],
    })
    expect(svgPictures(hub.html)).toEqual([[SIGN.toString('base64'), MARK.toString('base64')]])
  })

  it('a cid: that names no part is left for the sanitizer; cid:a never catches cid:ab', () => {
    const out = inlineCidPictures('<img src="cid:ab"><svg><image href="cid:a"/><image href="cid:none"/></svg>', [
      { contentId: '<a>', mime: 'image/png', bytes: SIGN },
      { contentId: 'ab', mime: 'image/png', bytes: MARK },
    ])
    expect(out).toBe(
      `<img src="data:image/png;base64,${MARK.toString('base64')}"><svg><image href="data:image/png;base64,${SIGN.toString('base64')}"/><image href="cid:none"/></svg>`,
    )
  })

  it('an SVG part naming itself is not followed into itself', () => {
    const self = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="cid:loop"/></svg>')
    const out = inlineCidPictures('<img src="cid:loop">', [{ contentId: 'loop', mime: 'image/svg+xml', bytes: self }])
    const inner = Buffer.from(/base64,([^"]+)/.exec(out)![1], 'base64').toString('utf8')
    expect(inner).toContain('href="cid:loop"')
  })
})
