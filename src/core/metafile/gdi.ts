import { View } from './bytes'
import type { GlyphFonts } from './fonts'
import { Budget, crop, isPicture, keyOut, readBitmap16, readDib, toPicture, unpremultiply, type Picture, type Raster } from './dib'
import {
  apply,
  axisAligned,
  clipExcludePath,
  clipExcludeRects,
  clipIntersectPath,
  clipIntersectRects,
  clipOffset,
  clipRects,
  clipUnion,
  det,
  esc,
  hex,
  IDENTITY,
  matrixAttr,
  num,
  PathData,
  pathContains,
  rect,
  scaleOf,
  compose,
  union,
  type Blend,
  type Clip,
  type Matrix,
  type Paint,
  type RecentShape,
  type Rect,
  type Stroke,
  type SvgOut,
} from './svg'
import { gouraud, shade, type Corners, type ShadeTriangle } from './shade'

/*
 * GDI's device context, as EMF and WMF records drive it (emf.ts, wmf.ts):
 * the objects (pens, brushes, fonts, palettes, regions), the mapping from
 * logical units to the device (mapping mode, window and viewport, world
 * transform), the clip, the path bracket, and the drawing calls, each
 * drawn into an SvgOut in device space.
 *
 * Coordinates go through the whole transform as they are recorded, as GDI
 * does: a path is kept in device space, so a transform changed half-way
 * through a path leaves what was already recorded where it was. Arcs and
 * ellipses become cubic Béziers in logical space first, so any transform,
 * rotated or sheared, maps them exactly. Text and bitmaps are placed by a
 * transform of their own.
 */

export interface Font {
  height: number
  width: number
  escapement: number
  orientation: number
  weight: number
  italic: boolean
  underline: boolean
  strike: boolean
  charset: number
  pitchFamily: number
  face: string
}

export interface Pen {
  style: number
  /** Logical units; 0 for a cosmetic pen (one pixel). */
  width: number
  color: number
  /** PS_GEOMETRIC, or a CreatePen pen wider than one unit: scaled with the drawing. */
  geometric: boolean
  /** EXTCREATEPEN (its caps and joins count; CreatePen's are round). */
  extended: boolean
  user?: number[]
}

/** A bitmap brush's DIB, decoded when it is used (a monochrome one takes the colors of the moment). */
export interface DibSource {
  info: View
  bits: View
  usage: number
}

export interface Brush {
  style: number
  color: number
  hatch: number
  dib?: DibSource
  /** An old WMF pattern brush's device-dependent bitmap (a Bitmap16 object, its rows 32 bytes in). */
  ddb?: View
  mono?: boolean
}

export type GdiObject =
  | { type: 'pen'; pen: Pen }
  | { type: 'brush'; brush: Brush }
  | { type: 'font'; font: Font }
  | { type: 'palette'; colors: number[] }
  | { type: 'region'; rects: Rect[] }

interface DC {
  pen: Pen
  brush: Brush
  font: Font
  palette: number[] | null
  textColor: number
  bkColor: number
  bkMode: number
  fillMode: number
  rop2: number
  textAlign: number
  mapMode: number
  winOrg: [number, number]
  winExt: [number, number]
  vpOrg: [number, number]
  vpExt: [number, number]
  world: Matrix
  clip: Clip
  cur: [number, number]
  arcCCW: boolean
  miter: number
  /** SetLayout: LAYOUT_RTL (1), LAYOUT_BITMAPORIENTATIONPRESERVED (8). */
  layout: number
}

export const DEFAULT_FONT: Font = {
  height: -16,
  width: 0,
  escapement: 0,
  orientation: 0,
  weight: 400,
  italic: false,
  underline: false,
  strike: false,
  charset: 0,
  pitchFamily: 0,
  face: '',
}

const BLACK_PEN: Pen = { style: 0, width: 0, color: 0, geometric: false, extended: false }
const WHITE_BRUSH: Brush = { style: 0, color: 0xffffff, hatch: 0 }

/** Stock objects (GetStockObject), by index. */
export function stockObject(index: number): GdiObject | null {
  const solid = (rgb: number): GdiObject => ({ type: 'brush', brush: { style: 0, color: rgb, hatch: 0 } })
  switch (index) {
    case 0:
      return solid(0xffffff)
    case 1:
      return solid(0xc0c0c0)
    case 2:
      return solid(0x808080)
    case 3:
      return solid(0x404040)
    case 4:
      return solid(0)
    case 5:
      return { type: 'brush', brush: { style: 1, color: 0, hatch: 0 } }
    case 6:
      return { type: 'pen', pen: { ...BLACK_PEN, color: 0xffffff } }
    case 7:
      return { type: 'pen', pen: BLACK_PEN }
    case 8:
      return { type: 'pen', pen: { ...BLACK_PEN, style: 5 } }
    case 10:
    case 11:
    case 16:
      return { type: 'font', font: { ...DEFAULT_FONT, pitchFamily: 0x31, face: 'Courier New' } }
    case 12:
    case 13:
    case 14:
    case 17:
      return { type: 'font', font: DEFAULT_FONT }
    case 15:
      return { type: 'palette', colors: [] }
    case 18:
      return solid(0xffffff)
    case 19:
      return { type: 'pen', pen: BLACK_PEN }
    default:
      return null
  }
}

/** A COLORREF (0x00bbggrr, or a palette index when its high byte is 1) as 0xRRGGBB. */
export function colorref(c: number, palette?: readonly number[] | null): number {
  if ((c >>> 24) === 1 && palette) return palette[c & 0xffff] ?? 0
  return ((c & 0xff) << 16) | (c & 0xff00) | ((c >>> 16) & 0xff)
}

/* Text alignment and ExtTextOut options. */
const TA_UPDATECP = 1
const TA_RIGHT = 2
const TA_CENTER = 6
const TA_BOTTOM = 8
const TA_BASELINE = 24
export const ETO_OPAQUE = 2
export const ETO_CLIPPED = 4
export const ETO_GLYPH_INDEX = 0x10
export const ETO_RTLREADING = 0x80
export const ETO_PDY = 0x2000
const TA_RTLREADING = 0x100
/* SetLayout. */
const LAYOUT_RTL = 1
const LAYOUT_BITMAPORIENTATIONPRESERVED = 8

/** How much of the em is above the baseline and below it, for placing text by its top or bottom. */
const ASCENT = 0.905
const DESCENT = 0.212
/** A font's cell height (positive lfHeight) over its em: ascent plus descent. */
const CELL = ASCENT + DESCENT

/** Fonts that ship under another name with the same metrics, so text keeps its width where the original is missing. */
const SUBSTITUTES: Record<string, string[]> = {
  calibri: ['Carlito'],
  cambria: ['Caladea'],
  arial: ['Liberation Sans', 'Arimo'],
  helvetica: ['Liberation Sans', 'Arimo'],
  'arial narrow': ['Liberation Sans Narrow'],
  'times new roman': ['Liberation Serif', 'Tinos'],
  times: ['Liberation Serif', 'Tinos'],
  'courier new': ['Liberation Mono', 'Cousine'],
  courier: ['Liberation Mono', 'Cousine'],
  'segoe ui': ['Selawik'],
}

/** Symbol's letters and signs, as Unicode (the font maps ASCII codes to Greek). */
const SYMBOL_CHARS: Record<number, string> = (() => {
  const upper = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ'
  const lower = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ'
  const map: Record<number, string> = {}
  for (let i = 0; i < 26; i++) {
    map[0x41 + i] = upper[i]
    map[0x61 + i] = lower[i]
  }
  const signs: [number, string][] = [
    [0xb7, '•'], [0xb4, '×'], [0xb8, '÷'], [0xb1, '±'], [0xa3, '≤'], [0xb3, '≥'], [0xb9, '≠'], [0xbb, '≈'], [0xa5, '∞'],
    [0xd6, '√'], [0xe5, '∑'], [0xf2, '∫'], [0xb6, '∂'], [0xd1, '∇'], [0xae, '→'], [0xac, '←'], [0xad, '↑'], [0xaf, '↓'],
    [0xb0, '°'], [0xa2, '′'], [0xb2, '″'], [0xce, '∈'], [0xc7, '∩'], [0xc8, '∪'], [0xd7, '·'], [0xbc, '…'], [0x22, '∀'], [0x24, '∃'],
  ]
  for (const [k, v] of signs) map[k] = v
  return map
})()

