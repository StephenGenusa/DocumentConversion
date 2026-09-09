#!/usr/bin/env node
/**
 * Builds a small synthetic EPUB for `tests/core/epub-links.test.ts`'s "real
 * corpus book" case, replacing a real copyrighted book. It reproduces the one
 * property under test: chapters that cross-reference each other by relative
 * href, which the hub has to drop (the target file will not exist once the
 * spine is flattened into one document) while external http/mailto links
 * survive.
 *
 *   node scripts/fixtures/build-epub-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import * as V from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus/inference-notes.epub')

const zip = new JSZip()
zip.file('mimetype', 'application/epub+zip')
zip.file(
  'META-INF/container.xml',
  '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
)
zip.file(
  'OPS/book.opf',
  `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${V.EPUB.title}</dc:title>
    <dc:identifier id="bookid">urn:uuid:example-0000-0000-0000-000000000000</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`,
)

/** A 2x2 PNG — the smallest thing that still decodes as an image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z4AATAxDVgQAF0oBc' +
    'c0Q3FIAAAAASUVORK5CYII=',
  'base64',
)
zip.file('OPS/images/figure-1.png', PNG)
// Spelled with a space, referenced percent-encoded: the reader has to decode
// the href before it can find the entry.
zip.file('OPS/images/figure two.png', PNG)

zip.file(
  'OPS/c1.xhtml',
  `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>${V.EPUB.chapters[0]}</h1>
  <p>${V.EPUB.c1[0]}</p>
  <p>See <a href="c2.xhtml#batching">Chapter Two</a> for how batching changes that trade-off.</p>
  <p>The appendix in <a href="c3.xhtml#glossary">Chapter Three</a> defines every term used below.</p>
  <p>Jump to <a href="#further-reading">further reading</a> at the end of this chapter.</p>
  <p>The background paper this chapter draws on is summarised at
  <a href="${V.EPUB.externalUrl}">${V.EPUB.externalLabel}</a>.</p>
  <p>Questions about this text can be sent to <a href="mailto:notes@example.com">the editor</a>.</p>
  <p><img src="images/figure-1.png" alt="throughput against batch size"/></p>
  <p>The same figure again, which must reuse the first resolution:
  <img src="images/figure-1.png" alt="throughput against batch size"/></p>
  <p>A figure that is not in the archive at all:
  <img src="images/missing-figure.png" alt="not shipped"/></p>
  <p>And one whose name needs percent-decoding to be found:
  <img src="images/figure%20two.png" alt="latency"/></p>
  <p id="further-reading">${V.EPUB.c1[9]}</p>
</body></html>`,
)
zip.file(
  'OPS/c2.xhtml',
  `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1 id="batching">${V.EPUB.chapters[1]}</h1>
  <p>${V.EPUB.c2[0]}</p>
  <p>Back to <a href="c1.xhtml">Chapter One</a>, or ahead to
  <a href="c3.xhtml#glossary">the glossary</a> for the terms used above.</p>
  <p>An <a href="c3.xhtml#cache"><em>emphasised</em> cross-reference</a> to the caching section.</p>
</body></html>`,
)
zip.file(
  'OPS/c3.xhtml',
  `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1 id="glossary">${V.EPUB.chapters[2]}</h1>
  <p id="cache"><strong>Cache</strong>: memory kept from one request to reuse in the next.</p>
  <p><strong>Batch</strong>: a group of requests processed together; see
  <a href="c2.xhtml#batching">Chapter Two</a>.</p>
  <p>External background: <a href="https://example.org/reading-list">a public reading list</a>.</p>
</body></html>`,
)

zip.generateAsync({ type: 'nodebuffer' }).then((buf) => {
  writeFileSync(OUT, buf)
  console.log(`wrote ${OUT} (${buf.length} bytes)`)
})
