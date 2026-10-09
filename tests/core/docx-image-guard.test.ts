import { describe, it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import JSZip from 'jszip'
import { writeDocx } from '../../src/core/writers/docx'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * html-to-docx fetches, itself and unguarded, any <img> src that contains an
 * http(s) URL. The writer must hand it none — however the tag is spelled.
 */
describe('docx writer and remote images', () => {
  it('never lets html-to-docx fetch, even through a parser-confusing tag', async () => {
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits++
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const html =
        `<p>before</p>` +
        `<p><img alt='a<b src="data:image/png;base64,AAAA"' src="${base}/confused.png"></p>` +
        `<p><img src="${base}/plain.png" alt="plain"></p>` +
        `<p>after</p>`
      const out = await writeDocx({ html })
      const doc = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string')
      expect(hits).toBe(0)
      expect(doc).toContain('before')
      expect(doc).toContain('after')
    } finally {
      server.close()
    }
  })

  it('a data: URI that contains a URL does not crash the document', async () => {
    const out = await writeDocx({ html: '<p>a</p><img src="data:,http://evil.example/x.png" alt="x"><p>b</p>' })
    expect(out.byteLength).toBeGreaterThan(0)
  })

  it('keeps a real embedded image', async () => {
    const out = await writeDocx({ html: `<p><img src="data:image/png;base64,${PNG.toString('base64')}"></p>` })
    const media = Object.keys((await JSZip.loadAsync(out)).files).filter((n) => /media\/.+\.png$/.test(n))
    expect(media.length).toBeGreaterThan(0)
  })
})
