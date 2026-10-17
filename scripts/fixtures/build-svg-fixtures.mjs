#!/usr/bin/env node
/**
 * Builds the SVG fixtures (spec D10, plan step 16) in `tests/corpus/`:
 *
 *   reading-room-plan.svg      an invented floor plan, drawn as an SVG file
 *   reading-room-hostile.svg   the same plan carrying everything B6 strips:
 *                              a script, event handlers, external hrefs, an
 *                              @import, a foreignObject with an iframe, an
 *                              xml-stylesheet and an external entity. It opens
 *                              with a BOM, an XML prolog and comments, so the
 *                              content sniff is exercised too.
 *   reading-room-marked-plan.svg
 *                              the plan with the quiet seating marker placed
 *                              on it three times as nested SVG images
 *                              (<image href="data:image/svg+xml;base64,…">),
 *                              one of them carrying a script: B6 keeps the
 *                              nested pictures and cleans them.
 *   reading-room-photo-plan.svg
 *                              the plan with four small pictures placed on it
 *                              as data URIs, one of each type an SVG may hold:
 *                              PNG, JPEG, GIF and WebP (one colour each, so a
 *                              drawing shows at a glance which were kept).
 *   reading-room-page.html     a page showing the plan as an SVG <img> (a
 *                              base64 data URI) and a small marker as a
 *                              percent-encoded one: the shape that gave Word
 *                              output an unusable `image/svg+xml` part.
 *   reading-room-seating.html  a seating chart: 150 quiet seating markers,
 *                              each its own colour (so 150 distinct SVG
 *                              images), more than Word conversion once took
 *                              (it stopped at 100).
 *
 * Every address the hostile file names is 127.0.0.1 port 9 (discard), so
 * nothing could be reached even if a request were made. Every word comes from
 * vocabulary.mjs (READING_ROOM).
 *
 *   node scripts/fixtures/build-svg-fixtures.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { READING_ROOM as R } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const corpus = (name) => join(here, '../../tests/corpus', name)

const FONT = `Arial, 'Liberation Sans', Helvetica, sans-serif`

/** Shelves as [x, y, width, height, label index]; the desk faces the entrance. */
const SHELVES = [
  [30, 40, 160, 60, 0],
  [30, 130, 160, 60, 1],
  [290, 40, 160, 60, 2],
  [290, 170, 110, 50, 3],
]

function plan(extra = { root: '', inside: '' }) {
  const shelves = SHELVES.map(
    ([x, y, w, h, i]) =>
      `  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#dbe8f5" stroke="#2f5d8a" stroke-width="2"/>\n` +
      `  <text x="${x + w / 2}" y="${y + h / 2 + 6}" text-anchor="middle" font-size="16">${R.labels[i]}</text>`,
  ).join('\n')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="480" height="300" viewBox="0 0 480 300" font-family="${FONT}"${extra.root}>`,
    `  <title>${R.title}</title>`,
    `  <rect x="2" y="2" width="476" height="296" fill="#ffffff" stroke="#333" stroke-width="3"/>`,
    shelves,
    `  <path d="M 200 296 L 280 296" stroke="#c0392b" stroke-width="8"/>`,
    `  <text x="240" y="282" text-anchor="middle" font-size="14" fill="#c0392b">${R.labels[4]}</text>`,
    extra.inside,
    `</svg>`,
    '',
  ]
    .filter((l) => l !== '')
    .join('\n')
}

const clean = `<?xml version="1.0" encoding="UTF-8"?>\n${plan()}\n`

const hostile =
  '﻿' +
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<?xml-stylesheet type="text/css" href="http://127.0.0.1:9/sheet.css"?>`,
    `<!-- ${R.title} -->`,
    `<!DOCTYPE svg [ <!ENTITY outside SYSTEM "file:///etc/hostname"> ]>`,
    `<!-- ${R.labels[3]} -->`,
    plan({
      root: ` onload="alert(1)"`,
      inside: [
        `  <script>alert(1)</script>`,
        `  <style>@import url(http://127.0.0.1:9/import.css); rect { fill: url(http://127.0.0.1:9/fill.png) }</style>`,
        `  <image href="http://127.0.0.1:9/picture.png" x="0" y="0" width="10" height="10"/>`,
        `  <use xlink:href="http://127.0.0.1:9/symbols.svg#shelf"/>`,
        `  <a href="javascript:alert(1)"><circle cx="460" cy="20" r="8" fill="#2f5d8a" onclick="alert(1)"/></a>`,
        `  <foreignObject x="0" y="0" width="10" height="10"><iframe xmlns="http://www.w3.org/1999/xhtml" src="http://127.0.0.1:9/frame"></iframe></foreignObject>`,
        `  <set attributeName="href" to="javascript:alert(1)"/>`,
        `  <text x="10" y="20" font-size="8">&outside;</text>`,
      ].join('\n'),
    }),
    '',
  ].join('\n')

