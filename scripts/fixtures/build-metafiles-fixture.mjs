#!/usr/bin/env node
/**
 * Builds `tests/corpus/reading-room-metafiles.docx`: a Word document whose
 * pictures are EMF, EMF+ and WMF drawings (metafile-corpus.mjs), one for
 * each part of the metafile drawing code. Word keeps each as it is; every
 * other target draws it (src/core/metafile), or takes out the one bitmap
 * a pasted photograph is. Every word comes from vocabulary.mjs.
 *
 *   node scripts/fixtures/build-metafiles-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDocx, mediaParagraph, para } from './lib-docx.mjs'
import { metafileCorpus } from './metafile-corpus.mjs'
import { READING_ROOM as R } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../tests/corpus/reading-room-metafiles.docx')

const pictures = metafileCorpus()
const media = pictures.map((p) => ({ bytes: p.bytes, ext: p.ext, contentType: p.ext === 'emf' ? 'image/x-emf' : 'image/x-wmf' }))
const EMU = 9525 // per CSS px
const body = [
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${R.metafilesTitle}</w:t></w:r></w:p>`,
  para(R.metafilesIntro),
  ...pictures.map((p, i) => mediaParagraph(i, { descr: p.alt, cx: p.width * EMU, cy: p.height * EMU })),
  para(R.metafilesAfter),
].join('')

writeFileSync(out, await buildDocx({ body, media }))
console.log(`wrote ${out}`)
