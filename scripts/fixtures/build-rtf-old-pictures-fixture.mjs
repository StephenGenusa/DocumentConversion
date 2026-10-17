#!/usr/bin/env node
/**
 * Builds `tests/corpus/reading-room-old-pictures.rtf`: a rich-text document
 * whose pictures are the rarer kinds RTF can carry:
 *
 *   \macpict    a QuickDraw (Mac) picture of an 8-bit PackBitsRect bitmap
 *   \macpict    a QuickDraw picture holding a QuickTime-compressed JPEG
 *   \wbitmap    a one-bit device-dependent bitmap
 *   \macpict    a QuickDraw drawing with no bitmap in it, its description in \picprop
 *   \pmmetafile an OS/2 metafile
 *
 * The first three become pictures (a PNG, the JPEG, a PNG); the last two a
 * placeholder that says the app cannot draw them (readers/rtf.ts, readPict;
 * metafile/pict.ts). Pictures are generated here, never committed by hand;
 * every word comes from vocabulary.mjs (READING_ROOM).
 *
 *   node scripts/fixtures/build-rtf-old-pictures-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { pictPackBits, pictQuickTime, pictDrawing, ddb } from './lib-pict.mjs'
import { READING_ROOM as R } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../tests/corpus/reading-room-old-pictures.rtf')

/** A round sign, in few colors (an 8-bit picture): a blue disc with a pale bar across it, on white. */
function sign(x, y) {
  const d = Math.hypot(x - 23.5, y - 23.5)
  if (y >= 20 && y < 28 && x >= 9 && x < 39) return [242, 230, 200]
  return d <= 22 ? [58, 110, 165] : [255, 255, 255]
}

/** Shelves under morning light, as a camera would take it. */
function photo() {
  const c = createCanvas(120, 80)
  const g = c.getContext('2d')
  g.fillStyle = '#f6d7a7'
  g.fillRect(0, 0, 120, 80)
  for (let x = 0; x < 120; x += 12) {
    g.fillStyle = ['#8c3c28', '#3c5a78', '#b4965a'][(x / 12) % 3]
    g.fillRect(x, 40, 10, 34)
  }
  return Buffer.from(c.toBuffer('image/jpeg', 88))
}

/** A square marker with a dark border. */
const marker = (x, y) => (x < 2 || y < 2 || x > 13 || y > 13 || (x > 5 && x < 10 && y > 5 && y < 10) ? [0, 0, 0] : [255, 255, 255])

const hex = (bytes) => bytes.toString('hex').replace(/(.{128})/g, '$1\n')
const TWIPS = 15 // per CSS px

const packed = `{\\pict\\macpict\\picw48\\pich48\\picwgoal${48 * TWIPS}\\pichgoal${48 * TWIPS}\n${hex(pictPackBits({ width: 48, height: 48, rgb: sign }))}}`
const quickTime = `{\\pict\\macpict\\picw120\\pich80\n${hex(pictQuickTime({ width: 120, height: 80, image: photo() }))}}`
const bits = ddb({ width: 16, height: 16, depth: 1, rgb: marker })
const device = `{\\pict\\wbitmap0\\wbmbitspixel1\\wbmplanes1\\wbmwidthbytes${bits.widthBytes}\\picw16\\pich16\\picwgoal${16 * TWIPS}\\pichgoal${16 * TWIPS}\n${hex(bits.bits)}}`
const drawing = `{\\pict{\\*\\picprop{\\sp{\\sn wzDescription}{\\sv ${R.rtfOldDrawingAlt}}}}\\macpict\\picw96\\pich64\n${hex(pictDrawing({ width: 96, height: 64 }))}}`
// The start of an OS/2 metafile: a Begin Document structured field.
const os2 = `{\\pict\\pmmetafile8\\picw4233\\pich2117\\picwgoal${160 * TWIPS}\\pichgoal${80 * TWIPS}\n0012d3a8a8000000000000000000000000000000}`

const rtf = [
  '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}',
  `\\pard\\f0\\fs36\\b ${R.rtfOldTitle}\\b0\\fs22\\par`,
  `\\pard ${R.rtfOldIntro}\\par`,
  `\\pard ${R.rtfOldPackedLead}\\par`,
  `\\pard ${packed}\\par`,
  `\\pard ${R.rtfOldPhotoLead}\\par`,
  `\\pard ${quickTime}\\par`,
  `\\pard ${R.rtfOldDeviceLead}\\par`,
  `\\pard ${device}\\par`,
  `\\pard ${R.rtfOldDrawingLead}\\par`,
  `\\pard ${drawing}\\par`,
  `\\pard ${R.rtfOldOs2Lead}\\par`,
  `\\pard ${os2}\\par`,
  `\\pard ${R.rtfOldAfter}\\par`,
  '}',
].join('\n')

writeFileSync(out, Buffer.from(rtf, 'latin1'))
console.log(`wrote ${out}`)
