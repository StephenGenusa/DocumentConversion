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

/**
 * The RGB of one pixel of a PNG the page made (8-bit RGBA, not interlaced:
 * what canvas.toDataURL writes), as #rrggbb.
 */
function pngPixel(b64, x, y) {
  const bytes = Buffer.from(b64, 'base64')
  const width = bytes.readUInt32BE(16)
  const idat = []
  for (let at = 8; at < bytes.length; ) {
    const len = bytes.readUInt32BE(at)
    if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = require('zlib').inflateSync(Buffer.concat(idat))
  const stride = width * 4
  let prev = Buffer.alloc(stride)
  let row
  for (let r = 0; r <= y; r++) {
    const filter = raw[r * (stride + 1)]
    const line = raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1))
    row = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0
      const b = prev[i]
      const c = i >= 4 ? prev[i - 4] : 0
      const p = a + b - c
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]
      row[i] = (line[i] + pred) & 0xff
    }
    prev = row
  }
  return '#' + [0, 1, 2].map((k) => row[x * 4 + k].toString(16).padStart(2, '0')).join('')
}

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
  // An SVG image nested in one (an icon placed in a plan): drawn, after the host's own sanitising.
  {
    const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><script>fetch("http://127.0.0.1:9/nested")</script><rect width="4" height="4" fill="#ff0000"/></svg>'
    const NESTED =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0000ff"/>' +
      `<image x="20" y="0" width="20" height="20" href="data:image/svg+xml;base64,${Buffer.from(ICON).toString('base64')}"/></svg>`
    const r = await host.render({ kind: 'svg', source: NESTED, display: true, format: 'png' })
    out.svgNested = r.png ? { left: pngPixel(r.png, 10, 20), right: pngPixel(r.png, 70, 20) } : { error: r.error }
  }
  // PNG, JPEG, GIF and WebP pictures placed in an SVG image (data URIs): drawn, each in its own color.
  {
    const { createCanvas } = require('@napi-rs/canvas')
    const solid = (color, format) => {
      const c = createCanvas(4, 4)
      const g = c.getContext('2d')
      g.fillStyle = color
      g.fillRect(0, 0, 4, 4)
      return c.encodeSync(format, 100)
    }
    // A 1x1 GIF whose one pixel is palette entry 0, blue.
    const gif = Buffer.from('474946383961010001008000000000ff0000ff2c00000000010001000002024401003b', 'hex')
    const pictures = [
      ['png', solid('#ff0000', 'png')],
      ['jpeg', solid('#00ff00', 'jpeg')],
      ['gif', gif],
      ['webp', solid('#ffff00', 'webp')],
    ]
    const RASTERS =
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20"><rect width="80" height="20" fill="#ffffff"/>' +
      pictures.map(([type, bytes], i) => `<image x="${i * 20}" y="0" width="20" height="20" preserveAspectRatio="none" href="data:image/${type};base64,${bytes.toString('base64')}"/>`).join('') +
      '</svg>'
    const r = await host.render({ kind: 'svg', source: RASTERS, display: true, format: 'png' })
    out.svgRasters = r.png ? pictures.map((_, i) => pngPixel(r.png, i * 40 + 20, 20)) : { error: r.error }
  }

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
    const picture = async (source, maxBytes, as, page) => {
      const r = await host.render({ kind: 'picture', source, display: true, format: 'png', fit: as ? { maxBytes, as } : { maxBytes }, ...(page === undefined ? {} : { page }) })
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
    // Real TIFFs (Chromium decodes none; the page uses UTIF.js), made here.
    const { tiff } = await import(require('path').join(__dirname, '..', '..', 'scripts', 'fixtures', 'lib-tiff.mjs'))
    const shade = (x, y) => [(x * 5) & 255, (y * 3) & 255, 160, x < 10 ? 0 : 255]
    out.pictureTiffLzw = await picture(uri('image/tiff', tiff({ width: 300, height: 200, pixel: shade, compression: 'lzw' })), 5 * 1024 * 1024)
    out.pictureTiffAlpha = await picture(uri('image/tiff', tiff({ width: 60, height: 40, pixel: shade, kind: 'rgba', compression: 'deflate' })), 5 * 1024 * 1024)
    out.pictureTiffBilevel = await picture(uri('image/tiff', tiff({ width: 97, height: 31, pixel: shade, kind: 'bilevel', compression: 'packbits', bigEndian: true })), 5 * 1024 * 1024)
    // The picture format asked for: PNG for an opaque picture too; JPEG still PNG with transparency.
    out.pictureTiffBilevelPng = await picture(uri('image/tiff', tiff({ width: 97, height: 31, pixel: shade, kind: 'bilevel', compression: 'packbits', bigEndian: true })), 5 * 1024 * 1024, 'png')
    out.pictureWebpPng = await picture(uri('image/webp', opaque.toBuffer('image/webp')), 5 * 1024 * 1024, 'png')
    out.pictureAlphaJpeg = await picture(uri('image/png', canvas(200, 200, true).toBuffer('image/png')), 5 * 1024 * 1024, 'jpeg')
    // A page of a multi-page TIFF, by its place in the file's chain (core asks so when it cannot take the page out alone).
    {
      const fax = tiff({ pages: [{ width: 30, height: 20, pixel: shade, compression: 'lzw' }, { width: 17, height: 11, pixel: shade, kind: 'bilevel', compression: 'packbits' }] })
      out.pictureTiffPage2 = await picture(uri('image/tiff', fax), 5 * 1024 * 1024, 'png', 1)
      out.pictureTiffPage3 = await picture(uri('image/tiff', fax), 5 * 1024 * 1024, 'png', 2)
    }
    // A TIFF whose chain of pages loops back on itself: refused, not followed forever.
    {
      const t = tiff({ width: 4, height: 4, pixel: shade, kind: 'gray' })
      const ifd = t.readUInt32LE(4)
      t.writeUInt32LE(ifd, ifd + 2 + t.readUInt16LE(ifd) * 12)
      out.pictureTiffLoop = await picture(uri('image/tiff', t), 5 * 1024 * 1024, 'png')
    }
    {
      // Two of its pixels, as the page drew them (one transparent pixel keeps it PNG): the colors kept, not only the size.
      const r = await host.render({ kind: 'picture', source: uri('image/tiff', tiff({ width: 40, height: 4, pixel: (x, y) => (x + y === 0 ? [0, 0, 0, 0] : x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255]), kind: 'rgba' })), display: true, format: 'png', fit: { maxBytes: 5 * 1024 * 1024 } })
      out.pictureTiffPixels = r.png ? [pngPixel(r.png, 5, 1), pngPixel(r.png, 35, 1)] : r.error
    }
    // A TIFF that claims a vast picture: refused before anything is allocated.
    out.pictureTiffVast = await picture(uri('image/tiff', tiff({ width: 2, height: 2, pixel: shade, kind: 'gray', claim: { width: 100000, height: 100000 } })), 5 * 1024 * 1024)
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
    const bm = await math('\\bm{x}')
    const boldsymbol = await math('\\boldsymbol{x}')
    // Ids and the source attribute differ by formula; the drawing must not.
    const drawing = (svg) => (svg || '').replace(/\s(?:id|data-[\w-]+)="[^"]*"/g, '').replace(/href="#[^"]*"/g, 'href="#"')
    out.mathBm = { error: bm.error ?? null, same: Boolean(bm.svg) && drawing(bm.svg) === drawing(boldsymbol.svg) }
    out.mathUnclosed = (await math('\\frac{1}{')).error ?? null
    out.mathRequire = (await math('\\require{physics} x')).error ?? null
    out.mathHref = (await math('\\href{http://127.0.0.1:9/x}{y}')).error ?? null
    out.mathRecursive = (await math('\\def\\a{\\a\\a}\\a')).error ?? null
    // A definition in one formula does not carry over to the next.
    out.mathDefines = pick(await math('\\newcommand{\\Reals}{\\mathbb{R}} x \\in \\Reals'))
    out.mathLeaked = (await math('y \\in \\Reals')).error ?? null
    // Drawn as `b` is, or the error `a` got.
    const sameAs = async (a, b) => {
      const [x, y] = [await math(a), await math(b)]
      return x.error ?? y.error ?? (drawing(x.svg) === drawing(y.svg) ? 'same' : 'different')
    }
    out.mathShortcuts = {}
    for (const letter of 'RNZCQ') out.mathShortcuts[letter] = await sameAs(`\\${letter}^n`, `\\mathbb{${letter}}^n`)
    out.mathOwnShortcut = {
      newcommand: await sameAs('\\newcommand{\\R}{\\mathcal{R}}\\R', '\\mathcal{R}'),
      renewcommand: await sameAs('\\renewcommand{\\C}{\\mathrm{C}}\\C', '\\mathrm{C}'),
      def: await sameAs('\\def\\N{\\mathbf{N}}\\N', '\\mathbf{N}'),
      after: await sameAs('\\R', '\\mathbb{R}'),
    }
    out.mathSiunitx = {
      SI: await sameAs('\\SI{9.81}{\\metre\\per\\second\\squared}', '9.81\\,\\mathrm{m\\,s^{-2}}'),
      exponent: await sameAs('\\SI{3e8}{\\metre\\per\\second}', '3\\times10^{8}\\,\\mathrm{m\\,s^{-1}}'),
      prefixes: await sameAs('\\SI[round-mode=places]{-1.5}{\\kilo\\gram\\square\\metre}', '-1.5\\,\\mathrm{kg\\,m^{2}}'),
      micro: await sameAs('\\si{\\micro\\second}', '\\mathrm{\\mu s}'),
      literal: await sameAs('\\si{kg.m/s^2}', '\\mathrm{kg\\,m/s^2}'),
      num: await sameAs('\\num{6.022e23}', '6.022\\times10^{23}'),
      celsius: await sameAs('\\SI{20}{\\degreeCelsius}', '20\\,\\mathrm{{}^{\\circ}C}'),
      unknownUnit: (await math('\\SI{1}{\\furlong}')).error ?? null,
      unclosed: (await math('\\SI{1}{\\metre')).error ?? null,
    }
    // What core/tex-definitions.ts hands the host: definitions in front of the formula, a display environment too.
    out.mathCarried = (await math('\\newcommand{\\vv}[1]{\\mathbf{#1}}\\DeclareMathOperator*{\\argmax}{arg\\,max}\\begin{align} \\vv{x} &= \\argmax_y f \\tag{2} \\end{align}', true)).error ?? null
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
    // Label sizes as shown, in CSS px: Graphviz writes points in its viewBox,
    // and the picture is sized in px; Mermaid writes px in its stylesheet.
    const shownPx = (svg) => {
      const box = (/viewBox="([^"]*)"/.exec(svg) || [])[1]
      const scale = box ? Number(/width="([0-9.]+)"/.exec(svg)[1]) / Number(box.trim().split(/[\s,]+/)[2]) : 1
      return [...new Set([...svg.matchAll(/font-size="([0-9.]+)"/g)].map((m) => Math.round(Number(m[1]) * scale * 10) / 10))]
    }
    const flow = await host.render({ kind: 'mermaid', source: 'flowchart LR\n  A[Start] -->|go| B[End]', display: true, format: 'svg' })
    // The diagram's own rule (#mmdN{…}): what its node and edge labels inherit.
    const mermaidPx = flow.svg ? Number((/#[\w-]+\{[^}]*?font-size:\s*([0-9.]+)px/.exec(flow.svg) || [])[1]) : null
    const plain = await dot('digraph { a -> b [label="an edge"]; label="A graph" }')
    const sized = await dot('digraph { node [fontsize=20]; a -> b [label="an edge" fontsize=9]; label="A graph"; fontsize=30 }')
    out.labelPx = {
      mermaid: mermaidPx,
      dot: plain.svg ? shownPx(plain.svg) : [plain.error],
      dotOwnSize: sized.svg ? shownPx(sized.svg) : [sized.error],
    }
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
  const canceled = png('flowchart LR\n  C2 --> D', { signal: controller.signal }).then(
    () => 'resolved',
    (e) => e.name,
  )
  controller.abort()
  out.canceled = await canceled
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
