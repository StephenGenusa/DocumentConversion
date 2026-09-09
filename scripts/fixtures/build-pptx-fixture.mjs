/**
 * A synthetic PowerPoint deck for the corpus.
 *
 * Written because replacing the private corpus cost `pptx.ts` 31 points of line
 * coverage: the old suite never opened a .pptx deliberately — it reached the
 * reader only through `reader-image-budget`, which walks every docx/pptx in the
 * corpus directory. With no .pptx among the fixtures, the whole of the list,
 * table and picture path went untested.
 *
 * So this deck is built to reach that code, not to look like a real deck:
 *
 *   slide1   title placeholder + a three-level list, mixing bulleted and
 *            auto-numbered runs, which is what exercises `listTree` (depth
 *            clamping, sibling runs) and `renderListNodes` (ol/ul switching
 *            and the `OL_TYPE` map).
 *   slide2   a table with gridSpan and rowSpan, plus a merged continuation
 *            cell that must be skipped.
 *   slide10  a picture, resolved through slide rels to `ppt/media`. Numbered 10
 *            on purpose: OOXML names are not zero-padded, so a lexical sort
 *            puts slide10 before slide2 and `slideNumber` has to fix it.
 *
 *   node scripts/fixtures/build-pptx-fixture.mjs
 */
import JSZip from 'jszip'
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as V from './vocabulary.mjs'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../tests/corpus')

/** A 2x2 PNG. Small enough to stay well inside the image budget. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z4AATAxDVgQAF0oBc' +
    'c0Q3FIAAAAASUVORK5CYII=',
  'base64',
)

const deck = (body) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`

/** One paragraph at an outline level, optionally auto-numbered. */
const para = (level, text, autoNum) =>
  `<a:p><a:pPr lvl="${level}"${autoNum ? '' : ''}>` +
  (autoNum ? `<a:buAutoNum type="${autoNum}"/>` : '<a:buChar char="&#8226;"/>') +
  `</a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`

const shape = (paras, placeholder) =>
  `<p:sp><p:nvSpPr><p:nvPr>${placeholder ?? ''}</p:nvPr></p:nvSpPr>` +
  `<p:txBody>${paras}</p:txBody></p:sp>`

const slide1 = deck(
  shape(`<a:p><a:r><a:t>${V.DECK.title}</a:t></a:r></a:p>`, '<p:ph type="title"/>') +
    shape(
      [
        para(0, V.DECK.slides[0]),
        para(1, V.DECK.slides[1]),
        para(2, V.DECK.bullets[0]),
        para(1, V.DECK.slides[2]),
        para(0, V.DECK.bullets[1], 'arabicPeriod'),
        para(0, V.DECK.bullets[2], 'arabicPeriod'),
        // A bullet separates the two numbered runs on purpose. Adjacent
        // ordered runs are merged into ONE <ol> by renderListNodes, which
        // groups on `ordered` alone and takes the type from the first node —
        // so a lettered run placed directly after an arabic one silently
        // renders as arabic. That is the reader's behaviour today, not
        // something this fixture should paper over.
        para(0, V.DECK.bullets[3]),
        para(0, V.DECK.bullets[4], 'alphaLcPeriod'),
        para(0, V.DECK.bullets[5], 'alphaLcPeriod'),
      ].join(''),
    ),
)

const slide2 = deck(
  `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>
     <a:tr><a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>${V.DECK.tableHeader}</a:t></a:r></a:p></a:txBody></a:tc>
           <a:tc hMerge="1"><a:txBody><a:p><a:r><a:t>skipped</a:t></a:r></a:p></a:txBody></a:tc>
           <a:tc><a:txBody><a:p><a:r><a:t>Status</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
     <a:tr><a:tc rowSpan="2"><a:txBody><a:p><a:r><a:t>North</a:t></a:r></a:p></a:txBody></a:tc>
           <a:tc><a:txBody><a:p><a:r><a:t>24</a:t></a:r></a:p></a:txBody></a:tc>
           <a:tc><a:txBody><a:p><a:r><a:t>Complete</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
     <a:tr><a:tc vMerge="1"><a:txBody><a:p><a:r><a:t>skipped</a:t></a:r></a:p></a:txBody></a:tc>
           <a:tc><a:txBody><a:p><a:r><a:t>31</a:t></a:r></a:p></a:txBody></a:tc>
           <a:tc><a:txBody><a:p><a:r><a:t>In review</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
   </a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
)

const slide10 = deck(
  shape(`<a:p><a:r><a:t>${V.DECK.slides[3]}</a:t></a:r></a:p>`) +
    '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>',
)

const RELS_IMAGE =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/' +
  'relationships/image" Target="../media/image1.png"/></Relationships>'

const zip = new JSZip()
zip.file(
  '[Content_Types].xml',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/></Types>',
)
zip.file(
  '_rels/.rels',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/' +
    'relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
)
zip.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation/>')
zip.file('ppt/slides/slide1.xml', slide1)
zip.file('ppt/slides/slide2.xml', slide2)
zip.file('ppt/slides/slide10.xml', slide10)
zip.file('ppt/slides/_rels/slide10.xml.rels', RELS_IMAGE)
zip.file('ppt/media/image1.png', PNG)

const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
await writeFile(join(OUT, 'quarterly-review-deck.pptx'), bytes)
console.log(`quarterly-review-deck.pptx ${bytes.length} bytes`)