/** Wingdings' common bullets and marks. */
const WINGDINGS_CHARS: Record<number, string> = {
  0x6c: '●', 0x6e: '■', 0x6f: '□', 0x71: '❑', 0x76: '❖', 0x77: '◆', 0x9f: '•', 0xa7: '▪', 0xa8: '◻', 0xd8: '➢', 0xe0: '→',
  0xe8: '➔', 0xf0: '⇨', 0xfb: '✗', 0xfc: '✓', 0xfd: '☒', 0xfe: '☑', 0x4a: '☺', 0x4c: '☹', 0xab: '★',
}

/** A face name as written into the SVG: letters, digits, spaces and dashes only. */
function cleanFace(face: string): string {
  return face.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 64)
}

function generic(font: Font): string {
  const family = font.pitchFamily & 0xf0
  if (family === 0x10) return 'serif'
  if (family === 0x30) return 'monospace'
  if (family === 0x40) return 'cursive'
  if (family === 0x20) return 'sans-serif'
  if ((font.pitchFamily & 3) === 1) return 'monospace'
  if (/times|roman|serif|garamond|georgia|cambria|book|palatino|minion/i.test(font.face)) return 'serif'
  if (/courier|mono|consol|typewriter/i.test(font.face)) return 'monospace'
  return 'sans-serif'
}

/** A font's face and its metric-compatible substitutes, the face first. */
function fontNames(font: Font): string[] {
  const face = cleanFace(font.face)
  return face ? [face, ...(SUBSTITUTES[face.toLowerCase()] ?? [])] : []
}

/**
 * The font-family a font is drawn with: its face, metric-compatible
 * substitutes, then the generic family. A reader (and the render host,
 * Chromium) takes the first of them it has, by name, from the fonts
 * installed: the face where it is installed, else its twin, else the
 * generic family, which is the right kind (serif, sans-serif, monospace)
 * by the font's pitch and family or, without them, its name.
 */
export function fontFamily(font: Font, symbolic = false): string {
  const names = symbolic ? [] : fontNames(font)
  return [...names.map((n) => `'${n}'`), generic(font)].join(',')
}

/**
 * How far each of `chars` moves the pen, at `em`, measured with the font
 * or (the same widths) its metric-compatible twin, when one is installed
 * (fonts.ts): for text that comes without its advances. Null when none is
 * here, or a character is not in it. Control characters take no room.
 */
export function measure(fonts: GlyphFonts | undefined, font: Font, chars: string[], em: number): number[] | null {
  const widths = fonts?.advances(fontNames(font), font.weight >= 650, font.italic)
  if (!widths) return null
  const out: number[] = []
  for (const c of chars) {
    const code = c.codePointAt(0)!
    if (code < 0x20) {
      out.push(0)
      continue
    }
    const w = widths.get(code)
    if (w === undefined) return null
    out.push(w * em)
  }
  return out
}

/** Which symbol font, if any, maps a font's codes to other characters. */
function symbolTable(font: Font): Record<number, string> | null {
  const face = font.face.trim().toLowerCase()
  if (face === 'symbol') return SYMBOL_CHARS
  if (/^wingdings/.test(face)) return WINGDINGS_CHARS
  return null
}

/** Text in a symbol font as the characters it shows (codes U+F020-U+F0FF are the font's own codes). */
export function mapSymbols(text: string, font: Font): { text: string; symbolic: boolean } {
  const table = symbolTable(font)
  if (!table) return { text, symbolic: false }
  let out = ''
  for (const ch of text) {
    let code = ch.codePointAt(0)!
    if (code >= 0xf000 && code <= 0xf0ff) code -= 0xf000
    out += table[code] ?? (code >= 0x20 && code < 0x7f && table === SYMBOL_CHARS ? String.fromCharCode(code) : '•')
  }
  return { text: out, symbolic: true }
}

/** The code page a font's charset names, as TextDecoder knows it. */
const CHARSET_ENCODINGS: Record<number, string> = {
  0: 'windows-1252',
  1: 'windows-1252',
  77: 'macintosh',
  128: 'shift_jis',
  129: 'euc-kr',
  134: 'gbk',
  136: 'big5',
  161: 'windows-1253',
  162: 'windows-1254',
  163: 'windows-1258',
  177: 'windows-1255',
  178: 'windows-1256',
  186: 'windows-1257',
  204: 'windows-1251',
  222: 'windows-874',
  238: 'windows-1250',
}

/** 8-bit text in a font's charset. */
export function decodeAnsi(bytes: Buffer, charset: number): string {
  if (charset === 2) return [...bytes].map((b) => String.fromCharCode(0xf000 + b)).join('')
  try {
    return new TextDecoder(CHARSET_ENCODINGS[charset] ?? 'windows-1252').decode(bytes)
  } catch {
    return bytes.toString('latin1')
  }
}

/** Whether a charset is one byte a character (so a dx array has one entry a character). */
export function singleByte(charset: number): boolean {
  return ![128, 129, 130, 134, 136].includes(charset)
}

/* Binary raster operations (SetROP2). */
const R2_BLACK = 1
const R2_NOT = 6
const R2_XORPEN = 7
const R2_MASKPEN = 9
const R2_NOTXORPEN = 10
const R2_NOP = 11
const R2_NOTCOPYPEN = 4
const R2_MERGEPEN = 15
const R2_WHITE = 16

const KAPPA_ARC = (sweep: number): number => (4 / 3) * Math.tan(sweep / 4)

export interface GdiSetup {
  out: SvgOut
  budget: Budget
  /** Device pixels per millimeter (EMF's reference device). */
  pxPerMm: [number, number]
  /** The area outside which nothing shows, for clips that exclude. */
  universe: Rect
  /** WMF: the window maps onto this rectangle of the picture (its viewBox), once a window is known. */
  wmfView?: Rect
  /** The fonts text given as glyph numbers is read with, and text without advances measured with (fonts.ts). */
  fonts?: GlyphFonts
  /** The picture's frame in device space: what a right-to-left layout mirrors across. */
  frame?: Rect | null
}

export class Gdi {
  dc: DC
  private stack: DC[] = []
  readonly objects = new Map<number, GdiObject>()
  path: PathData | null = null
  private pathOpen = false
  private m: Matrix | null = null
  /** WMF: whether a window has been set (or given by the placeable header). */
  windowKnown = false
  /** What the metafile asked for that is not drawn, once each. */
  readonly lost = new Set<string>()
  private patterns = new Map<string, string>()

  constructor(readonly setup: GdiSetup) {
    this.dc = {
      pen: BLACK_PEN,
      brush: WHITE_BRUSH,
      font: DEFAULT_FONT,
      palette: null,
      textColor: 0,
      bkColor: 0xffffff,
      bkMode: 2,
      fillMode: 1,
      rop2: 13,
      textAlign: 0,
      mapMode: 1,
      winOrg: [0, 0],
      winExt: [1, 1],
      vpOrg: [0, 0],
      vpExt: [1, 1],
      world: IDENTITY,
      clip: null,
      cur: [0, 0],
      arcCCW: true,
      miter: 10,
      layout: 0,
    }
  }

  get out(): SvgOut {
    return this.setup.out
  }

  /* ---- state ---------------------------------------------------------- */

  changed(): void {
    this.m = null
  }

  set<K extends keyof DC>(key: K, value: DC[K]): void {
    this.dc = { ...this.dc, [key]: value }
    if (['mapMode', 'winOrg', 'winExt', 'vpOrg', 'vpExt', 'world', 'layout'].includes(key)) this.m = null
    if (key === 'layout' && (value as number) & LAYOUT_RTL && !this.setup.frame) this.lost.add('right-to-left layout')
  }

  save(): void {
    if (this.stack.length < 1000) this.stack.push(this.dc)
  }

  restore(n: number): void {
    // Negative: that many back (-1 the last saved); positive: the n-th saved.
    const index = n < 0 ? this.stack.length + n : n - 1
    if (index < 0 || index >= this.stack.length) return
    this.dc = this.stack[index]
    this.stack.length = index
    this.m = null
  }

  /**
   * Logical units to device units: world transform, then the mapping
   * mode's page transform, then, in a right-to-left layout, the mirror
   * across the picture's frame (GDI mirrors across the device; the frame
   * is this picture's device).
   */
  matrix(): Matrix {
    if (!this.m) {
      const m = compose(this.dc.world, this.page())
      const f = this.setup.frame
      this.m = this.mirrored() && f ? compose(m, [-1, 0, 0, 1, f.l + f.r, 0]) : m
    }
    return this.m
  }

