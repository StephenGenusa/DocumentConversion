import { describe, it, expect } from 'vitest'
import { readHtml } from '../../src/core/readers/html'
import { detect } from '../../src/core/detect'
import { inlineMhtmlPictures, unpackMhtml } from '../../src/core/mhtml'

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const BOUNDARY = '----MultipartBoundary--abc123----'

/** A page laid out the way Chromium saves one ("Saved by Blink"): quoted-printable HTML, base64 pictures under their addresses. */
function blinkPage(html: string, extra = ''): Buffer {
  return Buffer.from(
    [
      'From: <Saved by Blink>',
      'Snapshot-Content-Location: https://example.com/post/1',
      'Subject: A saved page',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related;',
      '\ttype="text/html";',
      `\tboundary="${BOUNDARY}"`,
      '',
      '',
      `--${BOUNDARY}`,
      'Content-Type: text/html',
      'Content-ID: <frame-1>',
      'Content-Transfer-Encoding: quoted-printable',
      'Content-Location: https://example.com/post/1',
      '',
      html,
      `--${BOUNDARY}`,
      'Content-Type: text/css',
      'Content-Transfer-Encoding: quoted-printable',
      'Content-Location: cid:css-1',
      '',
      'p { color: red; }',
      `--${BOUNDARY}`,
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-Location: https://img.example.com/media/pic?format=png&name=medium',
      '',
      PNG.toString('base64').replace(/(.{20})/g, '$1\r\n'),
      extra + `--${BOUNDARY}--`,
      '',
    ].join('\r\n'),
    'latin1',
  )
}

const PAGE =
  '<!DOCTYPE html><html><head><meta http-equiv=3D"Content-Type" content=3D"text/html; charset=3DUTF-8">' +
  '<title>A saved page</title></head><body><h1>Caf=C3=A9 notes</h1><p>A long line that Chromium wraps wi=\r\n' +
  'th a soft break.</p><p><img alt=3D"Chart" src=3D"https://img.example.com/media/pic?format=3Dpng&amp;name=3Dmedium"></p>' +
  '<p><img alt=3D"Elsewhere" src=3D"https://img.example.com/not-saved.png"></p></body></html>'

const DATA_URI = `data:image/png;base64,${PNG.toString('base64')}`

describe('unpackMhtml', () => {
  it('gives the first HTML part as the page and the rest as parts, decoded', () => {
    const page = unpackMhtml(blinkPage(PAGE))!
    expect(page.html.location).toBe('https://example.com/post/1')
    expect(page.html.bytes.toString('utf8')).toContain('<h1>Café notes</h1>')
    expect(page.html.bytes.toString('utf8')).toContain('wraps with a soft break')
    expect(page.parts.map((p) => p.mime)).toEqual(['text/css', 'image/png'])
    expect(page.parts[1].bytes.equals(PNG)).toBe(true)
  })

  it('is null for a plain HTML file and for a multipart with no HTML part', () => {
    expect(unpackMhtml(Buffer.from('<!doctype html><html><body>Content-Type: multipart/related</body></html>'))).toBeNull()
    const noHtml = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b--\r\n`
    expect(unpackMhtml(Buffer.from(noHtml))).toBeNull()
  })

  it('reads a multipart nested in another, and a file cut short', () => {
    const nested =
      'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=outer\r\n\r\n' +
      '--outer\r\nContent-Type: multipart/alternative; boundary="inner"\r\n\r\n' +
      '--inner\r\nContent-Type: text/html; charset="windows-1252"\r\n\r\n<p>caf\xe9</p>\r\n--inner--\r\n' +
      '--outer\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <pic1>\r\n\r\n' +
      PNG.toString('base64')
    const page = unpackMhtml(Buffer.from(nested, 'latin1'))!
    expect(page.html.charset).toBe('windows-1252')
    expect(page.parts).toHaveLength(1)
    expect(page.parts[0].contentId).toBe('pic1')
    expect(page.parts[0].bytes.equals(PNG)).toBe(true)
  })
})

describe('inlineMhtmlPictures', () => {
  const page = unpackMhtml(blinkPage(PAGE))!

  it('matches a cid: picture and a relative address', () => {
    const withId = { ...page, parts: [{ mime: 'image/png', contentId: 'pic1', bytes: PNG }] }
    expect(inlineMhtmlPictures('<img src="cid:pic1">', withId)).toBe(`<img src="${DATA_URI}">`)
    const relative = { ...page, parts: [{ mime: 'image/png', location: 'https://example.com/post/img/a.png', bytes: PNG }] }
    expect(inlineMhtmlPictures("<img src='img/a.png'>", relative)).toBe(`<img src='${DATA_URI}'>`)
  })

  it('leaves links, and a part that is not a picture, alone', () => {
    const html = '<a href="https://img.example.com/media/pic?format=png&amp;name=medium">x</a><img src="cid:css-1">'
    expect(inlineMhtmlPictures(html, page)).toBe(html)
  })
})

describe('readHtml on a saved page', () => {
  it('puts the saved picture where the page names it', async () => {
    const hub = await readHtml({ bytes: blinkPage(PAGE), filename: 'page.mhtml' })
    expect(hub.title).toBe('A saved page')
    expect(hub.html).toContain('Café notes')
    expect(hub.html).toContain(DATA_URI)
    expect(hub.html).not.toContain('Saved by Blink')
    expect(hub.html).not.toContain('MultipartBoundary')
    // A picture the file did not save keeps its address, for the fetch step.
    expect(hub.html).toContain('https://img.example.com/not-saved.png')
  })

  it('routes .mhtml and .mht to the html reader', () => {
    expect(detect(blinkPage(PAGE), 'page.mhtml')).toEqual({ kind: 'ok', format: 'html' })
    expect(detect(blinkPage(PAGE), 'PAGE.MHT')).toEqual({ kind: 'ok', format: 'html' })
  })
})
