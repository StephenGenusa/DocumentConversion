/*
 * The Automatic picture format (settings: pictures.format 'auto', the
 * default; CLI --pictures auto): whether a picture a target can't hold is
 * better kept as PNG or made JPG, decided from its decoded pixels. Plain
 * script, loaded by host.html before host.js (window.pictureKind), and by
 * the tests as a CommonJS module.
 *
 * PNG keeps every pixel and is small for a picture made of large areas of
 * one color; JPG is far smaller for a photograph but blurs lines and text
 * and cannot see through. So a picture becomes PNG when, in this order:
 *
 *   transparent   any pixel is not fully opaque (JPG would flatten it)
 *   gif           it came from a GIF: drawn, palette art in nearly every case
 *   few colors    the sample holds 64 colors or fewer (line art, diagrams,
 *                 charts, bilevel faxes and scans), and the picture has at
 *                 least four sample pixels a color (a 4 x 4 photo is not
 *                 "few colors" for having 16 pixels)
 *   flat          its most common colors, exactly, cover 70% of the sample:
 *                 a screenshot or a drawing with anti-aliased edges (the 16
 *                 most common, or one in eight of the colors it has where
 *                 that is fewer). A gradient or a photograph spreads over
 *                 hundreds of colors, so no 16 of them cover that much.
 *   bilevel       90% of the sample is near white or near black and of
 *                 little color, at least half of it near white: a grayscale
 *                 scan of a printed page, whose paper is never one white
 *
 * and JPG otherwise ('photo'). The sample is the picture's pixels on a grid
 * of at most 256 x 256 points (every pixel of a smaller picture), taken
 * exactly, never blended; transparency is checked on every pixel. The same
 * pixels always give the same answer.
 */
;(function (root) {
  'use strict'

  var GRID = 256
  var FEW_COLORS = 64
  var DOMINANT = 16
  var FLAT_SHARE = 0.7
  var BILEVEL_SHARE = 0.9
  /** Luma at or below this is near black, at or above NEAR_WHITE near white; chroma is the channels' spread. */
  var NEAR_BLACK = 64
  var NEAR_WHITE = 192
  var GRAY_CHROMA = 32

  /**
   * `rgba` is the picture's pixels (ImageData's data: four bytes a pixel),
   * `type` the MIME type it was decoded from. Answers the format and the
   * rule that chose it (above).
   */
  function pictureKind(rgba, width, height, type) {
    for (var a = 3; a < rgba.length; a += 4) {
      if (rgba[a] !== 255) return { format: 'png', reason: 'transparent' }
    }
    if (type === 'image/gif') return { format: 'png', reason: 'gif' }
    var stepX = Math.max(1, Math.ceil(width / GRID))
    var stepY = Math.max(1, Math.ceil(height / GRID))
    var counts = new Map()
    var samples = 0
    var nearEnds = 0
    var nearWhite = 0
    for (var y = 0; y < height; y += stepY) {
      for (var x = 0; x < width; x += stepX) {
        var i = (y * width + x) * 4
        var r = rgba[i]
        var g = rgba[i + 1]
        var b = rgba[i + 2]
        var color = (r << 16) | (g << 8) | b
        counts.set(color, (counts.get(color) || 0) + 1)
        samples++
        var luma = (r * 299 + g * 587 + b * 114) / 1000
        var chroma = Math.max(r, g, b) - Math.min(r, g, b)
        if (chroma <= GRAY_CHROMA && (luma <= NEAR_BLACK || luma >= NEAR_WHITE)) {
          nearEnds++
          if (luma >= NEAR_WHITE) nearWhite++
        }
      }
    }
    if (samples === 0) return { format: 'jpeg', reason: 'photo' }
    var distinct = counts.size
    if (distinct <= FEW_COLORS && distinct * 4 <= samples) return { format: 'png', reason: 'few colors' }
    var top = Math.min(DOMINANT, Math.max(1, Math.floor(distinct / 8)))
    var largest = Array.from(counts.values()).sort(function (p, q) {
      return q - p
    })
    var covered = 0
    for (var k = 0; k < top; k++) covered += largest[k]
    if (covered >= FLAT_SHARE * samples) return { format: 'png', reason: 'flat' }
    if (nearEnds >= BILEVEL_SHARE * samples && nearWhite * 2 >= nearEnds) return { format: 'png', reason: 'bilevel' }
    return { format: 'jpeg', reason: 'photo' }
  }

  if (typeof module === 'object' && module.exports) module.exports = { pictureKind: pictureKind }
  else root.pictureKind = pictureKind
})(this)
