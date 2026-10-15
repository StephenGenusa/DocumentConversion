/*
 * The render host page's functions (spec B5). See host.html and
 * src/main/render-host.ts. Plain browser script: no modules, no network.
 */
;(function () {
  'use strict'

  /** The label font stack (spec B5, B8): metric-compatible on Windows, macOS and Linux. */
  var FONT = 'Arial, "Liberation Sans", Helvetica, sans-serif'

  /** The engine files beside this page, by kind. */
  var ENGINE_FILES = { mermaid: 'mermaid.min.js' }

  var loading = {}

  /** Load an engine's file once; later calls share the first load. */
  function load(kind) {
    if (!ENGINE_FILES[kind]) return Promise.reject(new Error('Unknown engine ' + kind))
    if (!loading[kind]) {
      loading[kind] = new Promise(function (resolve, reject) {
        var script = document.createElement('script')
        script.src = ENGINE_FILES[kind]
        script.onload = function () {
          try {
            if (kind === 'mermaid') setUpMermaid()
            resolve()
          } catch (err) {
            reject(err)
          }
        }
        script.onerror = function () {
          reject(new Error('The ' + kind + ' engine could not be loaded'))
        }
        document.head.appendChild(script)
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

  /** An SVG (already sanitised by the main process) drawn to PNG at `scale`, on white. */
  async function rasterize(svg, width, height, scale) {
    var s = Math.min(scale, MAX_SIDE / width, MAX_SIDE / height)
    var w = Math.max(1, Math.round(width * s))
    var h = Math.max(1, Math.round(height * s))
    var img = new Image()
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
    await img.decode()
    var canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    var ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    var url = canvas.toDataURL('image/png')
    return url.slice(url.indexOf(',') + 1)
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
    draw: function (kind, source) {
      if (kind === 'mermaid') return answer(mermaidSvg(source))
      return answer(Promise.reject(new Error('No engine for ' + kind)))
    },
    rasterize: function (svg, width, height, scale) {
      return answer(rasterize(svg, width, height, scale))
    },
  }
})()
