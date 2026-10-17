import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { build } from 'esbuild'
import JSZip from 'jszip'
import { initKf8File } from '../kf8-reader.mjs'
import { KINDLE_IMAGE_MAX_BYTES } from '../../src/core/pictures'
// @ts-expect-error: a plain .mjs fixture library, no types.
import { tiff as makeTiff } from '../../scripts/fixtures/lib-tiff.mjs'

/**
 * Large pictures, converted whole by the real render host in a real
 * Electron main process (owner, 2026-10-16: the render host's 5 MB SVG and
 * 30 MB picture caps are gone). Every input is made here, none committed. Prints each
 * case's time and memory to a file with LARGE_PICTURE_TIMINGS=<path>.
 *
 * Needs a display (Electron opens a hidden window); skipped without one.
 */
const ROOT = resolve(__dirname, '..', '..')
const PAGE_DIR = join(ROOT, 'resources', 'render')
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
const MB = 1024 * 1024

/** A PNG of random noise, which does not compress: about 3 bytes a pixel. Written by hand (stored, not deflated), for speed. */
function noisePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // RGB
  const stride = width * 3 + 1
  const raw = randomBytes(stride * height)
  for (let y = 0; y < height; y++) raw[y * stride] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** An SVG of `bytes` or so: a plan of small coloured squares. */
function bigSvg(bytes: number): string {
  const parts: string[] = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const r = `<rect x="${(i * 7) % 2000}" y="${Math.floor(i / 285) % 1500}" width="6" height="6" fill="#${((i * 7919) & 0xffffff).toString(16).padStart(6, '0')}"/>`
    parts.push(r)
    size += r.length
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1500" viewBox="0 0 2000 1500">${parts.join('')}</svg>`
}

const uri = (mime: string, bytes: Buffer): string => `data:${mime};base64,${bytes.toString('base64')}`
const page = (alt: string, src: string): string => `<p>Before.</p><p><img src="${src}" alt="${alt}"></p><p>After.</p>`

type CaseResult = { ms?: number; baseMainMb?: number; peakMainMb?: number; peakAllMb?: number; advice: string[]; error?: string }

