#!/usr/bin/env node
/**
 * Builds `tests/corpus/reading-room-pictures.rtf`: a rich-text document
 * whose pictures are the kinds RTF carries, the way Word and older word
 * processors write them:
 *
 *   a PNG       in Word's pair: {\*\shppict} PNG, {\nonshppict} WMF fallback,
 *               its description in \picprop
 *   a JPEG      as \bin raw bytes, scaled by \picscalex/\picscaley
 *   an EMF      in the pair, with a DIB beside it for older readers
 *   a WMF       bare (\wmetafile8), sized only by \picwgoal/\pichgoal
 *   a DIB       (\dibitmap0), in a table cell
 *
 * The reader keeps every one (readers/rtf.ts); the picture step gives each
 * target the best of a pair it can use (pictures.ts). Pictures are
 * generated here, never committed by hand; every word comes from
 * vocabulary.mjs (READING_ROOM).
 *
 *   node scripts/fixtures/build-rtf-pictures-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { emf, wmf } from './lib-tiff.mjs'
import { READING_ROOM as R } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../tests/corpus/reading-room-pictures.rtf')

/** A round sign: a blue disc with a pale bar across it. */
function sign() {
  const c = createCanvas(96, 96)
  const g = c.getContext('2d')
  g.fillStyle = '#3a6ea5'
  g.beginPath()
  g.arc(48, 48, 44, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#f2e6c8'
  g.fillRect(18, 40, 60, 16)
  return Buffer.from(c.toBuffer('image/png'))
}

/** Morning light across shelves, as a camera would take it. */
function photo() {
  const c = createCanvas(240, 160)
  const g = c.getContext('2d')
  const sky = g.createLinearGradient(0, 0, 0, 160)
  sky.addColorStop(0, '#f6d7a7')
  sky.addColorStop(1, '#8a6a4a')
  g.fillStyle = sky
  g.fillRect(0, 0, 240, 160)
  for (let x = 0; x < 240; x += 12) {
    g.fillStyle = ['#8c3c28', '#3c5a78', '#b4965a'][(x / 12) % 3]
    g.fillRect(x, 100, 10, 50)
  }
  return Buffer.from(c.toBuffer('image/jpeg', 88))
}

/** A 16 x 16 24-bit DIB (BITMAPINFOHEADER, then the rows bottom-up, as \dibitmap holds it): a green square marker. */
function dib() {
  const w = 16
  const h = 16
  const row = w * 3
  const b = Buffer.alloc(40 + row * h)
  b.writeUInt32LE(40, 0)
  b.writeInt32LE(w, 4)
  b.writeInt32LE(h, 8)
  b.writeUInt16LE(1, 12)
  b.writeUInt16LE(24, 14)
  b.writeUInt32LE(row * h, 20)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = x < 2 || y < 2 || x > w - 3 || y > h - 3
      const at = 40 + y * row + x * 3
      // BGR
      b[at] = edge ? 40 : 90
      b[at + 1] = edge ? 90 : 170
      b[at + 2] = edge ? 30 : 60
    }
  }
  return b
}

const hex = (bytes) => bytes.toString('hex').replace(/(.{128})/g, '$1\n')
const TWIPS = 15 // per CSS px

const signPng = sign()
const pair = (pict, fallback) => `{\\*\\shppict${pict}}{\\nonshppict${fallback}}`

const signPict = `{\\pict{\\*\\picprop\\shplid1025{\\sp{\\sn shapeType}{\\sv 75}}{\\sp{\\sn wzDescription}{\\sv ${R.rtfSignAlt}}}}\\picscalex100\\picscaley100\\picw96\\pich96\\picwgoal${96 * TWIPS}\\pichgoal${96 * TWIPS}\\pngblip\n${hex(signPng)}}`
const signFallback = `{\\pict\\picscalex100\\picscaley100\\picw2540\\pich2540\\picwgoal${96 * TWIPS}\\pichgoal${96 * TWIPS}\\wmetafile8\n${hex(wmf({ width: 96, height: 96, placeable: false }))}}`

const jpeg = photo()
const photoPict = `{\\pict\\jpegblip\\picw240\\pich160\\picwgoal${240 * TWIPS}\\pichgoal${160 * TWIPS}\\picscalex75\\picscaley75\\bin${jpeg.length} ${jpeg.toString('latin1')}}`

const planPict = `{\\pict\\emfblip\\picw6350\\pich4233\\picwgoal${240 * TWIPS}\\pichgoal${160 * TWIPS}\n${hex(emf({ width: 240, height: 160 }))}}`
const planFallback = `{\\pict\\dibitmap0\\picw16\\pich16\\picwgoal${240 * TWIPS}\\pichgoal${160 * TWIPS}\n${hex(dib())}}`

const labelPict = `{\\pict\\wmetafile8\\picw5292\\pich2117\\picwgoal${200 * TWIPS}\\pichgoal${80 * TWIPS}\n${hex(wmf({ width: 200, height: 80, placeable: false }))}}`

const markerPict = `{\\pict\\dibitmap0\\picw16\\pich16\\picwgoal${16 * TWIPS}\\pichgoal${16 * TWIPS}\n${hex(dib())}}`

const cell = (text) => `\\pard\\intbl ${text}\\cell`
const rtf = [
  '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}',
  `\\pard\\f0\\fs36\\b ${R.rtfTitle}\\b0\\fs22\\par`,
  `\\pard ${R.rtfIntro}\\par`,
  `\\pard ${pair(signPict, signFallback)}\\par`,
  `\\pard ${R.rtfPhotoLead}\\par`,
  `\\pard ${photoPict}\\par`,
  `\\pard ${R.rtfPlanLead}\\par`,
  `\\pard ${pair(planPict, planFallback)}\\par`,
  `\\pard ${R.rtfLabelLead}\\par`,
  `\\pard ${labelPict}\\par`,
  `\\pard ${R.rtfBitmapLead}\\par`,
  `\\trowd\\cellx3000\\cellx6000${cell(R.rtfTableHead[0])}${cell(R.rtfTableHead[1])}\\row`,
  `\\trowd\\cellx3000\\cellx6000${cell(R.labels[0])}${cell(markerPict)}\\row`,
  `\\pard ${R.rtfAfter}\\par`,
  '}',
].join('\n')

writeFileSync(out, Buffer.from(rtf, 'latin1'))
console.log(`wrote ${out}`)