  /** Whether the layout is right to left (and there is a frame to mirror across). */
  mirrored(): boolean {
    return (this.dc.layout & LAYOUT_RTL) !== 0 && !!this.setup.frame
  }

  private page(): Matrix {
    const dc = this.dc
    const nz = (v: number): number => (v === 0 || !Number.isFinite(v) ? 1 : v)
    if (this.setup.wmfView) {
      if (!this.windowKnown) return IDENTITY
      const v = this.setup.wmfView
      const sx = (v.r - v.l) / nz(dc.winExt[0])
      const sy = (v.b - v.t) / nz(dc.winExt[1])
      return [sx, 0, 0, sy, v.l - dc.winOrg[0] * sx, v.t - dc.winOrg[1] * sy]
    }
    const [mx, my] = this.setup.pxPerMm
    let sx = 1
    let sy = 1
    switch (dc.mapMode) {
      case 2: // MM_LOMETRIC, 0.1 mm
        sx = 0.1 * mx
        sy = -0.1 * my
        break
      case 3: // MM_HIMETRIC, 0.01 mm
        sx = 0.01 * mx
        sy = -0.01 * my
        break
      case 4: // MM_LOENGLISH, 0.01 in
        sx = 0.254 * mx
        sy = -0.254 * my
        break
      case 5: // MM_HIENGLISH, 0.001 in
        sx = 0.0254 * mx
        sy = -0.0254 * my
        break
      case 6: // MM_TWIPS
        sx = (25.4 / 1440) * mx
        sy = (-25.4 / 1440) * my
        break
      case 7: // MM_ISOTROPIC: the same scale both ways, the smaller one
      case 8: {
        sx = dc.vpExt[0] / nz(dc.winExt[0])
        sy = dc.vpExt[1] / nz(dc.winExt[1])
        if (dc.mapMode === 7) {
          const s = Math.min(Math.abs(sx), Math.abs(sy))
          sx = Math.sign(sx || 1) * s
          sy = Math.sign(sy || 1) * s
        }
        break
      }
    }
    return [sx, 0, 0, sy, dc.vpOrg[0] - dc.winOrg[0] * sx, dc.vpOrg[1] - dc.winOrg[1] * sy]
  }

  /* ---- objects -------------------------------------------------------- */

  select(obj: GdiObject | undefined): void {
    if (!obj) return
    switch (obj.type) {
      case 'pen':
        this.set('pen', obj.pen)
        break
      case 'brush':
        this.set('brush', obj.brush)
        break
      case 'font':
        this.set('font', obj.font)
        break
      case 'palette':
        this.set('palette', obj.colors)
        break
      case 'region':
        this.selectClipRegion(this.regionToDevice(obj.rects), 5)
        break
    }
  }

  color(c: number): number {
    return colorref(c, this.dc.palette)
  }

  /* ---- paint ---------------------------------------------------------- */

  /** The color a pen or brush color is drawn as under the ROP2, and the blend; null: nothing is drawn. */
  private rop(rgb: number): { rgb: number; blend?: Blend } | null {
    switch (this.dc.rop2) {
      case R2_NOP:
        return null
      case R2_BLACK:
        return { rgb: 0 }
      case R2_WHITE:
        return { rgb: 0xffffff }
      case R2_NOTCOPYPEN:
        return { rgb: rgb ^ 0xffffff }
      case R2_MASKPEN:
        return { rgb, blend: 'multiply' }
      case R2_MERGEPEN:
        return { rgb, blend: 'lighten' }
      case R2_XORPEN:
      case R2_NOTXORPEN:
        return { rgb, blend: 'difference' }
      case R2_NOT:
        return { rgb: 0xffffff, blend: 'difference' }
      default:
        return { rgb }
    }
  }

  blend(): Blend | undefined {
    return this.rop(0)?.blend
  }

  /** The current brush as a fill; null for a null brush or ROP2 that draws nothing. */
  fill(brush = this.dc.brush): Paint | null {
    switch (brush.style) {
      case 1:
        return null
      case 2:
        return this.hatch(brush.hatch, this.color(brush.color))
      case 3:
      case 5:
      case 6:
        return this.dibPattern(brush) ?? { kind: 'color', rgb: 0x808080 }
      default: {
        const r = this.rop(this.color(brush.color))
        return r ? { kind: 'color', rgb: r.rgb } : null
      }
    }
  }

  /** A hatch brush as an SVG pattern, eight CSS px a tile, its background the background color where the mode is opaque. */
  private hatch(style: number, rgb: number): Paint {
    const bk = this.dc.bkMode === 2 ? this.color(this.dc.bkColor) : null
    const t = 8 * this.out.hairline
    const key = `hatch:${style}:${rgb}:${bk}:${num(t)}`
    let id = this.patterns.get(key)
    if (!id) {
      const T = num(t)
      const h = num(t / 2)
      const lines: Record<number, string> = {
        0: `M0 ${h}H${T}`,
        1: `M${h} 0V${T}`,
        2: `M0 0L${T} ${T}M${num(-t / 2)} ${h}L${h} ${num(t * 1.5)}M${h} ${num(-t / 2)}L${num(t * 1.5)} ${h}`,
        3: `M0 ${T}L${T} 0M${num(-t / 2)} ${h}L${h} ${num(-t / 2)}M${h} ${num(t * 1.5)}L${num(t * 1.5)} ${h}`,
        4: `M0 ${h}H${T}M${h} 0V${T}`,
        5: `M0 0L${T} ${T}M0 ${T}L${T} 0`,
      }
      const d = lines[style] ?? lines[4]
      id = this.out.def(key, (id) =>
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${T}" height="${T}">` +
        (bk === null ? '' : `<rect width="${T}" height="${T}" fill="${hex(bk)}"/>`) +
        `<path d="${d}" fill="none" stroke="${hex(rgb)}" stroke-width="${num(this.out.hairline)}"/></pattern>`,
      )
      this.patterns.set(key, id)
    }
    return { kind: 'url', id }
  }

