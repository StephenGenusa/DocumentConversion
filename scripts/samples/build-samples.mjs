#!/usr/bin/env node
/**
 * Builds the sample documents the app opens from Help -> Sample Documents,
 * into resources/samples/ (shipped with the app: electron-builder packs
 * resources/**):
 *
 *   engineering-design-note.md       a footbridge deck retrofit: a Graphviz
 *                                    load path, formulas with units (siunitx),
 *                                    a table with merged headers, an SVG
 *                                    elevation drawing, footnotes, terms
 *   software-design-specification.md a document sync service: Mermaid
 *                                    sequence, class and state diagrams, code
 *                                    in five languages, an API table
 *   lab-report.md                    reaction rate against temperature:
 *                                    display and in-sentence formulas, a
 *                                    \newcommand reused, a Mermaid flowchart,
 *                                    a data table, a plotted result (SVG) and
 *                                    a photograph (PNG)
 *   meeting-summary.md               an office move: Mermaid Gantt and mind
 *                                    map, an annotated floor plan (SVG) whose
 *                                    callouts match the action items
 *   architecture-diagram.svg         the sync service's system diagram, with
 *                                    gradients, groups, real text, a PNG logo
 *                                    and nested SVG icons
 *
 * Every word is in sample-text.mjs. Pictures are drawn here, as SVG text or
 * as PNG pixels encoded here (zlib only), so the output is the same bytes on
 * every run and every machine: no clock, no randomness but a seeded one, no
 * fonts rasterized into a PNG.
 *
 *   node scripts/samples/build-samples.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { SAMPLE_ENGINEERING, SAMPLE_SOFTWARE, SAMPLE_LAB, SAMPLE_MEETING, SAMPLE_ARCHITECTURE } from './sample-text.mjs'

export const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'samples')

// No spaces after the commas: a capitalized word, a comma and another is what the PII guard reads as a person.
const FONT = 'Helvetica,Arial,sans-serif'

/* -- small helpers ----------------------------------------------------------- */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** A number for SVG: at most two decimals, no trailing zeros. */
const n = (v) => String(Math.round(v * 100) / 100)
const b64 = (buf) => Buffer.from(buf).toString('base64')
const svgUri = (svg) => `data:image/svg+xml;base64,${b64(svg)}`
const pngUri = (png) => `data:image/png;base64,${b64(png)}`

function text(x, y, s, { size = 12, weight = 'normal', fill = '#1f2933', anchor = 'start', style = '' } = {}) {
  return `<text x="${n(x)}" y="${n(y)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${style ? ` font-style="${style}"` : ''}>${esc(s)}</text>`
}

/** Fill `{{NAME}}` and `{{KIND:name}}` places in a body. Every place must be filled. */
function fill(body, values) {
  return body.replace(/\{\{([A-Z0-9]+(?::[a-z0-9]+)?)\}\}/g, (whole, key) => {
    if (!(key in values)) throw new Error(`no value for ${whole}`)
    return values[key]
  })
}

/* -- PNG, encoded here ------------------------------------------------------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A PNG of `width` x `height` from `pixel(x, y)` -> [r, g, b] or [r, g, b, a] (0-255). */
export function encodePng(width, height, channels, pixel) {
  const row = width * channels + 1
  const raw = Buffer.alloc(row * height)
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y)
      for (let c = 0; c < channels; c++) raw[y * row + 1 + x * channels + c] = Math.max(0, Math.min(255, Math.round(p[c])))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A seeded generator (a 32-bit LCG): the same "noise" on every run. */
function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 0x19660d) + 0x3c6ef35f) >>> 0
    return s / 0x100000000
  }
}

const mix = (a, b, t) => a + (b - a) * t
const smooth = (edge0, edge1, x) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Coverage of a point by a rounded rectangle, anti-aliased over about a pixel. */
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x1 - r, x))
  const cy = Math.max(y0 + r, Math.min(y1 - r, y))
  const d = Math.hypot(x - cx, y - cy) - r
  const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1
  return inside ? 1 - smooth(-0.75, 0.75, d) : 0
}

/**
 * The Heron logo, 96 x 96: a rounded square shading from blue to teal with a
 * white ring broken by two arrowheads (the sync mark), transparent corners.
 */
export function logoPng() {
  const S = 96
  return encodePng(S, S, 4, (x, y) => {
    const px = x + 0.5
    const py = y + 0.5
    const cover = roundRect(px, py, 0, 0, S, S, 22)
    const t = (px + py) / (2 * S)
    let r = mix(0x1f, 0x16, t)
    let g = mix(0x5f, 0xa8, t)
    let b = mix(0xb0, 0xa6, t)
    const cx = S / 2
    const cy = S / 2
    const d = Math.hypot(px - cx, py - cy)
    const ang = Math.atan2(py - cy, px - cx)
    // The ring, with a gap after each arrowhead.
    const ring = 1 - smooth(5.2, 6.4, Math.abs(d - 26))
    const gapA = Math.abs(Math.atan2(Math.sin(ang - 0.35), Math.cos(ang - 0.35))) < 0.42
    const gapB = Math.abs(Math.atan2(Math.sin(ang - 0.35 - Math.PI), Math.cos(ang - 0.35 - Math.PI))) < 0.42
    let white = gapA || gapB ? 0 : ring
    // Two arrowheads, pointing along the ring at the start of each gap.
    for (const base of [0.35 - 0.42, 0.35 + Math.PI - 0.42]) {
      const ax = cx + 26 * Math.cos(base)
      const ay = cy + 26 * Math.sin(base)
      // Tangent direction (clockwise in screen coordinates).
      const tx = -Math.sin(base)
      const ty = Math.cos(base)
      const u = (px - ax) * tx + (py - ay) * ty // along
      const v = (px - ax) * Math.cos(base) + (py - ay) * Math.sin(base) // across
      if (u >= -1 && u <= 13) white = Math.max(white, 1 - smooth(-0.5, 1, Math.abs(v) - (13 - u) * 0.85))
    }
    // The dot in the middle.
    white = Math.max(white, 1 - smooth(6.5, 7.7, d))
    r = mix(r, 255, white)
    g = mix(g, 255, white)
    b = mix(b, 255, white)
    return [r, g, b, 255 * cover]
  })
}

