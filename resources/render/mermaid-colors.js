/*
 * The colors Mermaid's diagrams are drawn in. Plain script, loaded by
 * host.html before host.js (window.mermaidColors), and by the tests as a
 * CommonJS module.
 *
 * The render host draws with Mermaid's 'neutral' theme: flowcharts,
 * sequence, class, state and ER diagrams in gray boxes and black lines,
 * which print well and suit any document. But 'neutral' is gray all the way
 * through: the section colors that tell a mind map's branches apart (and a
 * timeline's periods, a kanban's columns, a treemap's groups, a pie's
 * slices), a git graph's branches, a journey's sections, a quadrant chart's
 * quarters and an XY chart's first series are all shades of gray there,
 * where Mermaid's default theme gives them colors. These variables put the
 * colors back, over 'neutral', and nothing else.
 *
 * Every label set on a colored fill gets the darker or the lighter of two
 * text colors, whichever stands out more from that fill (WCAG contrast; the
 * palette is chosen so that is at least 4.5:1, normal-size text), and the
 * fills are mid tones that print in color and in gray alike.
 *
 * A diagram that names its own theme (an init directive or front matter)
 * is drawn in that theme as Mermaid would, without these: ownTheme.
 */
;(function (root) {
  'use strict'

  var DARK_TEXT = '#1f2328'
  var LIGHT_TEXT = '#ffffff'

  /**
   * Section colors (cScale0..11): mind map branches, timeline periods,
   * kanban columns, treemap groups, pie slices. Light enough for dark text.
   */
  var SECTIONS = [
    '#8cb8e8', // blue
    '#f4b66a', // orange
    '#8fd19e', // green
    '#ee9fae', // rose
    '#bba6e3', // violet
    '#ecd56a', // yellow
    '#7fd3cd', // teal
    '#dcb48a', // tan
    '#b2cf72', // olive
    '#e7a5d8', // pink
    '#a3bdd6', // slate
    '#f2a68f', // coral
  ]

  /** Branch colors (git0..7), also a mind map's root: strong enough for lines and white text. */
  var BRANCHES = ['#3b6db3', '#b55d0c', '#2a7d45', '#b83b55', '#6f52b0', '#8a6f00', '#1f7f7a', '#8e5a2a']

  /** Journey sections and their tasks (fillType0..7): pale, under dark text. */
  var JOURNEY = ['#d6e5f7', '#fde3c4', '#d5efdb', '#f8d9df', '#e2d9f4', '#f6edc0', '#d0efec', '#efdfcd']

  function rgb(hex) {
    var h = { white: 'fff', black: '000' }[hex] || String(hex).replace('#', '')
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }

  /** WCAG relative luminance. */
  function luminance(hex) {
    var c = rgb(hex).map(function (v) {
      v /= 255
      // WCAG's knee, rounded: no 8-bit channel lies between its value and 0.04.
      return v <= 0.04 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }

  /** WCAG contrast ratio of two colors, 1 to 21. */
  function contrast(a, b) {
    var la = luminance(a)
    var lb = luminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  /** A color's darker shade, each channel times `by` (0 to 1). */
  function shade(hex, by) {
    return (
      '#' +
      rgb(hex)
        .map(function (c) {
          return ('0' + Math.round(c * by).toString(16)).slice(-2)
        })
        .join('')
    )
  }

  /** The text color that reads best on a fill. */
  function labelOn(fill) {
    return contrast(fill, DARK_TEXT) >= contrast(fill, LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT
  }

  /** The variables laid over Mermaid's 'neutral' theme. */
  function themeVariables() {
    var v = {}
    SECTIONS.forEach(function (fill, i) {
      v['cScale' + i] = fill
      v['cScaleLabel' + i] = labelOn(fill)
      // The line under a mind map's node: a darker shade of its fill
      // ('neutral' draws the fill's inverse, a clashing color once colored).
      v['cScaleInv' + i] = shade(fill, 0.55)
    })
    BRANCHES.forEach(function (fill, i) {
      v['git' + i] = fill
      v['gitBranchLabel' + i] = labelOn(fill)
    })
    JOURNEY.forEach(function (fill, i) {
      v['fillType' + i] = fill
    })
    // 'neutral' sets the pie's colors from cScale (pie12 from cScale0).
    // Quadrant chart: four pale quarters, the points in the first branch color.
    v.quadrant1Fill = '#dbe8f7'
    v.quadrant2Fill = '#dff1e3'
    v.quadrant3Fill = '#fbefd8'
    v.quadrant4Fill = '#f6e1e6'
    v.quadrantPointFill = BRANCHES[0]
    // Gantt: sections in alternate pale rows, tasks in the first branch
    // color (white text), active ones pale with dark text; done stays gray
    // and critical red, as in Mermaid's default theme.
    v.sectionBkgColor = '#dbe8f7'
    v.sectionBkgColor2 = '#fbefd8'
    v.altSectionBkgColor = '#ffffff'
    v.taskBkgColor = BRANCHES[0]
    v.taskBorderColor = '#2c5590'
    v.taskTextColor = LIGHT_TEXT
    v.taskTextLightColor = LIGHT_TEXT
    v.activeTaskBkgColor = '#bcd4f1'
    v.activeTaskBorderColor = BRANCHES[0]
    // An XY chart's series ('neutral' starts with #EEE, invisible on white).
    // Mermaid takes xyChart whole, so every key 'neutral' gives is here.
    v.xyChart = {
      backgroundColor: '#ffffff',
      titleColor: '#111111',
      xAxisTitleColor: '#111111',
      xAxisLabelColor: '#111111',
      xAxisTickColor: '#111111',
      xAxisLineColor: '#111111',
      yAxisTitleColor: '#111111',
      yAxisLabelColor: '#111111',
      yAxisTickColor: '#111111',
      yAxisLineColor: '#111111',
      plotColorPalette: BRANCHES.join(','),
    }
    return v
  }

  /**
   * Whether a diagram chooses its own theme: `theme:` in a `%%{init: …}%%`
   * directive or in its front matter (`themeVariables` alone does not).
   */
  function ownTheme(source) {
    var text = String(source)
    var front = /^\s*---\r?\n([\s\S]*?)\r?\n\s*---/.exec(text)
    if (front && /^\s*["']?theme["']?\s*:/m.test(front[1])) return true
    var directives = text.match(/%%\{[\s\S]*?\}%%/g) || []
    return directives.some(function (d) {
      return /["']?\btheme\b["']?\s*:/.test(d)
    })
  }

  var api = { themeVariables: themeVariables, ownTheme: ownTheme, contrast: contrast, DARK_TEXT: DARK_TEXT, LIGHT_TEXT: LIGHT_TEXT }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.mermaidColors = api
})(this)