  /** A bitmap brush as an SVG pattern of its bitmap, a device pixel a pixel. */
  private dibPattern(brush: Brush): Paint | null {
    const src = brush.dib
    if (!src && !brush.ddb) return null
    const mono: [number, number] | undefined = brush.mono || brush.ddb ? [this.color(this.dc.textColor), this.color(this.dc.bkColor)] : undefined
    const key = src ? `dib:${src.info.start}:${src.bits.start}:${mono?.join(',') ?? ''}` : `ddb:${brush.ddb!.start}:${mono?.join(',')}`
    let id = this.patterns.get(key)
    if (!id) {
      const opts = { budget: this.setup.budget, usage: src?.usage, palette: this.dc.palette ?? undefined, mono }
      const bmp = src ? readDib(src.info, src.bits, opts) : readBitmap16(brush.ddb!, 32, opts)
      if (!bmp) return null
      const pic = toPicture(bmp)
      const w = num(pic.width * this.out.hairline)
      const h = num(pic.height * this.out.hairline)
      id = this.out.def(key, (id) =>
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${w}" height="${h}"><image width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:${pic.mime};base64,${pic.bytes.toString('base64')}"/></pattern>`,
      )
      this.patterns.set(key, id)
    }
    return { kind: 'url', id }
  }

  /** The current pen as a stroke, in device units; null for a null pen or ROP2 that draws nothing. */
  stroke(pen = this.dc.pen): Stroke | null {
    const kind = pen.style & 0x0f
    if (kind === 5) return null
    const r = this.rop(this.color(pen.color))
    if (!r) return null
    const m = this.matrix()
    const width = pen.geometric ? pen.width * scaleOf(m) : 0
    const unit = pen.geometric ? Math.max(width, this.out.hairline) : this.out.hairline
    // CreatePen draws a pen wider than one unit solid, whatever its style says.
    const dashed = pen.extended || pen.width <= 1
    let dash: number[] | undefined
    if (dashed) {
      const cosmetic = !pen.geometric
      const patterns: Record<number, number[]> = cosmetic
        ? { 1: [18, 6], 2: [3, 3], 3: [9, 6, 3, 6], 4: [9, 3, 3, 3, 3, 3], 8: [1, 1] }
        : { 1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1], 8: [1, 1] }
      if (kind === 7 && pen.user?.length) dash = pen.user.map((v) => v * (cosmetic ? this.out.hairline : scaleOf(m)))
      else if (patterns[kind]) dash = patterns[kind].map((v) => v * unit)
    }
    const caps = pen.extended ? pen.style & 0x0f00 : 0
    const joins = pen.extended ? pen.style & 0xf000 : 0
    return {
      paint: { kind: 'color', rgb: r.rgb },
      width,
      dash,
      cap: dash && !pen.geometric ? 'butt' : caps === 0x200 ? 'butt' : caps === 0x100 ? 'square' : 'round',
      join: joins === 0x1000 ? 'bevel' : joins === 0x2000 ? 'miter' : 'round',
      miter: this.dc.miter,
    }
  }

  private rule(): 'nonzero' | 'evenodd' {
    return this.dc.fillMode === 2 ? 'nonzero' : 'evenodd'
  }

  /* ---- geometry ------------------------------------------------------- */

  private pt(x: number, y: number): [number, number] {
    return apply(this.matrix(), x, y)
  }

  /** The path drawing goes into: the open path bracket, or a new one drawn at once. */
  private target(): PathData {
    return this.pathOpen && this.path ? this.path : new PathData()
  }

  /** Draw a figure built outside a path bracket (inside one it is only recorded). */
  private done(p: PathData, fill: boolean, stroke: boolean): void {
    if (this.pathOpen) return
    this.out.shape(p, fill ? this.fill() : null, stroke ? this.stroke() : null, this.rule(), this.dc.clip, this.blend())
  }

  moveTo(x: number, y: number): void {
    this.set('cur', [x, y])
    if (this.pathOpen && this.path) this.path.moveTo(...this.pt(x, y))
  }

  lineTo(x: number, y: number): void {
    const p = this.target()
    if (!this.pathOpen || !p.start) p.moveTo(...this.pt(...this.dc.cur))
    p.lineTo(...this.pt(x, y))
    this.set('cur', [x, y])
    this.done(p, false, true)
  }

  /** Polyline (open, stroked) or Polygon (closed, filled and stroked); points flat, x then y. */
  poly(points: number[], closed: boolean): void {
    if (points.length < 4) return
    const p = this.target()
    p.moveTo(...this.pt(points[0], points[1]))
    for (let i = 2; i + 1 < points.length; i += 2) p.lineTo(...this.pt(points[i], points[i + 1]))
    if (closed) p.close()
    this.done(p, closed, true)
  }

  polyPoly(polys: number[][], closed: boolean): void {
    const p = this.target()
    for (const pts of polys) {
      if (pts.length < 4) continue
      p.moveTo(...this.pt(pts[0], pts[1]))
      for (let i = 2; i + 1 < pts.length; i += 2) p.lineTo(...this.pt(pts[i], pts[i + 1]))
      if (closed) p.close()
    }
    this.done(p, closed, true)
  }

  /** PolylineTo: lines on from the current position. */
  polyTo(points: number[]): void {
    if (points.length < 2) return
    const p = this.target()
    if (!this.pathOpen || !p.start) p.moveTo(...this.pt(...this.dc.cur))
    for (let i = 0; i + 1 < points.length; i += 2) p.lineTo(...this.pt(points[i], points[i + 1]))
    this.set('cur', [points[points.length - 2], points[points.length - 1]])
    this.done(p, false, true)
  }

  /** PolyBezier (a start point, then three points a curve) or PolyBezierTo (from the current position). */
  bezier(points: number[], fromCurrent: boolean): void {
    const p = this.target()
    let i = 0
    if (fromCurrent) {
      if (!this.pathOpen || !p.start) p.moveTo(...this.pt(...this.dc.cur))
    } else {
      if (points.length < 8) return
      p.moveTo(...this.pt(points[0], points[1]))
      i = 2
    }
    for (; i + 5 < points.length; i += 6) {
      p.curveTo(...this.pt(points[i], points[i + 1]), ...this.pt(points[i + 2], points[i + 3]), ...this.pt(points[i + 4], points[i + 5]))
    }
    if (points.length >= 2) this.set('cur', [points[i - 2] ?? this.dc.cur[0], points[i - 1] ?? this.dc.cur[1]])
    this.done(p, false, true)
  }

  /** PolyDraw: points each with its type (PT_MOVETO 6, PT_LINETO 2, PT_BEZIERTO 4, | PT_CLOSEFIGURE 1). */
  polyDraw(points: number[], types: number[]): void {
    const p = this.target()
    if (!this.pathOpen || !p.start) p.moveTo(...this.pt(...this.dc.cur))
    for (let k = 0; k < types.length && 2 * k + 1 < points.length; k++) {
      const t = types[k] & ~1
      const x = points[2 * k]
      const y = points[2 * k + 1]
      if (t === 6) p.moveTo(...this.pt(x, y))
      else if (t === 2) p.lineTo(...this.pt(x, y))
      else if (t === 4 && 2 * k + 5 < points.length) {
        p.curveTo(...this.pt(x, y), ...this.pt(points[2 * k + 2], points[2 * k + 3]), ...this.pt(points[2 * k + 4], points[2 * k + 5]))
        k += 2
      }
      if (types[k] & 1) p.close()
      this.set('cur', [points[2 * k], points[2 * k + 1]])
    }
    this.done(p, false, true)
  }

  rectangle(l: number, t: number, r: number, b: number): void {
    const p = this.target()
    p.moveTo(...this.pt(l, t))
    p.lineTo(...this.pt(r, t))
    p.lineTo(...this.pt(r, b))
    p.lineTo(...this.pt(l, b))
    p.close()
    this.done(p, true, true)
  }

  /** Part of an ellipse (center, radii, in logical units) from parameter angle t0 through `sweep`, as Béziers. */
  private arcInto(p: PathData, cx: number, cy: number, rx: number, ry: number, t0: number, sweep: number, join: 'move' | 'line'): void {
    const at = (t: number): [number, number] => this.pt(cx + rx * Math.cos(t), cy + ry * Math.sin(t))
    if (join === 'move' || !p.start) p.moveTo(...at(t0))
    else p.lineTo(...at(t0))
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
    const seg = sweep / n
    const k = KAPPA_ARC(seg)
    for (let i = 0; i < n; i++) {
      const a = t0 + i * seg
      const b = a + seg
      p.curveTo(
        ...this.pt(cx + rx * (Math.cos(a) - k * Math.sin(a)), cy + ry * (Math.sin(a) + k * Math.cos(a))),
        ...this.pt(cx + rx * (Math.cos(b) + k * Math.sin(b)), cy + ry * (Math.sin(b) - k * Math.cos(b))),
        ...at(b),
      )
    }
  }

  ellipse(l: number, t: number, r: number, b: number): void {
    const p = this.target()
    this.arcInto(p, (l + r) / 2, (t + b) / 2, (r - l) / 2, (b - t) / 2, 0, 2 * Math.PI, 'move')
    p.close()
    this.done(p, true, true)
  }

  roundRect(l: number, t: number, r: number, b: number, w: number, h: number): void {
    ;[l, r] = [Math.min(l, r), Math.max(l, r)]
    ;[t, b] = [Math.min(t, b), Math.max(t, b)]
    const rx = Math.min(Math.abs(w) / 2, (r - l) / 2)
    const ry = Math.min(Math.abs(h) / 2, (b - t) / 2)
    const p = this.target()
    const q = Math.PI / 2
    p.moveTo(...this.pt(l + rx, t))
    this.arcInto(p, r - rx, t + ry, rx, ry, -q, q, 'line')
    this.arcInto(p, r - rx, b - ry, rx, ry, 0, q, 'line')
    this.arcInto(p, l + rx, b - ry, rx, ry, q, q, 'line')
    this.arcInto(p, l + rx, t + ry, rx, ry, 2 * q, q, 'line')
    p.close()
    this.done(p, true, true)
  }

  /**
   * Arc / Chord / Pie / ArcTo: the ellipse in the box, from where the line
   * from its center to the start point crosses it to where the line to the
   * end point does, in the arc direction (counter-clockwise as it is seen,
   * unless SetArcDirection said otherwise).
   */
  arc(kind: 'arc' | 'chord' | 'pie' | 'arcto', l: number, t: number, r: number, b: number, xs: number, ys: number, xe: number, ye: number): void {
    const cx = (l + r) / 2
    const cy = (t + b) / 2
    const rx = Math.abs(r - l) / 2
    const ry = Math.abs(b - t) / 2
    if (!(rx > 0 && ry > 0)) return
    const angle = (x: number, y: number): number => Math.atan2((y - cy) / ry, (x - cx) / rx)
    const t0 = angle(xs, ys)
    const t1 = angle(xe, ye)
    // Counter-clockwise on a y-down device is decreasing t; a flipped transform turns it round.
    const sign = this.dc.arcCCW === det(this.matrix()) > 0 ? -1 : 1
    const tau = 2 * Math.PI
    let sweep = sign > 0 ? (t1 - t0 + tau) % tau : -((t0 - t1 + tau) % tau)
    if (Math.abs(sweep) < 1e-9) sweep = sign * tau
    const p = this.target()
    if (kind === 'arcto') {
      if (!this.pathOpen || !p.start) p.moveTo(...this.pt(...this.dc.cur))
      this.arcInto(p, cx, cy, rx, ry, t0, sweep, 'line')
      const end = t0 + sweep
      this.set('cur', [cx + rx * Math.cos(end), cy + ry * Math.sin(end)])
      this.done(p, false, true)
      return
    }
    this.arcInto(p, cx, cy, rx, ry, t0, sweep, 'move')
    if (kind === 'pie') p.lineTo(...this.pt(cx, cy))
    if (kind !== 'arc') p.close()
    this.done(p, kind !== 'arc', true)
  }

  /** AngleArc: a line from the current position, then an arc of a circle; angles in degrees, counter-clockwise as seen. */
  angleArc(x: number, y: number, radius: number, start: number, sweep: number): void {
    const flip = det(this.matrix()) > 0 ? -1 : 1
    const t0 = (flip * start * Math.PI) / 180
    const s = (flip * sweep * Math.PI) / 180
    const p = this.target()
    if (!this.pathOpen || !p.start) p.moveTo(...this.pt(...this.dc.cur))
    this.arcInto(p, x, y, radius, radius, t0, s, 'line')
    this.set('cur', [x + radius * Math.cos(t0 + s), y + radius * Math.sin(t0 + s)])
    this.done(p, false, true)
  }

  setPixel(x: number, y: number, c: number): void {
    const [dx, dy] = this.pt(x, y)
    const p = new PathData()
    const s = this.out.hairline
    p.moveTo(dx, dy)
    p.lineTo(dx + s, dy)
    p.lineTo(dx + s, dy + s)
    p.lineTo(dx, dy + s)
    p.close()
    this.out.shape(p, { kind: 'color', rgb: this.color(c) }, null, 'nonzero', this.dc.clip)
  }

  /* ---- path bracket --------------------------------------------------- */

  beginPath(): void {
    this.path = new PathData()
    this.pathOpen = true
  }
  endPath(): void {
    this.pathOpen = false
  }
  abortPath(): void {
    this.path = null
    this.pathOpen = false
  }
  closeFigure(): void {
    this.path?.close()
  }
  /** FillPath, StrokePath, StrokeAndFillPath: the path drawn, then gone. */
  drawPath(fill: boolean, stroke: boolean): void {
    const p = this.path
    this.path = null
    this.pathOpen = false
    if (!p || p.empty) return
    if (fill) {
      // Filling closes every figure.
      p.close()
    }
    this.out.shape(p, fill ? this.fill() : null, stroke ? this.stroke() : null, this.rule(), this.dc.clip, this.blend())
  }

  /* ---- clipping ------------------------------------------------------- */

  private deviceRects(l: number, t: number, r: number, b: number): Rect | null {
    const m = this.matrix()
    if (!axisAligned(m)) return null
    const [x0, y0] = apply(m, l, t)
    const [x1, y1] = apply(m, r, b)
    return rect(x0, y0, x1, y1)
  }

  private quad(l: number, t: number, r: number, b: number): string {
    const p = new PathData()
    p.moveTo(...this.pt(l, t))
    p.lineTo(...this.pt(r, t))
    p.lineTo(...this.pt(r, b))
    p.lineTo(...this.pt(l, b))
    p.close()
    return p.d
  }

  intersectClipRect(l: number, t: number, r: number, b: number): void {
    const d = this.deviceRects(l, t, r, b)
    this.set('clip', d ? clipIntersectRects(this.dc.clip, [d]) : clipIntersectPath(this.dc.clip, this.quad(l, t, r, b), 'nonzero'))
  }

  excludeClipRect(l: number, t: number, r: number, b: number): void {
    const d = this.deviceRects(l, t, r, b)
    this.set('clip', d ? clipExcludeRects(this.dc.clip, [d], this.setup.universe) : clipExcludePath(this.dc.clip, this.quad(l, t, r, b), this.setup.universe))
  }

  offsetClip(dx: number, dy: number): void {
    const m = this.matrix()
    this.set('clip', clipOffset(this.dc.clip, dx * m[0], dy * m[3]))
  }

  /** A region's rectangles (logical units) in device space. */
  regionToDevice(rects: Rect[]): Rect[] {
    const out: Rect[] = []
    for (const r of rects) {
      const d = this.deviceRects(r.l, r.t, r.r, r.b)
      if (d) out.push(d)
      else {
        // Rotated: its corners' box, the nearest a list of rectangles comes.
        const pts = [this.pt(r.l, r.t), this.pt(r.r, r.t), this.pt(r.l, r.b), this.pt(r.r, r.b)]
        out.push(rect(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))))
      }
    }
    return out
  }

  /** ExtSelectClipRgn: a region (device rectangles) combined with the clip by mode (RGN_AND 1, OR 2, XOR 3, DIFF 4, COPY 5); null rects with COPY: no clip. */
  selectClipRegion(rects: Rect[] | null, mode: number): void {
    const clip = this.dc.clip
    if (rects === null) {
      if (mode === 5) this.set('clip', null)
      return
    }
    switch (mode) {
      case 1:
        this.set('clip', clipIntersectRects(clip, rects))
        break
      case 2:
      case 3:
        this.set('clip', clipUnion(clip, clipRects(rects)))
        break
      case 4:
        this.set('clip', clipExcludeRects(clip, rects, this.setup.universe))
        break
      default:
        this.set('clip', clipRects(rects))
    }
  }

  /** SelectClipPath: the path, by mode, then gone. */
  selectClipPath(mode: number): void {
    const p = this.path
    this.path = null
    this.pathOpen = false
    if (!p || p.empty) return
    p.close()
    const rule = this.rule()
    const clip = this.dc.clip
    switch (mode) {
      case 1:
        this.set('clip', clipIntersectPath(clip, p.d, rule))
        break
      case 2:
      case 3:
        this.set('clip', clipUnion(clip, { d: p.d, rule, parent: null, depth: 1 }))
        break
      case 4:
        this.set('clip', clipExcludePath(clip, p.d, this.setup.universe))
        break
      default:
        this.set('clip', clipIntersectPath(null, p.d, rule))
    }
  }

  /* ---- regions, gradients --------------------------------------------- */

  /** FillRgn, PaintRgn: a region (logical rectangles) filled with a brush. */
  fillRegion(rects: Rect[], brush = this.dc.brush): void {
    const p = new PathData()
    for (const r of rects) {
      p.moveTo(...this.pt(r.l, r.t))
      p.lineTo(...this.pt(r.r, r.t))
      p.lineTo(...this.pt(r.r, r.b))
      p.lineTo(...this.pt(r.l, r.b))
      p.close()
    }
    this.out.shape(p, this.fill(brush), null, 'nonzero', this.dc.clip, this.blend())
  }

  /** FrameRgn: each rectangle's outline, `w` by `h` logical units thick, in the brush. */
  frameRegion(rects: Rect[], brush: Brush, w: number, h: number): void {
    const p = new PathData()
    for (const r of rects) {
      const box = (l: number, t: number, rr: number, b: number): void => {
        p.moveTo(...this.pt(l, t))
        p.lineTo(...this.pt(rr, t))
        p.lineTo(...this.pt(rr, b))
        p.lineTo(...this.pt(l, b))
        p.close()
      }
      box(r.l, r.t, r.r, r.b)
      box(r.l + w, r.t + h, r.r - w, r.b - h)
    }
    this.out.shape(p, this.fill(brush), null, 'evenodd', this.dc.clip)
  }

  /**
   * GradientFill: rectangles shaded left to right (mode 0) or top to bottom
   * (1) between two vertices' colors, as linear gradients; triangles (2)
   * Gouraud shaded, all of the record's in one bitmap (shade.ts) the
   * triangles cut out. Triangles too many or too fine to shade are filled
   * with their vertices' mean color.
   */
  gradient(vertices: { x: number; y: number; rgb: number }[], mode: number, shapes: number[][]): void {
    if (mode === 2) {
      this.triangles(vertices, shapes)
      return
    }
    for (const s of shapes) {
      const v = s.map((i) => vertices[i])
      if (v.some((x) => !x)) continue
      const p = new PathData()
      const [a, b] = v
      p.moveTo(...this.pt(a.x, a.y))
      p.lineTo(...this.pt(b.x, a.y))
      p.lineTo(...this.pt(b.x, b.y))
      p.lineTo(...this.pt(a.x, b.y))
      p.close()
      const [x1, y1] = this.pt(a.x, a.y)
      const [x2, y2] = mode === 0 ? this.pt(b.x, a.y) : this.pt(a.x, b.y)
      const key = `grad:${num(x1)},${num(y1)},${num(x2)},${num(y2)},${a.rgb},${b.rgb}`
      const id = this.out.def(key, (id) =>
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"><stop offset="0" stop-color="${hex(a.rgb)}"/><stop offset="1" stop-color="${hex(b.rgb)}"/></linearGradient>`,
      )
      this.out.shape(p, { kind: 'url', id }, null, 'nonzero', this.dc.clip)
    }
  }