/**
 * A photograph of six cuvettes on a bench, 720 x 220, the violet fading from
 * left to right: soft light, a little grain (seeded), so it reads as a photo.
 * `remaining` is the share of dye left in each.
 */
export function cuvettePng(remaining) {
  const W = 720
  const H = 220
  const grain = seeded(0x2026)
  const noise = Array.from({ length: W * H }, () => (grain() - 0.5) * 9)
  const violet = [88, 30, 140]
  return encodePng(W, H, 3, (x, y) => {
    const px = x + 0.5
    const py = y + 0.5
    // Bench and wall: warm gray, lit from the upper left.
    const wall = 222 - 28 * (py / H) - 18 * (px / W)
    let c = py > 176 ? [wall - 38, wall - 44, wall - 52] : [wall, wall - 3, wall - 9]
    for (let i = 0; i < remaining.length; i++) {
      const x0 = 48 + i * 112
      const x1 = x0 + 68
      const glass = roundRect(px, py, x0, 22, x1, 184, 6)
      if (glass <= 0) {
        // Its shadow on the bench.
        const sh = py > 176 && py < 196 && px > x0 + 8 && px < x1 + 26 ? 0.82 : 1
        if (sh < 1) c = c.map((v) => v * mix(1, sh, smooth(176, 182, py) * (1 - smooth(190, 196, py))))
        continue
      }
      const share = remaining[i]
      const liquid = py > 58 ? 1 : smooth(54, 58, py)
      const tint = violet.map((v, k) => mix(250 - k * 4, v, Math.pow(share, 0.8)))
      let g = c.map((v, k) => mix(v * 1.03 + 6, tint[k], liquid * 0.92))
      // A highlight down the left edge of the glass, and darker edges.
      const edge = Math.min(px - x0, x1 - px)
      const shine = smooth(9, 12, px - x0) * (1 - smooth(16, 21, px - x0))
      g = g.map((v) => mix(v, 255, shine * 0.55))
      g = g.map((v) => v * mix(0.78, 1, smooth(0, 5, edge)))
      c = c.map((v, k) => mix(v, g[k], glass))
    }
    const k = noise[y * W + x]
    return c.map((v) => v + k)
  })
}

/* -- the engineering note's elevation --------------------------------------- */

