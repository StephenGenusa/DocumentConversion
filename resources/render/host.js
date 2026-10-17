/*
 * The render host page's functions (spec B5). See host.html and
 * src/main/render-host.ts. Plain browser script: no modules, no network.
 */
;(function () {
  'use strict'

  /** The label font stack (spec B5, B8): metric-compatible on Windows, macOS and Linux. */
  var FONT = 'Arial, "Liberation Sans", Helvetica, sans-serif'

  /**
   * The engine files beside this page, by kind, each list loaded in order:
   * the TIFF decoder (UTIF.js) finds zlib's inflate (pako) as a global.
   */
  var ENGINE_FILES = {
    mermaid: ['mermaid.min.js'],
    dot: ['viz-global.js'],
    math: ['tex-svg-full.js'],
    tiff: ['pako-inflate.min.js', 'utif.js'],
  }

  var loading = {}

  function loadScript(kind, file) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script')
      script.src = file
      script.onload = function () {
        resolve()
      }
      script.onerror = function () {
        reject(new Error('The ' + kind + ' engine could not be loaded'))
      }
      document.head.appendChild(script)
    })
  }

  /** Load an engine's files once; later calls share the first load. */
  function load(kind) {
    if (!ENGINE_FILES[kind]) return Promise.reject(new Error('Unknown engine ' + kind))
    if (!loading[kind]) {
      loading[kind] = ENGINE_FILES[kind]
        .reduce(function (done, file) {
          return done.then(function () {
            return loadScript(kind, file)
          })
        }, Promise.resolve())
        .then(function () {
          if (kind === 'mermaid') setUpMermaid()
        })
      // A failed load may be retried by the next request.
      loading[kind].catch(function () {
        delete loading[kind]
      })
    }
    return loading[kind]
  }

  /**
   * Mermaid's settings. `secure` lists the keys a diagram's own
   * `%%{init: …}%%` directive may not change: Mermaid's defaults plus
   * htmlLabels, which would bring back HTML labels (foreignObject) and with
   * them the markup strict mode exists to keep out. Mermaid removes a secure
   * key at any depth of a directive, so flowchart.htmlLabels is covered too.
   */
  function setUpMermaid() {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: 'neutral',
      fontFamily: FONT,
      themeVariables: { fontFamily: FONT },
      suppressErrorRendering: true,
      deterministicIds: true,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels'],
    })
  }

  var counter = 0

  /** Mermaid's HTML-serialised SVG as standalone XML, sized by its viewBox. */
  function normalise(markup) {
    var holder = document.createElement('div')
    holder.innerHTML = markup
    var svg = holder.querySelector('svg')
    if (!svg) throw new Error('The engine returned no picture')
    var box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
    var width = box.length === 4 && box[2] > 0 ? box[2] : 0
    var height = box.length === 4 && box[3] > 0 ? box[3] : 0
    if (!width || !height) throw new Error('The engine returned a picture with no size')
    width = Math.ceil(width)
    height = Math.ceil(height)
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    svg.style.removeProperty('max-width')
    if (!svg.getAttribute('style')) svg.removeAttribute('style')
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    return { svg: new XMLSerializer().serializeToString(svg), width: width, height: height }
  }

  /** One line of an engine's message, short enough to read in a notice. */
  function message(err) {
    var text = String((err && (err.message || err.str)) || err || 'unknown error')
    // A parser's message is a heading, the line quoted, a caret under it and
    // the tokens it expected. Joined on one line the quote and the caret say
    // nothing, so keep the heading and what it found instead.
    var lines = text.split('\n')
    if (lines.length > 1 && /^(Parse|Lexical) error/.test(lines[0])) {
      var got = /got '([^']*)'/.exec(text)
      // At the end, the line a parser names is past the last one written.
      if (got && got[1] === 'EOF') text = 'Parse error: the diagram ends too soon'
      else text = lines[0].replace(/[:.]\s*$/, '') + (got ? ": unexpected '" + got[1] + "'" : '')
    }
    text = text.replace(/\s+/g, ' ').trim()
    return text.length > 300 ? text.slice(0, 297) + '...' : text
  }

  async function mermaidSvg(source) {
    await load('mermaid')
    var id = 'mmd' + ++counter
    var scratch = document.getElementById('scratch')
    try {
      var out = await window.mermaid.render(id, source, scratch)
      var result = normalise(out.svg)
      // What the diagram was finally drawn with, after its own directives:
      // the host test checks that a directive could not loosen it.
      var cfg = window.mermaid.mermaidAPI.getConfig()
      result.config = {
        securityLevel: cfg.securityLevel,
        htmlLabels: cfg.htmlLabels,
        flowchartHtmlLabels: cfg.flowchart && cfg.flowchart.htmlLabels,
      }
      return result
    } finally {
      // Mermaid leaves its working element behind when a diagram fails.
      var left = document.getElementById('d' + id) || document.getElementById(id)
      if (left && left.parentNode) left.parentNode.removeChild(left)
      scratch.textContent = ''
    }
  }

  /** The largest side a canvas is given, in device pixels. */
  var MAX_SIDE = 8192

  /**
   * Sources the main process sends in pieces (render-host.ts `send`), by
   * id: an SVG's text, or any other picture's bytes, each piece of base64
   * decoded as it comes, so no one string holds the whole of a large
   * picture. Answers kept for it to fetch in pieces (`take`), by the same
   * id. Both are dropped when the block is done.
   */
  var uploads = {}
  var answers = {}

  function begin(id, type) {
    uploads[id] = { type: String(type), parts: [] }
    return true
  }

  function put(id, piece) {
    var u = uploads[id]
    if (!u || typeof piece !== 'string') return false
    if (u.type === 'image/svg+xml') {
      u.parts.push(piece)
      return true
    }
    var text = atob(piece)
    var bytes = new Uint8Array(text.length)
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
    u.parts.push(bytes)
    return true
  }

  /** The source sent as `id`, taken (it is held once). */
  function received(id) {
    var u = uploads[id]
    delete uploads[id]
    if (!u) throw new Error('the picture did not arrive')
    return u
  }

  /** Keep an answer's base64 for `take`; answers its length. */
  function keep(id, b64) {
    answers[id] = b64
    return b64.length
  }

  /** A picture (a Blob) decoded by Chromium through a blob: URL, let go once decoded. */
  async function decoded(blob) {
    var url = URL.createObjectURL(blob)
    try {
      var img = new Image()
      img.src = url
      await img.decode()
      return img
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /** The base64 of a canvas, as `type`, without its data: prefix. */
  function canvasData(canvas, type, quality) {
    var url = canvas.toDataURL(type, quality)
    return url.slice(url.indexOf(',') + 1)
  }

  /** An SVG (already sanitised by the main process, sent as `id`) drawn to PNG at `scale`, on white. Answers the PNG's length (kept for `take`). */
  async function rasterize(id, width, height, scale) {
    var svg = received(id)
    var s = Math.min(scale, MAX_SIDE / width, MAX_SIDE / height)
    var w = Math.max(1, Math.round(width * s))
    var h = Math.max(1, Math.round(height * s))
    var img = await decoded(new Blob(svg.parts, { type: 'image/svg+xml' }))
    var canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    var ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    return { length: keep(id, canvasData(canvas, 'image/png')) }
  }

  /** Bytes of a base64 payload. */
  function payloadBytes(b64) {
    var pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
    return (b64.length * 3) / 4 - pad
  }

  /** The most pixels a TIFF is decoded at: its RGBA copy is four bytes a pixel. */
  var MAX_TIFF_PIXELS = 50 * 1000 * 1000

  /**
   * UTIF.js follows a TIFF's chain of pages (IFDs) until an offset of zero,
   * so a file whose chain loops back on itself would hold the page forever.
   * The chain is walked first, each offset once, up to 1,000 pages.
   */
  function checkTiffChain(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    var le = bytes[0] === 0x49
    var seen = {}
    var at = bytes.length >= 8 ? view.getUint32(4, le) : 0
    for (var n = 0; at !== 0; n++) {
      if (at + 2 > bytes.length) break
      if (n >= 1000 || seen[at]) throw new Error('the TIFF could not be read')
      seen[at] = true
      var next = at + 2 + view.getUint16(at, le) * 12
      if (next + 4 > bytes.length) break
      at = view.getUint32(next, le)
    }
  }

  /**
   * A TIFF (its bytes), decoded by UTIF.js onto a canvas: Chromium
   * decodes no TIFF itself. The page at `index` in the file's chain of pages
   * (core read the chain, and asks for each page in turn), or the first
   * with a size, which is what Word and every other viewer show. Its size is read before anything is decoded, so a
   * TIFF claiming a vast picture is refused rather than allocated.
   */
  async function tiffCanvas(bytes, index) {
    await load('tiff')
    checkTiffChain(bytes)
    var UTIF = window.UTIF
    var ifds = UTIF.decode(bytes.buffer, { parseMN: false, debug: false })
    var page = index
      ? ifds[index]
      : ifds.filter(function (d) {
          return d.t256 && d.t257
        })[0]
    if (!page || !(page.t256 && page.t257)) throw new Error(index ? 'the TIFF has no page ' + (index + 1) : 'the TIFF holds no picture')
    var w = page.t256[0]
    var h = page.t257[0]
    if (!(w > 0 && h > 0)) throw new Error('the picture has no size')
    if (w * h > MAX_TIFF_PIXELS) throw new Error('the TIFF picture is too large to convert')
    UTIF.decodeImage(bytes.buffer, page, ifds)
    if (!page.data) throw new Error('the TIFF picture could not be decoded')
    var rgba = UTIF.toRGBA8(page)
    if (rgba.length !== w * h * 4) throw new Error('the TIFF picture could not be decoded')
    var canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    var g = canvas.getContext('2d')
    var data = g.createImageData(w, h)
    data.data.set(rgba)
    g.putImageData(data, 0, 0)
    return canvas
  }

  /**
   * A raster picture (the document's bytes, sent as `id`) decoded here, in
   * the sandbox, and re-encoded to fit `maxBytes`: PNG when it has
   * transparency (scaled down until it fits); PNG when asked for (`as`
   * 'png', or 'auto' and its pixels say so: picture-kind.js), unless that
   * PNG is over `maxBytes`, when it is fitted as JPEG instead (owner,
   * 2026-10-17: a smaller picture beats a scaled-down one); JPEG otherwise
   * (quality lowered, then scaled down). `page` is a TIFF's page. Answers
   * the length of the base64 (kept for `take`), its type and its size in
   * pixels.
   */
  async function reencode(id, maxBytes, as, page) {
    var out = await fitted(received(id), maxBytes, as, page)
    return { length: keep(id, out.data), mime: out.mime, width: out.width, height: out.height }
  }

  async function fitted(src, maxBytes, as, page) {
    var img
    if (src.type === 'image/tiff') {
      var size = src.parts.reduce(function (n, p) { return n + p.length }, 0)
      var bytes = new Uint8Array(size)
      for (var k = 0, at = 0; k < src.parts.length; at += src.parts[k].length, k++) bytes.set(src.parts[k], at)
      src.parts = null
      img = await tiffCanvas(bytes, page)
    } else {
      img = await decoded(new Blob(src.parts, { type: src.type }))
    }
    var width = img.naturalWidth || img.width
    var height = img.naturalHeight || img.height
    if (!(width > 0 && height > 0)) throw new Error('the picture has no size')
    var s0 = Math.min(1, MAX_SIDE / width, MAX_SIDE / height)
    var full = document.createElement('canvas')
    full.width = Math.max(1, Math.round(width * s0))
    full.height = Math.max(1, Math.round(height * s0))
    var fctx = full.getContext('2d', { willReadFrequently: true })
    fctx.drawImage(img, 0, 0, full.width, full.height)
    var kind = window.pictureKind(fctx.getImageData(0, 0, full.width, full.height).data, full.width, full.height, src.type)
    var transparent = kind.reason === 'transparent'
    var asPng = transparent || as === 'png' || (as === 'auto' && kind.format === 'png')
    function encode(scale, quality) {
      var c = full
      if (scale < 1 || !asPng) {
        c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(full.width * scale))
        c.height = Math.max(1, Math.round(full.height * scale))
        var g = c.getContext('2d')
        if (!asPng) {
          // JPEG has no transparency; what shows through is white, as on a page.
          g.fillStyle = '#ffffff'
          g.fillRect(0, 0, c.width, c.height)
        }
        g.drawImage(full, 0, 0, c.width, c.height)
      }
      var b64 = asPng ? canvasData(c, 'image/png') : canvasData(c, 'image/jpeg', quality)
      return { data: b64, bytes: payloadBytes(b64), mime: asPng ? 'image/png' : 'image/jpeg', width: c.width, height: c.height }
    }
    var scale = 1
    var out
    if (asPng) {
      out = encode(1, 0)
      if (out.bytes <= maxBytes) return out
      // Only transparency keeps a picture PNG at any size: it is scaled down.
      // Anything else too large as PNG (a Kindle's 5 MB) is fitted as JPEG.
      while (transparent) {
        if (scale < 0.05) throw new Error('it cannot be made small enough')
        scale *= 0.8
        out = encode(scale, 0)
        if (out.bytes <= maxBytes) return out
      }
      asPng = false
    }
    var qualities = [0.92, 0.85, 0.75, 0.65]
    for (var q = 0; q < qualities.length; q++) {
      out = encode(1, qualities[q])
      if (out.bytes <= maxBytes) return out
    }
    for (;;) {
      scale *= 0.8
      if (scale < 0.05) throw new Error('it cannot be made small enough')
      out = encode(scale, 0.75)
      if (out.bytes <= maxBytes) return out
    }
  }

  // -------------------------------------------------------------------------
  // Graphviz (viz-js: Graphviz compiled to WebAssembly, carried inside its
  // script). The graph's own layout= is honoured; dot when it names none.
  // -------------------------------------------------------------------------

  /**
   * The font Graphviz is given for labels it has no font for. Graphviz sizes
   * each shape from its own table of font widths, which knows Arial by name
   * but measures a list of fonts as Times (wrong by 4% or so). So labels are
   * measured as Arial, and the font Graphviz writes for them is then
   * replaced with the whole stack (spec B8), which shares Arial's widths.
   */
  var DOT_FONT = 'Arial'

  /**
   * Graphviz's default label size is 14 pt, which shows at 18.7 px once the
   * picture is sized in px; Mermaid's labels are 16 px (its root rule). 12 pt
   * is 16 px, so diagrams of both kinds side by side read alike.
   */
  var DOT_FONT_SIZE = '12'

  var vizReady = null

  /** One viz-js instance, made once; after a crash inside it, made again. */
  function viz() {
    if (!vizReady) {
      vizReady = load('dot').then(function () {
        return window.Viz.instance()
      })
      vizReady.catch(function () {
        vizReady = null
      })
    }
    return vizReady
  }

  /** Graphviz's messages for a graph it could not draw, as one readable line. */
  function vizMessage(errors) {
    var list = (errors || []).filter(function (e) {
      return e && e.level === 'error'
    })
    if (list.length === 0) list = errors || []
    var seen = {}
    var lines = []
    list.forEach(function (e) {
      var text = String(e.message || '').trim()
      // A message that only quotes the source back adds nothing on one line.
      if (!text || /^\.\.\. /.test(text)) return
      text = text
        .replace(/^syntax error in line (\d+)/i, 'Syntax error on line $1')
        .replace(/^Layout type: "([^"]*)" not recognized\..*$/, 'Layout type "$1" not recognized')
      if (!seen[text]) {
        seen[text] = true
        lines.push(text)
      }
    })
    return lines.length ? lines.join('; ') : 'Graphviz found no graph in it'
  }

  /** CSS px for an SVG length Graphviz writes (points, mostly). */
  function lengthPx(value) {
    var m = /^\s*([0-9.]+)\s*(pt|px|in|cm|mm|pc)?\s*$/.exec(value || '')
    if (!m) return 0
    var n = Number(m[1])
    var per = { pt: 96 / 72, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pc: 16 }[m[2] || 'px']
    return n * per
  }

  /**
   * Graphviz's SVG document as one standalone <svg>: its prolog, doctype and
   * any xml-stylesheet instruction (the graph's stylesheet=) left behind,
   * comments dropped, sized in CSS px (Graphviz sizes in points), and the
   * labels it was given no font for in the font stack.
   */
  function normaliseDot(markup) {
    var doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
    var svg = doc.documentElement
    if (!svg || svg.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) {
      throw new Error('The engine returned no picture')
    }
    var box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
    var width = lengthPx(svg.getAttribute('width')) || (box.length === 4 ? (box[2] * 96) / 72 : 0)
    var height = lengthPx(svg.getAttribute('height')) || (box.length === 4 ? (box[3] * 96) / 72 : 0)
    if (!(width > 0 && height > 0)) throw new Error('The engine returned a picture with no size')
    width = Math.ceil(width)
    height = Math.ceil(height)
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    var walker = doc.createTreeWalker(svg, NodeFilter.SHOW_COMMENT)
    var comments = []
    while (walker.nextNode()) comments.push(walker.currentNode)
    comments.forEach(function (c) {
      c.parentNode.removeChild(c)
    })
    var texts = svg.querySelectorAll('[font-family]')
    for (var i = 0; i < texts.length; i++) {
      if (texts[i].getAttribute('font-family') === DOT_FONT) texts[i].setAttribute('font-family', FONT)
    }
    return { svg: new XMLSerializer().serializeToString(svg), width: width, height: height }
  }

  async function dotSvg(source) {
    var instance = await viz()
    var result
    try {
      result = instance.render(source, {
        format: 'svg',
        // Defaults only: a font or size the graph, a node or an edge names is kept.
        graphAttributes: { fontname: DOT_FONT, fontsize: DOT_FONT_SIZE },
        nodeAttributes: { fontname: DOT_FONT, fontsize: DOT_FONT_SIZE },
        edgeAttributes: { fontname: DOT_FONT, fontsize: DOT_FONT_SIZE },
      })
    } catch (err) {
      // Graphviz itself stopped (out of memory, say): start a fresh one next time.
      vizReady = null
      throw new Error('Graphviz stopped: ' + message(err))
    }
    if (result.status !== 'success' || typeof result.output !== 'string') throw new Error(vizMessage(result.errors))
    return normaliseDot(result.output)
  }

  // -------------------------------------------------------------------------
  // TeX (MathJax 3, tex-svg-full: TeX input, SVG output and every TeX
  // extension in the one file, so nothing else is ever loaded).
  // -------------------------------------------------------------------------

  /**
   * The TeX packages a formula may use: everything the file carries, less
   * the ones that would hide a mistake (noerrors shows the source instead of
   * an error, noundefined draws an unknown macro as red text: with both off
   * a formula that is wrong is an error, and the conversion keeps its
   * source and says so) and html (\href, \style, \class: links and styling
   * from inside a formula). require and autoload are left out too: each
   * loads extensions from the network on demand.
   */
  var TEX_PACKAGES = [
    'base', 'action', 'ams', 'amscd', 'bbox', 'boldsymbol', 'braket', 'bussproofs', 'cancel', 'cases', 'centernot',
    'color', 'colortbl', 'empheq', 'enclose', 'extpfeil', 'gensymb', 'mathtools', 'mhchem', 'newcommand', 'upgreek',
    'unicode', 'verb', 'configmacros', 'tagformat', 'textcomp', 'textmacros',
  ]

  /**
   * MathJax's settings, read by the file as it loads. The page draws only
   * when asked (no typesetting of the page, no menu, no accessibility
   * extensions, which the menu would otherwise fetch), and an error in a
   * formula is thrown rather than drawn.
   */
  function configureMathJax() {
    window.MathJax = {
      loader: { load: [], paths: { mathjax: '.' }, require: null },
      startup: { typeset: false, elements: null },
      options: {
        enableMenu: false,
        menuOptions: { settings: { assistiveMml: false, collapsible: false, explorer: false } },
      },
      tex: {
        packages: TEX_PACKAGES,
        // \bm is the bm package's bold math, common in papers and notebooks;
        // MathJax has no bm package, and \boldsymbol draws the same thing.
        // The shortcuts papers and notebooks define for themselves (number
        // sets in blackboard bold). Defaults only: a formula's own
        // \newcommand or \def of the same name is drawn instead.
        macros: {
          bm: ['\\boldsymbol{#1}', 1],
          R: '\\mathbb{R}',
          N: '\\mathbb{N}',
          Z: '\\mathbb{Z}',
          C: '\\mathbb{C}',
          Q: '\\mathbb{Q}',
        },
        // Without this an error becomes a red message drawn in the formula.
        formatError: function (jax, err) {
          throw err
        },
      },
      // Each picture carries the glyphs it uses (<defs> + <use href="#…">),
      // so it is complete on its own wherever it is put.
      svg: { fontCache: 'local' },
    }
  }

  /** Sizes are CSS px with 1ex = 8px (spec B5): MathJax's em of 16px. */
  var EX = 8
  var EM = 16

  var mathReady = null

  function mathjax() {
    if (!mathReady) {
      configureMathJax()
      mathReady = load('math').then(function () {
        return window.MathJax.startup.promise.then(function () {
          return window.MathJax
        })
      })
      mathReady.catch(function () {
        mathReady = null
      })
    }
    return mathReady
  }

  /**
   * A drawn formula as a standalone <svg> sized in whole CSS px, and where
   * the text baseline is in it. MathJax sizes in ex; the picture is widened
   * and deepened to the next whole pixel (its viewBox with it, so nothing is
   * stretched), and `baseline` is how far the baseline sits above its new
   * bottom edge. A display formula MathJax sets to the line's full width
   * (one with a \tag) is given the width it needs instead.
   */
  function normaliseMath(svg) {
    var exOf = function (value) {
      var m = /^\s*(-?[0-9.]+)ex\s*$/.exec(value || '')
      return m ? Number(m[1]) : NaN
    }
    var style = svg.getAttribute('style') || ''
    var align = /vertical-align:\s*(-?[0-9.]+)ex/.exec(style)
    var alignEx = align ? Number(align[1]) : 0
    var heightEx = exOf(svg.getAttribute('height'))
    var widthEx = exOf(svg.getAttribute('width'))
    if (!(widthEx > 0)) {
      var minWidth = /min-width:\s*([0-9.]+)ex/.exec(style)
      if (minWidth) widthEx = Number(minWidth[1])
    }
    if (!(heightEx > 0) || !(widthEx > 0)) throw new Error('The engine returned a picture with no size')
    var width = Math.max(1, Math.ceil(widthEx * EX - 1e-6))
    var height = Math.max(1, Math.ceil(heightEx * EX - 1e-6))
    var box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
    var baseline
    var root = svg
    if (box.length === 4 && box[2] > 0 && box[3] > 0) {
      // MathJax's units per px. The box is widened and deepened to the whole
      // pixel; the baseline is y = 0, and the box runs from box[1] down.
      var perPx = box[3] / (heightEx * EX)
      var vb = [box[0], box[1], width * perPx, height * perPx]
      baseline = (vb[1] + vb[3]) / perPx
      svg.setAttribute('viewBox', vb.map(function (n) { return String(Math.round(n * 1000) / 1000) }).join(' '))
    } else {
      // A display formula with a \tag: an outer <svg> as wide as the line,
      // holding the formula and its tag placed by percentages. Given the
      // width it needs and put inside one with a viewBox, it scales as a
      // whole like any other picture.
      baseline = -alignEx * EX
      root = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg')
      root.setAttribute('viewBox', '0 0 ' + width + ' ' + height)
      svg.parentNode.replaceChild(root, svg)
      root.appendChild(svg)
      svg.setAttribute('x', '0')
      svg.setAttribute('y', '0')
    }
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    svg.removeAttribute('style')
    svg.removeAttribute('focusable')
    svg.removeAttribute('role')
    svg.removeAttribute('aria-hidden')
    root.setAttribute('width', String(width))
    root.setAttribute('height', String(height))
    if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    var result = { svg: new XMLSerializer().serializeToString(root), width: width, height: height }
    result.baseline = Math.round(Math.max(0, Math.min(height, baseline)) * 1000) / 1000
    // What MathJax itself said, for the host test: its own lowering, in ex.
    result.mathjax = { verticalAlignEx: alignEx, widthEx: widthEx, heightEx: heightEx }
    return result
  }

  /**
   * What one formula defined (\def, \newcommand, \newenvironment, \let,
   * \DeclareMathOperator…) must not carry over to the next one: each is
   * drawn on its own, as it would be in the editor, so its drawing can be
   * cached and nothing reaches another document. (A document's definitions
   * reach its own later formulas in their source: core/tex-definitions.ts.)
   * MathJax keeps those definitions in
   * maps of their own; they are emptied, and its labels and equation
   * numbers reset, after every formula.
   */
  var DEFINED = { 'new-Command': 1, 'new-Environment': 1, 'new-Delimiter': 1, 'ams-declare-ops': 1, 'mathtools-paired-delims': 1 }

  function forget(MathJax) {
    try {
      // The maps the parser itself holds (newcommand's and the extensions'
      // own copies), by kind of definition.
      var handlers = MathJax.startup.input[0].parseOptions.handlers
      ;['macro', 'environment', 'delimiter'].forEach(function (kind) {
        var list = handlers.get(kind)._configuration
        for (var it of list) {
          var map = it.item
          if (map && DEFINED[map.name] && map.map && typeof map.map.clear === 'function') map.map.clear()
        }
      })
    } catch (e) {
      /* nothing defined yet */
    }
    try {
      MathJax.texReset()
    } catch (e) {
      /* nothing to reset */
    }
  }

  // siunitx (\SI, \si, \num and their version 3 names \qty, \unit), which
  // MathJax does not have: a basic form of it, written out in TeX before
  // the formula is drawn. A number (3e8 as 3×10⁸), a thin space and the
  // unit upright, its parts a thin space apart and \per as a power of -1,
  // as siunitx draws them by default. Options are ignored. A unit macro
  // not listed here, and the commands not done at all, are errors naming
  // them, so the formula keeps its source with a notice that says why.

  var SI_PREFIXES = {
    yocto: 'y', zepto: 'z', atto: 'a', femto: 'f', pico: 'p', nano: 'n', micro: '\\mu ', milli: 'm', centi: 'c',
    deci: 'd', deca: 'da', deka: 'da', hecto: 'h', kilo: 'k', mega: 'M', giga: 'G', tera: 'T', peta: 'P', exa: 'E',
    zetta: 'Z', yotta: 'Y',
  }

  var SI_UNITS = {
    metre: 'm', meter: 'm', gram: 'g', kilogram: 'kg', second: 's', ampere: 'A', kelvin: 'K', mole: 'mol',
    candela: 'cd', hertz: 'Hz', newton: 'N', pascal: 'Pa', joule: 'J', watt: 'W', coulomb: 'C', volt: 'V',
    farad: 'F', ohm: '\\Omega ', siemens: 'S', weber: 'Wb', tesla: 'T', henry: 'H', lumen: 'lm', lux: 'lx',
    becquerel: 'Bq', gray: 'Gy', sievert: 'Sv', katal: 'kat', radian: 'rad', steradian: 'sr', litre: 'L',
    liter: 'L', minute: 'min', hour: 'h', day: 'd', hectare: 'ha', tonne: 't', electronvolt: 'eV', dalton: 'Da',
    astronomicalunit: 'au', bar: 'bar', angstrom: '\\mathring{A}', bel: 'B', decibel: 'dB', neper: 'Np',
    percent: '\\%', degreeCelsius: '{}^{\\circ}C', degree: '{}^{\\circ}', arcminute: "'", arcsecond: "''",
  }

  /** Units written straight after the number, as siunitx does: 90°, not 90 °. */
  var SI_CLOSE = { degree: 1, arcminute: 1, arcsecond: 1 }

  /** The siunitx commands read here, and those that are only named as not supported. */
  var SI_COMMANDS = /\\(SI|si|num|qty|unit|ang|SIrange|SIlist|numrange|numlist|qtyrange|qtylist|sisetup)(?![A-Za-z])/g
  var SI_ARGS = { SI: 2, qty: 2, si: 1, unit: 1, num: 1, ang: 1 }

  /** The end of the argument at `i` (a group or one token), -1 for an unclosed group, null for none. */
  function siArgEnd(s, i) {
    if (s[i] === '{') {
      var depth = 0
      for (var j = i; j < s.length; j++) {
        if (s[j] === '\\') j++
        else if (s[j] === '{') depth++
        else if (s[j] === '}' && --depth === 0) return j + 1
      }
      return -1
    }
    if (s[i] === '\\') {
      var word = /^\\[A-Za-z]+/.exec(s.slice(i))
      return i + (word ? word[0].length : 2)
    }
    return i < s.length && s[i] !== '}' ? i + 1 : null
  }

  var ungroup = function (arg) {
    return arg[0] === '{' ? arg.slice(1, -1) : arg
  }

  /** A siunitx number: 3e8 → 3\times10^{8}, 1.2+-0.1 → 1.2\pm0.1, a decimal comma kept as one. */
  function siNumber(text) {
    var t = text.trim().replace(/\+-/g, '\\pm ')
    var m = /^([-+]?)(\d*[.,]?\d+)(?:[eE]([-+]?\d+))?$/.exec(t.replace(/\s+/g, ''))
    if (!m) return t
    var mantissa = m[1] + m[2].replace(',', '{,}')
    return m[3] === undefined ? mantissa : mantissa + '\\times10^{' + m[3].replace(/^\+/, '') + '}'
  }

  /** A siunitx unit: macros (\kilo\metre\per\second\squared) or literal text (km/s), upright. */
  function siUnit(text) {
    var parts = []
    var prefix = ''
    var power = null
    var per = false
    var literal = ''
    var close = false
    var count = 0
    function add(sym) {
      parts.push({ sym: prefix + sym, power: power, per: per })
      prefix = ''
      power = null
      per = false
    }
    function endLiteral() {
      if (literal) add(literal)
      literal = ''
    }
    function powerOfLast(p) {
      endLiteral()
      if (!parts.length) throw new Error('siunitx: a power with no unit before it')
      parts[parts.length - 1].power = p
    }
    var tokens = text.match(/\\[A-Za-z]+|\{(?:[^{}]|\{[^{}]*\})*\}|\s+|[\s\S]/g) || []
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i]
      var name = tok[0] === '\\' && tok.length > 1 && /^\\[A-Za-z]+$/.test(tok) ? tok.slice(1) : null
      var next = function () {
        var arg = tokens[++i]
        if (arg === undefined) throw new Error('Missing argument for ' + tok)
        return ungroup(arg).trim()
      }
      if (name === null) {
        if (/^\s+$/.test(tok) || tok === '.' || tok === '~') endLiteral()
        else literal += tok
        continue
      }
      endLiteral()
      if (Object.prototype.hasOwnProperty.call(SI_PREFIXES, name)) prefix += SI_PREFIXES[name]
      else if (Object.prototype.hasOwnProperty.call(SI_UNITS, name)) {
        count++
        close = Boolean(SI_CLOSE[name]) && !prefix
        add(SI_UNITS[name])
      } else if (name === 'per') per = true
      else if (name === 'square') power = '2'
      else if (name === 'cubic') power = '3'
      else if (name === 'raiseto') power = next()
      else if (name === 'squared') powerOfLast('2')
      else if (name === 'cubed') powerOfLast('3')
      else if (name === 'tothe') powerOfLast(next())
      else throw new Error('siunitx unit ' + tok + ' is not supported')
    }
    endLiteral()
    var tex = parts
      .map(function (p) {
        var exp = p.per ? (p.power ? '-' + p.power : '-1') : p.power
        return exp ? p.sym + '^{' + exp + '}' : p.sym
      })
      .join('\\,')
    return { tex: '\\mathrm{' + tex + '}', close: close && count === 1 && parts.length === 1 }
  }

  /** The formula with its siunitx commands written out in plain TeX. */
  function siunitx(source) {
    if (source.indexOf('\\') < 0) return source
    var out = ''
    var at = 0
    SI_COMMANDS.lastIndex = 0
    for (var m = SI_COMMANDS.exec(source); m; m = SI_COMMANDS.exec(source)) {
      // \\SI is a line break and the letters SI.
      if (!/(^|[^\\])(\\\\)*$/.test(source.slice(0, m.index))) continue
      var cmd = m[1]
      if (!SI_ARGS[cmd]) throw new Error('siunitx \\' + cmd + ' is not supported')
      var i = m.index + m[0].length
      while (/\s/.test(source[i] || '')) i++
      if (source[i] === '[') {
        var opt = /^\[[^\]]*\]/.exec(source.slice(i))
        if (opt) i += opt[0].length
      }
      var args = []
      for (var k = 0; k < SI_ARGS[cmd]; k++) {
        while (/\s/.test(source[i] || '')) i++
        var end = siArgEnd(source, i)
        if (end === -1) throw new Error('Missing close brace in \\' + cmd)
        if (end === null) break
        args.push(source.slice(i, end))
        i = end
      }
      // \qty with other than two arguments is not siunitx's (physics has one).
      if (args.length < SI_ARGS[cmd]) {
        if (cmd === 'qty') continue
        throw new Error('Missing argument for \\' + cmd)
      }
      var tex
      if (cmd === 'num') tex = siNumber(ungroup(args[0]))
      else if (cmd === 'ang') tex = siNumber(ungroup(args[0])) + '^{\\circ}'
      else if (cmd === 'si' || cmd === 'unit') tex = siUnit(ungroup(args[0])).tex
      else {
        var unit = siUnit(ungroup(args[1]))
        tex = siNumber(ungroup(args[0])) + (unit.close ? '' : '\\,') + unit.tex
      }
      out += source.slice(at, m.index) + tex
      at = i
      SI_COMMANDS.lastIndex = i
    }
    return out + source.slice(at)
  }

  async function mathSvg(source, display) {
    var MathJax = await mathjax()
    source = siunitx(source)
    var node
    try {
      node = MathJax.tex2svg(source, { display: Boolean(display), em: EM, ex: EX, containerWidth: 80 * EM })
    } finally {
      forget(MathJax)
    }
    var svg = node && node.querySelector('svg')
    if (!svg) throw new Error('The engine returned no picture')
    // An error MathJax still drew (rather than threw) is an error all the same.
    var merror = svg.querySelector('[data-mml-node="merror"]')
    if (merror) throw new Error(merror.getAttribute('data-mjx-error') || merror.textContent || 'TeX error')
    return normaliseMath(svg)
  }

  /** Every call answers { ok, value } or { ok: false, error }, never throws across the boundary. */
  function answer(promise) {
    return promise.then(
      function (value) {
        return { ok: true, value: value }
      },
      function (err) {
        return { ok: false, error: message(err) }
      },
    )
  }

  window.renderHost = {
    ready: true,
    draw: function (kind, source, display) {
      if (kind === 'mermaid') return answer(mermaidSvg(source))
      if (kind === 'dot') return answer(dotSvg(source))
      if (kind === 'math') return answer(mathSvg(source, display))
      return answer(Promise.reject(new Error('No engine for ' + kind)))
    },
    begin: begin,
    put: put,
    rasterize: function (id, width, height, scale) {
      return answer(rasterize(id, width, height, scale))
    },
    reencode: function (id, maxBytes, as, page) {
      return answer(reencode(id, maxBytes, as, page))
    },
    take: function (id, from, to) {
      var a = answers[id]
      return typeof a === 'string' ? a.slice(from, to) : null
    },
    drop: function (ids) {
      ids.forEach(function (id) {
        delete uploads[id]
        delete answers[id]
      })
      return true
    },
  }
})()