  private triangles(vertices: { x: number; y: number; rgb: number }[], shapes: number[][]): void {
    const tris: ShadeTriangle[] = []
    const p = new PathData()
    const flat: { path: PathData; rgb: number }[] = []
    for (const s of shapes) {
      const v = s.map((i) => vertices[i])
      if (v.length !== 3 || v.some((x) => !x)) continue
      const pts: Corners = [this.pt(v[0].x, v[0].y), this.pt(v[1].x, v[1].y), this.pt(v[2].x, v[2].y)]
      const one = new PathData()
      one.moveTo(...pts[0])
      one.lineTo(...pts[1])
      one.lineTo(...pts[2])
      one.close()
      p.append(one)
      tris.push({ p: pts, color: gouraud(...(v.map((x) => (0xff000000 | x.rgb) >>> 0) as [number, number, number])) })
      const mean = [16, 8, 0].map((sh) => Math.round(v.reduce((n, x) => n + ((x.rgb >> sh) & 0xff), 0) / 3))
      flat.push({ path: one, rgb: (mean[0] << 16) | (mean[1] << 8) | mean[2] })
    }
    if (tris.length === 0) return
    const shaded = shade(tris, this.out.hairline, this.setup.budget)
    if (shaded) {
      this.out.shape(p, { kind: 'image', picture: shaded.picture, m: shaded.m, rgb: flat[0].rgb }, null, 'nonzero', this.dc.clip)
      return
    }
    this.lost.add('triangle gradients too large to shade (drawn in their mean colors)')
    for (const f of flat) this.out.shape(f.path, { kind: 'color', rgb: f.rgb }, null, 'nonzero', this.dc.clip)
  }

