import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { runHarness } from './electron-harness'

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
  mathBm: { error: string | null; same: boolean }
  mathUnclosed: string | null
  mathRequire: string | null
  mathHref: string | null
  mathRecursive: string | null
  mathDefines: any
  mathLeaked: string | null
  mathCarried: string | null
  mathShortcuts: Record<string, string>
  mathOwnShortcut: Record<string, string>
  mathSiunitx: Record<string, string | null>
  mathPackages: Record<string, string | null>
  dotDigraph: { width?: number; height?: number; error?: string; fonts: string[]; head: string | null; hasDoctype: boolean | null }
  dotPng: { width?: number; height?: number; error?: string; magic?: string; pixelWidth?: number; pixelHeight?: number }
  dotLayered: { width?: number; height?: number; error?: string }
  dotNeato: { width?: number; height?: number; error?: string }
  dotUndirected: { width?: number; height?: number; error?: string }
  dotOwnFont: string[]
  labelPx: { mermaid: number | null; dot: Array<number | string>; dotOwnSize: Array<number | string> }
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
  svgNested: { left?: string; right?: string; error?: string }
  svgRasters: string[] | { error?: string }
  pictureWebp: Picture
  pictureShrunk: Picture
  pictureAlpha: Picture
  pictureSkiaCrash: Picture
  pictureGarbage: Picture
  pictureTiff: Picture
  pictureTiffLzw: Picture
  pictureTiffAlpha: Picture
  pictureTiffBilevel: Picture
  pictureTiffBilevelPng: Picture
  pictureWebpPng: Picture
  pictureAlphaJpeg: Picture
  pictureAutoPhoto: Picture
  pictureAutoDrawing: Picture
  pictureAutoAlpha: Picture
  pictureRefit: Picture
  pictureTiffLoop: Picture
  pictureTiffPage2: Picture
  pictureTiffPage3: Picture
  pictureTiffPixels: string[] | string
  pictureTiffVast: Picture
  pictureAfter: Picture
  order: string[]
  canceled: string
  timeout: string | null
  afterTimeout: { ok: boolean; windowsOpened: number }
  openBeforeIdle: boolean
  openAfterIdle: boolean
  reopened: boolean
  requests: Array<{ url: string; allowed: boolean }>
  mermaidHues: Record<string, number | string>
  mindmapPairs: Array<{ section: string; fill?: string; text?: string }>
  mindmapRootText: string | null
}

