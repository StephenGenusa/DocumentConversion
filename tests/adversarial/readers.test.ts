/**
 * ADVERSARIAL reader tests.
 *
 * Written against the specs only (docs/superpowers/specs/*), NOT against the
 * reader implementations. Each test names the spec clause it probes. Tests
 * marked SPEC-AMBIGUITY probe behavior the specs do not pin down; they assert
 * what a careful user would expect.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'

import { readPptx } from '../../src/core/readers/pptx'
import { readEpub } from '../../src/core/readers/epub'
import { readOdt } from '../../src/core/readers/odt'
import { readOdp } from '../../src/core/readers/odp'
import { readIcs } from '../../src/core/readers/ics'
import { readMbox, splitMbox } from '../../src/core/readers/mbox'
import { readIpynb } from '../../src/core/readers/ipynb'
import { readCsv } from '../../src/core/readers/csv'
import { readCode } from '../../src/core/readers/code'
import { readImage, imageMime } from '../../src/core/readers/image'
import { readEml } from '../../src/core/readers/eml'
import { docBodyToHub, readDoc } from '../../src/core/readers/doc'
import { readRst } from '../../src/core/readers/rst'
import { readAsciidoc } from '../../src/core/readers/asciidoc'
import { sanitizeToHub, HUB_TAGS } from '../../src/core/allowlist'

const SLOW = 30000

// ---------------------------------------------------------------- helpers

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

async function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, data] of Object.entries(entries)) zip.file(name, data)
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
}

/** ODF zips store `mimetype` first and uncompressed. */
async function odfZip(mimetype: string, entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', mimetype, { compression: 'STORE' })
  for (const [name, data] of Object.entries(entries)) zip.file(name, data)
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
}

const PPT_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** Build a slide XML from shapes, each shape being a list of paragraph texts (runs). */
function slideXml(shapes: string[][][], extraShapes = ''): string {
  const sps = shapes
    .map(
      (paras) =>
        `<p:sp><p:txBody>${paras
          .map((runs) => `<a:p>${runs.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join('')}</a:p>`)
          .join('')}</p:txBody></p:sp>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${PPT_NS}><p:cSld><p:spTree>${sps}${extraShapes}</p:spTree></p:cSld></p:sld>`
}

function picShape(rid: string): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture"/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch/></p:blipFill><p:spPr/></p:pic>`
}

function relsXml(rels: { id: string; target: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`,
    )
    .join('')}</Relationships>`
}

const ODF_TEXT_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'

function odtContent(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_TEXT_NS}><office:body><office:text>${body}</office:text></office:body></office:document-content>`
}

function odpContent(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_TEXT_NS}><office:body><office:presentation>${body}</office:presentation></office:body></office:document-content>`
}

function drawPage(name: string, paras: string[]): string {
  const text = paras.map((p) => `<text:p>${p}</text:p>`).join('')
  return `<draw:page draw:name="${name}"><draw:frame><draw:text-box>${text}</draw:text-box></draw:frame></draw:page>`
}

function ics(events: string[]): Buffer {
  return Buffer.from(
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Adversarial//EN', ...events, 'END:VCALENDAR', ''].join('\r\n'),
    'utf8',
  )
}

function vevent(lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n')
}

function eml(headers: Record<string, string>, body: string): string {
  const h = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n')
  return `${h}\r\n\r\n${body}`
}

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8')
}

function nb(cells: unknown[], metadata: unknown = {}, nbformat = 4): Buffer {
  return buf(JSON.stringify({ cells, metadata, nbformat, nbformat_minor: 5 }))
}

/** Count occurrences of a substring. */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1
}

/** Positions of markers in output, for order assertions. */
function orderOf(html: string, markers: string[]): number[] {
  return markers.map((m) => html.indexOf(m))
}

// ================================================================== PPTX
// Spec F18 (format-additions-2): slides sorted numerically; first paragraph
// -> <h2>, rest -> <p>; images via ppt/slides/_rels/slideN.xml.rels.

describe('pptx reader (spec F18)', () => {
  it('sorts slides NUMERICALLY, not lexicographically (slide10 after slide2)', async () => {
    const bytes = await zipOf({
      'ppt/presentation.xml': '<p:presentation/>',
      'ppt/slides/slide1.xml': slideXml([[['ONE']]]),
      'ppt/slides/slide2.xml': slideXml([[['TWO']]]),
      'ppt/slides/slide10.xml': slideXml([[['TEN']]]),
      'ppt/slides/slide11.xml': slideXml([[['ELEVEN']]]),
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    const [one, two, ten, eleven] = orderOf(doc.html, ['ONE', 'TWO', 'TEN', 'ELEVEN'])
    expect(one).toBeGreaterThanOrEqual(0)
    expect(two).toBeGreaterThan(one)
    expect(ten).toBeGreaterThan(two)
    expect(eleven).toBeGreaterThan(ten)
  }, SLOW)

  it('emits exactly ONE <h2> per slide even when the slide has multiple shapes', async () => {
    // Real decks put the title in one shape and the bullets in another.
    // Spec: "the first paragraph becomes an <h2> (slide title), the rest <p>".
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([
        [['Slide Title']],
        [['Bullet one'], ['Bullet two']],
      ]),
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(count(doc.html, '<h2')).toBe(1)
    expect(doc.html).toContain('Slide Title')
    expect(doc.html).toContain('Bullet one')
    expect(doc.html).toContain('Bullet two')
  }, SLOW)

  it('joins multiple <a:r> runs inside one <a:p> WITHOUT inserting separators', async () => {
    // PowerPoint splits runs mid-word on spellcheck/format boundaries.
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([[['Hel', 'lo', ' World']]]),
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).toContain('Hello World')
  }, SLOW)

  it('escapes XML-decoded text so markup in <a:t> cannot inject tags', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([[['Title']], [['A &amp; B &lt;script&gt;alert(1)&lt;/script&gt;']]]),
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).not.toContain('<script>')
    expect(doc.html).toMatch(/A &amp; B/)
  }, SLOW)

  it('preserves non-ASCII text runs', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([[['Überschrift — 日本語 ✓']]]),
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).toContain('Überschrift — 日本語 ✓')
  }, SLOW)

  it('embeds slide images as data URIs resolved through slideN.xml.rels', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([[['Picture slide']]], picShape('rId2')),
      'ppt/slides/_rels/slide1.xml.rels': relsXml([{ id: 'rId2', target: '../media/image1.png' }]),
      'ppt/media/image1.png': PNG_1x1,
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).toContain('data:image/png;base64,')
  }, SLOW)

  it('handles a slide with an image and NO text at all', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([], picShape('rId2')),
      'ppt/slides/_rels/slide1.xml.rels': relsXml([{ id: 'rId2', target: '../media/image1.png' }]),
      'ppt/media/image1.png': PNG_1x1,
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).toContain('data:image/png;base64,')
  }, SLOW)

  it('survives a rels entry pointing at a media file that does not exist', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([[['Broken image slide']]], picShape('rId9')),
      'ppt/slides/_rels/slide1.xml.rels': relsXml([{ id: 'rId9', target: '../media/missing.png' }]),
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).toContain('Broken image slide')
    // No dangling img with an empty/undefined src.
    expect(doc.html).not.toContain('src=""')
    expect(doc.html).not.toContain('undefined')
  }, SLOW)

  it('does not crash on a completely empty slide', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([]),
      'ppt/slides/slide2.xml': slideXml([[['Second']]]),
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).toContain('Second')
  }, SLOW)

  /*
   * RULING: speaker notes are authored content and are KEPT, in a blockquote
   * after the slide's own text. The reader reaches them through the slide's
   * rels part, so a fixture with a notesSlide but no `<Relationship>` pointing
   * at it exercises nothing at all — the notes branch is dead code for it, and
   * "expect(html).not.toContain(note)" passes for a document in which the
   * reader was never asked the question.
   */
  const notesRels = (target: string): string =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="${target}"/>` +
    `</Relationships>`

  /** A notes part: the notes body lives in a `body` placeholder shape. */
  const notesSlideXml = (...paras: string[]): string =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes ${PPT_NS}><p:cSld><p:spTree>` +
    `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>` +
    paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('') +
    `</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`

  it('keeps speaker notes, attributed as notes, after the slide body', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([[['Visible title']]]),
      'ppt/slides/_rels/slide1.xml.rels': notesRels('../notesSlides/notesSlide1.xml'),
      'ppt/notesSlides/notesSlide1.xml': notesSlideXml('First note line', 'Second note line'),
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).toContain('First note line')
    expect(doc.html).toContain('Second note line')
    // Marked as notes, not passed off as slide text, and after the slide.
    expect(doc.html).toContain('<blockquote>')
    expect(doc.html).toMatch(/Notes:/)
    expect(doc.html.indexOf('Visible title')).toBeLessThan(doc.html.indexOf('First note line'))
  }, SLOW)

  it('a notesSlide no relationship points at is not read', async () => {
    // The part is in the package but nothing links it to slide 1; the reader
    // navigates by rels, so it must not go trawling the zip for notes.
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([[['Visible title']]]),
      'ppt/notesSlides/notesSlide1.xml': notesSlideXml('ORPHAN NOTE'),
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).toContain('Visible title')
    expect(doc.html).not.toContain('ORPHAN NOTE')
  }, SLOW)

  it('does not repeat the slide text that the notes part echoes in its slide-image placeholder', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': slideXml([[['Visible title']]]),
      'ppt/slides/_rels/slide1.xml.rels': notesRels('../notesSlides/notesSlide1.xml'),
      'ppt/notesSlides/notesSlide1.xml':
        `<?xml version="1.0"?><p:notes ${PPT_NS}><p:cSld><p:spTree>` +
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:txBody>` +
        `<a:p><a:r><a:t>Visible title</a:t></a:r></a:p></p:txBody></p:sp>` +
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>` +
        `<a:p><a:r><a:t>The real note</a:t></a:r></a:p></p:txBody></p:sp>` +
        `</p:spTree></p:cSld></p:notes>`,
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).toContain('The real note')
    expect(doc.html.split('Visible title')).toHaveLength(2) // said once, by the slide
  }, SLOW)

  it('SPEC-AMBIGUITY: does not treat empty <a:t/> runs as a slide title', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml':
        `<?xml version="1.0"?><p:sld ${PPT_NS}><p:cSld><p:spTree>` +
        `<p:sp><p:txBody><a:p><a:r><a:t></a:t></a:r></a:p><a:p><a:r><a:t>Real Title</a:t></a:r></a:p></p:txBody></p:sp>` +
        `</p:spTree></p:cSld></p:sld>`,
    })
    const doc = await readPptx({ bytes, filename: 'deck.pptx' })
    expect(doc.html).toMatch(/<h2[^>]*>\s*Real Title/)
  }, SLOW)
})

