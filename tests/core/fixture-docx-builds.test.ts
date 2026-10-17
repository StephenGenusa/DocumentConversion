import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildDocx, para, imageParagraph, imageRelIds, FIXTURE_DATE } from '../../scripts/fixtures/lib-docx.mjs'

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