describe.skipIf(!hasDisplay)('large pictures, through the render host', () => {
  let dir: string
  let bundles: string
  let result: Record<string, CaseResult> & { fatal?: string }
  const out = (name: string): Promise<Buffer> => readFile(join(dir, 'out', name))
  let sizes: { png: number; tiff: number; svg: number }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docconv-large-'))
    await mkdir(join(dir, 'out'))
    // Under out/ (gitignored), so the bundle finds its packages in node_modules: Electron ignores NODE_PATH.
    await mkdir(join(ROOT, 'out'), { recursive: true })
    bundles = await mkdtemp(join(ROOT, 'out', 'large-pictures-'))
    const coreJs = join(bundles, 'core.cjs')
    const hostJs = join(bundles, 'render-host.js')
    await build({ entryPoints: [join(ROOT, 'src/core/index.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: coreJs, logLevel: 'silent' })
    await build({ entryPoints: [join(ROOT, 'src/main/render-host.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: hostJs, logLevel: 'silent' })

    // 40 MB each: a PNG of noise (Kindle holds PNG, but not at 40 MB), and a
    // TIFF 21,000 px wide (Word sizes a TIFF from its header, and believes
    // none wider than 20,000 px, so it is converted for Word too).
    const png = noisePng(4000, 3600)
    const tiff: Buffer = makeTiff({ width: 21_000, height: 700, rowsPerStrip: 64, pixel: (x: number, y: number) => [(x * 7) & 255, (y * 3) & 255, (x ^ y) & 255] })
    const svg = Buffer.from(bigSvg(12 * MB), 'utf8')
    sizes = { png: png.length, tiff: tiff.length, svg: svg.length }
    const files: Record<string, string> = {
      png: page('Noise', uri('image/png', png)),
      tiff: page('Panorama', uri('image/tiff', tiff)),
      svg: page('Plan', uri('image/svg+xml', svg)),
    }
    for (const [name, html] of Object.entries(files)) await writeFile(join(dir, `${name}.html`), html)
    const cases = [
      ['tiff.docx', 'docx', 'tiff'],
      ['png.docx', 'docx', 'png'],
      ['svg.docx', 'docx', 'svg'],
      ['tiff.azw3', 'azw3', 'tiff'],
      ['png.azw3', 'azw3', 'png'],
      ['svg.azw3', 'azw3', 'svg'],
    ].map(([name, target, input]) => ({ name, target, htmlFile: join(dir, `${input}.html`) }))
    await writeFile(join(dir, 'cases.json'), JSON.stringify(cases))

    const electron = require('electron') as unknown as string
    const stdout = await new Promise<string>((resolvePromise, reject) => {
      execFile(
        electron,
        ['--js-flags=--expose-gc', join(__dirname, 'large-pictures-harness.cjs'), coreJs, hostJs, PAGE_DIR, join(dir, 'cases.json'), join(dir, 'out')],
        {
          cwd: ROOT,
          timeout: 600_000,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
        },
        (err, stdoutText) => (err && !stdoutText.includes('RESULT ') ? reject(err) : resolvePromise(stdoutText)),
      )
    })
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '))
    if (!line) throw new Error(`no result from the harness:\n${stdout}`)
    result = JSON.parse(line.slice('RESULT '.length))
    if (result.fatal) throw new Error(result.fatal)
    if (process.env.LARGE_PICTURE_TIMINGS) {
      await writeFile(process.env.LARGE_PICTURE_TIMINGS, JSON.stringify({ sizes, cases: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, { ms: v.ms, baseMainMb: v.baseMainMb, peakMainMb: v.peakMainMb, peakAllMb: v.peakAllMb }])) }))
    }
  }, 660_000)

  afterAll(async () => {
    await Promise.all([dir, bundles].filter(Boolean).map((d) => rm(d, { recursive: true, force: true })))
  })

  const ok = (name: string): void => {
    expect(result[name]?.error, name).toBeUndefined()
    expect(result[name].advice, name).toEqual([])
  }

  /** Word's media parts, by name, with their bytes. */
  async function media(name: string): Promise<Buffer[]> {
    const zip = await JSZip.loadAsync(await out(name))
    const names = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !zip.files[n].dir)
    return Promise.all(names.map((n) => zip.file(n)!.async('nodebuffer')))
  }

  /** A Kindle book's pictures, as an independent reader finds them, and its text. */
  async function kindle(name: string): Promise<{ pictures: Buffer[]; html: string }> {
    const bookDir = await mkdtemp(join(dir, 'book-'))
    const file = join(bookDir, 'book.azw3')
    await writeFile(file, await out(name))
    const kf8 = await initKf8File(file, bookDir)
    let html = ''
    const pictures: Buffer[] = []
    for (const item of kf8.getSpine()) {
      const ch = kf8.loadChapter(item.id)
      html += ch ? ch.html : ''
      for (const m of (ch ? ch.html : '').matchAll(/<img[^>]+src="([^"]+)"/g)) pictures.push(await readFile(m[1]))
    }
    return { pictures, html }
  }
  const isPng = (b: Buffer): boolean => b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG'
  const isJpeg = (b: Buffer): boolean => b[0] === 0xff && b[1] === 0xd8

  it('the inputs are as large as they say', () => {
    expect(sizes.png).toBeGreaterThan(40 * MB)
    expect(sizes.tiff).toBeGreaterThan(40 * MB)
    expect(sizes.svg).toBeGreaterThan(12 * MB)
  })

  it('Word: a 40 MB TIFF it cannot size is converted to PNG', async () => {
    ok('tiff.docx')
    const parts = await media('tiff.docx')
    expect(parts).toHaveLength(1)
    expect(isPng(parts[0])).toBe(true)
    // Drawn at the canvas's largest side, 8,192 px, for a picture 21,000 px wide.
    expect(parts[0].readUInt32BE(16)).toBe(8192)
  })

  it('Word: a 40 MB PNG is kept as it is', async () => {
    ok('png.docx')
    const parts = await media('png.docx')
    expect(parts).toHaveLength(1)
    expect(parts[0].length).toBe(sizes.png)
  })

  it('Word: a 12 MB SVG gets its PNG copy', async () => {
    ok('svg.docx')
    const parts = await media('svg.docx')
    expect(parts.filter(isPng)).toHaveLength(1)
  })

  it.each(['tiff.azw3', 'png.azw3', 'svg.azw3'])('Kindle: %s is stored, under 5 MB', async (name) => {
    ok(name)
    const { pictures, html } = await kindle(name)
    expect(html).not.toContain('[image:')
    expect(pictures).toHaveLength(1)
    expect(isPng(pictures[0]) || isJpeg(pictures[0])).toBe(true)
    expect(pictures[0].length).toBeLessThanOrEqual(KINDLE_IMAGE_MAX_BYTES)
  })
})
