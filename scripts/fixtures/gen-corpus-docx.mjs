// Generates the synthetic .docx / .xlsx / .xls replacements for tests/corpus/.
// Run with: node scripts/fixtures/gen-corpus-docx.mjs
//
// These files stand in for real, PII-bearing documents that used to live in
// the original private corpus. Every string below is invented; nothing is copied from the
// originals. Each fixture reproduces the STRUCTURAL property the owning test
// depends on — see the comment above each block, and the report handed back
// with this change for the full mapping.
import * as V from './vocabulary.mjs'
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDocx, para, paraRuns, listItem, imageParagraph, imageRelIds, decimalNumberingXml } from './lib-docx.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus')

/* -------------------------------------------------------------------------- */
/* supply-request-header.docx — reader-docx.test.ts                         */
/* A default page header that becomes the document's title (once, not once   */
/* per page), and nothing else that could compete with it.                   */
/* -------------------------------------------------------------------------- */
{
  const body = V.SUPPLY_DOCX.lines.map(para).join('')
  const bytes = await buildDocx({
    body,
    headers: { default: para(V.SUPPLY_DOCX.title) },
  })
  await writeFile(join(OUT, 'supply-request-header.docx'), bytes)
}

/* -------------------------------------------------------------------------- */
/* induction-pack-with-footer.docx — reader-docx.test.ts, doc-images-notice  */
/* A footer (page furniture) that must NOT surface as a title, plus a        */
/* handful of embedded images so the "does not mistake docx media for legacy */
/* .doc pictures" case has something real to not-mistake.                    */
/* -------------------------------------------------------------------------- */
{
  const N = 18
  const ids = imageRelIds(N)
  const paras = []
  const topics = V.INDUCTION_DOCX.headings
  let idCounter = 1
  for (const topic of topics) {
    paras.push(para(topic))
    paras.push(para(V.INDUCTION_DOCX.caption))
    const chunk = ids.splice(0, 3)
    paras.push(imageParagraph(chunk, idCounter))
    idCounter += chunk.length
  }
  const bytes = await buildDocx({
    body: paras.join(''),
    footers: { default: para(V.INDUCTION_DOCX.footer) },
    imageCount: N,
  })
  await writeFile(join(OUT, 'induction-pack-with-footer.docx'), bytes)
}

/* -------------------------------------------------------------------------- */
/* branch-notes-with-toc.docx — reader-docx-fidelity.test.ts, doc-images-notice*/
/* Tab-separated table-of-contents lines that must not glue to their page    */
/* number, plus embedded images for the same "not mistaken" property.       */
/* -------------------------------------------------------------------------- */
{
  const N = 9
  const ids = imageRelIds(N)
  const toc =
    V.NOTES_DOCX.toc.map(([t, pg]) => paraRuns([t, '\t', pg])).join('')
  const body =
    para(V.NOTES_DOCX.title) +
    toc +
    para(V.NOTES_DOCX.captions[0]) +
    imageParagraph(ids.slice(0, 4), 1) +
    para(V.NOTES_DOCX.captions[1]) +
    imageParagraph(ids.slice(4), 5)
  const bytes = await buildDocx({ body, imageCount: N })
  await writeFile(join(OUT, 'branch-notes-with-toc.docx'), bytes)
}

/* -------------------------------------------------------------------------- */
/* charts-with-images.docx — doc-images-notice.test.ts                  */
/* Ordinary prose with embedded images, same "not mistaken" property, at a    */
/* different image count so the each-file case in the test is exercised.    */
/* -------------------------------------------------------------------------- */
{
  const N = 12
  const ids = imageRelIds(N)
  const body =
    para(V.CHARTS_DOCX.title) +
    para(V.CHARTS_DOCX.lead) +
    imageParagraph(ids, 1) +
    para(V.CHARTS_DOCX.tail)
  const bytes = await buildDocx({ body, imageCount: N })
  await writeFile(join(OUT, 'charts-with-images.docx'), bytes)
}

/* -------------------------------------------------------------------------- */
/* context-menu-howto.docx — reader-docx-fidelity.test.ts                     */
/* A 13-step numbered procedure with a screenshot after most steps, all one   */
/* numbering instance — the case that used to restart at "1." after every    */
/* interrupting image. 17 images total, three pinned strings kept in order.  */
/* -------------------------------------------------------------------------- */
{
  const stepTexts = V.HOWTO_DOCX.steps
  // How many images follow each step (index 0..12); sums to 17.
  const imagesAfter = [2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 0, 0]
  const N = imagesAfter.reduce((a, b) => a + b, 0)
  const ids = imageRelIds(N)
  let cursor = 0
  let imgId = 1
  const parts = []
  stepTexts.forEach((text, i) => {
    parts.push(listItem(1, text))
    const count = imagesAfter[i]
    if (count > 0) {
      const chunk = ids.slice(cursor, cursor + count)
      cursor += count
      parts.push(imageParagraph(chunk, imgId))
      imgId += count
    }
  })
  const bytes = await buildDocx({
    body: parts.join(''),
    numberingXml: decimalNumberingXml(),
    imageCount: N,
  })
  await writeFile(join(OUT, 'context-menu-howto.docx'), bytes)
}

console.log('docx/xlsx corpus fixtures written to', OUT)