/** A small round marker, written percent-encoded the way pages often inline icons. */
const marker =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
  `<circle cx="12" cy="12" r="10" fill="#2f5d8a"/><circle cx="12" cy="12" r="4" fill="#ffffff"/></svg>`

/** The marker as a nested SVG image, at (x, y), 24 px across. */
const placedMarker = (x, y, svg = marker) =>
  `  <image x="${x}" y="${y}" width="24" height="24" href="data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}"/>`

const markedPlan = `<?xml version="1.0" encoding="UTF-8"?>\n${plan({
  root: '',
  inside: [
    `  <desc>${R.iconAlt}</desc>`,
    placedMarker(210, 60),
    placedMarker(210, 150),
    placedMarker(420, 240, marker.replace('</svg>', `<script>fetch('http://127.0.0.1:9/marker')</script></svg>`)),
  ].join('\n'),
})}\n`

/** A 24 px square of one colour, encoded as `format` (png, jpeg, webp). */
function swatch(colour, format) {
  const c = createCanvas(24, 24)
  const g = c.getContext('2d')
  g.fillStyle = colour
  g.fillRect(0, 0, 24, 24)
  g.fillStyle = '#ffffff'
  g.fillRect(8, 8, 8, 8)
  return c.encodeSync(format, 90)
}

/** A 1x1 GIF of palette entry 0 (#2f8a5d), drawn 24 px across by the <image>. */
const GIF = Buffer.from('474946383961010001008000002f8a5d0000002c00000000010001000002024401003b', 'hex')

const photoPlan = `<?xml version="1.0" encoding="UTF-8"?>\n${plan({
  root: '',
  inside: [
    `  <desc>${R.iconAlt}</desc>`,
    ...[
      ['png', swatch('#c0392b', 'png')],
      ['jpeg', swatch('#2f5d8a', 'jpeg')],
      ['gif', GIF],
      ['webp', swatch('#8a5d2f', 'webp')],
    ].map(
      ([type, bytes], i) =>
        `  <image x="${210 + i * 30}" y="120" width="24" height="24" preserveAspectRatio="none" href="data:image/${type};base64,${bytes.toString('base64')}"/>`,
    ),
  ].join('\n'),
})}\n`

const page = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>' + R.pageTitle + '</title></head>',
  '<body>',
  `<h1>${R.pageTitle}</h1>`,
  `<p>${R.pageIntro}</p>`,
  `<p><img src="data:image/svg+xml;base64,${Buffer.from(clean, 'utf8').toString('base64')}" alt="${R.title}"></p>`,
  `<p>${R.pageAfter}</p>`,
  `<p>${R.iconIntro} <img src="data:image/svg+xml,${encodeURIComponent(marker)}" alt="${R.iconAlt}" width="24" height="24"></p>`,
  '</body>',
  '</html>',
  '',
].join('\n')

/** The marker in the n-th of a run of blues and greens, so every one is a different picture. */
const markerNo = (n) => marker.replace('#2f5d8a', `#${(0x204060 + n * 0x000101).toString(16).padStart(6, '0')}`)

const SEATS = 150
const seating = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>' + R.pageTitle + '</title></head>',
  '<body>',
  `<h1>${R.pageTitle}</h1>`,
  `<p>${R.iconIntro}</p>`,
  ...Array.from({ length: SEATS / 10 }, (_, row) =>
    `<p>${Array.from({ length: 10 }, (_, k) => `<img src="data:image/svg+xml;base64,${Buffer.from(markerNo(row * 10 + k), 'utf8').toString('base64')}" alt="${R.iconAlt}" width="24" height="24">`).join(' ')}</p>`,
  ),
  `<p>${R.pageAfter}</p>`,
  '</body>',
  '</html>',
  '',
].join('\n')

for (const [name, text] of [
  ['reading-room-plan.svg', clean],
  ['reading-room-hostile.svg', hostile],
  ['reading-room-page.html', page],
  ['reading-room-marked-plan.svg', markedPlan],
  ['reading-room-photo-plan.svg', photoPlan],
  ['reading-room-seating.html', seating],
]) {
  writeFileSync(corpus(name), text)
  console.log(`wrote ${corpus(name)}`)
}
