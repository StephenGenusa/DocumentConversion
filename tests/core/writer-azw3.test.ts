import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initKf8File } from '../kf8-reader.mjs'
import { writeAzw3 } from '../../src/core/writers/azw3'

/**
 * Read back with an INDEPENDENT parser rather than asserting on our own bytes.
 *
 * The Kindle spec said this was not possible - there being no JS Kindle reader -
 * and fell back to byte-level structural assertions. @lingo-reader/mobi-parser
 * turned out to exist, so AZW3 gets the same round trip the EPUB writer enjoys:
 * a file that only satisfies our own idea of the format is not evidence.
 *
 * Not covered here: whether a real Kindle renders it. Nothing in a test suite
 * can establish that, and section 0's rule - render it and look - applies.
 */
async function roundTrip(doc: Parameters<typeof writeAzw3>[0]) {
  const bytes = await writeAzw3(doc)
  const file = join(mkdtempSync(join(tmpdir(), 'azw3-test-')), 'book.azw3')
  writeFileSync(file, bytes)
  const kf8 = await initKf8File(file, join(tmpdir(), 'azw3-test-img'))
  return { bytes, kf8 }
}

const TWO_CHAPTERS =
  '<h1>Chapter One</h1><p>The first chapter body.</p>' +
  '<h1>Chapter Two</h1><p>The second chapter body.</p>'

describe('the AZW3 writer', () => {
  it('produces a file a Kindle parser accepts', async () => {
    const { bytes } = await roundTrip({ html: TWO_CHAPTERS, title: 'Round Trip' })
    // PalmDB type/creator, at fixed offsets, are what identifies the family.
    expect(bytes.subarray(60, 64).toString('latin1')).toBe('BOOK')
    expect(bytes.subarray(64, 68).toString('latin1')).toBe('MOBI')
  })

  it('carries the title and language through EXTH', async () => {
    const { kf8 } = await roundTrip({ html: TWO_CHAPTERS, title: 'Round Trip' })
    const meta = kf8.getMetadata()
    expect(meta.title).toBe('Round Trip')
    expect(meta.language).toBe('en')
  })

  it('declares one spine entry per chapter', async () => {
    const { kf8 } = await roundTrip({ html: TWO_CHAPTERS, title: 'T' })
    expect(kf8.getSpine()).toHaveLength(2)
  })

  it('returns each chapter with its own text, in order', async () => {
    const { kf8 } = await roundTrip({ html: TWO_CHAPTERS, title: 'T' })
    const spine = kf8.getSpine()
    const first = await kf8.loadChapter(spine[0].id)
    const second = await kf8.loadChapter(spine[1].id)
    expect(first?.html).toContain('Chapter One')
    expect(first?.html).toContain('The first chapter body.')
    // The frames of reference for insertOffset and the fragment offset differ;
    // swapping them yields a chapter that decodes but is sliced mid-word.
    expect(first?.html).not.toContain('second chapter')
    expect(second?.html).toContain('Chapter Two')
    expect(second?.html).toContain('The second chapter body.')
  })

  it('survives a document with no headings at all', async () => {
    const { kf8 } = await roundTrip({ html: '<p>Just one paragraph.</p>', title: 'T' })
    const spine = kf8.getSpine()
    expect(spine.length).toBeGreaterThanOrEqual(1)
    const only = await kf8.loadChapter(spine[0].id)
    expect(only?.html).toContain('Just one paragraph.')
  })

  it('keeps a table intact', async () => {
    const html = '<h1>C</h1><table><tbody><tr><td>cell one</td><td>cell two</td></tr></tbody></table>'
    const { kf8 } = await roundTrip({ html, title: 'T' })
    const ch = await kf8.loadChapter(kf8.getSpine()[0].id)
    expect(ch?.html).toContain('cell one')
    expect(ch?.html).toContain('cell two')
  })

  it('falls back to a title rather than emitting an empty one', async () => {
    const { kf8 } = await roundTrip({ html: '<p>x</p>' })
    expect(kf8.getMetadata().title).toBe('Untitled')
  })

  it('names no DATP or guide index, and gives each fragment the tags readers look up (2, 3, 4, 6)', async () => {
    // calibre refused every book this writer made: it read the guide index
    // from a field left at 0 (record 0 itself), and a fragment without tag 3.
    const { bytes } = await roundTrip({ html: TWO_CHAPTERS, title: 'T' })
    const count = bytes.readUInt16BE(76)
    const offsets = Array.from({ length: count }, (_, i) => bytes.readUInt32BE(78 + i * 8))
    const record = (i: number) => bytes.subarray(offsets[i], i + 1 < count ? offsets[i + 1] : bytes.length)
    const r0 = record(0)
    expect(r0.readUInt32BE(256)).toBe(0xffffffff) // DATP
    expect(r0.readUInt32BE(260)).toBe(0xffffffff) // guide
    const frag = record(r0.readUInt32BE(248))
    expect(frag.toString('latin1', 0, 4)).toBe('INDX')
    const tagx = frag.indexOf('TAGX')
    const tags: number[] = []
    for (let at = tagx + 12; frag[at + 3] !== 1; at += 4) tags.push(frag[at])
    expect(tags).toEqual([2, 3, 4, 6])
  })
})
