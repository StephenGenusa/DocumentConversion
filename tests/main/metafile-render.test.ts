import { describe, it, expect, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import { build } from 'esbuild'
import { drawMetafile } from '../../src/core/metafile'
import { sanitizeSvg } from '../../src/core/svg-sanitize'
// @ts-expect-error: a plain .mjs fixture library, no types.
import { metafileCorpus } from '../../scripts/fixtures/metafile-corpus.mjs'

/**
 * The metafile corpus drawn (src/core/metafile), sanitized and rasterized
 * by the real render host, as a conversion to Kindle does: key points of
 * each picture checked for the color they should be. Needs a display;
 * skipped without one.
 */
const ROOT = resolve(__dirname, '..', '..')
const PAGE_DIR = join(ROOT, 'resources', 'render')
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

/** A PNG the page made (8-bit RGBA, not interlaced), decoded to rows of RGBA. */
function decode(b64: string): { width: number; height: number; at: (x: number, y: number) => number[] } {
  const bytes = Buffer.from(b64, 'base64')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const channels = bytes[25] === 6 ? 4 : 3
  const idat: Buffer[] = []
  for (let at = 8; at < bytes.length; ) {
    const len = bytes.readUInt32BE(at)
    if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rows: Buffer[] = []
  let prev = Buffer.alloc(stride)
  for (let r = 0; r < height; r++) {
    const filter = raw[r * (stride + 1)]
    const line = raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1))
    const row = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      row[i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]) & 0xff
    }
    rows.push(row)
    prev = row
  }
  return { width, height, at: (x, y) => [...rows[y].subarray(x * channels, x * channels + 3)] }
}

const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const WHITE = '#ffffff'

type Result = Record<string, { png?: string; width?: number; height?: number; error?: string }> & { fatal?: string }

