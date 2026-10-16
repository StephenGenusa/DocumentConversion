#!/usr/bin/env node
/**
 * Builds `tests/corpus/reading-room-scans.docx`: a Word document whose
 * pictures are the kinds a Kindle (AZW3) book cannot store as they are, the
 * way old documents carry them:
 *
 *   a TIFF photograph   RGB, LZW-compressed, as scanners save it
 *   a TIFF line scan    one bit a pixel, PackBits, big-endian
 *   an EMF drawing      Word's vector picture format
 *
 * The TIFFs become JPEG for Kindle (decoded in the render host); the EMF
 * cannot be drawn here and stays its alt text. All three are generated
 * (scripts/fixtures/lib-tiff.mjs), never committed by hand; every word
 * comes from vocabulary.mjs (READING_ROOM).
 *
 *   node scripts/fixtures/build-scan-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDocx, mediaParagraph, para } from './lib-docx.mjs'
import { emf, tiff } from './lib-tiff.mjs'
import { READING_ROOM as R } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../tests/corpus/reading-room-scans.docx')

/** A window onto a morning sky above a row of shelves, as a scanner would see a print of it. */
function photo(x, y) {
  const W = 320
  const H = 200
  const t = y / H
  let rgb = [246 - 150 * t, 215 - 90 * t, 167 + 30 * t]
  // Window frames.
  const fx = x % (W / 3)
  if (y > 16 && y < 110 && (fx < 8 || fx > W / 3 - 8)) rgb = [74, 59, 44]
  // Shelves along the bottom, with books.
  if (y > 130) rgb = (Math.floor(x / 9) + Math.floor(y / 35)) % 3 === 0 ? [140, 60, 40] : (Math.floor(x / 9) % 3 === 1 ? [60, 90, 120] : [180, 150, 90])
  if (y % 35 < 4 && y > 130) rgb = [90, 70, 50]
  return rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))))
}

/** Shelving drawn in lines, as a fax-quality scan: white paper, black lines. */
function lines(x, y) {
  const ink = (y % 40 < 3 && x >= 10 && x < 293) || (x >= 10 && (x - 10) % 70 < 3 && y < 163 && x < 293)
  return ink ? [0, 0, 0] : [255, 255, 255]
}

const media = [
  { bytes: tiff({ width: 320, height: 200, pixel: photo, compression: 'lzw' }), ext: 'tif', contentType: 'image/tiff' },
  { bytes: tiff({ width: 300, height: 164, pixel: lines, kind: 'bilevel', compression: 'packbits', bigEndian: true }), ext: 'tiff', contentType: 'image/tiff' },
  { bytes: emf({ width: 160, height: 120 }), ext: 'emf', contentType: 'image/x-emf' },
]

const EMU = 9525 // per CSS px
const body = [
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${R.scansTitle}</w:t></w:r></w:p>`,
  para(R.scansIntro),
  mediaParagraph(0, { descr: R.scanAlt, cx: 320 * EMU, cy: 200 * EMU }),
  mediaParagraph(1, { descr: R.lineScanAlt, cx: 300 * EMU, cy: 164 * EMU }),
  mediaParagraph(2, { descr: R.drawingAlt, cx: 160 * EMU, cy: 120 * EMU }),
  para(R.scansAfter),
].join('')

writeFileSync(out, await buildDocx({ body, media }))
console.log(`wrote ${out}`)