export function elevationSvg() {
  const L = SAMPLE_ENGINEERING.elevation.labels
  const W = 960
  const H = 360
  const m = 24 // px per meter
  const x0 = 48
  const deckY = 176
  const topY = deckY - 2.4 * m
  const parts = []
  const line = (xa, ya, xb, yb, stroke = '#2b3a4a', w = 2.2, extra = '') =>
    `<line x1="${n(xa)}" y1="${n(ya)}" x2="${n(xb)}" y2="${n(yb)}" stroke="${stroke}" stroke-width="${w}"${extra}/>`
  // Sky to water.
  parts.push(`<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f8fc"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
  <linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bcd9ee"/><stop offset="1" stop-color="#8fbfe0"/></linearGradient>
  <pattern id="soil" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#e7dcc8"/><path d="M0 10 L10 0" stroke="#b9a37f" stroke-width="1"/></pattern>
  <marker id="tick" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M2 8 L8 2" stroke="#4a5865" stroke-width="1.4"/></marker>
  <marker id="dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6"><circle cx="5" cy="5" r="4" fill="#c46a1b"/></marker>
</defs>`)
  parts.push(`<rect width="${W}" height="${H}" fill="url(#sky)"/>`)
  parts.push(text(24, 32, SAMPLE_ENGINEERING.elevation.title, { size: 20, weight: 'bold' }))
  parts.push(text(24, 52, L.north, { size: 13, fill: '#5b6773' }))
  // Water, riverbed and banks.
  parts.push(`<rect x="0" y="246" width="${W}" height="54" fill="url(#water)"/>`)
  let wave = 'M0 246'
  for (let x = 0; x <= W; x += 24) wave += ` Q${x + 6} 242 ${x + 12} 246 T${x + 24} 246`
  parts.push(`<path d="${wave}" fill="none" stroke="#5f97c2" stroke-width="1.2"/>`)
  parts.push(text(W / 2 + 120, 266, L.water, { size: 13, fill: '#2f5f86', style: 'italic' }))
  parts.push(`<path d="M0 300 L${W} 300 L${W} ${H} L0 ${H} Z" fill="url(#soil)"/>`)
  parts.push(`<path d="M0 196 L${x0 - 6} 196 L${x0 + 30} 300 L0 300 Z" fill="url(#soil)" stroke="#8a7a5c"/>`)
  parts.push(`<path d="M${W} 196 L${x0 + 36 * m + 6} 196 L${x0 + 36 * m - 30} 300 L${W} 300 Z" fill="url(#soil)" stroke="#8a7a5c"/>`)
  // Abutments and the pier: concrete.
  parts.push(`<rect x="${x0 - 22}" y="${deckY + 10}" width="30" height="${300 - deckY - 10}" fill="#d5d8dc" stroke="#6b7580"/>`)
  parts.push(`<rect x="${x0 + 36 * m - 8}" y="${deckY + 10}" width="30" height="${300 - deckY - 10}" fill="#d5d8dc" stroke="#6b7580"/>`)
  const pierX = x0 + 18 * m
  parts.push(`<path d="M${pierX - 14} ${deckY + 10} L${pierX + 14} ${deckY + 10} L${pierX + 20} 300 L${pierX - 20} 300 Z" fill="#d5d8dc" stroke="#6b7580"/>`)
  // Two spans of Pratt truss.
  for (let s = 0; s < 2; s++) {
    const xs = x0 + s * 18 * m
    const P = (i) => xs + i * 4.5 * m
    const truss = []
    truss.push(line(P(0), deckY, P(4), deckY)) // bottom chord
    truss.push(line(P(1), topY, P(3), topY)) // top chord
    truss.push(line(P(0), deckY, P(1), topY)) // end diagonals
    truss.push(line(P(3), topY, P(4), deckY))
    for (const i of [1, 2, 3]) truss.push(line(P(i), deckY, P(i), topY, '#2b3a4a', 1.6)) // verticals
    truss.push(line(P(1), topY, P(2), deckY, '#2b3a4a', 1.4)) // diagonals toward the middle
    truss.push(line(P(3), topY, P(2), deckY, '#2b3a4a', 1.4))
    parts.push(`<g id="span${s + 1}">${truss.join('')}</g>`)
    // The new deck along the bottom chord.
    parts.push(`<rect x="${P(0)}" y="${deckY}" width="${18 * m}" height="7" fill="#7cc495" stroke="#2f8a4e" stroke-width="1"/>`)
    // Bearings, one under each end of the span.
    for (const bx of [P(0) + (s === 0 ? 0 : 6), P(4) - (s === 0 ? 6 : 0)]) {
      parts.push(`<path d="M${bx - 7} ${deckY + 17} L${bx + 7} ${deckY + 17} L${bx} ${deckY + 8} Z" fill="#f2a65a" stroke="#c46a1b"/>`)
    }
    for (let i = 0; i <= 4; i++) parts.push(text(P(i) + (i === 0 ? 4 : i === 4 ? -4 : 0), deckY + 32, `L${i}`, { size: 12, fill: '#5b6773', anchor: i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }))
    // Span dimension above.
    const dy = topY - 26
    parts.push(line(P(0), dy, P(4), dy, '#4a5865', 1, ' marker-start="url(#tick)" marker-end="url(#tick)"'))
    parts.push(line(P(0), dy - 6, P(0), topY - 4, '#9aa5b1', 0.8))
    parts.push(line(P(4), dy - 6, P(4), topY - 4, '#9aa5b1', 0.8))
    parts.push(`<rect x="${P(2) - 52}" y="${dy - 11}" width="104" height="20" fill="#f4f8fc"/>`)
    parts.push(text(P(2), dy + 5, L.span, { size: 14, anchor: 'middle' }))
  }
  // Height dimension at the right end of span 2.
  const hx = x0 + 36 * m - 4.5 * m + 16
  parts.push(line(hx, topY, hx, deckY, '#4a5865', 1, ' marker-start="url(#tick)" marker-end="url(#tick)"'))
  parts.push(text(hx + 6, (topY + deckY) / 2 + 4, L.height, { size: 14 }))
  // Overall dimension below.
  const oy = 322
  parts.push(line(x0, oy, x0 + 36 * m, oy, '#4a5865', 1, ' marker-start="url(#tick)" marker-end="url(#tick)"'))
  parts.push(`<rect x="${pierX - 66}" y="${oy - 11}" width="132" height="20" fill="#e7dcc8"/>`)
  parts.push(text(pierX, oy + 5, L.overall, { size: 14, anchor: 'middle', weight: 'bold' }))
  // Support names.
  parts.push(text(x0 - 20, 238, L.abutmentA, { size: 13, weight: 'bold', anchor: 'start', fill: '#3d4852' }))
  parts.push(text(pierX - 26, 238, L.pier, { size: 13, weight: 'bold', anchor: 'end', fill: '#3d4852' }))
  parts.push(text(x0 + 36 * m + 20, 238, L.abutmentB, { size: 13, weight: 'bold', anchor: 'end', fill: '#3d4852' }))
  // Callouts with leaders.
  const callout = (tx, ty, ax, ay, label, color, anchor = 'start') => {
    parts.push(`<path d="M${n(tx)} ${n(ty + 4)} L${n(ax)} ${n(ay)}" stroke="${color}" stroke-width="1.1" fill="none" marker-end="url(#dot)"/>`)
    parts.push(text(tx + (anchor === 'end' ? -4 : 4), ty, label, { size: 14, weight: 'bold', fill: color, anchor }))
  }
  callout(x0 + 1.5 * m, 68, x0 + 6.8 * m, deckY + 3, L.deck, '#2f8a4e')
  callout(x0 + 10.5 * m, 68, x0 + 2 * 4.5 * m + 2, deckY - 2, L.gusset, '#c46a1b')
  callout(pierX + 3 * m, 228, pierX + 6, deckY + 13, L.bearings, '#c46a1b')
  // Scale bar.
  const sx = 24
  const sy = H - 14
  parts.push(`<rect x="${sx}" y="${sy - 6}" width="${2.5 * m}" height="5" fill="#2b3a4a"/><rect x="${sx + 2.5 * m}" y="${sy - 6}" width="${2.5 * m}" height="5" fill="#ffffff" stroke="#2b3a4a"/>`)
  parts.push(text(sx + 5 * m + 8, sy, L.scale, { size: 12, fill: '#2b3a4a' }))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
${parts.join('\n')}
</svg>
`
}

/* -- the lab report's numbers and plot -------------------------------------- */

const R_GAS = 8.314

/**
 * The five runs, worked out: a rate constant at each bath temperature from
 * an activation energy of 58 kJ/mol, each nudged by a fixed scatter (what the
 * runs "measured"), then fitted back by least squares as the report does.
 */
export function labResults() {
  const baths = [15, 20, 25, 30, 35]
  const scatter = [1.018, 0.982, 1.006, 0.99, 1.011]
  const runs = baths.map((c, i) => {
    const T = c + 273.15
    const k = 4.1e-3 * Math.exp((-58e3 / R_GAS) * (1 / T - 1 / 298.15)) * scatter[i]
    return { c, T, inv: 1000 / T, k, ln: Math.log(k), half: Math.LN2 / k }
  })
  const xs = runs.map((r) => 1 / r.T)
  const ys = runs.map((r) => r.ln)
  const mx = xs.reduce((a, b) => a + b) / xs.length
  const my = ys.reduce((a, b) => a + b) / ys.length
  const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0)
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0)
  const syy = ys.reduce((a, y) => a + (y - my) ** 2, 0)
  const slope = sxy / sxx
  const intercept = my - slope * mx
  return { runs, slope, intercept, r2: (sxy * sxy) / (sxx * syy), ea: (-slope * R_GAS) / 1000 }
}

export function plotSvg(lab) {
  const P = SAMPLE_LAB.plot
  const W = 640
  const H = 400
  const left = 78
  const right = 26
  const top = 40
  const bottom = 62
  const xMin = 3.22
  const xMax = 3.5
  const yMin = -6.6
  const yMax = -4.4
  const X = (v) => left + ((v - xMin) / (xMax - xMin)) * (W - left - right)
  const Y = (v) => H - bottom - ((v - yMin) / (yMax - yMin)) * (H - top - bottom)
  const parts = []
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`)
  parts.push(`<rect x="${left}" y="${top}" width="${W - left - right}" height="${H - top - bottom}" fill="#fbfcfe" stroke="#c9d2dc"/>`)
  for (let v = 3.25; v <= 3.5001; v += 0.05) {
    parts.push(`<line x1="${n(X(v))}" y1="${top}" x2="${n(X(v))}" y2="${H - bottom}" stroke="#e6ebf0"/>`)
    parts.push(text(X(v), H - bottom + 18, v.toFixed(2), { size: 11, anchor: 'middle', fill: '#4a5865' }))
  }
  for (let v = -6.6; v <= -4.3999; v += 0.4) {
    parts.push(`<line x1="${left}" y1="${n(Y(v))}" x2="${W - right}" y2="${n(Y(v))}" stroke="#e6ebf0"/>`)
    parts.push(text(left - 8, Y(v) + 4, v.toFixed(1).replace('-', '−'), { size: 11, anchor: 'end', fill: '#4a5865' }))
  }
  parts.push(text((left + W - right) / 2, H - 16, P.xLabel, { size: 13, anchor: 'middle' }))
  parts.push(`<text x="22" y="${(top + H - bottom) / 2}" font-size="13" fill="#1f2933" text-anchor="middle" font-style="italic" transform="rotate(-90 22 ${(top + H - bottom) / 2})">${esc(P.yLabel)}</text>`)
  parts.push(text(left, 26, P.title, { size: 16, weight: 'bold' }))
  // The fit, across the plotted range.
  const fy = (inv) => lab.intercept + lab.slope * (inv / 1000)
  parts.push(`<line x1="${n(X(3.23))}" y1="${n(Y(fy(3.23)))}" x2="${n(X(3.49))}" y2="${n(Y(fy(3.49)))}" stroke="#c0392b" stroke-width="2" stroke-dasharray="7 4"/>`)
  for (const r of lab.runs) {
    parts.push(`<circle cx="${n(X(r.inv))}" cy="${n(Y(r.ln))}" r="6" fill="#5a1e8c" stroke="#ffffff" stroke-width="1.6"/>`)
    parts.push(text(X(r.inv) + 10, Y(r.ln) - 8, `${r.c} °C`, { size: 10, fill: '#5b6773' }))
  }
  // Legend.
  const lx = W - right - 190
  const ly = top + 16
  parts.push(`<rect x="${lx}" y="${ly - 12}" width="178" height="50" rx="6" fill="#ffffff" stroke="#c9d2dc"/>`)
  parts.push(`<circle cx="${lx + 16}" cy="${ly + 2}" r="5" fill="#5a1e8c"/>`)
  parts.push(text(lx + 30, ly + 6, P.points, { size: 11 }))
  parts.push(`<line x1="${lx + 6}" y1="${ly + 24}" x2="${lx + 26}" y2="${ly + 24}" stroke="#c0392b" stroke-width="2" stroke-dasharray="7 4"/>`)
  parts.push(text(lx + 30, ly + 28, P.fit, { size: 11 }))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