// ================================================================== EPUB
// Spec F20: META-INF/container.xml -> OPF -> manifest + SPINE ORDER;
// title from <dc:title>; chapters sanitized.

function opf(opts: {
  title?: string
  manifest: { id: string; href: string; type: string }[]
  spine: string[]
}): string {
  const t = opts.title === undefined ? '' : `<dc:title>${opts.title}</dc:title>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${t}</metadata>
  <manifest>${opts.manifest
    .map((m) => `<item id="${m.id}" href="${m.href}" media-type="${m.type}"/>`)
    .join('')}</manifest>
  <spine>${opts.spine.map((i) => `<itemref idref="${i}"/>`).join('')}</spine>
</package>`
}

function container(opfPath: string): string {
  return `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
}

const XHTML = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`

describe('epub reader (spec F20)', () => {
  it('follows SPINE order, not manifest order', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container('OEBPS/content.opf'),
      'OEBPS/content.opf': opf({
        title: 'Ordered Book',
        manifest: [
          { id: 'c1', href: 'c1.xhtml', type: 'application/xhtml+xml' },
          { id: 'c2', href: 'c2.xhtml', type: 'application/xhtml+xml' },
          { id: 'c3', href: 'c3.xhtml', type: 'application/xhtml+xml' },
        ],
        spine: ['c3', 'c1', 'c2'],
      }),
      'OEBPS/c1.xhtml': XHTML('<p>CHAPTER-ALPHA</p>'),
      'OEBPS/c2.xhtml': XHTML('<p>CHAPTER-BETA</p>'),
      'OEBPS/c3.xhtml': XHTML('<p>CHAPTER-GAMMA</p>'),
    })
    const doc = await readEpub({ bytes, filename: 'book.epub' })
    const [g, a, b] = orderOf(doc.html, ['CHAPTER-GAMMA', 'CHAPTER-ALPHA', 'CHAPTER-BETA'])
    expect(g).toBeGreaterThanOrEqual(0)
    expect(a).toBeGreaterThan(g)
    expect(b).toBeGreaterThan(a)
  }, SLOW)

  it('resolves hrefs relative to a NESTED OPF path (OEBPS/sub/content.opf)', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container('OEBPS/sub/content.opf'),
      'OEBPS/sub/content.opf': opf({
        title: 'Nested',
        manifest: [{ id: 'c1', href: 'text/ch1.xhtml', type: 'application/xhtml+xml' }],
        spine: ['c1'],
      }),
      'OEBPS/sub/text/ch1.xhtml': XHTML('<p>NESTED-BODY</p>'),
    })
    const doc = await readEpub({ bytes, filename: 'book.epub' })
    expect(doc.html).toContain('NESTED-BODY')
  }, SLOW)

  it('resolves an href with a #fragment', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container('OEBPS/content.opf'),
      'OEBPS/content.opf': opf({
        title: 'Frag',
        manifest: [{ id: 'c1', href: 'c1.xhtml#start', type: 'application/xhtml+xml' }],
        spine: ['c1'],
      }),
      'OEBPS/c1.xhtml': XHTML('<p id="start">FRAGMENT-BODY</p>'),
    })
    const doc = await readEpub({ bytes, filename: 'book.epub' })
    expect(doc.html).toContain('FRAGMENT-BODY')
  }, SLOW)

  it('skips non-document manifest items (CSS, images) — no stylesheet text leaks', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container('OEBPS/content.opf'),
      'OEBPS/content.opf': opf({
        title: 'WithAssets',
        manifest: [
          { id: 'css', href: 'style.css', type: 'text/css' },
          { id: 'img', href: 'cover.png', type: 'image/png' },
          { id: 'c1', href: 'c1.xhtml', type: 'application/xhtml+xml' },
        ],
        spine: ['c1'],
      }),
      'OEBPS/style.css': 'body { color: STYLESHEET-LEAK; }',
      'OEBPS/cover.png': PNG_1x1,
      'OEBPS/c1.xhtml': XHTML('<p>Body text</p>'),
    })
    const doc = await readEpub({ bytes, filename: 'book.epub' })
    expect(doc.html).toContain('Body text')
    expect(doc.html).not.toContain('STYLESHEET-LEAK')
  }, SLOW)

  it('takes the title from <dc:title>', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container('content.opf'),
      'content.opf': opf({
        title: 'The Real Title',
        manifest: [{ id: 'c1', href: 'c1.xhtml', type: 'application/xhtml+xml' }],
        spine: ['c1'],
      }),
      'c1.xhtml': XHTML('<p>hi</p>'),
    })
    const doc = await readEpub({ bytes, filename: 'book.epub' })
    expect(doc.title).toBe('The Real Title')
  }, SLOW)

  it('survives a missing <dc:title> without throwing', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container('content.opf'),
      'content.opf': opf({
        manifest: [{ id: 'c1', href: 'c1.xhtml', type: 'application/xhtml+xml' }],
        spine: ['c1'],
      }),
      'c1.xhtml': XHTML('<p>untitled body</p>'),
    })
    const doc = await readEpub({ bytes, filename: 'book.epub' })
    expect(doc.html).toContain('untitled body')
  }, SLOW)

  it('sanitizes chapters through the shared allowlist (scripts and handlers gone)', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container('content.opf'),
      'content.opf': opf({
        title: 'Hostile',
        manifest: [{ id: 'c1', href: 'c1.xhtml', type: 'application/xhtml+xml' }],
        spine: ['c1'],
      }),
      'c1.xhtml': XHTML('<p onclick="steal()">Safe text</p><script>alert(1)</script>'),
    })
    const doc = await readEpub({ bytes, filename: 'book.epub' })
    expect(doc.html).toContain('Safe text')
    expect(doc.html).not.toContain('<script')
    expect(doc.html).not.toContain('onclick')
  }, SLOW)

  it('SPEC-AMBIGUITY: a spine idref with no matching manifest item is skipped, not fatal', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container('content.opf'),
      'content.opf': opf({
        title: 'Dangling',
        manifest: [{ id: 'c1', href: 'c1.xhtml', type: 'application/xhtml+xml' }],
        spine: ['ghost', 'c1'],
      }),
      'c1.xhtml': XHTML('<p>still here</p>'),
    })
    const doc = await readEpub({ bytes, filename: 'book.epub' })
    expect(doc.html).toContain('still here')
  }, SLOW)

  it('SPEC-AMBIGUITY: a manifest href that is missing from the zip degrades, not throws', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container('content.opf'),
      'content.opf': opf({
        title: 'Missing file',
        manifest: [
          { id: 'c1', href: 'gone.xhtml', type: 'application/xhtml+xml' },
          { id: 'c2', href: 'c2.xhtml', type: 'application/xhtml+xml' },
        ],
        spine: ['c1', 'c2'],
      }),
      'c2.xhtml': XHTML('<p>survivor</p>'),
    })
    const doc = await readEpub({ bytes, filename: 'book.epub' })
    expect(doc.html).toContain('survivor')
  }, SLOW)
})

