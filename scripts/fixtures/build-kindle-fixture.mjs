#!/usr/bin/env node
/**
 * Builds `tests/corpus/reading-room-album.html`: a page with every kind of
 * picture a Kindle (AZW3) book must keep, for the e2e matrix and for looking
 * at the output by eye:
 *
 *   a photograph   a JPEG drawn here (sky, window frames, shelves), standing
 *                  in for a camera picture: the first picture, so the cover
 *   a WebP image   a format a Kindle does not show, converted on writing
 *   a diagram      a Mermaid flowchart, drawn as PNG for Kindle and Word
 *   an SVG image   the reading room plan, rasterised to PNG for Kindle and Word
 *
 * The pictures are generated, never committed by hand. Every word comes from
 * vocabulary.mjs (READING_ROOM).
 *
 *   node scripts/fixtures/build-kindle-fixture.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { READING_ROOM as R } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const corpus = (name) => join(here, '../../tests/corpus', name)

/** A window onto a morning sky above a row of shelves, with soft light. */
function photograph(width, height) {
  const c = createCanvas(width, height)
  const g = c.getContext('2d')
  const sky = g.createLinearGradient(0, 0, 0, height)
  sky.addColorStop(0, '#f6d7a7')
  sky.addColorStop(0.55, '#9cc3e4')
  sky.addColorStop(1, '#5b7fa3')
  g.fillStyle = sky
  g.fillRect(0, 0, width, height)
  // Window frames.
  g.strokeStyle = '#4a3b2c'
  g.lineWidth = 14
  for (let x = width / 6; x < width; x += width / 3) g.strokeRect(x - width / 8, height * 0.08, width / 4, height * 0.45)
  // Shelves with books of many colors.
  const colors = ['#8c2f39', '#2f5d8a', '#c79a3b', '#3e7d4f', '#6b4c8a', '#b5651d']
  for (let row = 0; row < 3; row++) {
    const y = height * 0.6 + row * height * 0.13
    g.fillStyle = '#5a4330'
    g.fillRect(0, y + height * 0.1, width, height * 0.02)
    for (let x = 8, i = row; x < width - 20; i++) {
      const w = 14 + ((i * 37) % 22)
      g.fillStyle = colors[i % colors.length]
      g.fillRect(x, y + ((i * 13) % 12), w, height * 0.1 - ((i * 13) % 12))
      x += w + 3
    }
  }
  // Morning light falling across the room.
  const light = g.createRadialGradient(width * 0.2, height * 0.2, 10, width * 0.2, height * 0.2, width * 0.9)
  light.addColorStop(0, 'rgba(255,240,200,0.45)')
  light.addColorStop(1, 'rgba(255,240,200,0)')
  g.fillStyle = light
  g.fillRect(0, 0, width, height)
  return c
}

/** Media shelves, as a WebP. */
function mediaShelves(width, height) {
  const c = createCanvas(width, height)
  const g = c.getContext('2d')
  g.fillStyle = '#e9e4da'
  g.fillRect(0, 0, width, height)
  for (let i = 0; i < 4; i++) {
    g.fillStyle = '#7a5c3e'
    g.fillRect(20, 40 + i * 60, width - 40, 10)
    for (let x = 30; x < width - 50; x += 26) {
      g.fillStyle = ['#2f5d8a', '#c0392b', '#3e7d4f'][(x / 26 + i) % 3 | 0]
      g.fillRect(x, 8 + i * 60, 20, 32)
    }
  }
  return c
}

const photo = Buffer.from(photograph(800, 600).toBuffer('image/jpeg', 88))
const webp = Buffer.from(mediaShelves(360, 260).toBuffer('image/webp'))
const plan = readFileSync(corpus('reading-room-plan.svg'))

const page = [
  '<!doctype html>',
  '<html lang="en">',
  `<head><meta charset="utf-8"><title>${R.albumTitle}</title></head>`,
  '<body>',
  `<h1>${R.albumTitle}</h1>`,
  `<p>${R.albumIntro}</p>`,
  `<p><img src="data:image/jpeg;base64,${photo.toString('base64')}" alt="${R.photoAlt}" width="800" height="600"></p>`,
  `<p>${R.photoAfter}</p>`,
  `<h2>${R.title}</h2>`,
  `<p><img src="data:image/svg+xml;base64,${plan.toString('base64')}" alt="${R.title}"></p>`,
  `<p>${R.pageAfter}</p>`,
  `<h2>${R.labels[2]}</h2>`,
  `<p><img src="data:image/webp;base64,${webp.toString('base64')}" alt="${R.webpAlt}"></p>`,
  `<p>${R.flowIntro}</p>`,
  `<pre><code class="language-mermaid">flowchart LR\n  A[${R.flow[0]}] --&gt; B[${R.flow[1]}] --&gt; C[${R.flow[2]}]</code></pre>`,
  '</body>',
  '</html>',
  '',
].join('\n')

writeFileSync(corpus('reading-room-album.html'), page)
console.log(`wrote ${corpus('reading-room-album.html')}`)
