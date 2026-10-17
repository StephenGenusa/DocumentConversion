#!/usr/bin/env node
/**
 * Builds `tests/corpus/reading-room-fax.docx`: a Word document whose one
 * picture is a multi-page TIFF, as a fax or a scanned letter arrives:
 *
 *   page 1   one bit a pixel, PackBits: lines of type
 *   page 2   a preview (reduced-resolution copy), which is not a page
 *   page 2   eight-bit gray, LZW: a shaded plan
 *   page 3   one bit a pixel, PackBits: a closing line and a signature
 *
 * Word, and every viewer, shows only a TIFF's first page; the converter
 * makes each page its own picture (pictures.ts), so all three come
 * through, in order. The TIFF is generated (scripts/fixtures/lib-tiff.mjs),
 * never committed by hand; every word comes from vocabulary.mjs
 * (READING_ROOM).
 *
 *   node scripts/fixtures/build-fax-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDocx, mediaParagraph, para } from './lib-docx.mjs'
import { tiff } from './lib-tiff.mjs'
import { READING_ROOM as R } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../tests/corpus/reading-room-fax.docx')

const W = 340
const H = 440
const WHITE = [255, 255, 255]
const BLACK = [0, 0, 0]

/** Lines of type: bars of ink of varying length, a heading bar first. */
function typed(x, y) {
  if (y > 30 && y < 44 && x > 30 && x < 220) return BLACK
  const line = Math.floor((y - 70) / 18)
  const inLine = y >= 70 && (y - 70) % 18 < 7 && line < 18
  const end = W - 30 - ((line * 37) % 90)
  return inLine && x > 30 && x < end && (x + line * 7) % 41 > 4 ? BLACK : WHITE
}

/** A shaded plan: gray floor, darker shelves, a light aisle. */
function plan(x, y) {
  let v = 200 - Math.round((y / H) * 40)
  if (x > 40 && x < W - 40 && y > 60 && y < H - 60 && Math.floor((y - 60) / 40) % 2 === 0) v = 90
  if (x > W / 2 - 15 && x < W / 2 + 15) v = 235
  return [v, v, v]
}

/** A closing line and a looping signature. */
function signed(x, y) {
  if (y >= 70 && y < 77 && x > 30 && x < 250) return BLACK
  const s = 300 + 25 * Math.sin(x / 14) + 10 * Math.sin(x / 5)
  if (x > 40 && x < 260 && Math.abs(y - s) < 2) return BLACK
  if (y >= 350 && y < 352 && x > 30 && x < 290) return BLACK
  return WHITE
}

const fax = tiff({
  pages: [
    { width: W, height: H, pixel: typed, kind: 'bilevel', compression: 'packbits', pageNumber: [0, 3], dpi: 100 },
    { width: 34, height: 44, pixel: (x, y) => typed(x * 10, y * 10), kind: 'gray', thumbnail: true },
    { width: W, height: H, pixel: plan, kind: 'gray', compression: 'lzw', pageNumber: [1, 3], dpi: 100 },
    { width: W, height: H, pixel: signed, kind: 'bilevel', compression: 'packbits', pageNumber: [2, 3], dpi: 100 },
  ],
})

const media = [{ bytes: fax, ext: 'tif', contentType: 'image/tiff' }]

const EMU = 9525 // per CSS px
const body = [
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${R.faxTitle}</w:t></w:r></w:p>`,
  para(R.faxIntro),
  mediaParagraph(0, { descr: R.faxAlt, cx: Math.round((W * 96) / 100) * EMU, cy: Math.round((H * 96) / 100) * EMU }),
  para(R.faxAfter),
].join('')

writeFileSync(out, await buildDocx({ body, media }))
console.log(`wrote ${out}`)