// ================================================================== ODT
// No written spec clause (round-2 spec lists .odt as out of scope); the task
// contract states: text:h with outline-level -> h1..h6, paragraphs, lists.

describe('odt reader', () => {
  it('maps text:h outline-level 1..6 to h1..h6', async () => {
    const bytes = await odfZip('application/vnd.oasis.opendocument.text', {
      'content.xml': odtContent(
        [1, 2, 3, 4, 5, 6].map((n) => `<text:h text:outline-level="${n}">Level${n}</text:h>`).join(''),
      ),
    })
    const doc = await readOdt({ bytes, filename: 'a.odt' })
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(doc.html).toMatch(new RegExp(`<h${n}[^>]*>\\s*Level${n}`))
    }
  }, SLOW)

  it('SPEC-AMBIGUITY: clamps outline-level 7 to h6 rather than emitting <h7>', async () => {
    const bytes = await odfZip('application/vnd.oasis.opendocument.text', {
      'content.xml': odtContent('<text:h text:outline-level="7">Deep</text:h>'),
    })
    const doc = await readOdt({ bytes, filename: 'a.odt' })
    expect(doc.html).not.toContain('<h7')
    expect(doc.html).toContain('Deep')
  }, SLOW)

  it('SPEC-AMBIGUITY: a text:h with NO outline-level still becomes a heading (not a <p>)', async () => {
    const bytes = await odfZip('application/vnd.oasis.opendocument.text', {
      'content.xml': odtContent('<text:h>Bare Heading</text:h>'),
    })
    const doc = await readOdt({ bytes, filename: 'a.odt' })
    expect(doc.html).toMatch(/<h[1-6][^>]*>\s*Bare Heading/)
  }, SLOW)

  it('SPEC-AMBIGUITY: outline-level 0 does not produce <h0>', async () => {
    const bytes = await odfZip('application/vnd.oasis.opendocument.text', {
      'content.xml': odtContent('<text:h text:outline-level="0">Zero</text:h>'),
    })
    const doc = await readOdt({ bytes, filename: 'a.odt' })
    expect(doc.html).not.toContain('<h0')
    expect(doc.html).toContain('Zero')
  }, SLOW)

  it('flattens text:span and text:s inside a paragraph into readable text', async () => {
    const bytes = await odfZip('application/vnd.oasis.opendocument.text', {
      'content.xml': odtContent(
        '<text:p>Hello <text:span text:style-name="T1">bold</text:span> world</text:p>',
      ),
    })
    const doc = await readOdt({ bytes, filename: 'a.odt' })
    // `/Hello\s*bold\s*world/` here would be no test at all — "Helloboldworld"
    // matches it, and running the words together is precisely the failure this
    // exists to catch. Pin the text instead of a pattern the broken output
    // would also satisfy.
    expect(doc.html.replace(/<[^>]+>/g, '').trim()).toBe('Hello bold world')
  }, SLOW)

  it('supplies the separation itself when <text:s> is the only thing holding words apart', async () => {
    // ODF writes runs of spaces as <text:s/>, so the XML around a span can
    // carry no literal whitespace at all. Strip the tags naively and this
    // paragraph becomes "Helloboldworld".
    const bytes = await odfZip('application/vnd.oasis.opendocument.text', {
      'content.xml': odtContent(
        '<text:p>Hello<text:s/><text:span text:style-name="T1">bold</text:span><text:s/>world</text:p>',
      ),
    })
    const doc = await readOdt({ bytes, filename: 'a.odt' })
    expect(doc.html.replace(/<[^>]+>/g, '').trim()).toBe('Hello bold world')
  }, SLOW)

  it('renders list items (including nested lists) as list markup', async () => {
    const bytes = await odfZip('application/vnd.oasis.opendocument.text', {
      'content.xml': odtContent(
        '<text:list><text:list-item><text:p>Outer</text:p>' +
          '<text:list><text:list-item><text:p>Inner</text:p></text:list-item></text:list>' +
          '</text:list-item></text:list>',
      ),
    })
    const doc = await readOdt({ bytes, filename: 'a.odt' })
    expect(doc.html).toMatch(/<(ul|ol)/)
    expect(doc.html).toContain('Outer')
    expect(doc.html).toContain('Inner')
  }, SLOW)

  it('escapes XML entities so document text cannot become markup', async () => {
    const bytes = await odfZip('application/vnd.oasis.opendocument.text', {
      'content.xml': odtContent('<text:p>5 &lt; 6 &amp;&amp; 7 &gt; 6</text:p>'),
    })
    const doc = await readOdt({ bytes, filename: 'a.odt' })
    expect(doc.html).toContain('&lt;')
    expect(doc.html).toContain('&amp;')
  }, SLOW)
})

// ================================================================== ODP

describe('odp reader', () => {
  it('produces one section per draw:page with the first line as <h2>', async () => {
    const bytes = await odfZip('application/vnd.oasis.opendocument.presentation', {
      'content.xml': odpContent(
        drawPage('page1', ['First Slide', 'body a', 'body b']) + drawPage('page2', ['Second Slide', 'body c']),
      ),
    })
    const doc = await readOdp({ bytes, filename: 'a.odp' })
    expect(count(doc.html, '<h2')).toBe(2)
    expect(doc.html).toMatch(/<h2[^>]*>\s*First Slide/)
    expect(doc.html).toMatch(/<h2[^>]*>\s*Second Slide/)
    const [p1, p2] = orderOf(doc.html, ['First Slide', 'Second Slide'])
    expect(p2).toBeGreaterThan(p1)
  }, SLOW)

  it('handles a page with zero text without emitting an empty heading', async () => {
    const bytes = await odfZip('application/vnd.oasis.opendocument.presentation', {
      'content.xml': odpContent(
        '<draw:page draw:name="blank"></draw:page>' + drawPage('page2', ['Has Text']),
      ),
    })
    const doc = await readOdp({ bytes, filename: 'a.odp' })
    expect(doc.html).toContain('Has Text')
    expect(doc.html).not.toMatch(/<h2[^>]*>\s*<\/h2>/)
  }, SLOW)

  it('keeps every text:p of a page, not just the first two', async () => {
    const paras = ['Title', 'l1', 'l2', 'l3', 'l4', 'l5']
    const bytes = await odfZip('application/vnd.oasis.opendocument.presentation', {
      'content.xml': odpContent(drawPage('p', paras)),
    })
    const doc = await readOdp({ bytes, filename: 'a.odp' })
    for (const p of paras) expect(doc.html).toContain(p)
  }, SLOW)
})

// ================================================================== ICS

