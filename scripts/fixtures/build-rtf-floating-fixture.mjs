#!/usr/bin/env node
/**
 * Builds `tests/corpus/reading-room-floating.rtf`: a rich-text document whose
 * pictures float beside the text, as Word writes a picture with text wrapping
 * on: a shape (`{\shp`) whose `pib` property holds the picture, inside the
 * ignorable `{\*\shpinst}`, and a copy in `{\shprslt}` for readers that know
 * no shapes.
 *
 *   a PNG       in the shape's pib, its description in the shape, a WMF copy
 *               in \shprslt
 *   an OS/2     metafile in the pib (a picture type nothing reads), a JPEG
 *               copy in \shprslt: the copy is the picture
 *
 * Each picture should come through once, where its shape stands
 * (readers/rtf.ts, floatingPicture). Pictures are generated here, never
 * committed by hand; every word comes from vocabulary.mjs (READING_ROOM).
 *
 *   node scripts/fixtures/build-rtf-floating-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { wmf } from './lib-tiff.mjs'
import { READING_ROOM as R } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../tests/corpus/reading-room-floating.rtf')

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

/** Shelves under morning light, as a camera would take it. */
function photo() {
  const c = createCanvas(160, 120)
  const g = c.getContext('2d')
  g.fillStyle = '#f6d7a7'
  g.fillRect(0, 0, 160, 120)
  for (let x = 0; x < 160; x += 16) {
    g.fillStyle = ['#8c3c28', '#3c5a78', '#b4965a'][(x / 16) % 3]
    g.fillRect(x, 60, 12, 50)
  }
  return Buffer.from(c.toBuffer('image/jpeg', 88))
}

const hex = (bytes) => bytes.toString('hex').replace(/(.{128})/g, '$1\n')
const TWIPS = 15 // per CSS px

/** A floating shape as Word writes it, `width` x `height` CSS px, wrapped square at `side`. */
function floating({ id, width, height, side, alt, pib, result }) {
  const left = side === 'left' ? 0 : 6000
  const props = [
    '{\\sp{\\sn shapeType}{\\sv 75}}',
    '{\\sp{\\sn fFlipH}{\\sv 0}}',
    alt ? `{\\sp{\\sn wzDescription}{\\sv ${alt}}}` : '',
    `{\\sp{\\sn pib}{\\sv ${pib}}}`,
    '{\\sp{\\sn fLayoutInCell}{\\sv 1}}',
  ].join('')
  return (
    `{\\shp{\\*\\shpinst\\shpleft${left}\\shptop0\\shpright${left + width * TWIPS}\\shpbottom${height * TWIPS}` +
    `\\shpfhdr0\\shpbxcolumn\\shpbxignore\\shpbypara\\shpbyignore\\shpwr2\\shpwrk${side === 'left' ? 1 : 2}\\shpfblwtxt0\\shpz0\\shplid${id}${props}}` +
    `{\\shprslt\\par\\pard\\ql \\li0\\ri0\\widctlpar\\phpara\\posx${side === 'left' ? 'l' : 'r'}\\pvpara\\posy0\\dxfrtext180\\dfrmtxtx180\\dfrmtxty0\\wraparound\\aspalpha\\aspnum\\faauto\\rin0\\lin0\\itap0 ${result}\\par\\pard}}`
  )
}

const signPng = sign()
const signWmf = wmf({ width: 96, height: 96, placeable: false })
const signFloat = floating({
  id: 2049,
  width: 64,
  height: 64,
  side: 'left',
  alt: R.rtfFloatSignAlt,
  pib: `{\\pict\\picscalex67\\picscaley67\\picw96\\pich96\\picwgoal${96 * TWIPS}\\pichgoal${96 * TWIPS}\\pngblip\n${hex(signPng)}}`,
  result: `{\\pict\\picscalex67\\picscaley67\\picw2540\\pich2540\\picwgoal${96 * TWIPS}\\pichgoal${96 * TWIPS}\\wmetafile8\n${hex(signWmf)}}`,
})

const jpeg = photo()
// An OS/2 metafile header nothing reads, as an older word processor left it.
const os2 = Buffer.from('0012d3a8a8000000000000000000000000000000', 'hex')
const photoFloat = floating({
  id: 2050,
  width: 160,
  height: 120,
  side: 'right',
  pib: `{\\pict\\pmmetafile8\\picw4233\\pich3175\\picwgoal${160 * TWIPS}\\pichgoal${120 * TWIPS}\n${hex(os2)}}`,
  result: `{\\pict\\jpegblip\\picw160\\pich120\\picwgoal${160 * TWIPS}\\pichgoal${120 * TWIPS}\n${hex(jpeg)}}`,
})

const rtf = [
  '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}',
  `\\pard\\f0\\fs36\\b ${R.rtfFloatTitle}\\b0\\fs22\\par`,
  `\\pard ${R.rtfFloatIntro}\\par`,
  `\\pard ${signFloat}${R.rtfFloatSignLead}.\\par`,
  `\\pard ${photoFloat}${R.rtfFloatPhotoLead}.\\par`,
  `\\pard ${R.rtfFloatAfter}\\par`,
  '}',
].join('\n')

writeFileSync(out, Buffer.from(rtf, 'latin1'))
console.log(`wrote ${out}`)
