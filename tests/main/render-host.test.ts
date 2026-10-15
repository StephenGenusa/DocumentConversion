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
  mathInline: any
  mathInlineSvg: { head: string; uses: number; localRefs: number; defs: boolean; style: boolean } | null
  mathDeep: any
  mathDisplay: any
  mathSumInline: any
  mathManyOk: boolean
  mathMatrix: any
  mathTagged: any
  mathPng: { width?: number; height?: number; error?: string; magic?: string; pixelWidth?: number; pixelHeight?: number }
  mathPngBaseline: number | undefined
  mathUnknown: string | null
  mathUnclosed: string | null
  mathRequire: string | null
  mathHref: string | null
  mathRecursive: string | null
  mathDefines: any
  mathLeaked: string | null
  mathPackages: Record<string, string | null>
  dotDigraph: { width?: number; height?: number; error?: string; fonts: string[]; head: string | null; hasDoctype: boolean | null }
  dotPng: { width?: number; height?: number; error?: string; magic?: string; pixelWidth?: number; pixelHeight?: number }
  dotLayered: { width?: number; height?: number; error?: string }
  dotNeato: { width?: number; height?: number; error?: string }
  dotUndirected: { width?: number; height?: number; error?: string }
  dotOwnFont: string[]
  dotBroken: string | null
  dotWrongEdge: string | null
  dotEmpty: string | null
  dotUnknownLayout: string | null
  dotSlow: { error: string | null; ms: number }
  dotAfterSlow: { width?: number; height?: number; error?: string }
  dotHostile: { error?: string; remote: boolean | null; javascript: boolean | null }
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
    expect(new Set(files)).toEqual(new Set(['host.html', 'host.js', 'mermaid.min.js', 'viz-global.js', 'tex-svg-full.js']))
    // Each engine is loaded once per window, not once per diagram (the run
    // opens four windows: first use, after each of two time-outs, after idle).
    expect(files.filter((f) => f === 'mermaid.min.js').length).toBeLessThanOrEqual(4)
    expect(files.filter((f) => f === 'viz-global.js').length).toBeLessThanOrEqual(2)
    // MathJax: one file, nothing fetched after it (no extension, font or menu file).
    expect(files.filter((f) => f === 'tex-svg-full.js').length).toBe(1)
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

  it('answers a broken diagram with the engine message', () => {
    expect(result.broken).toBe('Parse error: the diagram ends too soon')
  })

  describe('TeX (step 18)', () => {
    type M = { width?: number; height?: number; baseline?: number; error?: string; mathjax?: { verticalAlignEx: number; widthEx: number; heightEx: number } }
    /** The baseline MathJax gave (its own vertical-align, in ex at 8 px), plus the padding to the whole pixel below. */
    const expectBaseline = (m: M): void => {
      expect(m.error).toBeUndefined()
      const mj = m.mathjax!
      const pad = m.height! - mj.heightEx * 8
      expect(pad).toBeGreaterThanOrEqual(0)
      expect(pad).toBeLessThan(1)
      expect(m.baseline).toBeCloseTo(-mj.verticalAlignEx * 8 + pad, 2)
      expect(m.width).toBe(Math.ceil(mj.widthEx * 8 - 1e-6))
    }

    it('draws inline TeX as a standalone SVG in whole px, its baseline where MathJax puts it', () => {
      expectBaseline(result.mathInline)
      // x^2 sits on the line: barely any depth.
      expect(result.mathInline.baseline).toBeLessThan(2)
      expectBaseline(result.mathDeep)
      // Subscripts reach below the line: lowered by more.
      expect(result.mathDeep.baseline!).toBeGreaterThan(3)
      expect(result.mathInlineSvg).toMatchObject({ head: '<svg ', defs: true, style: false })
    })

    it("keeps MathJax's glyphs: every <use> points at a path in the picture's own <defs> (fontCache local)", () => {
      expect(result.mathInlineSvg!.uses).toBeGreaterThanOrEqual(2)
      expect(result.mathInlineSvg!.localRefs).toBe(result.mathInlineSvg!.uses)
    })

    it('draws display style larger than the same TeX inline; matrices and tagged formulas too', () => {
      expect(result.mathDisplay.error).toBeUndefined()
      expect(result.mathDisplay.height!).toBeGreaterThan(result.mathSumInline.height!)
      expect(result.mathMatrix.error).toBeUndefined()
      expect(result.mathMatrix.height!).toBeGreaterThan(30)
      // A \tag: MathJax's full-width box, given its own width and a viewBox.
      expect(result.mathTagged.error).toBeUndefined()
      expect(result.mathTagged.width!).toBeGreaterThan(100)
      expect(result.mathTagged.nested).toBeGreaterThanOrEqual(2)
      expect(result.mathTagged.rootViewBox).toBe(true)
      expect(result.mathManyOk).toBe(true)
    })

    it('draws PNG at twice the CSS size, with the baseline', () => {
      expect(result.mathPng.magic).toBe('PNG')
      expect(result.mathPng.pixelWidth).toBe(result.mathPng.width! * 2)
      expect(result.mathPng.pixelHeight).toBe(result.mathPng.height! * 2)
      expect(result.mathPngBaseline).toBeGreaterThan(0)
    })

    it("answers a mistake with MathJax's message, never red text: unknown macros (noundefined off), errors (noerrors off)", () => {
      expect(result.mathUnknown).toBe('Undefined control sequence \\foo')
      expect(result.mathUnclosed).toBe('Missing close brace')
      expect(result.mathRecursive).toMatch(/maximum macro substitution count exceeded/)
    })

    it('loads nothing on demand and takes no links: \\require and \\href are unknown', () => {
      expect(result.mathRequire).toBe('Undefined control sequence \\require')
      expect(result.mathHref).toBe('Undefined control sequence \\href')
    })

    it("keeps one formula's definitions out of the next", () => {
      expect(result.mathDefines.error).toBeUndefined()
      expect(result.mathLeaked).toBe('Undefined control sequence \\R')
    })

    it('has the extensions notebooks use, from the one file', () => {
      expect(result.mathPackages).toEqual({ boldsymbol: null, mhchem: null, cancel: null, color: null, mathtools: null, braket: null })
    })
  })

  describe('Graphviz (step 17)', () => {
    it('draws a digraph as a standalone SVG, sized in CSS px from its points, labels in the font stack', () => {
      const d = result.dotDigraph
      expect(d.error).toBeUndefined()
      expect(d.head).toBe('<svg ')
      expect(d.hasDoctype).toBe(false)
      expect(d.width).toBeGreaterThan(60)
      expect(d.height).toBeGreaterThan(100)
      // Node, edge and graph labels alike (spec B5, B8): never Graphviz's default Times.
      expect(d.fonts.length).toBeGreaterThanOrEqual(3)
      for (const f of d.fonts) expect(f).toBe('Arial, "Liberation Sans", Helvetica, sans-serif')
    })

    it('draws a PNG at twice the CSS size', () => {
      expect(result.dotPng.magic).toBe('PNG')
      expect(result.dotPng.pixelWidth).toBe(result.dotPng.width! * 2)
      expect(result.dotPng.pixelHeight).toBe(result.dotPng.height! * 2)
    })

    it("honours the graph's own layout= (neato), and draws undirected graphs", () => {
      expect(result.dotLayered.error).toBeUndefined()
      expect(result.dotNeato.error).toBeUndefined()
      // dot stacks the triangle in three ranks; neato lays it out flat.
      expect(result.dotNeato.height).toBeLessThan(result.dotLayered.height! * 0.7)
      expect(result.dotUndirected.error).toBeUndefined()
      expect(result.dotUndirected.height).toBeGreaterThan(100)
    })

    it('keeps a font the source names', () => {
      expect(result.dotOwnFont).toContain('Courier,monospace')
      expect(result.dotOwnFont).toContain('Times,serif')
      expect(result.dotOwnFont).not.toContain('Arial, "Liberation Sans", Helvetica, sans-serif')
    })

    it("answers a broken graph with Graphviz's message, made readable", () => {
      expect(result.dotBroken).toBe("Syntax error on line 1 near '}'")
      expect(result.dotWrongEdge).toBe("Syntax error on line 1 near '->'")
      expect(result.dotEmpty).toBe('Graphviz found no graph in it')
      expect(result.dotUnknownLayout).toBe('Layout type "nosuch" not recognized')
    })

    it('stops a graph Graphviz would take minutes over at the time limit, then draws the next', () => {
      expect(result.dotSlow.error).toBe('drawing took longer than 2 s')
      expect(result.dotSlow.ms).toBeLessThan(5000)
      expect(result.dotAfterSlow.error).toBeUndefined()
      expect(result.dotAfterSlow.width).toBeGreaterThan(0)
    })

    it('keeps out links, stylesheets and pictures a graph names', () => {
      expect(result.dotHostile.remote).toBe(false)
      expect(result.dotHostile.javascript).toBe(false)
    })
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
    const viz = /pkg: '@viz-js\/viz',\s*version: '([^']+)'/.exec(script)?.[1]
    expect(viz).toBe('3.31.0')
    expect(host).toContain(`dot: '${viz}'`)
    const mathjax = /pkg: 'mathjax',\s*version: '([^']+)'/.exec(script)?.[1]
    expect(mathjax).toBe('3.2.2')
    expect(host).toContain(`math: '${mathjax}'`)
  })
})