describe('ics reader', () => {
  it('sorts events BY START TIME regardless of file order', async () => {
    const bytes = ics([
      vevent(['UID:b', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261201T100000Z', 'SUMMARY:ZZ-LATE-EVENT']),
      vevent(['UID:a', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260101T100000Z', 'SUMMARY:AA-EARLY-EVENT']),
    ])
    const doc = await readIcs({ bytes, filename: 'cal.ics' })
    const [late, early] = orderOf(doc.html, ['ZZ-LATE-EVENT', 'AA-EARLY-EVENT'])
    expect(early).toBeGreaterThanOrEqual(0)
    expect(late).toBeGreaterThan(early)
  }, SLOW)

  it('throws ConversionError read-failed when the calendar has no VEVENT', async () => {
    const bytes = ics([])
    await expect(readIcs({ bytes, filename: 'empty.ics' })).rejects.toMatchObject({
      name: 'ConversionError',
      code: 'read-failed',
    })
  }, SLOW)

  it('renders location and organizer when present', async () => {
    const bytes = ics([
      vevent([
        'UID:1',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260301T090000Z',
        'SUMMARY:Standup',
        'LOCATION:Room 4B',
        'ORGANIZER;CN=Alice Smith:mailto:alice@example.com',
      ]),
    ])
    const doc = await readIcs({ bytes, filename: 'cal.ics' })
    expect(doc.html).toContain('Room 4B')
    expect(doc.html).toMatch(/Alice Smith|alice@example\.com/)
  }, SLOW)

  it('unescapes RFC-5545 DESCRIPTION escapes (\\n, \\, , \\;)', async () => {
    const bytes = ics([
      vevent([
        'UID:1',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260301T090000Z',
        'SUMMARY:Escapes',
        'DESCRIPTION:Line one\\nLine two\\, with comma\\; and semicolon',
      ]),
    ])
    const doc = await readIcs({ bytes, filename: 'cal.ics' })
    expect(doc.html).toContain('Line two, with comma')
    expect(doc.html).toContain('and semicolon')
    // The literal backslash escapes must not survive into the output.
    expect(doc.html).not.toContain('\\n')
    expect(doc.html).not.toContain('\\,')
  }, SLOW)

  it('handles an all-day event (DTSTART;VALUE=DATE)', async () => {
    const bytes = ics([
      vevent([
        'UID:1',
        'DTSTAMP:20260101T000000Z',
        'DTSTART;VALUE=DATE:20260704',
        'DTEND;VALUE=DATE:20260705',
        'SUMMARY:Independence Day',
      ]),
    ])
    const doc = await readIcs({ bytes, filename: 'cal.ics' })
    expect(doc.html).toContain('Independence Day')
    expect(doc.html).not.toMatch(/Invalid Date/i)
  }, SLOW)

  it('SPEC-AMBIGUITY: an event with NO DTSTART does not break sorting or the render', async () => {
    const bytes = ics([
      vevent(['UID:1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:UNDATED-EVENT']),
      vevent(['UID:2', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260301T090000Z', 'SUMMARY:DATED-EVENT']),
    ])
    const doc = await readIcs({ bytes, filename: 'cal.ics' })
    expect(doc.html).toContain('DATED-EVENT')
    expect(doc.html).toContain('UNDATED-EVENT')
    expect(doc.html).not.toMatch(/Invalid Date|NaN|undefined/)
  }, SLOW)

  it('SPEC-AMBIGUITY: an event with no SUMMARY still renders a section', async () => {
    const bytes = ics([
      vevent(['UID:1', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260301T090000Z', 'LOCATION:Nowhere']),
    ])
    const doc = await readIcs({ bytes, filename: 'cal.ics' })
    expect(doc.html).toContain('Nowhere')
    expect(doc.html).not.toContain('undefined')
  }, SLOW)

  it('escapes HTML metacharacters coming from calendar text', async () => {
    const bytes = ics([
      vevent([
        'UID:1',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260301T090000Z',
        'SUMMARY:Review <script>alert(1)</script> & sync',
      ]),
    ])
    const doc = await readIcs({ bytes, filename: 'cal.ics' })
    expect(doc.html).not.toContain('<script>')
    expect(doc.html).toContain('&amp;')
  }, SLOW)
})

// ================================================================== MBOX
// Spec F21: split on `From ` at column 0; unescape `>From `; each message
// through the eml reader; joined with <hr>; one unreadable message degrades
// to a placeholder rather than failing the archive.

const MSG_A = eml(
  { From: 'alice@example.com', To: 'bob@example.com', Subject: 'First message', Date: 'Mon, 1 Sep 2025 10:00:00 +0000' },
  'Body of the FIRST message.\r\n',
)
const MSG_B = eml(
  { From: 'carol@example.com', To: 'bob@example.com', Subject: 'Second message', Date: 'Tue, 2 Sep 2025 10:00:00 +0000' },
  'Body of the SECOND message.\r\n',
)

function mboxOf(messages: string[], sep = 'From MAILER-DAEMON Mon Sep  1 10:00:00 2025'): string {
  return messages.map((m) => `${sep}\n${m.replace(/\r\n/g, '\n')}\n`).join('')
}

describe('mbox reader (spec F21)', () => {
  it('splitMbox returns one entry per `From ` line at column 0', () => {
    const parts = splitMbox(mboxOf([MSG_A, MSG_B]))
    expect(parts.length).toBe(2)
    expect(parts[0]).toContain('First message')
    expect(parts[1]).toContain('Second message')
  })

  it('splitMbox does NOT split on a `>From ` quoted body line, and unescapes it', () => {
    const body = 'Quoting an old mail:\n>From nobody Sat Jan  1 00:00:00 2000\nend of body.\n'
    const msg = eml({ From: 'a@b.c', To: 'd@e.f', Subject: 'Quoted From' }, body)
    const parts = splitMbox(mboxOf([msg]))
    expect(parts.length).toBe(1)
    expect(parts[0]).toContain('\nFrom nobody Sat Jan  1 00:00:00 2000')
    expect(parts[0]).not.toContain('>From nobody')
  })

  it('splitMbox unescapes multi-level quoting (>>From -> >From)', () => {
    const body = 'deep quote:\n>>From nobody Sat Jan  1 00:00:00 2000\n'
    const msg = eml({ From: 'a@b.c', To: 'd@e.f', Subject: 'Deep quote' }, body)
    const parts = splitMbox(mboxOf([msg]))
    expect(parts.length).toBe(1)
    expect(parts[0]).toContain('>From nobody')
    expect(parts[0]).not.toContain('>>From nobody')
  })

  it('splitMbox returns nothing for empty input', () => {
    expect(splitMbox('')).toEqual([])
  })

  it('splitMbox handles a single message with no trailing newline', () => {
    const text = `From MAILER-DAEMON Mon Sep  1 10:00:00 2025\n${MSG_A.replace(/\r\n/g, '\n')}`
    const parts = splitMbox(text)
    expect(parts.length).toBe(1)
    expect(parts[0]).toContain('First message')
  })

  it('reads an archive into one document per message joined with <hr>', async () => {
    const doc = await readMbox({ bytes: buf(mboxOf([MSG_A, MSG_B])), filename: 'a.mbox' })
    expect(doc.html).toContain('First message')
    expect(doc.html).toContain('Second message')
    expect(count(doc.html, '<hr')).toBeGreaterThanOrEqual(1)
    const [a, b] = orderOf(doc.html, ['First message', 'Second message'])
    expect(b).toBeGreaterThan(a)
  }, SLOW)

  it('degrades ONE unreadable message to a placeholder without failing the archive', async () => {
    // A middle entry that is not a parseable message at all.
    const garbage = '\u0000\u0001\u0002 not a message at all ￾\n'
    const text = mboxOf([MSG_A, garbage, MSG_B])
    const doc = await readMbox({ bytes: buf(text), filename: 'a.mbox' })
    expect(doc.html).toContain('First message')
    expect(doc.html).toContain('Second message')
  }, SLOW)

  it('reports per-message progress via ctx.onProgress', async () => {
    const seen: string[] = []
    await readMbox(
      { bytes: buf(mboxOf([MSG_A, MSG_B])), filename: 'a.mbox' },
      { onProgress: (stage) => seen.push(stage) },
    )
    expect(seen.length).toBeGreaterThan(0)
  }, SLOW)

  it('SPEC-AMBIGUITY: an mbox with a single message still renders that message', async () => {
    const doc = await readMbox({ bytes: buf(mboxOf([MSG_A])), filename: 'a.mbox' })
    expect(doc.html).toContain('First message')
    expect(doc.html).toContain('FIRST message')
  }, SLOW)

  it('SPEC-AMBIGUITY: leading junk before the first `From ` line is not lost silently as a crash', async () => {
    const text = `garbage preamble line\n${mboxOf([MSG_A])}`
    const doc = await readMbox({ bytes: buf(text), filename: 'a.mbox' })
    expect(doc.html).toContain('First message')
  }, SLOW)
})

// ================================================================== IPYNB
// Spec F13.

describe('ipynb reader (spec F13)', () => {
  it('accepts `source` as an array of lines AND as a plain string', async () => {
    const arr = nb([{ cell_type: 'code', source: ['x = 1\n', 'y = 2\n'], outputs: [], metadata: {} }])
    const str = nb([{ cell_type: 'code', source: 'x = 1\ny = 2\n', outputs: [], metadata: {} }])
    const a = await readIpynb({ bytes: arr, filename: 'n.ipynb' })
    const b = await readIpynb({ bytes: str, filename: 'n.ipynb' })
    expect(a.html).toContain('x = 1')
    expect(a.html).toContain('y = 2')
    expect(b.html).toContain('x = 1')
    expect(b.html).toContain('y = 2')
  }, SLOW)

  it('uses metadata.language_info.name for the code fence language', async () => {
    const bytes = nb(
      [{ cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} }],
      { language_info: { name: 'python' }, kernelspec: { language: 'julia' } },
    )
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('language-python')
    expect(doc.html).not.toContain('language-julia')
  }, SLOW)

  it('falls back to kernelspec.language when language_info is absent', async () => {
    const bytes = nb([{ cell_type: 'code', source: 'puts 1', outputs: [], metadata: {} }], {
      kernelspec: { language: 'ruby' },
    })
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('language-ruby')
  }, SLOW)

  it('falls back to plaintext when neither language field exists', async () => {
    const bytes = nb([{ cell_type: 'code', source: 'nothing', outputs: [], metadata: {} }], {})
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('language-plaintext')
  }, SLOW)

  it('renders markdown cells through the markdown pipeline', async () => {
    const bytes = nb([{ cell_type: 'markdown', source: '# Heading\n\nSome *emphasis*.\n', metadata: {} }])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toMatch(/<h1[^>]*>\s*Heading/)
    expect(doc.html).toMatch(/<em>emphasis<\/em>/)
  }, SLOW)

  it('sanitizes raw HTML inside a markdown cell', async () => {
    const bytes = nb([
      { cell_type: 'markdown', source: 'Hello <script>alert(1)</script> <b onclick="x()">bold</b>\n', metadata: {} },
    ])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).not.toContain('<script')
    // The handler must not survive as live markup (escaped text is fine).
    expect(doc.html).not.toContain('<b onclick')
  }, SLOW)

  it('SPEC-AMBIGUITY: markdown cells must not typographically rewrite quotes inside inline code', async () => {
    // A notebook's prose routinely quotes code. markdown-it's `typographer`
    // turns "x" into curly quotes, which silently corrupts technical text.
    const bytes = nb([
      { cell_type: 'markdown', source: 'Call `f("a", "b")` and pass "literal" strings.\n', metadata: {} },
    ])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('f(&quot;a&quot;, &quot;b&quot;)')
    expect(doc.html).not.toContain('“')
    expect(doc.html).not.toContain('”')
  }, SLOW)

  it('HTML-escapes code cell source so it cannot inject markup', async () => {
    const bytes = nb([
      { cell_type: 'code', source: 'const s = "<script>alert(1)</script>"', outputs: [], metadata: {} },
    ])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).not.toContain('<script>')
    expect(doc.html).toContain('&lt;script&gt;')
  }, SLOW)

  it('renders stream outputs as <pre>', async () => {
    const bytes = nb([
      {
        cell_type: 'code',
        source: 'print("hi")',
        metadata: {},
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['hi\n', 'there\n'] }],
      },
    ])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('<pre')
    expect(doc.html).toContain('there')
  }, SLOW)

  it('renders execute_result text/plain output', async () => {
    const bytes = nb([
      {
        cell_type: 'code',
        source: '1+1',
        metadata: {},
        outputs: [{ output_type: 'execute_result', execution_count: 1, data: { 'text/plain': ['2'] }, metadata: {} }],
      },
    ])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('2')
  }, SLOW)

  it('embeds image/png outputs as a data-URI <img>', async () => {
    const b64 = PNG_1x1.toString('base64')
    const bytes = nb([
      {
        cell_type: 'code',
        source: 'plot()',
        metadata: {},
        outputs: [{ output_type: 'display_data', data: { 'image/png': b64 }, metadata: {} }],
      },
    ])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('data:image/png;base64,')
  }, SLOW)

  it('handles image/png given as an ARRAY of base64 lines (real nbformat writes wrapped lines)', async () => {
    const b64 = PNG_1x1.toString('base64')
    const lines = [b64.slice(0, 20) + '\n', b64.slice(20) + '\n']
    const bytes = nb([
      {
        cell_type: 'code',
        source: 'plot()',
        metadata: {},
        outputs: [{ output_type: 'display_data', data: { 'image/png': lines }, metadata: {} }],
      },
    ])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('data:image/png;base64,')
    expect(doc.html).not.toContain('\n' + b64.slice(20))
  }, SLOW)

  it('SPEC-AMBIGUITY: an output with both image/png and text/plain prefers the image', async () => {
    const b64 = PNG_1x1.toString('base64')
    const bytes = nb([
      {
        cell_type: 'code',
        source: 'fig',
        metadata: {},
        outputs: [
          {
            output_type: 'display_data',
            data: { 'text/plain': ['<Figure size 640x480 with 1 Axes>'], 'image/png': b64 },
            metadata: {},
          },
        ],
      },
    ])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('data:image/png;base64,')
  }, SLOW)

  it('strips ANSI escape codes from error tracebacks', async () => {
    const bytes = nb([
      {
        cell_type: 'code',
        source: '1/0',
        metadata: {},
        outputs: [
          {
            output_type: 'error',
            ename: 'ZeroDivisionError',
            evalue: 'division by zero',
            traceback: [
              '\u001b[0;31m---------------------------------------------------------------------------\u001b[0m',
              '\u001b[0;31mZeroDivisionError\u001b[0m                         Traceback (most recent call last)',
              '\u001b[0;32m----> 1\u001b[0m \u001b[38;5;241m1\u001b[39m\u001b[38;5;241m/\u001b[39m\u001b[38;5;241m0\u001b[39m',
            ],
          },
        ],
      },
    ])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('ZeroDivisionError')
    expect(doc.html).not.toContain('\u001b[')
    expect(doc.html).not.toContain('[0;31m')
    expect(doc.html).not.toContain('[38;5;241m')
  }, SLOW)

  it('handles a code cell with NO outputs key at all', async () => {
    const bytes = nb([{ cell_type: 'code', source: 'x = 1', metadata: {} }])
    const doc = await readIpynb({ bytes, filename: 'n.ipynb' })
    expect(doc.html).toContain('x = 1')
  }, SLOW)

  it('SPEC-AMBIGUITY: nbformat 3 notebooks (worksheets + `input`) do not throw', async () => {
    const v3 = buf(
      JSON.stringify({
        nbformat: 3,
        nbformat_minor: 0,
        metadata: {},
        worksheets: [
          {
            cells: [
              { cell_type: 'code', input: ['x = 1\n'], language: 'python', outputs: [] },
              { cell_type: 'markdown', source: ['# Old Notebook\n'] },
            ],
          },
        ],
      }),
    )
    await expect(readIpynb({ bytes: v3, filename: 'old.ipynb' })).resolves.toBeTruthy()
  }, SLOW)

  it('uses the filename as the title', async () => {
    const bytes = nb([{ cell_type: 'code', source: 'x', outputs: [], metadata: {} }])
    const doc = await readIpynb({ bytes, filename: 'analysis.ipynb' })
    expect(doc.title).toBeTruthy()
    expect(String(doc.title)).toContain('analysis')
  }, SLOW)

  it('rejects non-notebook JSON with a read-failed error instead of an empty document', async () => {
    // RULING: this was written as "resolves or rejects, either is fine", with
    // a branch apiece — which is not a test: whichever branch runs, its
    // assertion holds, and the branch that does not run costs nothing. The
    // shipped behaviour is a refusal, and the refusal is what is pinned.
    const bytes = buf(JSON.stringify({ hello: 'world' }))
    await expect(readIpynb({ bytes, filename: 'x.ipynb' })).rejects.toMatchObject({
      code: 'read-failed',
    })
    await expect(readIpynb({ bytes, filename: 'x.ipynb' })).rejects.toThrow(/notebook/i)
  }, SLOW)

  it('rejects a file that is not JSON at all', async () => {
    await expect(readIpynb({ bytes: buf('not json {{{'), filename: 'x.ipynb' })).rejects.toBeInstanceOf(Error)
  }, SLOW)
})

// ================================================================== CSV
// Spec F6.

describe('csv reader (spec F6)', () => {
  it('auto-detects a semicolon delimiter', async () => {
    const doc = await readCsv({ bytes: buf('name;city;age\nAlice;Berlin;30\nBob;Paris;41\n'), filename: 'a.csv' })
    expect(doc.html).toContain('Berlin')
    expect(count(doc.html, '<td')).toBeGreaterThanOrEqual(6)
    expect(doc.html).not.toContain('Alice;Berlin')
  }, SLOW)

  it('auto-detects a tab delimiter', async () => {
    const doc = await readCsv({ bytes: buf('name\tcity\nAlice\tBerlin\nBob\tParis\n'), filename: 'a.tsv' })
    expect(doc.html).toContain('Berlin')
    expect(doc.html).not.toContain('Alice\tBerlin')
  }, SLOW)

  it('promotes the first row to <thead> when text header sits over a numeric body', async () => {
    const doc = await readCsv({ bytes: buf('alpha,beta,gamma\n1,2,3\n4,5,6\n7,8,9\n'), filename: 'a.csv' })
    expect(doc.html).toContain('<thead')
    expect(doc.html).toContain('<th')
  }, SLOW)

  it('does NOT promote a numeric first row over a text body (inverse heuristic)', async () => {
    const doc = await readCsv({ bytes: buf('1,2,3\nalpha,beta,gamma\ndelta,epsilon,zeta\n'), filename: 'a.csv' })
    expect(doc.html).not.toContain('<thead')
    expect(doc.html).not.toContain('<th>')
  }, SLOW)

  it('keeps quoted fields containing the delimiter intact', async () => {
    const doc = await readCsv({
      bytes: buf('name,note\nAlice,"Berlin, Germany"\nBob,"Paris, France"\n'),
      filename: 'a.csv',
    })
    expect(doc.html).toContain('Berlin, Germany')
    // 3 rows x 2 columns; the quoted comma must NOT create a third column.
    expect(count(doc.html, '<tr')).toBe(3)
    expect(count(doc.html, '<td')).toBe(6)
    expect(doc.html).not.toContain('&quot;Berlin')
  }, SLOW)

  it('keeps embedded newlines inside quoted fields in one cell', async () => {
    const doc = await readCsv({ bytes: buf('a,b\n"line1\nline2",second\n'), filename: 'a.csv' })
    expect(count(doc.html, '<tr')).toBe(2)
  }, SLOW)

  it('handles a single-row csv without inventing a header/body split', async () => {
    const doc = await readCsv({ bytes: buf('only,one,row\n'), filename: 'a.csv' })
    expect(doc.html).toContain('only')
    expect(doc.html).toContain('row')
    expect(count(doc.html, '<tr')).toBe(1)
  }, SLOW)

  it('handles ragged rows (fewer/more fields) without dropping data', async () => {
    const doc = await readCsv({ bytes: buf('a,b,c\n1,2\n3,4,5,6\n'), filename: 'a.csv' })
    for (const v of ['1', '2', '3', '4', '5', '6']) expect(doc.html).toContain(v)
  }, SLOW)

  it('HTML-escapes cell contents', async () => {
    const doc = await readCsv({ bytes: buf('a,b\n"<script>alert(1)</script>","x & y"\n'), filename: 'a.csv' })
    expect(doc.html).not.toContain('<script>')
    expect(doc.html).toContain('&amp;')
  }, SLOW)

  it('strips a UTF-8 BOM from the first header cell', async () => {
    const doc = await readCsv({ bytes: buf('\ufeffname,city\nAlice,Berlin\n'), filename: 'a.csv' })
    expect(doc.html).not.toContain('\ufeff')
  }, SLOW)

  it('throws table-too-large past the cell budget', async () => {
    // Budget raised to 500k per table/sheet after a routine 2 MB business
    // workbook (~317k cells) was rejected outright by the old 50k cap.
    const cols = 10
    const rows = 50_100 // 501,000 cells
    const lines = [Array.from({ length: cols }, (_, i) => `col${i}`).join(',')]
    for (let r = 0; r < rows - 1; r++) lines.push(Array.from({ length: cols }, () => String(r)).join(','))
    await expect(readCsv({ bytes: buf(lines.join('\n')), filename: 'big.csv' })).rejects.toMatchObject({
      name: 'ConversionError',
      code: 'table-too-large',
    })
  }, SLOW)

  it('does NOT throw table-too-large just under the limit', async () => {
    const cols = 10
    const rows = 4000 // 40,000 cells
    const lines = [Array.from({ length: cols }, (_, i) => `col${i}`).join(',')]
    for (let r = 0; r < rows - 1; r++) lines.push(Array.from({ length: cols }, () => String(r)).join(','))
    await expect(readCsv({ bytes: buf(lines.join('\n')), filename: 'ok.csv' })).resolves.toBeTruthy()
  }, SLOW)

  it('SPEC-AMBIGUITY: CRLF line endings do not leak stray \\r into cells', async () => {
    const doc = await readCsv({ bytes: buf('name,city\r\nAlice,Berlin\r\nBob,Paris\r\n'), filename: 'a.csv' })
    expect(doc.html).not.toContain('\r')
  }, SLOW)
})

// ================================================================== CODE
// Spec F7.

describe('code reader (spec F7)', () => {
  it('maps the extension to a language class and sets HubDocument.language', async () => {
    const doc = await readCode({ bytes: buf('def f():\n    return 1\n'), filename: 'thing.py' })
    expect(doc.html).toContain('language-python')
    expect(doc.language).toBe('python')
  }, SLOW)

  it('wraps the file in a single <pre><code> block with the filename as title and an <h1>', async () => {
    const doc = await readCode({ bytes: buf('console.log(1)\n'), filename: 'main.ts' })
    expect(doc.title).toBe('main.ts')
    expect(doc.html).toMatch(/<h1[^>]*>/)
    expect(count(doc.html, '<pre')).toBe(1)
  }, SLOW)

  it('preserves TABS verbatim (no tab-to-space conversion)', async () => {
    const src = 'function f() {\n\tif (x) {\n\t\treturn 1\n\t}\n}\n'
    const doc = await readCode({ bytes: buf(src), filename: 'f.js' })
    expect(doc.html).toContain('\t\treturn 1')
  }, SLOW)

  it('strips a UTF-8 BOM', async () => {
    const doc = await readCode({ bytes: buf('\ufeffusing System;\n'), filename: 'P.cs' })
    expect(doc.html).not.toContain('\ufeff')
    expect(doc.html).toContain('using System;')
  }, SLOW)

  it('HTML-escapes the source', async () => {
    const doc = await readCode({ bytes: buf('if (a < b && c > d) { }\n'), filename: 'x.c' })
    expect(doc.html).toContain('&lt;')
    expect(doc.html).toContain('&amp;&amp;')
    expect(doc.html).not.toContain('a < b')
  }, SLOW)

  it('recognizes extensionless Makefile by filename', async () => {
    const doc = await readCode({ bytes: buf('all:\n\techo hi\n'), filename: 'Makefile' })
    expect(doc.html).toMatch(/language-makefile/i)
  }, SLOW)

  it('recognizes extensionless Dockerfile by filename', async () => {
    const doc = await readCode({ bytes: buf('FROM node:20\nRUN npm ci\n'), filename: 'Dockerfile' })
    expect(doc.html).toMatch(/language-dockerfile/i)
  }, SLOW)

  it('SPEC-AMBIGUITY: normalizes CRLF so no literal \\r survives in the code block', async () => {
    const doc = await readCode({ bytes: buf('line one\r\nline two\r\n'), filename: 'x.py' })
    expect(doc.html).not.toContain('\r')
  }, SLOW)

  it('SPEC-AMBIGUITY: a very long single line is not truncated', async () => {
    const long = 'x'.repeat(20000)
    const doc = await readCode({ bytes: buf(`const s = "${long}"\n`), filename: 'x.js' })
    expect(doc.html).toContain(long)
  }, SLOW)

  it('SPEC-AMBIGUITY: an unknown extension still produces a code block (plaintext) rather than throwing', async () => {
    const doc = await readCode({ bytes: buf('some content\n'), filename: 'notes.qqq' })
    expect(doc.html).toContain('<pre')
    expect(doc.html).toContain('some content')
  }, SLOW)

  it('does not double-escape an ampersand entity already in the source', async () => {
    const doc = await readCode({ bytes: buf('const s = "&amp;"\n'), filename: 'x.js' })
    // The literal source text is `&amp;`, so escaped output must be `&amp;amp;`.
    expect(doc.html).toContain('&amp;amp;')
  }, SLOW)
})

// ================================================================== IMAGE
// Spec F12.

describe('image reader (spec F12)', () => {
  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16)])
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('\0\x10JFIF\0', 'binary')])
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x20, 0, 0, 0]),
    Buffer.from('WEBPVP8 ', 'ascii'),
    Buffer.alloc(16),
  ])
  const bmp = Buffer.concat([Buffer.from('BM', 'ascii'), Buffer.alloc(30)])
  const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(30)])

  it('identifies PNG / JPEG / GIF / WebP by magic bytes', () => {
    expect(imageMime(PNG_1x1)).toBe('image/png')
    expect(imageMime(jpeg)).toBe('image/jpeg')
    expect(imageMime(gif)).toBe('image/gif')
    expect(imageMime(webp)).toBe('image/webp')
  })

  it('returns null for BMP and TIFF (not on the accepted list)', () => {
    expect(imageMime(bmp)).toBeNull()
    expect(imageMime(tiff)).toBeNull()
  })

  it('returns null for an empty buffer without throwing', () => {
    expect(imageMime(Buffer.alloc(0))).toBeNull()
  })

  it('does not mistake a bare RIFF container (e.g. WAV) for WebP', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x20, 0, 0, 0]),
      Buffer.from('WAVEfmt ', 'ascii'),
      Buffer.alloc(16),
    ])
    expect(imageMime(wav)).toBeNull()
  })

  it('embeds a PNG as a data URI <img>', async () => {
    const doc = await readImage({ bytes: PNG_1x1, filename: 'shot.png' })
    expect(doc.html).toContain('data:image/png;base64,')
    expect(doc.html).toContain('<img')
  }, SLOW)

  it('throws image-unsupported for a BMP', async () => {
    await expect(readImage({ bytes: bmp, filename: 'x.bmp' })).rejects.toMatchObject({
      name: 'ConversionError',
      code: 'image-unsupported',
    })
  }, SLOW)

  it('throws image-unsupported for a TIFF', async () => {
    await expect(readImage({ bytes: tiff, filename: 'x.tif' })).rejects.toMatchObject({
      name: 'ConversionError',
      code: 'image-unsupported',
    })
  }, SLOW)

  it('trusts magic bytes over the filename extension', async () => {
    // A PNG named .jpg must still be reported as image/png.
    const doc = await readImage({ bytes: PNG_1x1, filename: 'mislabeled.jpg' })
    expect(doc.html).toContain('data:image/png;base64,')
  }, SLOW)

  it('SPEC-AMBIGUITY: a truncated PNG (valid magic, garbage body) still embeds rather than throwing', async () => {
    const truncated = Buffer.concat([PNG_1x1.subarray(0, 16), Buffer.from('GARBAGE')])
    const doc = await readImage({ bytes: truncated, filename: 'broken.png' })
    expect(doc.html).toContain('data:image/png;base64,')
  }, SLOW)

  it('SPEC-AMBIGUITY: gives the <img> an alt attribute so txt/md targets are not blank', async () => {
    const doc = await readImage({ bytes: PNG_1x1, filename: 'screenshot.png' })
    expect(doc.html).toMatch(/alt=/)
  }, SLOW)
})

