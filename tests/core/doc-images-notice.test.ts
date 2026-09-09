/**
 * Legacy .doc pictures.
 *
 * Word 97-2003 keeps pictures outside the text stream, and word-extractor's
 * Document exposes text and nothing else (getBody / getFootnotes /
 * getEndnotes / getHeaders / getFooters / getAnnotations / getTextboxes). Worse
 * for us, its `clean()` filter ends with `.replace(/[\x00-\x07]/g, '')`, which
 * deletes the 0x01 inline-picture character outright — so the reader is not
 * even told WHERE a picture stood. the loan calculations document loses six of them,
 * one of which is the formula the sentence "That formula is as follows:"
 * introduces.
 *
 * The bytes themselves are still in the file, in OfficeArt BLIP records, and
 * that is what earns the notice: a picture record with a consistent length and
 * the right image signature inside it is evidence, not a guess.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readDoc, countEmbeddedPictures, DOC_IMAGES_ADVICE } from '../../src/core/readers/doc'
import type { ReadContext } from '../../src/core/types'

const CORPUS = join(__dirname, '../corpus')
const describeIfCorpus = existsSync(CORPUS) ? describe : describe.skip

async function adviceFor(name: string): Promise<Array<[string, string]>> {
  const calls: Array<[string, string]> = []
  const ctx: ReadContext = { onAdvice: (kind, message) => calls.push([kind, message]) }
  await readDoc({ bytes: await readFile(join(CORPUS, name)), filename: name }, ctx)
  return calls
}

describeIfCorpus('countEmbeddedPictures', () => {
  it('counts the six PNG formulas in loan-calculations.doc', async () => {
    // Verified independently: each of the six BLIPs carves out as a valid PNG.
    expect(countEmbeddedPictures(await readFile(join(CORPUS, 'loan-calculations.doc')))).toBe(6)
  })

  it('counts the JPEG logo in shelving-instructions.doc', async () => {
    expect(countEmbeddedPictures(await readFile(join(CORPUS, 'shelving-instructions.doc')))).toBe(1)
  })

  it.each([
    'definitions.doc',
    'classification-explanation.doc',
    'reading-group-questions.doc',
    'volunteer-induction-questions.doc',
    'cataloguing-questions.doc',
  ])('finds nothing in a picture-free document: %s', async (name) => {
    expect(countEmbeddedPictures(await readFile(join(CORPUS, name)))).toBe(0)
  })

  it.each([
    'branch-notes-with-toc.docx', // 9 media entries
    'induction-pack-with-footer.docx', // 18
    'charts-with-images.docx', // 12
  ])('does not mistake the media zip in %s for legacy pictures', async (name) => {
    // These carry a handful of PNGs each, as ordinary zip entries with no
    // OfficeArt record around them. A bare signature scan would light up on
    // every one; the record-header gate must not.
    expect(countEmbeddedPictures(await readFile(join(CORPUS, name)))).toBe(0)
  })

  it('survives a buffer far too short to hold a record', () => {
    expect(countEmbeddedPictures(Buffer.alloc(0))).toBe(0)
    expect(countEmbeddedPictures(Buffer.from([0x1e, 0xf0, 0x1e, 0xf0]))).toBe(0)
  })

  it('rejects a record whose declared length runs past the end of the file', () => {
    const b = Buffer.alloc(200)
    b.writeUInt16LE(0x0e6e, 0) // recVer/recInstance for a one-uid PNG blip
    b.writeUInt16LE(0xf01e, 2)
    b.writeUInt32LE(0xffffff, 4) // a length no 200-byte buffer can hold
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b, 8 + 17)
    expect(countEmbeddedPictures(b)).toBe(0)
  })
})

describeIfCorpus('readDoc picture advice', () => {
  it('says the pictures were dropped, naming .docx as the fix', async () => {
    const images = (await adviceFor('loan-calculations.doc')).filter(([kind]) => kind === 'doc-images')
    expect(images).toHaveLength(1)
    expect(images[0][1]).toBe(DOC_IMAGES_ADVICE)
    expect(images[0][1]).toMatch(/picture/i)
    expect(images[0][1]).toMatch(/Word 97-2003/)
    expect(images[0][1]).toMatch(/\.docx/)
  })

  it('says it once for a document with a single picture', async () => {
    const kinds = (await adviceFor('shelving-instructions.doc')).map(([kind]) => kind)
    expect(kinds.filter((k) => k === 'doc-images')).toHaveLength(1)
  })

  it.each([
    'definitions.doc',
    'classification-explanation.doc',
    'reading-group-questions.doc',
    'volunteer-induction-questions.doc',
    'cataloguing-questions.doc',
  ])('stays silent about pictures in %s', async (name) => {
    expect((await adviceFor(name)).map(([kind]) => kind)).not.toContain('doc-images')
  })

  it('invents no placeholder for a picture it cannot place', async () => {
    // The 0x01 anchors are deleted before the reader ever sees the text, so
    // there is no honest position for an <img>. Saying so beats guessing.
    const name = 'loan-calculations.doc'
    const hub = await readDoc({ bytes: await readFile(join(CORPUS, name)), filename: name })
    expect(hub.html).not.toContain('<img')
    expect(hub.html).not.toMatch(/\[image\]|\[picture\]/i)
  })

  it('does not warn when the extractor returns prose from a picture-free file', async () => {
    const onAdvice = vi.fn()
    await readDoc({ bytes: Buffer.from('x'), filename: 'a.doc' }, { onAdvice }, async () => 'Just a sentence.')
    expect(onAdvice).not.toHaveBeenCalled()
  })

  it('still says nothing at all about a picture-only document, which fails first', async () => {
    // "picture-only-figure.doc" is one picture and no text: the hard error is
    // the honest answer there, and no advice must precede it.
    const onAdvice = vi.fn()
    const name = 'picture-only-figure.doc'
    await expect(
      readDoc({ bytes: await readFile(join(CORPUS, name)), filename: name }, { onAdvice }),
    ).rejects.toMatchObject({ code: 'read-failed' })
    expect(onAdvice).not.toHaveBeenCalled()
  })
})