/** WCAG contrast of two colors given as #rgb, #rrggbb, white or black. */
const { contrast } = createRequire(import.meta.url)(join(PAGE_DIR, 'mermaid-colors.js')) as { contrast: (a: string, b: string) => number }

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
      result = await runHarness<HarnessResult>([join(__dirname, 'render-host-harness.cjs'), hostJs, PAGE_DIR], { cwd: ROOT, timeout: 90_000 })
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
    expect(new Set(files)).toEqual(
      new Set(['host.html', 'picture-kind.js', 'mermaid-colors.js', 'host.js', 'mermaid.min.js', 'viz-global.js', 'tex-svg-full.js', 'pako-inflate.min.js', 'utif.js']),
    )
    // The TIFF decoder, once, with the inflate it needs loaded first.
    expect(files.filter((f) => f === 'utif.js').length).toBe(1)
    expect(files.indexOf('pako-inflate.min.js')).toBeLessThan(files.indexOf('utif.js'))
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
      // What the engine still let through (themeCSS) the sanitizer removes.
      expect(h.svgHasRemote).toBe(false)
      expect(h.svgHasImport).toBe(false)
    }
  })

  it("draws mind maps, pies, timelines, journeys, git graphs, quadrants, kanbans, XY charts and Gantt charts in color; flowcharts and sequence diagrams stay gray", () => {
    const h = result.mermaidHues
    expect(h.mindmap).toBeGreaterThanOrEqual(4)
    expect(h.pie).toBeGreaterThanOrEqual(4)
    expect(h.timeline).toBeGreaterThanOrEqual(3)
    expect(h.journey).toBeGreaterThanOrEqual(2)
    expect(h.gitGraph).toBeGreaterThanOrEqual(3)
    // Pale quarters (under the colored-pixel line) and blue points.
    expect(h.quadrant).toBeGreaterThanOrEqual(1)
    expect(h.kanban).toBeGreaterThanOrEqual(2)
    expect(h.xychart).toBeGreaterThanOrEqual(2)
    expect(h.gantt).toBeGreaterThanOrEqual(1)
    expect(h.flowchart).toBe(0)
    expect(h.sequence).toBe(0)
    // A diagram that names its own theme is drawn in it.
    expect(h.ownTheme).toBe(0)
  })

  it("sets a mind map's labels to read on their colored fills (contrast at least 4.5:1)", () => {
    expect(result.mindmapPairs).toHaveLength(5)
    for (const p of result.mindmapPairs) {
      expect(p.fill, p.section).toMatch(/^#/)
      expect(contrast(p.fill!, p.text!), p.section).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("centers a mind map circle's label on it (Mermaid starts an SVG label at the center)", () => {
    expect(result.mindmapRootText).toContain('text-anchor="middle"')
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

    it('draws \\bm as \\boldsymbol (the bm package\'s macro, common in papers)', () => {
      expect(result.mathBm).toEqual({ error: null, same: true })
    })

    it('loads nothing on demand and takes no links: \\require and \\href are unknown', () => {
      expect(result.mathRequire).toBe('Undefined control sequence \\require')
      expect(result.mathHref).toBe('Undefined control sequence \\href')
    })

    it("keeps one formula's definitions out of the next", () => {
      expect(result.mathDefines.error).toBeUndefined()
      expect(result.mathLeaked).toBe('Undefined control sequence \\Reals')
    })

    it('draws the home-made shortcuts \\R \\N \\Z \\C \\Q as blackboard bold, unless the formula defines its own', () => {
      expect(result.mathShortcuts).toEqual({ R: 'same', N: 'same', Z: 'same', C: 'same', Q: 'same' })
      expect(result.mathOwnShortcut).toEqual({ newcommand: 'same', renewcommand: 'same', def: 'same', after: 'same' })
    })

    it('draws siunitx quantities: the number, a thin space, the unit upright; an unknown unit is named as such', () => {
      const { unknownUnit, unclosed, ...drawn } = result.mathSiunitx
      expect(drawn).toEqual({ SI: 'same', exponent: 'same', prefixes: 'same', micro: 'same', literal: 'same', num: 'same', celsius: 'same' })
      expect(unknownUnit).toBe('siunitx unit \\furlong is not supported')
      expect(unclosed).toBe('Missing close brace in \\SI')
    })

    it('draws a formula with definitions carried in front of it, a display environment and its tag too', () => {
      expect(result.mathCarried).toBeNull()
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

    it("honors the graph's own layout= (neato), and draws undirected graphs", () => {
      expect(result.dotLayered.error).toBeUndefined()
      expect(result.dotNeato.error).toBeUndefined()
      // dot stacks the triangle in three ranks; neato lays it out flat.
      expect(result.dotNeato.height).toBeLessThan(result.dotLayered.height! * 0.7)
      expect(result.dotUndirected.error).toBeUndefined()
      expect(result.dotUndirected.height).toBeGreaterThan(100)
    })

    it("sets labels at Mermaid's size, and keeps a size the source names", () => {
      // Graphviz's own default, 14 pt, showed at 18.7 px beside Mermaid's 16.
      expect(result.labelPx.mermaid).toBe(16)
      expect(result.labelPx.dot).toEqual([16])
      // fontsize=30 on the graph, 20 on nodes, 9 on the edge: points, shown in px.
      expect([...result.labelPx.dotOwnSize].sort()).toEqual([12, 26.7, 40])
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

  it('rasterizes an SVG image at twice its own size (spec D10)', () => {
    expect(result.svgImage).toEqual({ width: 240, height: 150, magic: 'PNG', pixelWidth: 480, pixelHeight: 300 })
  })

  it('rasterizes a hostile SVG image without a request (the request log above holds only the page), and refuses one that is not an SVG', () => {
    expect(result.svgHostile).toMatchObject({ width: 40, height: 20, magic: 'PNG' })
    expect(result.requests.some((r) => r.url.includes('127.0.0.1'))).toBe(false)
    expect(result.svgNotOne).toBe('it is not a readable SVG')
  })

  it('draws an SVG image nested in an SVG image, without the request its script would make', () => {
    expect(result.svgNested).toEqual({ left: '#0000ff', right: '#ff0000' })
    expect(result.requests.some((r) => r.url.includes('/nested'))).toBe(false)
  })

  it('draws PNG, JPEG, GIF and WebP pictures placed in an SVG image', () => {
    expect(Array.isArray(result.svgRasters), JSON.stringify(result.svgRasters)).toBe(true)
    const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const near = (hex: string, want: string): boolean => rgb(hex).every((v, i) => Math.abs(v - rgb(want)[i]) <= 8)
    const [png, jpeg, gif, webp] = result.svgRasters as string[]
    expect(png).toBe('#ff0000')
    expect(near(jpeg, '#00ff00'), jpeg).toBe(true)
    expect(gif).toBe('#0000ff')
    expect(near(webp, '#ffff00'), webp).toBe(true)
  })

  it('re-encodes a picture a Kindle cannot store: WebP to JPEG, PNG with transparency kept as PNG, each under its size', () => {
    expect(result.pictureWebp).toEqual({ type: 'jpeg', bytes: expect.any(Number), width: 300, height: 200, magicOk: true })
    expect(result.pictureShrunk).toMatchObject({ type: 'jpeg', magicOk: true })
    expect(result.pictureShrunk.bytes).toBeLessThanOrEqual(20000)
    expect(result.pictureAlpha).toMatchObject({ type: 'png', magicOk: true })
    expect(result.pictureAlpha.bytes).toBeLessThanOrEqual(30000)
    expect(result.pictureAlpha.width).toBeLessThan(200)
  })

  it('chooses by the pixels when asked for Automatic: a photograph JPEG, a drawing and a see-through picture PNG', () => {
    expect(result.pictureAutoPhoto).toEqual({ type: 'jpeg', bytes: expect.any(Number), width: 300, height: 200, magicOk: true })
    expect(result.pictureAutoDrawing).toEqual({ type: 'png', bytes: expect.any(Number), width: 400, height: 300, magicOk: true })
    expect(result.pictureAutoAlpha).toMatchObject({ type: 'png', width: 200, height: 200, magicOk: true })
  })

  it('fits a PNG too large for its limit as JPEG at its full size, where it has no transparency', () => {
    expect(result.pictureRefit).toMatchObject({ type: 'jpeg', width: 300, height: 200, magicOk: true })
    expect(result.pictureRefit.bytes).toBeLessThanOrEqual(160 * 1000)
  })

  it('decodes TIFF in the page (Chromium has no decoder for it): JPEG, or PNG where it has transparency', () => {
    expect(result.pictureTiffLzw).toEqual({ type: 'jpeg', bytes: expect.any(Number), width: 300, height: 200, magicOk: true })
    expect(result.pictureTiffAlpha).toMatchObject({ type: 'png', width: 60, height: 40, magicOk: true })
    expect(result.pictureTiffBilevel).toMatchObject({ type: 'jpeg', width: 97, height: 31, magicOk: true })
    expect(result.pictureTiffBilevelPng).toMatchObject({ type: 'png', width: 97, height: 31, magicOk: true })
    expect(result.pictureWebpPng).toMatchObject({ type: 'png', width: 300, height: 200, magicOk: true })
    expect(result.pictureAlphaJpeg).toMatchObject({ type: 'png', width: 200, height: 200, magicOk: true })
    expect(result.pictureTiffLoop.error).toBe('the TIFF could not be read')
    expect(result.pictureTiffPage2).toMatchObject({ type: 'png', width: 17, height: 11, magicOk: true })
    expect(result.pictureTiffPage3.error).toBe('the TIFF has no page 3')
    expect(result.pictureTiffPixels).toEqual(['#ff0000', '#0000ff'])
  })

  it('decodes pictures only in the page: a malformed one costs an answer, never the app', () => {
    // Whatever the page made of it, the host is still answering afterwards.
    expect(result.pictureSkiaCrash.error ?? result.pictureSkiaCrash.type).toBeTruthy()
    expect(result.pictureGarbage.error).toBeTruthy()
    expect(result.pictureTiff.error).toBe('the TIFF holds no picture')
    expect(result.pictureTiffVast.error).toBe('the TIFF picture is too large to convert')
    expect(result.pictureAfter).toMatchObject({ type: 'jpeg', width: 20, height: 10, magicOk: true })
  })

  it('serves a repeated request from the cache', () => {
    expect(result.cacheHitDrew).toBe(0)
  })

  it('draws visible editor blocks first, then conversions, then prefetch', () => {
    expect(result.order).toEqual(['convert-1', 'visible', 'convert-2', 'prefetch'])
  })

  it('releases a canceled caller at once', () => {
    expect(result.canceled).toBe('AbortError')
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
    expect(host).toMatch(new RegExp(`mermaid: '${vendored}[ ']`))
    const viz = /pkg: '@viz-js\/viz',\s*version: '([^']+)'/.exec(script)?.[1]
    expect(viz).toBe('3.31.0')
    expect(host).toContain(`dot: '${viz}'`)
    const mathjax = /pkg: 'mathjax',\s*version: '([^']+)'/.exec(script)?.[1]
    expect(mathjax).toBe('3.2.2')
    expect(host).toContain(`math: '${mathjax}'`)
  })
})