  /**
   * ExtFloodFill and FloodFill: GDI fills pixels already drawn, and this
   * drawing has shapes, not pixels, so the fill is the shape the point is
   * in (SvgOut.recent, the last closed shapes drawn), filled again with the
   * brush. Surface (FLOODFILLSURFACE): the area of `rgb` around the point:
   * the shape on top at the point, when it is filled with that color.
   * Border (FLOODFILLBORDER): out to the border of `rgb`: the smallest shape
   * around the point outlined or filled in that color (nothing when the
   * point is that color already). Its outline is drawn again over the
   * fill, as GDI's fill stops at it. A point in no such shape (on the
   * paper, or in a shape drawn too long before) is named in lost.
   */
  floodFill(x: number, y: number, color: number, surface: boolean): void {
    const [px, py] = this.pt(x, y)
    const rgb = this.color(color)
    const at = this.out.recent.filter((s) => px >= s.bounds.l && px <= s.bounds.r && py >= s.bounds.t && py <= s.bounds.b && pathContains(s.d, s.rule, px, py))
    const top = at[at.length - 1]
    const colorOf = (p: Paint | null): number | null => (p?.kind === 'color' && (p.alpha ?? 1) > 0 ? p.rgb & 0xffffff : null)
    let target: RecentShape | undefined
    if (surface) target = top && colorOf(top.fill) === rgb ? top : undefined
    else if (!top || colorOf(top.fill) !== rgb) {
      const size = (s: RecentShape): number => (s.bounds.r - s.bounds.l) * (s.bounds.b - s.bounds.t)
      for (const s of at) if ((colorOf(s.stroke?.paint ?? null) === rgb || colorOf(s.fill) === rgb) && (!target || size(s) < size(target))) target = s
    } else return
    if (!target) {
      this.lost.add('flood fill outside the shapes drawn before it')
      return
    }
    this.out.shape(PathData.of(target.d, target.bounds), this.fill(), target.stroke, target.rule, this.dc.clip ?? target.clip, this.blend())
  }

  /* ---- bitmaps -------------------------------------------------------- */

  /**
   * PatBlt, and the bit-block transfers that use no source: the rectangle
   * filled with the brush (PATCOPY), black, white, or inverted.
   */
  patBlt(x: number, y: number, w: number, h: number, rop: number): void {
    const code = (rop >>> 16) & 0xff
    const p = new PathData()
    p.moveTo(...this.pt(x, y))
    p.lineTo(...this.pt(x + w, y))
    p.lineTo(...this.pt(x + w, y + h))
    p.lineTo(...this.pt(x, y + h))
    p.close()
    const clip = this.dc.clip
    switch (code) {
      case 0xf0: // PATCOPY
        this.out.shape(p, this.fill(), null, 'nonzero', clip)
        break
      case 0x5a: // PATINVERT
        this.out.shape(p, this.fill(), null, 'nonzero', clip, 'difference')
        break
      case 0x00: // BLACKNESS
        this.out.shape(p, { kind: 'color', rgb: 0 }, null, 'nonzero', clip)
        break
      case 0xff: // WHITENESS
        this.out.shape(p, { kind: 'color', rgb: 0xffffff }, null, 'nonzero', clip)
        break
      case 0x55: // DSTINVERT
        this.out.shape(p, { kind: 'color', rgb: 0xffffff }, null, 'nonzero', clip, 'difference')
        break
      default:
        if (code !== 0xaa) this.lost.add(`raster operation 0x${code.toString(16)}`)
    }
  }

  /** Whether a ternary raster operation reads its source bitmap. */
  static usesSource(rop: number): boolean {
    const code = (rop >>> 16) & 0xff
    return ((code >> 2) ^ code) & 0x33 ? true : false
  }

  /** The last bitmap drawn with a mask's raster operation, for pairing with the next (masked). */
  private lastBlt: { code: number; raster: Raster; key: string; drawn: number } | null = null

