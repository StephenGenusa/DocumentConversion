#!/usr/bin/env node
/**
 * Builds picture files that are documents of their own, as they arrive by
 * mail or from a scanner, each opened as it is (not inside a document):
 *
 *   tests/corpus/reading-room-lease.tiff         a fax of three pages and a preview
 *                                                (one bit a pixel, PackBits; eight-bit
 *                                                gray, LZW, a landscape page; one bit
 *                                                again, big-endian)
 *   tests/corpus/reading-room-floor-plan.emf     an EMF drawing with its labels as text
 *   tests/corpus/reading-room-shelf-label.wmf    a placeable WMF with a line of text
 *   tests/corpus/reading-room-sign.bmp           a 24-bit BMP
 *   tests/corpus/reading-room-marker.ico         an ICO holding a PNG
 *
 * Each page of the TIFF becomes a page of its own; Word keeps the TIFF
 * pages, the EMF and the WMF as they are, and every other target gets
 * pictures it holds (src/core/pictures.ts). All are generated
 * (lib-tiff.mjs, lib-metafile.mjs), never committed by hand, and every
 * word comes from vocabulary.mjs (READING_ROOM).
 *
 *   node scripts/fixtures/build-picture-files.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tiff } from './lib-tiff.mjs'
import { EmfWriter, WmfWriter, png } from './lib-metafile.mjs'
import { READING_ROOM as R } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const corpus = (name) => join(here, '../../tests/corpus', name)
const write = (name, bytes) => {
  writeFileSync(corpus(name), bytes)
  console.log(`wrote tests/corpus/${name} (${bytes.length} bytes)`)
}

const BLUE = 0x3a6ea5
const ORANGE = 0xe8a33d
const GREEN = 0x4f9a52

// The fax: letter-shaped pages at 100 dpi.
const W = 340
const H = 440
const WHITE = [255, 255, 255]
const BLACK = [0, 0, 0]

/** Lines of type under a heading bar, as a typed page looks from across the desk. */
function typed(x, y) {
  if (y > 30 && y < 44 && x > 30 && x < 240) return BLACK
  const line = Math.floor((y - 70) / 18)
  const inLine = y >= 70 && (y - 70) % 18 < 7 && line < 19
  const end = W - 30 - ((line * 29) % 80)
  return inLine && x > 30 && x < end && (x + line * 5) % 37 > 4 ? BLACK : WHITE
}

// The floor plan is a landscape page, as a fax sends a drawing turned sideways.
const PW = H
const PH = W

/** A shaded floor plan: gray floor, darker stacks, a light aisle down the middle. */
function plan(x, y) {
  let v = 210 - Math.round((y / PH) * 50)
  if (x > 40 && x < PW - 40 && y > 50 && y < PH - 50 && Math.floor((y - 50) / 34) % 2 === 0) v = 80
  if (x > PW / 2 - 14 && x < PW / 2 + 14) v = 240
  return [v, v, v]
}

/** A closing paragraph, a signature and a rule under it. */
function signed(x, y) {
  const line = Math.floor((y - 60) / 18)
  if (y >= 60 && line < 4 && (y - 60) % 18 < 7 && x > 30 && x < W - 40 - ((line * 23) % 60)) return BLACK
  const s = 300 + 22 * Math.sin(x / 13) + 9 * Math.sin(x / 4)
  if (x > 50 && x < 270 && Math.abs(y - s) < 2) return BLACK
  if (y >= 345 && y < 347 && x > 30 && x < 300) return BLACK
  return WHITE
}

write(
  'reading-room-lease.tiff',
  tiff({
    bigEndian: true,
    pages: [
      { width: W, height: H, pixel: typed, kind: 'bilevel', compression: 'packbits', pageNumber: [0, 3], dpi: 100 },
      { width: 34, height: 44, pixel: (x, y) => typed(x * 10, y * 10), kind: 'gray', thumbnail: true },
      { width: PW, height: PH, pixel: plan, kind: 'gray', compression: 'lzw', pageNumber: [1, 3], dpi: 100 },
      { width: W, height: H, pixel: signed, kind: 'bilevel', compression: 'packbits', pageNumber: [2, 3], dpi: 100 },
    ],
  }),
)