${parts.join('\n')}
</svg>
`
}

/* -- the meeting summary's floor plan --------------------------------------- */

export function floorPlanSvg() {
  const T = SAMPLE_MEETING.plan
  const W = 1000
  const H = 640
  const parts = []
  const room = (x, y, w, h, label, fillColor = '#eef3f8', sub = '') => {
    parts.push(`<g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fillColor}" stroke="#34495e" stroke-width="2"/>`)
    // A name too wide for its room goes on two lines, split at the middle word.
    const words = label.split(' ')
    const lines = label.length * 8 > w - 10 && words.length > 1 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [label]
    lines.forEach((l, k) => parts.push(text(x + w / 2, y + h / 2 + (sub ? -2 : 4) + (k - (lines.length - 1) / 2) * 17, l, { size: 14, weight: 'bold', anchor: 'middle', fill: '#2c3e50' })))
    if (sub) parts.push(text(x + w / 2, y + h / 2 + 14, sub, { size: 10, anchor: 'middle', fill: '#5b6773' }))
    parts.push('</g>')
  }
  const door = (x, y, horizontal) =>
    parts.push(horizontal ? `<rect x="${x}" y="${y - 3}" width="26" height="6" fill="#ffffff"/>` : `<rect x="${x - 3}" y="${y}" width="6" height="26" fill="#ffffff"/>`)
  parts.push(`<defs>
  <linearGradient id="floor" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fdfcf9"/><stop offset="1" stop-color="#f3efe6"/></linearGradient>
  <marker id="lead" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5"><circle cx="5" cy="5" r="4" fill="#d35400"/></marker>
</defs>`)
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`)
  parts.push(text(40, 36, T.title, { size: 20, weight: 'bold', fill: '#2c3e50' }))
  // The floor.
  parts.push(`<rect x="40" y="60" width="760" height="500" fill="url(#floor)" stroke="#2c3e50" stroke-width="5"/>`)
  // Windows along the north and east walls.
  for (let x = 60; x < 790; x += 60) parts.push(`<line x1="${x}" y1="60" x2="${x + 40}" y2="60" stroke="#7fb3d5" stroke-width="5"/>`)
  for (let y = 80; y < 540; y += 60) parts.push(`<line x1="800" y1="${y}" x2="800" y2="${y + 40}" stroke="#7fb3d5" stroke-width="5"/>`)
  // Rooms on the north side.
  room(40, 60, 290, 160, T.rooms.studio, '#f6eefb')
  door(250, 220, true)
  room(330, 60, 100, 110, T.rooms.quietA, '#eaf6ef')
  door(368, 170, true)
  room(430, 60, 100, 110, T.rooms.quietB, '#eaf6ef')
  door(468, 170, true)
  room(560, 60, 240, 150, T.rooms.meeting)
  door(600, 210, true)
  // Service rooms on the south side.
  room(40, 440, 170, 120, T.rooms.reception, '#fdf2e3')
  room(210, 450, 140, 110, T.rooms.kitchen, '#fdf2e3')
  door(260, 450, true)
  room(350, 470, 110, 90, T.rooms.print)
  door(392, 470, true)
  room(460, 470, 60, 90, T.rooms.it, '#e9ecef')
  room(520, 450, 90, 110, T.rooms.lift, '#e9ecef')
  room(610, 450, 80, 110, T.rooms.stairs, '#e9ecef')
  // The entrance: a gap in the south wall at reception.
  parts.push(`<rect x="154" y="555" width="48" height="10" fill="#ffffff"/>`)
  parts.push(`<path d="M154 560 A48 48 0 0 1 202 512" fill="none" stroke="#9aa5b1" stroke-dasharray="3 3"/>`)
  // Lockers along the south wall east of the stairs.
  parts.push(`<g>`)
  for (let i = 0; i < 6; i++) parts.push(`<rect x="${698 + i * 16}" y="528" width="14" height="28" fill="#d6dde4" stroke="#5b6773"/>`)
  parts.push(text(746, 520, T.rooms.lockers, { size: 13, weight: 'bold', anchor: 'middle', fill: '#2c3e50' }))
  parts.push(`</g>`)
  // Desk groups in the open area.
  const deskGroup = (x, y, cols, label, count, accent) => {
    const g = [`<g>`]
    g.push(`<rect x="${x - 10}" y="${y - 24}" width="${cols * 38 + 16}" height="98" rx="10" fill="${accent}" fill-opacity="0.18" stroke="${accent}" stroke-dasharray="4 3"/>`)
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < cols; c++) g.push(`<rect x="${x + c * 38}" y="${y + r * 34}" width="34" height="24" rx="2" fill="#ffffff" stroke="#34495e"/>`)
    }
    g.push(text(x - 2, y - 9, `${label} · ${count} ${T.deskCount}`, { size: 11, weight: 'bold', fill: '#2c3e50' }))
    g.push('</g>')
    parts.push(g.join(''))
  }
  deskGroup(70, 270, 5, T.desks[1], 10, '#8e44ad')
  deskGroup(300, 270, 5, T.desks[2], 10, '#2980b9')
  deskGroup(300, 380, 5, T.desks[3], 10, '#16a085')
  deskGroup(572, 350, 4, T.desks[0], 8, '#27ae60')
  // The four adjustable desks in desk group 1.
  for (let c = 0; c < 4; c++) parts.push(`<rect x="${572 + c * 38 + 4}" y="${350 + 34 + 4}" width="26" height="16" fill="#27ae60" fill-opacity="0.5"/>`)
  // The step-free route: entrance to the elevators and desk group 1.
  parts.push(`<path d="M178 548 L178 420 L560 420 L560 450 M560 420 L640 420 L640 446" fill="none" stroke="#27ae60" stroke-width="4" stroke-dasharray="10 6" stroke-linecap="round"/>`)
  // Numbered callouts, matching the action items.
  const callouts = [
    [470, 250, 420, 300],
    [430, 196, 430, 150],
    [760, 312, 700, 380],
    [180, 604, 262, 546],
    [380, 604, 406, 548],
    [790, 600, 740, 545],
  ]
  callouts.forEach(([cx, cy, ax, ay], i) => {
    parts.push(`<g><path d="M${cx} ${cy} L${ax} ${ay}" stroke="#d35400" stroke-width="1.6" marker-end="url(#lead)"/>`)
    parts.push(`<circle cx="${cx}" cy="${cy}" r="14" fill="#d35400" stroke="#ffffff" stroke-width="2"/>`)
    parts.push(text(cx, cy + 5, String(i + 1), { size: 14, weight: 'bold', anchor: 'middle', fill: '#ffffff' }))
    parts.push('</g>')
  })
  // Legend.
  const lx = 822
  parts.push(`<g><rect x="${lx}" y="60" width="170" height="372" rx="8" fill="#ffffff" stroke="#c9d2dc"/>`)
  parts.push(text(lx + 12, 84, T.legend.title, { size: 14, weight: 'bold', fill: '#2c3e50' }))
  parts.push(`<rect x="${lx + 12}" y="98" width="28" height="18" rx="2" fill="#ffffff" stroke="#34495e"/>`)
  parts.push(text(lx + 48, 112, T.legend.desk, { size: 13 }))
  parts.push(`<rect x="${lx + 12}" y="126" width="28" height="18" fill="#eef3f8" stroke="#34495e" stroke-width="2"/>`)
  parts.push(text(lx + 48, 140, T.legend.room, { size: 13 }))
  parts.push(`<line x1="${lx + 12}" y1="163" x2="${lx + 40}" y2="163" stroke="#27ae60" stroke-width="4" stroke-dasharray="8 5"/>`)
  parts.push(text(lx + 48, 167, T.legend.route, { size: 13 }))
  parts.push(`<circle cx="${lx + 26}" cy="190" r="10" fill="#d35400"/>`)
  parts.push(text(lx + 48, 194, T.legend.callout, { size: 13 }))
  T.callouts.forEach((label, i) => {
    const y = 228 + i * 32
    parts.push(`<circle cx="${lx + 24}" cy="${y}" r="11" fill="#d35400"/>`)
    parts.push(text(lx + 24, y + 4, String(i + 1), { size: 12, weight: 'bold', anchor: 'middle', fill: '#ffffff' }))
    parts.push(text(lx + 42, y + 5, label, { size: 13 }))
  })
  parts.push('</g>')
  // North arrow and scale.
  parts.push(`<g transform="translate(895 490)"><path d="M0 -34 L10 0 L0 -8 L-10 0 Z" fill="#2c3e50"/>${text(0, 16, T.north, { size: 11, anchor: 'middle', weight: 'bold' })}</g>`)
  parts.push(`<rect x="822" y="590" width="50" height="6" fill="#2c3e50"/><rect x="872" y="590" width="50" height="6" fill="#ffffff" stroke="#2c3e50"/>`)
  parts.push(text(822, 614, T.scale, { size: 12 }))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
${parts.join('\n')}
</svg>
`
}