  /**
   * A bitmap drawn into the logical rectangle (x, y, w, h) from the part of
   * it at (sx, sy, sw, sh). How it mixes with what is under it follows the
   * raster operation, as near as SVG's blend modes come.
   *
   * GDI's two ways of drawing a bitmap with transparent parts - a mask and
   * an image at the same place, one ORed and one ANDed (SRCPAINT, SRCAND,
   * either order), or the image XORed, the mask ANDed and the image XORed
   * again (SRCINVERT, SRCAND, SRCINVERT) - are put back together as the one
   * bitmap they mean, transparent where the mask is white: blending in an
   * SVG happens against the picture's own transparent backdrop, not the
   * page, so drawn one by one they would not come out.
   *
   * `to` (PlgBlt) puts the bitmap onto a parallelogram instead of `dest`:
   * the logical points its top-left, top-right and bottom-left corners go
   * to. A right-to-left layout mirrors bitmaps with the rest, unless it
   * keeps their orientation (LAYOUT_BITMAPORIENTATIONPRESERVED).
   */
  bitmap(
    dest: [number, number, number, number],
    src: [number, number, number, number],
    bmp: Raster | Picture | null,
    rop: number,
    extra: { opacity?: number; premultiplied?: boolean; transparent?: number; to?: readonly number[] } = {},
  ): void {
    if (!bmp) {
      this.lost.add('a bitmap that could not be read')
      return
    }
    const code = (rop >>> 16) & 0xff
    if (code === 0xaa) return
    let blend: Blend | undefined
    if (code === 0x88) blend = 'multiply'
    else if (code === 0xee) blend = 'lighten'
    else if (code === 0x66) blend = 'difference'
    let pic: Picture
    let cropBox: Rect | undefined
    let raster: Raster | null = null
    if (isPicture(bmp)) {
      pic = bmp
      // A JPEG or PNG is not decoded here: the part drawn is cut out by the SVG.
      const [sx, sy, sw, sh] = src
      if (sw > 0 && sh > 0 && (sx > 0 || sy > 0 || sw < bmp.width || sh < bmp.height)) cropBox = { l: sx, t: sy, r: Math.min(bmp.width, sx + sw), b: Math.min(bmp.height, sy + sh) }
    } else {
      let r = crop(bmp, src[0], src[1], src[2] || bmp.width, src[3] || bmp.height)
      if (r === bmp && (extra.premultiplied || extra.transparent !== undefined)) r = { ...bmp, rgba: bmp.rgba.slice() }
      if (extra.premultiplied) unpremultiply(r)
      if (extra.transparent !== undefined) keyOut(r, extra.transparent)
      raster = r
      pic = toPicture(r)
    }
    const [x, y, w, h] = dest
    const pw = cropBox ? cropBox.r - cropBox.l : pic.width
    const ph = cropBox ? cropBox.b - cropBox.t : pic.height
    if (!(pw > 0 && ph > 0) || (!extra.to && (w === 0 || h === 0))) return
    const to = extra.to
    let local: Matrix = to ? [(to[2] - to[0]) / pw, (to[3] - to[1]) / pw, (to[4] - to[0]) / ph, (to[5] - to[1]) / ph, to[0], to[1]] : [w / pw, 0, 0, h / ph, x, y]
    if (!(det(local) !== 0 && local.every(Number.isFinite))) return
    if (this.mirrored() && this.dc.layout & LAYOUT_BITMAPORIENTATIONPRESERVED) local = compose([-1, 0, 0, 1, pw, 0], local)
    const m = compose(local, this.matrix())
    const key = `${m.join(',')}|${pw}x${ph}`
    const last = this.lastBlt
    this.lastBlt = null
    if (raster && blend && last && last.key === key && last.drawn === this.out.drawn.length && last.raster.width === raster.width && last.raster.height === raster.height) {
      const pair = (last.code === 0xee && code === 0x88) || (last.code === 0x88 && code === 0xee)
      const xorAnd = last.code === 0x66 && code === 0x88
      if (pair || xorAnd) {
        // The mask is the first of a pair; of the XOR trick, the second (the image came first).
        const [mask, image] = pair ? [last.raster, raster] : [raster, last.raster]
        const f = xorAnd
          ? (d: number, mk: number, i: number) => ((d ^ i) & mk) ^ i
          : last.code === 0xee
            ? (d: number, mk: number, i: number) => (d | mk) & i
            : (d: number, mk: number, i: number) => (d & mk) | i
        this.out.undoLast()
        this.out.image(toPicture(masked(f, mask, image)), m, this.dc.clip, { pixelated: tiny(pw, ph, m) })
        if (xorAnd) this.xorImage = { image, key, drawn: this.out.drawn.length }
        return
      }
    }
    if (code === 0x66 && this.xorImage && this.xorImage.key === key && this.xorImage.drawn === this.out.drawn.length) {
      // The third step of the XOR trick: already drawn with the other two.
      this.xorImage = null
      return
    }
    this.xorImage = null
    this.out.image(pic, m, this.dc.clip, { opacity: extra.opacity, blend, crop: cropBox, pixelated: tiny(pw, ph, m) })
    if (raster && blend) this.lastBlt = { code, raster, key, drawn: this.out.drawn.length }
  }

  private xorImage: { image: Raster; key: string; drawn: number } | null = null

  /**
   * MaskBlt and PlgBlt's mask: `source` (already cut to the part drawn)
   * through a monochrome `mask` read from (mx, my), the foreground raster
   * operation where the mask is set (or runs out) and the background one
   * where it is clear, the brush's color as the pattern. As a masked pair
   * is (masked()), each pixel is worked out on a black page and a white
   * one: what does not depend on the page is drawn as it is, the page
   * left alone is transparent, anything else what it makes of white paper.
   */
  maskedRaster(source: Raster, mask: Raster, mx: number, my: number, fore: number, back: number): Raster {
    const brush = this.dc.brush
    const pattern = brush.style === 0 ? this.color(brush.color) : 0
    // Per operation, per channel, per page (black, white): the result for each source value.
    const tables = [fore, back].map((code) =>
      [16, 8, 0].map((shift) => {
        const p = (pattern >> shift) & 0xff
        return [0, 0xff].map((d) => Uint8Array.from({ length: 256 }, (_, s) => rop3(code, p, s, d)))
      }),
    )
    const { width, height } = source
    const src = source.rgba
    const out = new Uint8Array(src.length)
    let alpha = false
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const o = (j * width + i) * 4
        const u = mx + i
        const v = my + j
        const set = u < 0 || v < 0 || u >= mask.width || v >= mask.height || mask.rgba[(v * mask.width + u) * 4] >= 128
        const t = tables[set ? 0 : 1]
        let same = true
        let page = true
        for (let c = 0; c < 3; c++) {
          const onBlack = t[c][0][src[o + c]]
          const onWhite = t[c][1][src[o + c]]
          out[o + c] = onWhite
          if (onWhite !== onBlack) same = false
          if (onWhite !== 0xff || onBlack !== 0) page = false
        }
        out[o + 3] = !same && page ? 0 : 0xff
        if (out[o + 3] === 0) alpha = true
      }
    }
    return { width, height, rgba: out, alpha }
  }

  /* ---- text ----------------------------------------------------------- */

  /** ExtTextOut's glyph numbers (ETO_GLYPH_INDEX, one per UTF-16 unit of `raw`) as characters: readGlyphs. */
  private glyphText(raw: string, dx: number[] | null): { raw: string; dx: number[] | null; parts: string[] } | null {
    const glyphs = Array.from({ length: raw.length }, (_, i) => raw.charCodeAt(i))
    return readGlyphs(this.setup.fonts, this.dc.font, glyphs, dx, this.lost)
  }

  /**
   * ExtTextOut and TextOut: `text` at the reference point (logical units),
   * aligned by the text alignment, each character placed by its advance in
   * `dx` when there is one (so text keeps its layout whatever font draws
   * it), rotated by the font's escapement. ETO_OPAQUE fills `box` with the
   * background color first; ETO_CLIPPED clips the text to it.
   *
   * In a right-to-left layout the text's box is mirrored with everything
   * else (so text aligned left ends at its mirrored reference point) but
   * its glyphs are not: it is drawn through a flip of its own, its
   * characters still in their order. ETO_RTLREADING (or TA_RTLREADING)
   * text is in reading order and shown right to left: the reader lays it
   * out (direction="rtl", so the bidirectional algorithm places digits and
   * Latin words in it), fitted to its advances when they are known.
   */
  text(x: number, y: number, raw: string, dx: number[] | null, options: number, box: [number, number, number, number] | null): void {
    const dc = this.dc
    if (box && options & ETO_OPAQUE) {
      const p = new PathData()
      const [l, t, r, b] = box
      p.moveTo(...this.pt(l, t))
      p.lineTo(...this.pt(r, t))
      p.lineTo(...this.pt(r, b))
      p.lineTo(...this.pt(l, b))
      p.close()
      this.out.shape(p, { kind: 'color', rgb: this.color(dc.bkColor) }, null, 'nonzero', dc.clip)
    }
    if (!raw) return
    if (options & ETO_GLYPH_INDEX) {
      const read = this.glyphText(raw, dx)
      if (!read) return
      raw = read.raw
      dx = read.dx
    }
    if (this.pathOpen) {
      this.lost.add('text inside a path')
      return
    }
    let clip = dc.clip
    if (box && options & ETO_CLIPPED) {
      const d = this.deviceRects(...box)
      clip = d ? clipIntersectRects(clip, [d]) : clipIntersectPath(clip, this.quad(...box), 'nonzero')
    }
    const font = dc.font
    const { text, symbolic } = mapSymbols(raw, font)
    if (dc.textAlign & TA_UPDATECP) [x, y] = dc.cur
    const m = this.matrix()
    const em = font.height < 0 ? -font.height : font.height > 0 ? font.height / CELL : 16 / Math.max(1e-9, scaleOf(m))
    if (!(em > 0) || !Number.isFinite(em)) return
    const mirrored = this.mirrored()
    // Whether y is flipped (a mapping mode with y up), the mirror aside.
    const sgn = (det(m) < 0) !== mirrored ? -1 : 1
    const theta = (font.escapement / 10) * (Math.PI / 180)
    const u: [number, number] = [Math.cos(theta), -sgn * Math.sin(theta)]
    const v: [number, number] = [sgn * Math.sin(theta), sgn * Math.cos(theta)]
    const local: Matrix = [u[0], u[1], v[0], v[1], x, y]
    const t = compose(local, m)

    // Advances, a character (code point) at a time; a surrogate pair takes both of its units' advances.
    const units = [...raw].map((c) => c.length)
    const chars = [...text]
    let hasDx = !!dx && dx.length >= raw.length && chars.length === units.length
    let advances: number[] = []
    if (hasDx) {
      let k = 0
      for (const n of units) {
        advances.push(dx![k] + (n > 1 ? dx![k + 1] ?? 0 : 0))
        k += n
      }
    } else if (!symbolic && font.width === 0) {
      // No advances given: the font's own, measured, when it (or its twin) is here. A font
      // squeezed or stretched by its lfWidth is left alone: its widths are not the font's.
      const measured = measure(this.setup.fonts, font, chars, em)
      if (measured) {
        advances = measured
        hasDx = true
      }
    }
    const total = hasDx ? advances.reduce((s, a) => s + a, 0) : chars.length * em * (generic(font) === 'monospace' ? 0.6 : 0.55)
    const h = dc.textAlign & TA_CENTER
    const right = h === TA_RIGHT
    const center = h === TA_CENTER
    const vAlign = dc.textAlign & TA_BASELINE
    const baseY = vAlign === TA_BASELINE ? 0 : vAlign === TA_BOTTOM ? -DESCENT * em : ASCENT * em
    const x0 = hasDx ? (right ? -total : center ? -total / 2 : 0) : 0
    const left = right ? -total : center ? -total / 2 : 0
    const rtl = (options & ETO_RTLREADING) !== 0 || (dc.textAlign & TA_RTLREADING) !== 0
    // What the markup is drawn through, and the box's left there: mirrored, a flip of the text's own.
    const drawT = mirrored ? compose([-1, 0, 0, 1, 0, 0], t) : t
    const boxLeft = mirrored ? -left - total : left

    if (dc.bkMode === 2 && !(box && options & ETO_OPAQUE)) {
      const p = new PathData()
      const top = baseY - ASCENT * em
      const bottom = baseY + DESCENT * em
      p.moveTo(...apply(t, left, top))
      p.lineTo(...apply(t, left + total, top))
      p.lineTo(...apply(t, left + total, bottom))
      p.lineTo(...apply(t, left, bottom))
      p.close()
      this.out.shape(p, { kind: 'color', rgb: this.color(dc.bkColor) }, null, 'nonzero', clip)
    }

    // What is written: printable characters only, each with its place when known.
    let content = ''
    const xs: string[] = []
    let pos = x0
    chars.forEach((c, i) => {
      const code = c.codePointAt(0)!
      const keep = code >= 0x20 && !(code >= 0x7f && code < 0xa0) && code !== 0xfffe && code !== 0xffff
      if (keep) {
        content += c
        if (hasDx) xs.push(num(boxLeft + pos - left))
      }
      if (hasDx) pos += advances[i]
    })
    if (!content.trim()) return
    const r = this.rop(this.color(dc.textColor))
    if (!r) return
    // The side of its box the text is anchored by (mirrored, the other one), as SVG names it for its direction.
    const side = center ? 'middle' : right !== mirrored ? 'right' : 'left'
    const anchorName = side === 'middle' ? 'middle' : (side === 'right') !== rtl ? 'end' : 'start'
    let place: string
    let anchor: string
    if (rtl && hasDx) {
      // Its right end at the box's right, its run as long as its advances make it.
      place = ` x="${num(boxLeft + total)}" y="${num(baseY)}" textLength="${num(total)}" lengthAdjust="spacingAndGlyphs"`
      anchor = ' direction="rtl" text-anchor="start"'
    } else {
      place = ` x="${hasDx ? xs.join(' ') : '0'}" y="${num(baseY)}"`
      anchor = rtl ? ` direction="rtl" text-anchor="${anchorName}"` : hasDx || anchorName === 'start' ? '' : ` text-anchor="${anchorName}"`
    }
    const decoration = [font.underline ? 'underline' : '', font.strike ? 'line-through' : ''].filter(Boolean).join(' ')
    const markup =
      `<text transform="${matrixAttr(drawT)}"${place}` +
      ` font-family="${esc(fontFamily(font, symbolic))}" font-size="${num(em) === '0' ? '0.01' : num(em)}"` +
      (font.weight >= 550 ? ` font-weight="${font.weight >= 650 ? 'bold' : Math.round(font.weight / 100) * 100}"` : '') +
      (font.italic ? ' font-style="italic"' : '') +
      (decoration ? ` text-decoration="${decoration}"` : '') +
      anchor +
      ` fill="${hex(r.rgb)}" xml:space="preserve"${SvgOut_blend(r.blend)}>${esc(content)}</text>`
    const corners = [apply(t, left, baseY - ASCENT * em), apply(t, left + total, baseY - ASCENT * em), apply(t, left, baseY + DESCENT * em), apply(t, left + total, baseY + DESCENT * em)]
    const bounds = corners.reduce<Rect | null>((acc, [px, py]) => union(acc, { l: px, t: py, r: px, b: py }), null)
    this.out.add(markup, clip, { kind: 'text', bounds })
    if (dc.textAlign & TA_UPDATECP && hasDx) {
      // The current position moves on by the text's advance, along its baseline.
      this.set('cur', [x + u[0] * total, y + u[1] * total])
    }
  }
}

