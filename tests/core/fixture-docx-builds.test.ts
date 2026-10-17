import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { inflateSync } from 'node:zlib'
import { loadImage } from '@napi-rs/canvas'
import { buildDocx, para, imageParagraph, imageRelIds, FIXTURE_DATE, TINY_PNG } from '../../scripts/fixtures/lib-docx.mjs'

/*
 * The .docx fixtures in tests/corpus are built by scripts/fixtures (lib-docx's
 * buildDocx) and committed. Building one again gave other bytes: JSZip stamps
 * every entry, folders too, with the time it was added. Every entry now
 * carries FIXTURE_DATE, so a generator run reproduces its committed fixture.
 */

const CORPUS = join(__dirname, '../corpus')
/** Every corpus .docx a script in scripts/fixtures builds with buildDocx. */
const BUILT = [
  'supply-request-header.docx', 'induction-pack-with-footer.docx', 'branch-notes-with-toc.docx', 'charts-with-images.docx',
  'context-menu-howto.docx', 'treasurer-equations.docx', 'reading-room-fax.docx', 'reading-room-drawings.docx',
  'reading-room-metafiles.docx', 'reading-room-scans.docx',
]

describe('lib-docx builds the same file every time', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives the same bytes built at two different times', async () => {
    const make = (): Promise<Buffer> =>
      buildDocx({ body: para('alpha') + imageParagraph(imageRelIds(2), 1), headers: { default: para('head') }, imageCount: 2 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-01T10:00:00Z'))
    const first = await make()
    vi.setSystemTime(new Date('2026-10-17T21:13:58Z'))
    const second = await make()
    expect(second.equals(first)).toBe(true)
  })

  it('stamps every entry, folders included, with FIXTURE_DATE', async () => {
    const zip = await JSZip.loadAsync(await buildDocx({ body: para('alpha'), imageCount: 1 }))
    const entries = Object.values(zip.files)
    expect(entries.some((e) => e.dir)).toBe(true)
    for (const entry of entries) expect(entry.date.getTime(), entry.name).toBe(FIXTURE_DATE.getTime())
  })

  it('the committed fixtures are what the generators write now', async () => {
    for (const name of BUILT) {
      const zip = await JSZip.loadAsync(readFileSync(join(CORPUS, name)))
      for (const entry of Object.values(zip.files)) expect(entry.date.getTime(), `${name} ${entry.name}`).toBe(FIXTURE_DATE.getTime())
    }
  })
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

/** A PNG whose every chunk's CRC is right, whose pixels inflate and which decodes. */
async function expectValidPng(png: Buffer, what: string): Promise<void> {
  expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), what).toBe(true)
  const idat: Buffer[] = []
  let at = 8
  while (at < png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    expect(png.readUInt32BE(at + 8 + length), `${what} ${type} CRC`).toBe(crc32(png.subarray(at + 4, at + 8 + length)))
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  expect(() => inflateSync(Buffer.concat(idat)), what).not.toThrow()
  expect((await loadImage(png)).width, what).toBe(3)
}

/*
 * TINY_PNG was a hand-typed 3x1 PNG whose CRCs libpng refused (the bytes
 * tests/fixtures/sample.png had until f244846), and four corpus fixtures
 * carried it as their pictures.
 */
describe('lib-docx pictures', () => {
  it('TINY_PNG is a valid 3x1 PNG', async () => {
    await expectValidPng(TINY_PNG, 'TINY_PNG')
  })

  it('every corpus fixture built with it carries the valid one', async () => {
    for (const name of ['induction-pack-with-footer.docx', 'branch-notes-with-toc.docx', 'charts-with-images.docx', 'context-menu-howto.docx']) {
      const zip = await JSZip.loadAsync(readFileSync(join(CORPUS, name)))
      const media = Object.keys(zip.files).filter((n) => /^word\/media\/rImg\d+\.png$/.test(n))
      expect(media.length, name).toBeGreaterThan(0)
      for (const part of media) await expectValidPng(await zip.files[part].async('nodebuffer'), `${name} ${part}`)
    }
  })
})