// ================================================================== EML
// Spec F5.

describe('eml reader (spec F5)', () => {
  it('renders a header block table and takes the subject as the title', async () => {
    const bytes = buf(
      eml(
        {
          From: 'Alice <alice@example.com>',
          To: 'Bob <bob@example.com>',
          Subject: 'Quarterly report',
          Date: 'Mon, 1 Sep 2025 10:00:00 +0000',
        },
        'Hello Bob,\r\n\r\nSee attached.\r\n',
      ),
    )
    const doc = await readEml({ bytes, filename: 'm.eml' })
    expect(doc.title).toBe('Quarterly report')
    expect(doc.html).toContain('<table')
    expect(doc.html).toMatch(/alice@example\.com/)
    expect(doc.html).toMatch(/bob@example\.com/)
  }, SLOW)

  it('paragraph-ifies a plain-text body (blank lines become separate <p>)', async () => {
    const bytes = buf(
      eml({ From: 'a@b.c', To: 'd@e.f', Subject: 'Plain' }, 'First paragraph.\r\n\r\nSecond paragraph.\r\n'),
    )
    const doc = await readEml({ bytes, filename: 'm.eml' })
    expect(doc.html).toContain('First paragraph.')
    expect(doc.html).toContain('Second paragraph.')
    expect(count(doc.html, '<p')).toBeGreaterThanOrEqual(2)
  }, SLOW)

  it('sanitizes an HTML body', async () => {
    const bytes = buf(
      [
        'From: a@b.c',
        'To: d@e.f',
        'Subject: Rich',
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><body><p onclick="x()">Rich body</p><script>alert(1)</script></body></html>',
        '',
      ].join('\r\n'),
    )
    const doc = await readEml({ bytes, filename: 'm.eml' })
    expect(doc.html).toContain('Rich body')
    expect(doc.html).not.toContain('<script')
    expect(doc.html).not.toContain('onclick')
  }, SLOW)

  it('lists attachments as a name+size table without converting them', async () => {
    const b = 'BOUNDARY42'
    const bytes = buf(
      [
        'From: a@b.c',
        'To: d@e.f',
        'Subject: With attachment',
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${b}"`,
        '',
        `--${b}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Body text here.',
        '',
        `--${b}`,
        'Content-Type: application/pdf; name="report.pdf"',
        'Content-Disposition: attachment; filename="report.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-1.4 fake').toString('base64'),
        '',
        `--${b}--`,
        '',
      ].join('\r\n'),
    )
    const doc = await readEml({ bytes, filename: 'm.eml' })
    expect(doc.html).toContain('Body text here.')
    expect(doc.html).toContain('report.pdf')
  }, SLOW)

  it('resolves cid: inline images to data URIs', async () => {
    const b = 'BOUND99'
    const bytes = buf(
      [
        'From: a@b.c',
        'To: d@e.f',
        'Subject: Inline image',
        'MIME-Version: 1.0',
        `Content-Type: multipart/related; boundary="${b}"`,
        '',
        `--${b}`,
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><body><p>See picture:</p><img src="cid:pic1@example.com"></body></html>',
        '',
        `--${b}`,
        'Content-Type: image/png',
        'Content-ID: <pic1@example.com>',
        'Content-Transfer-Encoding: base64',
        '',
        PNG_1x1.toString('base64'),
        '',
        `--${b}--`,
        '',
      ].join('\r\n'),
    )
    const doc = await readEml({ bytes, filename: 'm.eml' })
    expect(doc.html).toContain('data:image/png;base64,')
    expect(doc.html).not.toContain('cid:pic1')
  }, SLOW)

  it('SPEC-AMBIGUITY: decodes RFC-2047 encoded-word subjects', async () => {
    const bytes = buf(
      eml({ From: 'a@b.c', To: 'd@e.f', Subject: '=?utf-8?B?w5xiZXJzaWNodA==?=' }, 'body\r\n'),
    )
    const doc = await readEml({ bytes, filename: 'm.eml' })
    expect(doc.title).toBe('Übersicht')
  }, SLOW)

  it('SPEC-AMBIGUITY: escapes a subject containing HTML metacharacters', async () => {
    const bytes = buf(
      eml({ From: 'a@b.c', To: 'd@e.f', Subject: 'Fix <script>alert(1)</script> now' }, 'body\r\n'),
    )
    const doc = await readEml({ bytes, filename: 'm.eml' })
    expect(doc.html).not.toContain('<script>')
  }, SLOW)
})

// ================================================================== DOC
// Spec F19: text and paragraph breaks only.

describe('doc reader body shaping (spec F19)', () => {
  it('turns blank-line separated text into separate paragraphs', () => {
    const doc = docBodyToHub('First para.\n\nSecond para.\n\nThird para.', 'legacy.doc')
    expect(count(doc.html, '<p')).toBeGreaterThanOrEqual(3)
    expect(doc.html).toContain('First para.')
    expect(doc.html).toContain('Third para.')
  })

  it('uses the filename as the title', () => {
    const doc = docBodyToHub('Body', 'Report Q3.doc')
    expect(doc.title).toBe('Report Q3.doc')
  })

  it('HTML-escapes body text', () => {
    const doc = docBodyToHub('a < b & c > d <script>x</script>', 'x.doc')
    expect(doc.html).not.toContain('<script>')
    expect(doc.html).toContain('&amp;')
    expect(doc.html).toContain('&lt;')
  })

  it('SINGLE-newline paragraph marks (what word-extractor really emits) become separate paragraphs', () => {
    // Verified in node_modules/word-extractor/lib/filters.js: the Word
    // paragraph mark 0x0D is replaced with ONE "\n" (replaceTable[0x000D]).
    // Real .doc bodies are therefore \n-separated, not blank-line separated.
    // Spec F19 promises "text and paragraph breaks only" — the paragraph
    // breaks are the entire contract of this reader.
    const doc = docBodyToHub('Para one\nPara two\nPara three', 'old.doc')
    expect(count(doc.html, '<p')).toBeGreaterThanOrEqual(3)
  })

  it('SPEC-AMBIGUITY: a CR-only separated body is not emitted with raw \\r in the HTML', () => {
    const doc = docBodyToHub('Para one\rPara two', 'old.doc')
    expect(doc.html).not.toContain('\r')
  })

  it('reports an empty body rather than writing an empty document', () => {
    // RULING: a picture-only .doc extracts to nothing (Word 97-2003 keeps
    // images outside the text stream). Producing a 0-byte file with exit 0
    // hid the loss in batches, so this now fails loudly and says why.
    expect(() => docBodyToHub('', 'empty.doc')).toThrowError(/no extractable text/i)
  })

  it('end-to-end via the injectable extractor: \\n-separated paragraphs survive as <p> elements', async () => {
    // Closes the loop on the previous test: readDoc does not pre-normalize
    // the extractor's output either.
    const extractor = async () => 'Para one\nPara two\nPara three'
    const doc = await readDoc({ bytes: Buffer.from('\xd0\xcf\x11\xe0', 'binary'), filename: 'x.doc' }, undefined, extractor)
    expect(count(doc.html, '<p')).toBeGreaterThanOrEqual(3)
  })

  it('SPEC-AMBIGUITY: strips NUL and control junk that word-extractor leaves in', () => {
    const doc = docBodyToHub('Clean text\u0000\u0007 more text', 'junk.doc')
    expect(doc.html).not.toContain('\u0000')
    expect(doc.html).not.toContain('\u0007')
  })
})

// ================================================================== RST / ASCIIDOC
// No spec of record for these formats — pure SPEC-AMBIGUITY probes.

describe('rst reader (no spec of record)', () => {
  it('SPEC-AMBIGUITY: renders an overlined/underlined section title as a heading', async () => {
    const src = 'Document Title\n==============\n\nSome body text.\n\nSubsection\n----------\n\nMore text.\n'
    const doc = await readRst({ bytes: buf(src), filename: 'a.rst' })
    expect(doc.html).toMatch(/<h[1-3][^>]*>\s*Document Title/)
    expect(doc.html).toContain('Some body text.')
  }, SLOW)

  it('SPEC-AMBIGUITY: renders a literal block as <pre>', async () => {
    const src = 'Intro::\n\n    code line one\n    code line two\n\nAfter.\n'
    const doc = await readRst({ bytes: buf(src), filename: 'a.rst' })
    expect(doc.html).toContain('code line one')
  }, SLOW)

  it('SPEC-AMBIGUITY: does not emit raw HTML from rst source text', async () => {
    const doc = await readRst({ bytes: buf('Title\n=====\n\nText with <script>alert(1)</script>.\n'), filename: 'a.rst' })
    expect(doc.html).not.toContain('<script>')
  }, SLOW)
})

describe('asciidoc reader (no spec of record)', () => {
  it('SPEC-AMBIGUITY: maps = / == levels to h1 / h2 and sets the title', async () => {
    const src = '= The Document Title\n\nIntro paragraph.\n\n== First Section\n\nSection body.\n'
    const doc = await readAsciidoc({ bytes: buf(src), filename: 'a.adoc' })
    expect(doc.html).toContain('First Section')
    expect(doc.html).toContain('Section body.')
    expect(String(doc.title ?? '')).toContain('The Document Title')
  }, SLOW)

  it('SPEC-AMBIGUITY: renders a source block as <pre><code>', async () => {
    const src = '= T\n\n[source,python]\n----\nprint("hi")\n----\n'
    const doc = await readAsciidoc({ bytes: buf(src), filename: 'a.adoc' })
    expect(doc.html).toMatch(/<pre/)
    expect(doc.html).toContain('print(')
    expect(doc.html).toContain('language-python')
  }, SLOW)

  it('SPEC-AMBIGUITY: passthrough blocks cannot smuggle a <script> into the hub', async () => {
    const src = '= T\n\n++++\n<script>alert(1)</script>\n++++\n'
    const doc = await readAsciidoc({ bytes: buf(src), filename: 'a.adoc' })
    expect(doc.html).not.toContain('<script>')
  }, SLOW)

  it('SPEC-AMBIGUITY: renders an asciidoc table as a <table>', async () => {
    const src = '= T\n\n|===\n| A | B\n| 1 | 2\n|===\n'
    const doc = await readAsciidoc({ bytes: buf(src), filename: 'a.adoc' })
    expect(doc.html).toContain('<table')
  }, SLOW)
})

// ================================================================== SANITIZER
// Spec F1 (io-expansion): shared allowlist; data: on img; colspan/rowspan;
// scripts and handlers removed; Office cruft stripped.

describe('sanitizeToHub (spec F1 allowlist)', () => {
  it('allows data: URIs on <img>', () => {
    const out = sanitizeToHub(`<p>x</p><img src="data:image/png;base64,${PNG_1x1.toString('base64')}">`)
    expect(out).toContain('data:image/png;base64,')
  })

  it('keeps colspan and rowspan on table cells', () => {
    const out = sanitizeToHub(
      '<table><tbody><tr><td colspan="2" rowspan="3">merged</td><th colspan="4">head</th></tr></tbody></table>',
    )
    expect(out).toContain('colspan="2"')
    expect(out).toContain('rowspan="3"')
    expect(out).toContain('colspan="4"')
  })

  it('removes <script> entirely, including its text content', () => {
    const out = sanitizeToHub('<p>keep</p><script>alert("PWNED")</script>')
    expect(out).toContain('keep')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('PWNED')
  })

  it('removes inline event handlers', () => {
    const out = sanitizeToHub('<p onclick="steal()" onmouseover="x()">text</p>')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('onmouseover')
  })

  it('strips Office <o:p> cruft and mso- styles', () => {
    const out = sanitizeToHub(
      '<!--StartFragment--><p style="mso-margin-top-alt:auto;color:red">Word text<o:p></o:p></p><!--EndFragment-->',
    )
    expect(out).toContain('Word text')
    expect(out).not.toContain('o:p')
    expect(out).not.toContain('mso-')
    expect(out).not.toContain('StartFragment')
  })

  it('drops javascript: hrefs', () => {
    const out = sanitizeToHub('<a href="javascript:alert(1)">click</a>')
    expect(out).toContain('click')
    expect(out).not.toContain('javascript:')
  })

  it('drops data:text/html on an <a>', () => {
    const out = sanitizeToHub('<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>')
    expect(out).not.toContain('data:text/html')
  })

  it('SPEC-AMBIGUITY: drops <img srcset> (the CSP only restricts src)', () => {
    const out = sanitizeToHub('<img src="data:image/png;base64,iVBORw0KGgo=" srcset="https://evil.example/track.png 1x">')
    expect(out).not.toContain('srcset')
    expect(out).not.toContain('evil.example')
  })

  it('removes <svg> and any <script> nested inside it', () => {
    const out = sanitizeToHub('<p>before</p><svg><script>alert(1)</script></svg><p>after</p>')
    expect(out).toContain('before')
    expect(out).toContain('after')
    expect(out).not.toContain('<svg')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
  })

  it('SPEC-AMBIGUITY: neutralizes CSS expression() in a style attribute', () => {
    const out = sanitizeToHub('<p style="width:expression(alert(1))">text</p>')
    expect(out).not.toContain('expression(')
  })

  it('removes <iframe>, <object>, <embed>, <form> and <input>', () => {
    const out = sanitizeToHub(
      '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="y">' +
        '<form action="https://evil.example"><input name="pw"></form><p>ok</p>',
    )
    expect(out).toContain('ok')
    for (const tag of ['iframe', 'object', 'embed', 'form', 'input']) {
      expect(out).not.toContain(`<${tag}`)
    }
  })

  it('removes <style> blocks and <link rel=stylesheet>', () => {
    const out = sanitizeToHub('<style>body{background:url(https://evil.example/x)}</style><link rel="stylesheet" href="https://evil.example/x.css"><p>ok</p>')
    expect(out).toContain('ok')
    expect(out).not.toContain('evil.example')
  })

  it('keeps every tag it declares in HUB_TAGS (allowlist is honest)', () => {
    // A tag advertised in HUB_TAGS but silently dropped is a broken invariant.
    const voidish = new Set(['img', 'hr', 'br'])
    const missing: string[] = []
    for (const tag of HUB_TAGS) {
      const html = voidish.has(tag)
        ? tag === 'img'
          ? '<img src="data:image/png;base64,iVBORw0KGgo=">'
          : `<${tag}>`
        : `<${tag}>content</${tag}>`
      const wrapped = tag === 'li' ? `<ul>${html}</ul>` : tag === 'tr' || tag === 'td' || tag === 'th' || tag === 'thead' || tag === 'tbody' ? `<table>${html}</table>` : html
      const out = sanitizeToHub(wrapped)
      if (!out.includes(`<${tag}`)) missing.push(tag)
    }
    expect(missing).toEqual([])
  })

  it('does not mangle nested lists', () => {
    const out = sanitizeToHub('<ul><li>a<ul><li>b</li></ul></li></ul>')
    expect(count(out, '<ul')).toBe(2)
    expect(count(out, '<li')).toBe(2)
  })

  it('leaves plain text with entities intact', () => {
    const out = sanitizeToHub('<p>Tom &amp; Jerry &lt;3</p>')
    expect(out).toContain('&amp;')
    expect(out).toContain('&lt;3')
  })
})