/**
 * The characters glyph numbers stand for (fonts.ts), read with the font
 * the metafile names, or null (and noted) when that font is not here. A
 * glyph that is two characters (a ligature, a character outside the BMP)
 * shares its advance among them; one the font does not name is U+FFFF,
 * which is never written, so what follows it keeps its place. `parts`
 * is each glyph's own characters.
 */
export function readGlyphs(
  fonts: GlyphFonts | undefined,
  font: Font,
  glyphs: number[],
  dx: number[] | null,
  lost: Set<string>,
): { raw: string; dx: number[] | null; parts: string[] } | null {
  const face = cleanFace(font.face) || 'its font'
  const chars = fonts?.characters(font.face, font.weight >= 650, font.italic)
  if (!chars) {
    lost.add(`text given as glyph numbers, in a font not found here (${face})`)
    return null
  }
  let raw = ''
  const parts: string[] = []
  const advances: number[] | null = dx && dx.length >= glyphs.length ? [] : null
  glyphs.forEach((g, i) => {
    let text = chars.get(g)
    if (!text) {
      lost.add(`glyph numbers the font does not name (${face})`)
      text = '\uffff'
    }
    parts.push(text)
    const points = [...text]
    for (const p of points) {
      raw += p
      if (advances) {
        advances.push(dx![i] / points.length)
        if (p.length > 1) advances.push(0)
      }
    }
  })
  return { raw, dx: advances, parts }
}

/** A ternary raster operation (its code's eight bits, one for each pattern, source and destination bit) on bytes. */
function rop3(code: number, p: number, s: number, d: number): number {
  let out = 0
  for (let i = 0; i < 8; i++) if ((code >> i) & 1) out |= (i & 4 ? p : ~p) & (i & 2 ? s : ~s) & (i & 1 ? d : ~d)
  return out & 0xff
}

/**
 * The one bitmap a masked transfer draws: each pixel worked out from what
 * the raster operations make of a black page and of a white one - the
 * same on both, an opaque pixel of that color; the page itself on both,
 * a transparent one; anything else, what it makes of white paper.
 */
function masked(f: (d: number, m: number, i: number) => number, mask: Raster, image: Raster): Raster {
  const out = new Uint8Array(image.rgba.length)
  const m = mask.rgba
  const im = image.rgba
  let alpha = false
  for (let p = 0; p < out.length; p += 4) {
    let same = true
    let page = true
    for (let c = 0; c < 3; c++) {
      const onWhite = f(0xff, m[p + c], im[p + c]) & 0xff
      const onBlack = f(0, m[p + c], im[p + c]) & 0xff
      out[p + c] = onWhite
      if (onWhite !== onBlack) same = false
      if (onWhite !== 0xff || onBlack !== 0) page = false
    }
    out[p + 3] = !same && page ? 0 : 0xff
    if (out[p + 3] === 0) alpha = true
  }
  return { width: image.width, height: image.height, rgba: out, alpha }
}

/** Whether a bitmap is small and drawn many times its size (a pattern, a mask, a block of color): drawn sharp, as GDI stretches. */
function tiny(width: number, height: number, m: Matrix): boolean {
  return Math.min(width, height) <= 32 && Math.min(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])) >= 4
}

function SvgOut_blend(blend?: Blend): string {
  return blend ? ` style="mix-blend-mode:${blend}"` : ''
}
