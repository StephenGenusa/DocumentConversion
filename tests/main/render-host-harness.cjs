/* eslint-disable */
/**
 * Drives the real render host inside Electron for tests/main/render-host.test.ts.
 *
 *   electron render-host-harness.cjs <bundled render-host.js> <resources/render>
 *
 * Prints one line, `RESULT <json>`, and exits.
 */
const { app } = require('electron')

const [hostPath, pageDir] = process.argv.slice(-2)
const { createRenderHost } = require(hostPath)

app.on('window-all-closed', () => {})

const FLOW = 'flowchart TD\n  A[Start] --> B{Is it?}\n  B -->|Yes| C[OK]\n  B -->|No| D[End]'
const SEQUENCE = 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi'
/** Every way a diagram's source might try to loosen the settings or reach out. */
const HOSTILE = [
  '%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%\n' +
    'flowchart TD\n  A["<b>bold</b> <img src=\'http://127.0.0.1:9/a.png\'>"] --> B\n  click A href "javascript:alert(1)"\n  click B call alert(1)',
  '%%{init: {"themeCSS": "@import url(http://127.0.0.1:9/x.css); .node rect { fill: url(http://127.0.0.1:9/p.png) }"}}%%\nflowchart LR\n  A --> B',
  '%%{init: {"securityLevel": "sandbox"}}%%\nflowchart LR\n  A --> B',
  'flowchart LR\n  A["<iframe src=\'http://127.0.0.1:9/\'></iframe>"] --> B\n  click B href "http://127.0.0.1:9/link"',
]

