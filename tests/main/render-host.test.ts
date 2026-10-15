import { describe, it, expect, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

/**
 * The real render host (spec B5) in a real Electron main process: the page,
 * the session that blocks every request, the queue, the cache, the time limit
 * and the idle close. The host is bundled for the run the way build:e2e-core
 * bundles it for the matrix.
 *
 * Needs a display (Electron opens a hidden window); skipped without one.
 */
const ROOT = resolve(__dirname, '..', '..')
const PAGE_DIR = join(ROOT, 'resources', 'render')
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

type Picture = { error?: string; type?: 'png' | 'jpeg'; bytes?: number; width?: number; height?: number; magicOk?: boolean }

interface HarnessResult {
  fatal?: string
  timings: Record<string, number>
  first: { width: number; height: number; error?: string; magic?: string; pixelWidth?: number; pixelHeight?: number }
  cacheHitDrew: number
  windowMemoryKb: number[]
  hostile: Array<{
    error?: string
    config?: { securityLevel?: string; htmlLabels?: boolean; flowchartHtmlLabels?: boolean }
    rawHasJavascript: boolean | null
    rawHasForeignObject: boolean | null
    rawHasIframe: boolean | null
    svgHasRemote: boolean | null
    svgHasImport: boolean | null
  }>
  broken: string | null
  dot: string | null
  svgImage: { width?: number; height?: number; error?: string; magic?: string; pixelWidth?: number; pixelHeight?: number }
  svgHostile: { width?: number; height?: number; error?: string; magic?: string }
  svgNotOne: string | null
  pictureWebp: Picture
  pictureShrunk: Picture
  pictureAlpha: Picture
  pictureSkiaCrash: Picture
  pictureGarbage: Picture
  pictureTiff: Picture
  pictureAfter: Picture
  order: string[]
  cancelled: string
  timeout: string | null
  afterTimeout: { ok: boolean; windowsOpened: number }
  openBeforeIdle: boolean
  openAfterIdle: boolean
  reopened: boolean
  requests: Array<{ url: string; allowed: boolean }>
}

describe.skipIf(!hasDisplay)('render host in Electron', () => {
  let result: HarnessResult

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docconv-render-host-'))
    try {
      const hostJs = join(dir, 'render-host.js')
      await build({
        entryPoints: [join(ROOT, 'src/main/render-host.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        // Everything but Electron inlined: the bundle runs from a temp folder.
        external: ['electron'],
        outfile: hostJs,
        logLevel: 'silent',
      })
      const electron = require('electron') as unknown as string
      const stdout = await new Promise<string>((resolvePromise, reject) => {
        execFile(
          electron,
          [join(__dirname, 'render-host-harness.cjs'), hostJs, PAGE_DIR],
          { cwd: ROOT, timeout: 90_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } },
          (err, out) => (err && !out.includes('RESULT ') ? reject(err) : resolvePromise(out)),
        )
      })
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '))
      if (!line) throw new Error(`no result from the harness:\n${stdout}`)
      result = JSON.parse(line.slice('RESULT '.length))
      if (result.fatal) throw new Error(result.fatal)
      if (process.env.RENDER_HOST_TIMINGS) {
        console.log(JSON.stringify({ timings: result.timings, windowMemoryKb: result.windowMemoryKb }))
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('requests nothing but the bundled page and the engine beside it', () => {
    const files = result.requests.map((r) => decodeURIComponent(new URL(r.url).pathname).split('/').pop())
    expect(result.requests.every((r) => r.allowed && r.url.startsWith('file://'))).toBe(true)
    expect(new Set(files)).toEqual(new Set(['host.html', 'host.js', 'mermaid.min.js']))
    // The engine is loaded once per window, not once per diagram.
    expect(files.filter((f) => f === 'mermaid.min.js').length).toBeLessThanOrEqual(3)
  })

  it('draws a PNG at twice the CSS size', () => {
    expect(result.first.error).toBeUndefined()
    expect(result.first.magic).toBe('PNG')
    expect(result.first.width).toBeGreaterThan(100)
    expect(result.first.pixelWidth).toBe(result.first.width * 2)
    expect(result.first.pixelHeight).toBe(result.first.height * 2)
  })

  it("keeps securityLevel 'strict' and SVG labels whatever %%{init}%% says", () => {
    for (const h of result.hostile) {
      expect(h.error).toBeUndefined()
      expect(h.config).toEqual({ securityLevel: 'strict', htmlLabels: false, flowchartHtmlLabels: false })
      expect(h.rawHasJavascript).toBe(false)
      expect(h.rawHasForeignObject).toBe(false)
      expect(h.rawHasIframe).toBe(false)
      // What the engine still let through (themeCSS) the sanitiser removes.
      expect(h.svgHasRemote).toBe(false)
      expect(h.svgHasImport).toBe(false)
    }
  })

  it('answers a broken diagram with the engine message, and an engine not yet built with an error', () => {
    expect(result.broken).toBe('Parse error: the diagram ends too soon')
    expect(result.dot).toBe('dot is not drawn yet')
  })

  it('rasterises an SVG image at twice its own size (spec D10)', () => {
    expect(result.svgImage).toEqual({ width: 240, height: 150, magic: 'PNG', pixelWidth: 480, pixelHeight: 300 })
  })

  it('rasterises a hostile SVG image without a request (the request log above holds only the page), and refuses one that is not an SVG', () => {
    expect(result.svgHostile).toMatchObject({ width: 40, height: 20, magic: 'PNG' })
    expect(result.requests.some((r) => r.url.includes('127.0.0.1'))).toBe(false)
    expect(result.svgNotOne).toBe('it is not a readable SVG')
  })

  it('re-encodes a picture a Kindle cannot store: WebP to JPEG, PNG with transparency kept as PNG, each under its size', () => {
    expect(result.pictureWebp).toEqual({ type: 'jpeg', bytes: expect.any(Number), width: 300, height: 200, magicOk: true })
    expect(result.pictureShrunk).toMatchObject({ type: 'jpeg', magicOk: true })
    expect(result.pictureShrunk.bytes).toBeLessThanOrEqual(20000)
    expect(result.pictureAlpha).toMatchObject({ type: 'png', magicOk: true })
    expect(result.pictureAlpha.bytes).toBeLessThanOrEqual(30000)
    expect(result.pictureAlpha.width).toBeLessThan(200)
  })

  it('decodes pictures only in the page: a malformed one costs an answer, never the app', () => {
    // Whatever the page made of it, the host is still answering afterwards.
    expect(result.pictureSkiaCrash.error ?? result.pictureSkiaCrash.type).toBeTruthy()
    expect(result.pictureGarbage.error).toBeTruthy()
    expect(result.pictureTiff.error).toBe('it is not a picture this app reads')
    expect(result.pictureAfter).toMatchObject({ type: 'jpeg', width: 20, height: 10, magicOk: true })
  })

  it('serves a repeated request from the cache', () => {
    expect(result.cacheHitDrew).toBe(0)
  })

  it('draws visible editor blocks first, then conversions, then prefetch', () => {
    expect(result.order).toEqual(['convert-1', 'visible', 'convert-2', 'prefetch'])
  })

  it('releases a cancelled caller at once', () => {
    expect(result.cancelled).toBe('AbortError')
  })

  it('stops a block over its time limit and draws the next in a fresh window', () => {
    expect(result.timeout).toBe('drawing took longer than 0 s')
    expect(result.afterTimeout).toEqual({ ok: true, windowsOpened: 1 })
  })

  it('closes the window when idle and opens it again when needed', () => {
    expect(result.openBeforeIdle).toBe(true)
    expect(result.openAfterIdle).toBe(false)
    expect(result.reopened).toBe(true)
  })

  it('pins the engine version the build script vendors', () => {
    const script = readFileSync(join(ROOT, 'scripts/build-render-assets.mjs'), 'utf8')
    const host = readFileSync(join(ROOT, 'src/main/render-host.ts'), 'utf8')
    const vendored = /pkg: 'mermaid',\s*version: '([^']+)'/.exec(script)?.[1]
    expect(vendored).toBe('11.12.0')
    expect(host).toContain(`mermaid: '${vendored}'`)
  })
})