/* -- the architecture diagram ------------------------------------------------ */

/** A padlock, 24 x 24: its own SVG, placed in the diagram as a nested SVG picture. */
export function lockIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
<defs><linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7c948"/><stop offset="1" stop-color="#e0a800"/></linearGradient></defs>
<path d="M7 11 V7.5 a5 5 0 0 1 10 0 V11" fill="none" stroke="#7a5b00" stroke-width="2.2"/>
<rect x="4" y="10.5" width="16" height="12" rx="2.5" fill="url(#body)" stroke="#7a5b00" stroke-width="1.2"/>
<circle cx="12" cy="15.6" r="1.8" fill="#7a5b00"/><rect x="11.2" y="16.4" width="1.6" height="3.4" fill="#7a5b00"/>
</svg>
`
}

export function architectureSvg() {
  const A = SAMPLE_ARCHITECTURE
  const W = 1200
  const H = 800
  const parts = []
  parts.push(`<defs>
  <linearGradient id="header" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#173f73"/><stop offset="1" stop-color="#127a85"/></linearGradient>
  <linearGradient id="service" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e3eefb"/></linearGradient>
  <linearGradient id="core" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f86d6"/><stop offset="1" stop-color="#1f5fb0"/></linearGradient>
  <linearGradient id="queue" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff4e0"/><stop offset="1" stop-color="#ffe0b0"/></linearGradient>
  <linearGradient id="store" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#d9e8d4"/><stop offset="0.5" stop-color="#f3f8f1"/><stop offset="1" stop-color="#c9ddc2"/></linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.5" r="0.6"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  <filter id="shadow" x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#1b2a3a" flood-opacity="0.18"/></filter>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="#2c3e50"/></marker>
  <marker id="arrow-event" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="#d97706"/></marker>
  <marker id="arrow-data" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="#6b7d5c"/></marker>