/** An SVG with its text content taken out (style elements kept): what is left is tags and attributes. */
const markupOnly = (svg) => svg.replace(/(<style[^>]*>[\s\S]*?<\/style>)|>[^<]*</g, (m, style) => style || '><')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const requests = []
  const drawn = []
  const host = createRenderHost({
    pageDir,
    idleMs: 1500,
    partition: 'docconv-render-test',
    onRequest: (url, allowed) => requests.push({ url, allowed }),
    onDrawn: (req, raw) => drawn.push({ source: req.source, svg: raw.svg, config: raw.config, mathjax: raw.mathjax }),
  })
  const out = { timings: {} }
  const time = async (name, fn) => {
    const t = process.hrtime.bigint()
    const r = await fn()
    out.timings[name] = Number(process.hrtime.bigint() - t) / 1e6
    return r
  }
  const png = (src, extra) => host.render({ kind: 'mermaid', source: src, display: true, format: 'png' }, extra)

  const first = await time('firstPng', () => png(FLOW))
  out.first = { width: first.width, height: first.height, error: first.error }
  if (first.png) {
    const bytes = Buffer.from(first.png, 'base64')
    out.first.magic = bytes.subarray(1, 4).toString('latin1')
    out.first.pixelWidth = bytes.readUInt32BE(16)
    out.first.pixelHeight = bytes.readUInt32BE(20)
  }
  await time('warmPng', () => png(SEQUENCE))
  await time('warmSvg', () => host.render({ kind: 'mermaid', source: SEQUENCE, display: true, format: 'svg' }))
  const drawsBefore = host.stats().draws
  await time('cachedPng', () => png(FLOW))
  out.cacheHitDrew = host.stats().draws - drawsBefore

  // Memory of the render window's process.
  const metrics = app.getAppMetrics()
  const tab = metrics.filter((m) => m.type === 'Tab')
  out.windowMemoryKb = tab.map((m) => m.memory.workingSetSize)

  out.hostile = []
  for (const src of HOSTILE) {
    const r = await host.render({ kind: 'mermaid', source: src, display: true, format: 'svg' })
    const raw = drawn.find((d) => d.source === src)
    out.hostile.push({
      error: r.error,
      config: raw && raw.config,
      rawHasJavascript: raw ? /javascript:/i.test(raw.svg) : null,
      rawHasForeignObject: raw ? /foreignObject/i.test(raw.svg) : null,
      rawHasIframe: raw ? /<iframe/i.test(raw.svg) : null,
      // In an attribute or a url(): the label text may say anything.
      svgHasRemote: r.svg ? /127\.0\.0\.1/.test(markupOnly(r.svg)) : null,
      svgHasImport: r.svg ? /@import/i.test(r.svg) : null,
    })
  }

  // SVG images (spec D10): rasterised at twice their size; a hostile one sanitised before the page sees it.
  const pngSize = (r) => {
    if (!r.png) return { error: r.error }
    const bytes = Buffer.from(r.png, 'base64')
    return { width: r.width, height: r.height, magic: bytes.subarray(1, 4).toString('latin1'), pixelWidth: bytes.readUInt32BE(16), pixelHeight: bytes.readUInt32BE(20) }
  }
  const PLAN = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150" viewBox="0 0 480 300"><rect x="10" y="10" width="460" height="280" fill="#2f5d8a"/></svg>'
  out.svgImage = pngSize(await host.render({ kind: 'svg', source: PLAN, display: true, format: 'png' }))
  const HOSTILE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="20" onload="fetch(\'http://127.0.0.1:9/onload\')">' +
    '<style>@import url(http://127.0.0.1:9/import.css);</style><image href="http://127.0.0.1:9/a.png" width="10" height="10"/>' +
    '<use xlink:href="http://127.0.0.1:9/s.svg#a"/><rect width="40" height="20" fill="url(http://127.0.0.1:9/f.png)"/>' +
    '<script>fetch("http://127.0.0.1:9/script")</script></svg>'
  out.svgHostile = pngSize(await host.render({ kind: 'svg', source: HOSTILE_SVG, display: true, format: 'png' }))
  out.svgNotOne = (await host.render({ kind: 'svg', source: '<note/>', display: true, format: 'png' })).error ?? null

  // Pictures (kind `picture`, Kindle): decoded in the page, re-encoded to fit.
  {
    const { createCanvas } = require('@napi-rs/canvas')
    const canvas = (w, h, alpha) => {
      const c = createCanvas(w, h)
      const g = c.getContext('2d')
      const d = g.createImageData(w, h)
      const noise = require('crypto').randomBytes(w * h * 3)
      for (let i = 0, j = 0; i < d.data.length; i += 4, j += 3) {
        d.data[i] = noise[j]
        d.data[i + 1] = noise[j + 1]
        d.data[i + 2] = noise[j + 2]
        d.data[i + 3] = alpha && (i >> 2) % 2 ? 0 : 255
      }
      g.putImageData(d, 0, 0)
      return c
    }
    const uri = (mime, buf) => `data:${mime};base64,${Buffer.from(buf).toString('base64')}`
    const picture = async (source, maxBytes) => {
      const r = await host.render({ kind: 'picture', source, display: true, format: 'png', fit: { maxBytes } })
      if (r.error) return { error: r.error }
      const data = r.png ?? r.jpeg
      const bytes = Buffer.from(data, 'base64')
      return { type: r.png ? 'png' : 'jpeg', bytes: bytes.length, width: r.width, height: r.height, magicOk: r.png ? bytes[0] === 0x89 : bytes[0] === 0xff && bytes[1] === 0xd8 }
    }
    const opaque = canvas(300, 200, false)
    out.pictureWebp = await picture(uri('image/webp', opaque.toBuffer('image/webp')), 5 * 1024 * 1024)
    out.pictureShrunk = await picture(uri('image/png', opaque.toBuffer('image/png')), 20000)
    out.pictureAlpha = await picture(uri('image/png', canvas(200, 200, true).toBuffer('image/png')), 30000)
    // A PNG Skia crashes on in-process (a 3x1 picture from a Word file); here it costs at most the page.
    const SKIA_CRASH = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAYAAACczIWkAAAAEklEQVR4nGNgYGD4z8DA8B8ABQ0CAmXEU2sAAAAASUVORK5CYII='
    out.pictureSkiaCrash = await picture(`data:image/png;base64,${SKIA_CRASH}`, 5 * 1024 * 1024)
    out.pictureGarbage = await picture(uri('image/webp', Buffer.from('RIFF0000WEBPnot a picture at all')), 5 * 1024 * 1024)
    out.pictureTiff = await picture(uri('image/tiff', Buffer.from('49492a0008000000', 'hex')), 5 * 1024 * 1024)
    out.pictureAfter = await picture(uri('image/webp', canvas(20, 10, false).toBuffer('image/webp')), 5 * 1024 * 1024)
  }

  const broken = await png('flowchart TD\n  A -->')
  out.broken = broken.error ?? null

  // TeX (step 18): MathJax, the same page, sanitiser and rasteriser.
  {
    const math = (source, display = false, format = 'svg') => host.render({ kind: 'math', source, display, format })
    const raw = (source) => drawn.filter((d) => d.source === source).pop()
    const pick = (r) => ({ width: r.width, height: r.height, baseline: r.baseline, error: r.error })
    const first = await time('mathFirstSvg', () => math('x^2'))
    out.mathInline = { ...pick(first), mathjax: raw('x^2') && raw('x^2').mathjax }
    out.mathInlineSvg = first.svg ? { head: first.svg.slice(0, 5), uses: (first.svg.match(/<use\b[^>]*>/g) || []).length, localRefs: (first.svg.match(/href="#MJX-[^"]+"/g) || []).length, defs: /<defs>/.test(first.svg), style: /<svg[^>]*\sstyle=/.test(first.svg) } : null
    const DEEP = 'y_{i,j}^{(k)}'
    const deep = await math(DEEP)
    out.mathDeep = { ...pick(deep), mathjax: raw(DEEP) && raw(DEEP).mathjax }
    const SUM = '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}'
    out.mathDisplay = pick(await math(SUM, true))
    out.mathSumInline = pick(await math(SUM, false))
    const t0 = process.hrtime.bigint()
    const many = []
    for (let i = 0; i < 50; i++) many.push(await math(`a_{${i}} + \\frac{${i}}{b}`))
    out.timings.mathWarmAverage = Number(process.hrtime.bigint() - t0) / 1e6 / 50
    out.mathManyOk = many.every((r) => r.svg && !r.error)
    const MATRIX = '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'
    out.mathMatrix = pick(await math(MATRIX, true))
    const TAGGED = 'E = mc^2 \\tag{1}'
    const tagged = await math(TAGGED, true)
    out.mathTagged = { ...pick(tagged), nested: tagged.svg ? (tagged.svg.match(/<svg\b/g) || []).length : 0, rootViewBox: tagged.svg ? /^<svg[^>]*\sviewBox="0 0 \d+ \d+"/.test(tagged.svg) : null }
    out.mathPng = pngSize(await time('mathPng', () => math('\\int_0^1 x^2\\,dx', false, 'png')))
    out.mathPngBaseline = (await math('\\int_0^1 x^2\\,dx', false, 'png')).baseline
    out.mathUnknown = (await math('\\foo{x}')).error ?? null
    out.mathUnclosed = (await math('\\frac{1}{')).error ?? null
    out.mathRequire = (await math('\\require{physics} x')).error ?? null
    out.mathHref = (await math('\\href{http://127.0.0.1:9/x}{y}')).error ?? null
    out.mathRecursive = (await math('\\def\\a{\\a\\a}\\a')).error ?? null
    // A definition in one formula does not carry over to the next.
    out.mathDefines = pick(await math('\\newcommand{\\R}{\\mathbb{R}} x \\in \\R'))
    out.mathLeaked = (await math('y \\in \\R')).error ?? null
    out.mathPackages = {
      boldsymbol: (await math('\\boldsymbol{\\beta}')).error ?? null,
      mhchem: (await math('\\ce{H2O}')).error ?? null,
      cancel: (await math('\\cancel{x}')).error ?? null,
      color: (await math('\\color{red}{x}')).error ?? null,
      mathtools: (await math('\\coloneqq')).error ?? null,
      braket: (await math('\\braket{\\phi|\\psi}')).error ?? null,
    }
  }

  // Graphviz (step 17): its own engine, the same page, sanitiser and rasteriser.
  {
    const dot = (source, format = 'svg') => host.render({ kind: 'dot', source, display: true, format })
    const fonts = (svg) => [...svg.matchAll(/font-family="([^"]*)"/g)].map((m) => m[1].replace(/&quot;/g, '"'))
    const size = (r) => ({ width: r.width, height: r.height, error: r.error })
    const first = await time('dotFirstSvg', () => dot('digraph { a -> b [label="an edge"]; label="A graph" }'))
    out.dotDigraph = { ...size(first), fonts: first.svg ? fonts(first.svg) : [], head: first.svg ? first.svg.slice(0, 5) : null }
    out.dotDigraph.hasDoctype = first.svg ? /<!DOCTYPE|<\?xml-stylesheet/i.test(first.svg) : null
    await time('dotWarmSvg', () => dot('digraph { x -> y -> z }'))
    out.dotPng = pngSize(await time('dotPng', () => dot('digraph { a -> b [label="an edge"]; label="A graph" }', 'png')))
    const TRIANGLE = 'a -- b; b -- c; c -- a'
    out.dotLayered = size(await dot(`graph { ${TRIANGLE} }`))
    out.dotNeato = size(await dot(`graph { layout=neato; ${TRIANGLE} }`))
    out.dotUndirected = size(await dot('graph links { a -- b; b -- c }'))
    const own = await dot('digraph { node [fontname="Courier"]; a -> b; c [fontname="Times-Roman"] }')
    out.dotOwnFont = own.svg ? fonts(own.svg) : [own.error]
    out.dotBroken = (await dot('digraph { a -> }')).error ?? null
    out.dotWrongEdge = (await dot('graph { a -> b }')).error ?? null
    out.dotEmpty = (await dot('')).error ?? null
    out.dotUnknownLayout = (await dot('digraph { layout=nosuch; a -> b }')).error ?? null
    const hostile = await dot(
      'digraph { stylesheet="http://127.0.0.1:9/s.css"; a [URL="javascript:alert(1)" href="http://127.0.0.1:9/link"]; ' +
        'b [image="http://127.0.0.1:9/x.png"]; a -> b [URL="http://127.0.0.1:9/edge"] }',
    )
    // A graph Graphviz takes minutes over (it does not yield): stopped at the limit, and the next one draws.
    let edges = ''
    for (let i = 0; i < 400; i++) for (let k = 1; k <= 4; k++) edges += `n${i} -> n${(i * 7 + k * 13) % 400}; `
    const slowStart = Date.now()
    const slow = await host.render({ kind: 'dot', source: `digraph { ${edges}}`, display: true, format: 'svg' }, { timeoutMs: 1500 })
    out.dotSlow = { error: slow.error ?? null, ms: Date.now() - slowStart }
    out.dotAfterSlow = size(await dot('digraph { after -> slow }'))
    out.dotHostile = {
      error: hostile.error,
      remote: hostile.svg ? /127\.0\.0\.1/.test(markupOnly(hostile.svg)) : null,
      javascript: hostile.svg ? /javascript:/i.test(hostile.svg) : null,
    }
  }

  // Priority: with the page busy, a visible editor block jumps the conversion queue.
  const order = []
  const jobs = [
    png('flowchart LR\n  P1 --> Q', { priority: 'convert' }).then(() => order.push('convert-1')),
    png('flowchart LR\n  P2 --> Q', { priority: 'prefetch' }).then(() => order.push('prefetch')),
    png('flowchart LR\n  P3 --> Q', { priority: 'convert' }).then(() => order.push('convert-2')),
    png('flowchart LR\n  P4 --> Q', { priority: 'visible' }).then(() => order.push('visible')),
  ]
  await Promise.all(jobs)
  out.order = order

  // Cancel: a queued block's caller is released at once.
  const controller = new AbortController()
  const slow = png('flowchart LR\n  C1 --> D', {})
  const cancelled = png('flowchart LR\n  C2 --> D', { signal: controller.signal }).then(
    () => 'resolved',
    (e) => e.name,
  )
  controller.abort()
  out.cancelled = await cancelled
  await slow

  // A block over its time limit: an error, and the next block gets a fresh window.
  const windowsBefore = host.stats().windows
  const late = await png('flowchart LR\n  T1 --> T2', { timeoutMs: 1 })
  out.timeout = late.error ?? null
  const after = await png('flowchart LR\n  T3 --> T4')
  out.afterTimeout = { ok: Boolean(after.png), windowsOpened: host.stats().windows - windowsBefore }

  // Idle close.
  out.openBeforeIdle = host.stats().windowOpen
  await sleep(2500)
  out.openAfterIdle = host.stats().windowOpen
  const reopened = await time('reopenCachedEngine', () => png('flowchart LR\n  R1 --> R2'))
  out.reopened = Boolean(reopened.png)

  out.requests = requests
  out.stats = host.stats()
  host.close()
  console.log('RESULT ' + JSON.stringify(out))
  app.exit(0)
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.log('RESULT ' + JSON.stringify({ fatal: String(e && e.stack) }))
    app.exit(1)
  }),
)