describe.skipIf(!hasDisplay)('metafiles drawn, through the render host', () => {
  let result: Result

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docconv-metafile-'))
    try {
      const hostJs = join(dir, 'render-host.js')
      await build({ entryPoints: [join(ROOT, 'src/main/render-host.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: hostJs, logLevel: 'silent' })
      const input = metafileCorpus().map((p: { name: string; bytes: Buffer }) => {
        const r = drawMetafile(p.bytes)
        if ('error' in r) throw new Error(`${p.name}: ${r.error}`)
        return { name: p.name, svg: sanitizeSvg(r.svg) }
      })
      const json = join(dir, 'input.json')
      await writeFile(json, JSON.stringify(input))
      const electron = require('electron') as unknown as string
      const stdout = await new Promise<string>((resolvePromise, reject) => {
        execFile(
          electron,
          [join(__dirname, 'metafile-render-harness.cjs'), hostJs, PAGE_DIR, json],
          { cwd: ROOT, timeout: 90_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } },
          (err, out) => (err && !out.includes('RESULT ') ? reject(err) : resolvePromise(out)),
        )
      })
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '))
      if (!line) throw new Error(`no result from the harness:\n${stdout}`)
      result = JSON.parse(line.slice('RESULT '.length))
      if (result.fatal) throw new Error(result.fatal)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  /** The color at (x, y) in CSS px of the picture (the PNG is twice that), within a little of `want`. */
  function expectAt(name: string, x: number, y: number, want: string, slack = 24): void {
    const r = result[name]
    expect(r?.error, name).toBeUndefined()
    const img = decode(r.png!)
    const got = img.at(Math.round(x * 2), Math.round(y * 2))
    const ok = got.every((v, i) => Math.abs(v - hex(want)[i]) <= slack)
    expect(ok, `${name} at (${x}, ${y}): ${got} for ${want}`).toBe(true)
  }

  /** How many pixels in the box (CSS px) are dark: text was drawn there. */
  function inked(name: string, l: number, t: number, r: number, b: number): number {
    const img = decode(result[name].png!)
    let n = 0
    for (let y = t * 2; y < b * 2; y++) for (let x = l * 2; x < r * 2; x++) if (img.at(x, y).some((v) => v < 128)) n++
    return n
  }

  it('rasterizes every drawing at twice its size', () => {
    for (const p of metafileCorpus()) {
      const r = result[p.name]
      expect(r?.error, p.name).toBeUndefined()
      const img = decode(r.png!)
      expect([p.name, img.width, img.height]).toEqual([p.name, p.width * 2, p.height * 2])
    }
  })

  it('shapes: fills inside, white outside a rounded corner, an unfilled ellipse, a pie in its quarter only', () => {
    expectAt('shapes', 60, 40, '#3a6ea5')
    expectAt('shapes', 180, 40, '#e8a33d')
    expectAt('shapes', 132, 12, WHITE)
    expectAt('shapes', 280, 40, WHITE)
    expectAt('shapes', 85, 115, '#4f9a52')
    expectAt('shapes', 35, 165, WHITE)
  })

  it('transforms: the mapped rectangle, the turned one about its center, the scaled ellipse', () => {
    expectAt('transforms', 75, 50, '#3a6ea5')
    expectAt('transforms', 225, 100, '#e8a33d')
    expectAt('transforms', 45, 150, '#4f9a52')
    expectAt('transforms', 290, 10, WHITE)
  })

  it('clipping: inside the round window, outside it, the cut-out and its hole', () => {
    expectAt('clipping', 80, 80, '#3a6ea5')
    expectAt('clipping', 25, 25, WHITE)
    expectAt('clipping', 160, 30, '#e8a33d')
    expectAt('clipping', 190, 80, WHITE)
    expectAt('clipping', 145, 80, WHITE)
  })

  it('text: the line across, the turned words where they turn to, nothing elsewhere', () => {
    expect(inked('text', 10, 20, 150, 40)).toBeGreaterThan(200)
    expect(inked('text', 282, 110, 302, 188)).toBeGreaterThan(200)
    expect(inked('text', 30, 130, 110, 195)).toBeGreaterThan(100)
    expect(inked('text', 10, 60, 100, 100)).toBe(0)
  })

  it('hatching: lines on a clear background, lines on an opaque one', () => {
    expectAt('hatch', 20, 4, '#3a6ea5', 60)
    expectAt('hatch', 20, 1, WHITE)
    expectAt('hatch', 2, 82, '#fff2cc')
  })

  it('EMF+ only: its own shapes, alpha kept; the EMF records behind them not drawn', () => {
    expectAt('plus', 50, 40, '#4f9a52')
    expectAt('plus', 170, 40, '#9cb6d2', 16)
    expectAt('plus', 235, 155, WHITE)
  })

  it('WMF: shapes placed by the window', () => {
    expectAt('plan', 150, 35, '#e8a33d')
    expectAt('plan', 50, 100, '#4f9a52')
    expectAt('plan', 195, 5, WHITE)
  })

  it('right to left: the bar on the right, the sign ending at its mirrored place, one bitmap mirrored and one kept; Hebrew read right to left in its box', () => {
    expectAt('rtl', 215, 80, '#3a6ea5')
    expectAt('rtl', 25, 80, WHITE)
    expect(inked('rtl', 110, 22, 192, 42)).toBeGreaterThan(200)
    expect(inked('rtl', 20, 22, 100, 42)).toBe(0)
    // Red was on the bitmap's left: mirrored, it is on the right.
    expectAt('rtl', 180, 75, '#c0392b')
    expectAt('rtl', 140, 75, '#4f9a52')
    expectAt('rtl', 60, 75, '#c0392b')
    expectAt('rtl', 100, 75, '#4f9a52')
    expect(inked('rtl', 108, 120, 184, 145)).toBeGreaterThan(100)
    expect(inked('rtl', 20, 120, 104, 145)).toBe(0)
  })

  it('shading: the corner colors of the shaded square and their mix at its middle; the flood-filled rectangle and ellipse inside their outlines', () => {
    expectAt('shading', 13, 13, '#3a6ea5', 32)
    expectAt('shading', 107, 13, '#e8a33d', 32)
    expectAt('shading', 107, 107, '#4f9a52', 32)
    expectAt('shading', 13, 107, '#ffffff', 32)
    // The diagonal: blue and green mixed.
    expectAt('shading', 60, 60, '#4a8470', 32)
    expectAt('shading', 180, 40, '#4f9a52')
    expectAt('shading', 130, 40, '#c0392b', 60)
    expectAt('shading', 180, 120, '#e8a33d')
    expectAt('shading', 134, 94, WHITE)
  })

  it('EMF+ fills: the glow white at its center and blue at its edge, the pennant orange at its center, the rug striped by its tile', () => {
    expectAt('plusfills', 60, 50, WHITE, 16)
    expectAt('plusfills', 13, 50, '#3a6ea5', 40)
    expectAt('plusfills', 180, 40, '#e8a33d', 32)
    expectAt('plusfills', 133, 12, '#c0392b', 48)
    expectAt('plusfills', 236, 125, WHITE)
    expectAt('plusfills', 20, 125, '#3a6ea5')
    expectAt('plusfills', 28, 125, '#e8a33d')
  })

  it('masks: the marker round over the bar, black where the second mask is clear, the slanted photograph cut by its mask, two labels', () => {
    expectAt('masks', 60, 60, '#3a6ea5')
    expectAt('masks', 12, 12, WHITE)
    expectAt('masks', 12, 50, '#e8a33d')
    expectAt('masks', 140, 30, '#4f9a52')
    expectAt('masks', 160, 30, '#000000')
    expectAt('masks', 152, 90, '#4345a0', 40)
    expectAt('masks', 197, 130, WHITE)
    expect(inked('masks', 10, 118, 100, 134)).toBeGreaterThan(100)
    expect(inked('masks', 10, 138, 100, 154)).toBeGreaterThan(100)
  })

  it('a DIB drawn in an SVG keeps its pixels', () => {
    // The scan: 100 by 75 pixels over 200 by 150 px; pixel (50, 37) at (101, 75).
    expectAt('scan', 101, 75, `#${[Math.round((50 * 255) / 99), Math.round((37 * 255) / 74), 160].map((v) => v.toString(16).padStart(2, '0')).join('')}`, 12)
  })
})
