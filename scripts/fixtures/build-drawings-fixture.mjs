#!/usr/bin/env node
/**
 * Builds `tests/corpus/reading-room-drawings.docx`: a Word document whose
 * pictures are Word's own vector formats, as old documents carry them:
 *
 *   an EMF drawing   (enhanced metafile)
 *   a WMF drawing    (Windows metafile, with its Aldus placeable header)
 *
 * Word keeps both as they are (sized from their headers); every other
 * target shows each as its alt text until an EMF drawing step comes. Both
 * are generated (scripts/fixtures/lib-tiff.mjs), never committed by hand;
 * every word comes from vocabulary.mjs (READING_ROOM).
 *
 *   node scripts/fixtures/build-drawings-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDocx, mediaParagraph, para } from './lib-docx.mjs'
import { emf, wmf } from './lib-tiff.mjs'
import { READING_ROOM as R } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../tests/corpus/reading-room-drawings.docx')

const media = [
  { bytes: emf({ width: 240, height: 160 }), ext: 'emf', contentType: 'image/x-emf' },
  { bytes: wmf({ width: 200, height: 80 }), ext: 'wmf', contentType: 'image/x-wmf' },
]

const EMU = 9525 // per CSS px
const body = [
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${R.drawingsTitle}</w:t></w:r></w:p>`,
  para(R.drawingsIntro),
  mediaParagraph(0, { descr: R.emfAlt, cx: 240 * EMU, cy: 160 * EMU }),
  mediaParagraph(1, { descr: R.wmfAlt, cx: 200 * EMU, cy: 80 * EMU }),
  para(R.drawingsAfter),
].join('')

writeFileSync(out, await buildDocx({ body, media }))
console.log(`wrote ${out}`)