</defs>`)
  parts.push(`<rect width="${W}" height="${H}" fill="#f7f9fc"/>`)
  // Header, with the logo (a PNG) and the title.
  parts.push(`<g id="header"><rect width="${W}" height="92" fill="url(#header)"/><rect width="${W}" height="92" fill="url(#glow)"/>`)
  parts.push(`<image x="28" y="14" width="64" height="64" href="${pngUri(logoPng())}"><title>${esc(A.logoAlt)}</title></image>`)
  parts.push(text(110, 46, A.title, { size: 26, weight: 'bold', fill: '#ffffff' }))
  parts.push(text(110, 72, A.subtitle, { size: 15, fill: '#d6ecf3' }))
  parts.push('</g>')
  // Lanes.
  const lanes = [
    [24, 196, A.lanes.clients],
    [232, 170, A.lanes.edge],
    [414, 236, A.lanes.services],
    [662, 250, A.lanes.events],
    [924, 252, A.lanes.data],
  ]
  parts.push('<g id="lanes">')
  for (const [x, w, label] of lanes) {
    parts.push(`<rect x="${x}" y="112" width="${w}" height="560" rx="12" fill="#ffffff" stroke="#dbe3ec"/>`)
    parts.push(text(x + w / 2, 138, label.toUpperCase(), { size: 12, weight: 'bold', anchor: 'middle', fill: '#7b8a99' }))
  }
  parts.push('</g>')
  const box = (x, y, w, h, title, note, { fill = 'url(#service)', stroke = '#3f6fa8', color = '#1f2933', noteColor = '#5b6773', id = '' } = {}) => {
    parts.push(`<g${id ? ` id="${id}"` : ''} filter="url(#shadow)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`)
    parts.push(text(x + w / 2, y + h / 2 - (note ? 4 : -5), title, { size: 15, weight: 'bold', anchor: 'middle', fill: color }))
    if (note) parts.push(text(x + w / 2, y + h / 2 + 15, note, { size: 11, anchor: 'middle', fill: noteColor }))
    parts.push('</g>')
  }
  // Device icons: nested <svg> elements, each its own coordinate system.
  const devices = [
    '<rect x="2" y="3" width="20" height="13" rx="1.5" fill="#dbe8f7" stroke="#2c4a6e" stroke-width="1.5"/><path d="M8 20 H16 M12 16 V20" stroke="#2c4a6e" stroke-width="1.5"/>',
    '<rect x="6" y="2" width="12" height="20" rx="2.5" fill="#dbe8f7" stroke="#2c4a6e" stroke-width="1.5"/><circle cx="12" cy="18.5" r="1" fill="#2c4a6e"/>',
    '<rect x="2" y="4" width="20" height="16" rx="2" fill="#dbe8f7" stroke="#2c4a6e" stroke-width="1.5"/><path d="M2 8 H22" stroke="#2c4a6e" stroke-width="1.5"/><circle cx="5" cy="6" r="0.9" fill="#2c4a6e"/><circle cx="8" cy="6" r="0.9" fill="#2c4a6e"/>',
  ]
  const clientY = [176, 296, 416]
  A.clients.forEach((label, i) => {
    const y = clientY[i]
    parts.push(`<g id="client${i + 1}" filter="url(#shadow)"><rect x="44" y="${y}" width="156" height="72" rx="10" fill="url(#service)" stroke="#3f6fa8" stroke-width="1.5"/>`)
    parts.push(`<svg x="56" y="${y + 20}" width="32" height="32" viewBox="0 0 24 24">${devices[i]}</svg>`)
    parts.push(text(96, y + 42, label, { size: 14, weight: 'bold' }))
    parts.push('</g>')
  })
  parts.push(text(122, 520, A.clientNote, { size: 11, anchor: 'middle', fill: '#5b6773', style: 'italic' }))
  // Gateway.
  box(248, 278, 138, 108, A.gateway, A.gatewayNote, { id: 'gateway' })
  // Services: auth (with the padlock, a nested SVG picture), sync (the core), attachments.
  box(434, 168, 196, 84, A.services.auth, A.serviceNotes.auth, { id: 'auth' })
  parts.push(`<image x="444" y="176" width="26" height="26" href="${svgUri(lockIconSvg())}"/>`)
  box(434, 290, 196, 96, A.services.sync, A.serviceNotes.sync, { id: 'sync', fill: 'url(#core)', stroke: '#173f73', color: '#ffffff', noteColor: '#dbe9fa' })
  box(434, 428, 196, 84, A.services.blob, A.serviceNotes.blob, { id: 'blob' })
  // The change queue: a box of message slots.
  parts.push(`<g id="queue" filter="url(#shadow)"><rect x="684" y="404" width="206" height="76" rx="10" fill="url(#queue)" stroke="#d97706" stroke-width="1.5"/>`)
  for (let i = 0; i < 4; i++) parts.push(`<rect x="${698 + i * 14}" y="418" width="10" height="20" rx="2" fill="#f59e0b" fill-opacity="${n(0.4 + i * 0.15)}"/>`)
  parts.push(text(762, 434, A.queue, { size: 14, weight: 'bold' }))
  parts.push(text(787, 464, A.queueNote, { size: 11, anchor: 'middle', fill: '#7c4a03' }))
  parts.push('</g>')
  box(700, 548, 174, 60, A.workers.notifier, '', { id: 'notifier', fill: '#fff8ec', stroke: '#d97706' })
  box(700, 168, 174, 64, A.workers.indexer, '', { id: 'indexer', fill: '#fff8ec', stroke: '#d97706' })
  // Data stores: cylinders, each a nested <svg>.
  const cylinder = (x, y, title, note, id) => {
    parts.push(`<g id="${id}" filter="url(#shadow)"><svg x="${x}" y="${y}" width="212" height="96" viewBox="0 0 212 96">`)
    parts.push(`<path d="M2 14 V82 A104 12 0 0 0 210 82 V14" fill="url(#store)" stroke="#5f7d52" stroke-width="1.5"/><ellipse cx="106" cy="14" rx="104" ry="12" fill="#eef5eb" stroke="#5f7d52" stroke-width="1.5"/>`)
    parts.push(text(106, 52, title, { size: 15, weight: 'bold', anchor: 'middle' }))
    parts.push(text(106, 70, note, { size: 11, anchor: 'middle', fill: '#4d6142' }))
    parts.push('</svg></g>')
  }
  cylinder(944, 164, A.stores.search, A.storeNotes.search, 'search')
  cylinder(944, 292, A.stores.meta, A.storeNotes.meta, 'meta')
  cylinder(944, 420, A.stores.objects, A.storeNotes.objects, 'objects')
  // Arrows.
  const req = (d) => parts.push(`<path d="${d}" fill="none" stroke="#2c3e50" stroke-width="2" marker-end="url(#arrow)"/>`)
  const evt = (d) => parts.push(`<path d="${d}" fill="none" stroke="#d97706" stroke-width="2" stroke-dasharray="7 5" marker-end="url(#arrow-event)"/>`)
  const data = (d) => parts.push(`<path d="${d}" fill="none" stroke="#6b7d5c" stroke-width="2.4" marker-start="url(#arrow-data)" marker-end="url(#arrow-data)"/>`)
  parts.push('<g id="arrows">')
  for (const y of clientY) req(`M200 ${y + 36} C224 ${y + 36} 222 332 246 332`)
  req('M386 316 C410 316 408 210 432 210')
  req('M386 332 L432 336')
  req('M386 350 C410 350 408 470 432 470')
  data('M632 338 L942 338')
  data('M632 500 L942 500')
  evt('M632 372 C660 380 660 430 682 438')
  evt('M786 402 L786 236')
  evt('M786 482 L786 544')
  data('M876 200 L942 210')
  // The notifier pushes back to the clients, along the bottom.
  evt('M698 584 C620 650 300 646 140 640 C104 638 104 574 120 528')
  parts.push(`<rect x="300" y="632" width="160" height="22" rx="11" fill="#fff4e0" stroke="#d97706"/>`)
  parts.push(text(380, 647, A.push, { size: 11, anchor: 'middle', fill: '#7c4a03', weight: 'bold' }))
  parts.push('</g>')
  // Legend.
  const ly = 700
  parts.push(`<g id="legend"><rect x="24" y="${ly - 14}" width="830" height="84" rx="10" fill="#ffffff" stroke="#dbe3ec"/>`)
  parts.push(text(44, ly + 10, A.legend.title, { size: 13, weight: 'bold' }))
  parts.push(`<path d="M44 ${ly + 36} L92 ${ly + 36}" stroke="#2c3e50" stroke-width="2" marker-end="url(#arrow)"/>`)
  parts.push(text(100, ly + 40, A.legend.request, { size: 12 }))
  parts.push(`<path d="M250 ${ly + 36} L298 ${ly + 36}" stroke="#d97706" stroke-width="2" stroke-dasharray="7 5" marker-end="url(#arrow-event)"/>`)
  parts.push(text(306, ly + 40, A.legend.event, { size: 12 }))
  parts.push(`<path d="M496 ${ly + 36} L544 ${ly + 36}" stroke="#6b7d5c" stroke-width="2.4" marker-start="url(#arrow-data)" marker-end="url(#arrow-data)"/>`)
  parts.push(text(552, ly + 40, A.legend.data, { size: 12 }))
  parts.push(`<rect x="664" y="${ly + 22}" width="30" height="22" rx="5" fill="url(#service)" stroke="#3f6fa8"/>`)
  parts.push(text(700, ly + 38, A.legend.service, { size: 12 }))
  parts.push(`<svg x="664" y="${ly + 50}" width="30" height="18" viewBox="0 0 30 18"><path d="M1 4 V14 A14 3 0 0 0 29 14 V4" fill="url(#store)" stroke="#5f7d52"/><ellipse cx="15" cy="4" rx="14" ry="3" fill="#eef5eb" stroke="#5f7d52"/></svg>`)
  parts.push(text(700, ly + 64, A.legend.store, { size: 12 }))
  parts.push('</g>')
  parts.push(text(W - 24, H - 24, A.footer, { size: 12, anchor: 'end', fill: '#7b8a99', style: 'italic' }))
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<title>${esc(A.title)}</title>
${parts.join('\n')}
</svg>
`
}

/* -- the documents ----------------------------------------------------------- */

const image = (alt, uri) => `![${alt}](${uri})`

/** A number with a true minus sign. */
const minus = (s) => s.replace(/^-/, '−')

function labValues() {
  const lab = labResults()
  const rows = lab.runs
    .map((r) => `| ${r.c} | ${r.T.toFixed(2)} | ${r.inv.toFixed(4)} | ${(r.k * 1000).toFixed(2)} | ${minus(r.ln.toFixed(3))} | ${r.half.toFixed(0)} |`)
    .join('\n')
  const af = Math.exp(lab.intercept)
  const exp = Math.floor(Math.log10(af))
  const r25 = lab.runs.find((r) => r.c === 25)
  const r35 = lab.runs.find((r) => r.c === 35)
  return {
    lab,
    values: {
      'TABLE:rates': rows,
      EA: lab.ea.toFixed(1),
      SLOPE: minus(Math.round(lab.slope).toLocaleString('en-US')),
      AF: `${(af / 10 ** exp).toFixed(1)} × 10<sup>${exp}</sup>`,
      R2: lab.r2.toFixed(4),
      HALF25: r25.half.toFixed(0),
      HALF25ROUND: String(Math.round(r25.half / 10) * 10 + 10),
      RATIO: (r35.k / r25.k).toFixed(2),
    },
  }
}

/** Every sample: its file name and bytes, in menu order. */
export function buildSamples() {
  const { lab, values } = labValues()
  // The 25 °C run, every two minutes: the share of dye left.
  const k25 = lab.runs.find((r) => r.c === 25).k
  const remaining = [0, 120, 240, 360, 480, 600].map((t) => Math.exp(-k25 * t))
  return [
    {
      file: SAMPLE_ENGINEERING.file,
      bytes: Buffer.from(fill(SAMPLE_ENGINEERING.body, { 'FIG:elevation': image(SAMPLE_ENGINEERING.elevationAlt, svgUri(elevationSvg())) })),
    },
    { file: SAMPLE_SOFTWARE.file, bytes: Buffer.from(fill(SAMPLE_SOFTWARE.body, {})) },
    {
      file: SAMPLE_LAB.file,
      bytes: Buffer.from(
        fill(SAMPLE_LAB.body, {
          ...values,
          'FIG:plot': image(SAMPLE_LAB.plotAlt, svgUri(plotSvg(lab))),
          'FIG:cuvettes': image(SAMPLE_LAB.cuvetteAlt, pngUri(cuvettePng(remaining))),
        }),
      ),
    },
    {
      file: SAMPLE_MEETING.file,
      bytes: Buffer.from(fill(SAMPLE_MEETING.body, { 'FIG:plan': image(SAMPLE_MEETING.planAlt, svgUri(floorPlanSvg())) })),
    },
    { file: SAMPLE_ARCHITECTURE.file, bytes: Buffer.from(architectureSvg()) },
  ]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(SAMPLES_DIR, { recursive: true })
  for (const { file, bytes } of buildSamples()) {
    writeFileSync(join(SAMPLES_DIR, file), bytes)
    console.log(`wrote resources/samples/${file} (${bytes.length} bytes)`)
  }
}
