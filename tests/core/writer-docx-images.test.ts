import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { writeDocx } from '../../src/core/writers/docx'

// Two distinct 1x1 PNGs: enough for html-to-docx's image-size probe, and
// different byte-for-byte so a de-duplicating pass must keep both.
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC'
const red = `data:image/png;base64,${RED}`
const blue = `data:image/png;base64,${BLUE}`

interface Media {
  /** Distinct `word/media/*` parts left in the package. */
  parts: string[]
  /** Targets of the image relationships that document.xml actually references. */
  used: string[]
  /** Image relationships nothing in document.xml points at. */
  dangling: string[]
  bytes: number
}

async function inspect(docx: Buffer): Promise<Media> {
  const zip = await JSZip.loadAsync(docx)
  const parts = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !zip.files[n].dir)
  const doc = await zip.files['word/document.xml'].async('string')
  const rels = await zip.files['word/_rels/document.xml.rels'].async('string')
  const referenced = new Set((doc.match(/r:(?:embed|link|id)="([^"]+)"/g) ?? []).map((m) => /"([^"]+)"/.exec(m)![1]))
  const used: string[] = []
  const dangling: string[] = []
  for (const rel of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    if (!/relationships\/image/.test(rel)) continue
    const id = /Id="([^"]+)"/.exec(rel)![1]
    const target = /Target="([^"]+)"/.exec(rel)![1]
    ;(referenced.has(id) ? used : dangling).push(target)
  }
  return { parts, used, dangling, bytes: docx.length }
}

describe('writeDocx image parts', () => {
  // html-to-docx builds an <img> that is not a direct child of <p>/<li> twice:
  // buildImage writes the media part and its relationship, then hands the same
  // node to buildParagraph -> buildRun, which writes a second copy under a new
  // random name and embeds that one. The first is left orphaned.
  for (const [shape, html] of Object.entries({
    'a bare top-level image': `<p>before</p><img src="${red}" alt="a">`,
    'an image in a figure': `<figure><img src="${red}" alt="a"></figure>`,
    'an image in a div': `<div><img src="${red}" alt="a"></div>`,
    'an image in a table cell': `<table><tr><td><img src="${red}" alt="a"></td></tr></table>`,
    'an image in a paragraph': `<p><img src="${red}" alt="a"></p>`,
  })) {
    it(`writes ${shape} exactly once`, async () => {
      const media = await inspect(await writeDocx({ html, title: 'T' }))
      expect(media.dangling).toEqual([])
      expect(media.parts).toHaveLength(1)
      expect(media.used).toHaveLength(1)
    })
  }

  it('keeps both of two different images', async () => {
    const html = `<div><img src="${red}" alt="a"></div><div><img src="${blue}" alt="b"></div>`
    const media = await inspect(await writeDocx({ html, title: 'T' }))
    expect(media.dangling).toEqual([])
    expect(media.parts).toHaveLength(2)
    expect(new Set(media.used).size).toBe(2)
  })

  it('stores one copy of an image used twice, still embedded twice', async () => {
    const html = `<p><img src="${red}" alt="a"></p><p>mid</p><p><img src="${red}" alt="a again"></p>`
    const media = await inspect(await writeDocx({ html, title: 'T' }))
    expect(media.dangling).toEqual([])
    expect(media.parts).toHaveLength(1)
    // Both drawings survive; they simply share the single stored blob.
    expect(media.used).toHaveLength(2)
    expect(new Set(media.used).size).toBe(1)
  })

  it('leaves an image-free document untouched', async () => {
    const media = await inspect(await writeDocx({ html: '<h1>T</h1><p>No pictures.</p>', title: 'T' }))
    expect(media.parts).toEqual([])
    expect(media.used).toEqual([])
    expect(media.dangling).toEqual([])
  })

  it('shrinks a multi-image document', async () => {
    const imgs = Array.from({ length: 6 }, (_, i) => `<div><img src="${i % 2 ? blue : red}" alt="i${i}"></div>`)
    const media = await inspect(await writeDocx({ html: imgs.join(''), title: 'T' }))
    expect(media.dangling).toEqual([])
    // Six drawings, two distinct blobs.
    expect(media.parts).toHaveLength(2)
    expect(media.used).toHaveLength(6)
  })
})
