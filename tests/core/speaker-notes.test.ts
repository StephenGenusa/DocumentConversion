import { describe, it, expect } from 'vitest'
import { notesToHub, stripSpeakerNotes, SPEAKER_NOTES_TAG } from '../../src/core/speaker-notes'
import { sanitizeToHub } from '../../src/core/allowlist'

/**
 * Speaker notes have to survive the whole chain — reader, hub sanitiser,
 * editor, and back — while never appearing in the body of an ordinary
 * conversion. Both halves are load-bearing:
 *
 * Before this existed, `<aside>note</aside>` was stripped by the sanitiser and
 * its TEXT was kept and inlined, so a note leaked into the converted body as a
 * loose run of words with nothing to mark it. That is the silent-gluing class
 * section 0 calls the highest-value bug here.
 */
describe('notesToHub', () => {
  it('lifts a notes comment into an element the hub can carry', () => {
    expect(notesToHub('<p>Slide</p><!-- notes: say this bit -->')).toBe(
      `<p>Slide</p><${SPEAKER_NOTES_TAG}>say this bit</${SPEAKER_NOTES_TAG}>`,
    )
  })

  it('accepts the spellings people actually write', () => {
    for (const raw of ['<!--notes:x-->', '<!-- Notes: x -->', '<!--   NOTES :  x  -->']) {
      expect(notesToHub(raw)).toBe(`<${SPEAKER_NOTES_TAG}>x</${SPEAKER_NOTES_TAG}>`)
    }
  })

  it('leaves ordinary comments alone, so they are dropped as before', () => {
    expect(notesToHub('<p>a</p><!-- TODO: unrelated -->')).toBe('<p>a</p><!-- TODO: unrelated -->')
  })

  it('escapes markup inside a note rather than trusting it', () => {
    expect(notesToHub('<!-- notes: <script>x</script> -->')).toBe(
      `<${SPEAKER_NOTES_TAG}>&lt;script&gt;x&lt;/script&gt;</${SPEAKER_NOTES_TAG}>`,
    )
  })

  it('keeps a multi-line note as one note', () => {
    expect(notesToHub('<!-- notes: one\ntwo -->')).toContain('one\ntwo')
  })
})

describe('the hub carries notes', () => {
  it('survives sanitizeToHub as an element, not as loose text', () => {
    const html = sanitizeToHub(`<p>Slide</p><${SPEAKER_NOTES_TAG}>my note</${SPEAKER_NOTES_TAG}>`)
    expect(html).toContain(`<${SPEAKER_NOTES_TAG}>my note</${SPEAKER_NOTES_TAG}>`)
  })

  it('does not let a note carry attributes through', () => {
    const html = sanitizeToHub(`<${SPEAKER_NOTES_TAG} onclick="x" class="y">n</${SPEAKER_NOTES_TAG}>`)
    expect(html).toBe(`<${SPEAKER_NOTES_TAG}>n</${SPEAKER_NOTES_TAG}>`)
  })
})

describe('stripSpeakerNotes', () => {
  it('removes the note and its text, not just the tag', () => {
    const out = stripSpeakerNotes(`<p>a</p><${SPEAKER_NOTES_TAG}>secret</${SPEAKER_NOTES_TAG}><p>b</p>`)
    expect(out).toBe('<p>a</p><p>b</p>')
    expect(out).not.toContain('secret')
  })

  it('removes several, and leaves a document with none untouched', () => {
    const n = (t: string) => `<${SPEAKER_NOTES_TAG}>${t}</${SPEAKER_NOTES_TAG}>`
    expect(stripSpeakerNotes(`${n('a')}<p>x</p>${n('b')}`)).toBe('<p>x</p>')
    expect(stripSpeakerNotes('<p>x</p>')).toBe('<p>x</p>')
  })

  it('is not fooled by the word appearing in body text', () => {
    expect(stripSpeakerNotes('<p>aside from that</p>')).toBe('<p>aside from that</p>')
  })
})

/**
 * The half that matters in production: notes reach the hub and the editor, and
 * reach NO current writer. Asserted through the real converter rather than by
 * calling the strip directly, because the boundary is what has to hold.
 */
describe('notes never reach an ordinary output', () => {
  const NOTE = 'DO-NOT-EMIT-THIS-NOTE'
  const doc = () => ({
    html: `<h1>Slide</h1><p>Body text.</p><${SPEAKER_NOTES_TAG}><p>${NOTE}</p></${SPEAKER_NOTES_TAG}>`,
    title: 'Deck',
  })

  /**
   * epub and docx are deflated zips, so scanning the container bytes would find
   * neither the note nor the body — the test would pass while proving nothing.
   * Decompress them and read the parts.
   */
  async function textOf(bytes: Buffer): Promise<string> {
    if (bytes.subarray(0, 2).toString('latin1') !== 'PK') return bytes.toString('utf8')
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(bytes)
    const parts = await Promise.all(
      Object.values(zip.files)
        .filter((f) => !f.dir && /\.(x?html?|xml|opf|ncx)$/i.test(f.name))
        .map((f) => f.async('string')),
    )
    return parts.join('\n')
  }

  it.each(['txt', 'md', 'html', 'epub', 'docx'] as const)('is absent from %s output', async (target) => {
    const { createConverter } = await import('../../src/core/convert')
    const convert = createConverter(async () => {
      throw new Error('the pdf renderer is not needed for this test')
    })
    const out = await convert.write(doc(), target)
    const text = (await Promise.all(out.parts.map((part) => textOf(part.bytes)))).join('\n')
    expect(text).toContain('Body text')
    expect(text).not.toContain(NOTE)
  })
})

describe('the markdown reader lifts notes out of comments', () => {
  it('turns a notes comment into a note the hub keeps', async () => {
    const { readMarkdown } = await import('../../src/core/readers/md')
    const src = { bytes: Buffer.from('# Slide\n\nBody.\n\n<!-- notes: say this -->\n', 'utf8') }
    const { html } = await readMarkdown(src)
    expect(html).toContain(`<${SPEAKER_NOTES_TAG}>say this</${SPEAKER_NOTES_TAG}>`)
    expect(html).toContain('Body.')
  })

  it('still drops an unrelated comment', async () => {
    const { readMarkdown } = await import('../../src/core/readers/md')
    const src = { bytes: Buffer.from('Body.\n\n<!-- TODO: unrelated -->\n', 'utf8') }
    const { html } = await readMarkdown(src)
    expect(html).not.toContain('unrelated')
    expect(html).not.toContain(SPEAKER_NOTES_TAG)
  })
})

describe('but a slide target keeps them', () => {
  it('reaches the deck, where notes are the point', async () => {
    const { createConverter } = await import('../../src/core/convert')
    const convert = createConverter(async () => {
      throw new Error('the pdf renderer is not needed for this test')
    })
    const out = await convert.write(
      { html: `<p>Slide</p><${SPEAKER_NOTES_TAG}><p>KEEP-THIS-NOTE</p></${SPEAKER_NOTES_TAG}>` },
      'revealjs',
    )
    const html = out.parts[0].bytes.toString('utf8')
    expect(html).toContain('<aside class="notes"><p>KEEP-THIS-NOTE</p></aside>')
  })
})