// The floor plan: rooms as filled boxes, each named, the desk by the entrance.
{
  const [fiction, periodicals, media, desk, entrance] = R.labels
  const e = new EmfWriter({ width: 360, height: 240 })
  e.pen(1, 0, 2, 0x333333).select(1)
  e.brush(2, 0, 0xdfe8f3).select(2).rectangle(10, 10, 350, 230)
  e.brush(3, 0, BLUE).select(3).rectangle(30, 30, 170, 110)
  e.brush(4, 0, ORANGE).select(4).rectangle(190, 30, 330, 110)
  e.brush(5, 0, GREEN).select(5).rectangle(30, 130, 170, 210)
  e.ellipse(220, 140, 300, 200)
  e.setBkMode(1).setTextColor(0x000000).setTextAlign(24)
  e.font(6, { height: -18, face: 'Arial' }).select(6)
  e.text(45, 75, fiction).text(205, 75, periodicals).text(45, 175, media).text(238, 176, desk)
  e.font(7, { height: -14, italic: 1, face: 'Arial' }).select(7).text(150, 226, entrance)
  write('reading-room-floor-plan.emf', e.bytes())
}

// The shelf label: a framed card with one line of text, as an older word processor saved it.
{
  const w = new WmfWriter({ width: 240, height: 90 })
  w.setWindowOrg(0, 0).setWindowExt(240, 90)
  w.pen(0, 2, 0x333333).select(0)
  w.brush(0, 0xfff4d6).select(1).roundRect(4, 4, 236, 86, 16, 16)
  w.setBkMode(1).setTextColor(0x1d3557).setTextAlign(24)
  w.font({ height: -22, face: 'Arial' }).select(2).textOut(24, 54, R.labels[1])
  write('reading-room-shelf-label.wmf', w.bytes())
}

// The sign: a 24-bit BMP, bottom-up rows padded to four bytes.
{
  const width = 120
  const height = 80
  const row = Math.ceil((width * 3) / 4) * 4
  const b = Buffer.alloc(54 + row * height)
  b.write('BM', 0, 'latin1')
  b.writeUInt32LE(b.length, 2)
  b.writeUInt32LE(54, 10)
  b.writeUInt32LE(40, 14)
  b.writeInt32LE(width, 18)
  b.writeInt32LE(height, 22)
  b.writeUInt16LE(1, 26)
  b.writeUInt16LE(24, 28)
  b.writeUInt32LE(row * height, 34)
  b.writeInt32LE(2835, 38) // 72 dpi, in pixels a meter
  b.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // An arrow on a green board, under a pale frame.
      const frame = x < 6 || y < 6 || x >= width - 6 || y >= height - 6
      const arrow = (y > 34 && y < 46 && x > 20 && x < 80) || (x >= 80 && x < 100 && Math.abs(y - 40) < 100 - x)
      const [r, g, bl] = frame ? [230, 230, 220] : arrow ? [255, 255, 255] : [40, 120, 70]
      const at = 54 + (height - 1 - y) * row + x * 3
      b[at] = bl
      b[at + 1] = g
      b[at + 2] = r
    }
  }
  write('reading-room-sign.bmp', b)
}

// The marker: an ICO whose one picture is a PNG (as Windows Vista and later write large icons).
{
  const size = 48
  const marker = png(size, size, (x, y) => {
    const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5)
    return d < 18 ? [58, 110, 165] : d < 22 ? [232, 163, 61] : [255, 255, 255]
  })
  const dir = Buffer.alloc(22)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2) // an icon
  dir.writeUInt16LE(1, 4) // one picture
  dir[6] = size
  dir[7] = size
  dir.writeUInt16LE(1, 10) // planes
  dir.writeUInt16LE(32, 12) // bits a pixel
  dir.writeUInt32LE(marker.length, 14)
  dir.writeUInt32LE(22, 18)
  write('reading-room-marker.ico', Buffer.concat([dir, marker]))
}
