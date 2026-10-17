/**
 * CSS colors, read the way a browser reads them (CSS Color 4): the 148 named
 * colors, #rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba(), hsl()/hsla() and hwb()
 * in comma or space syntax, with percentages, hue units and `/ alpha`.
 */

/** A color: red, green and blue 0-255 (not rounded), alpha 0-1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** The CSS Color 4 named colors (transparent and currentColor are keywords, not names). */
export const NAMED_COLORS: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null), {
    aliceblue: 'F0F8FF', antiquewhite: 'FAEBD7', aqua: '00FFFF', aquamarine: '7FFFD4', azure: 'F0FFFF',
    beige: 'F5F5DC', bisque: 'FFE4C4', black: '000000', blanchedalmond: 'FFEBCD', blue: '0000FF',
    blueviolet: '8A2BE2', brown: 'A52A2A', burlywood: 'DEB887', cadetblue: '5F9EA0', chartreuse: '7FFF00',
    chocolate: 'D2691E', coral: 'FF7F50', cornflowerblue: '6495ED', cornsilk: 'FFF8DC', crimson: 'DC143C',
    cyan: '00FFFF', darkblue: '00008B', darkcyan: '008B8B', darkgoldenrod: 'B8860B', darkgray: 'A9A9A9',
    darkgreen: '006400', darkgrey: 'A9A9A9', darkkhaki: 'BDB76B', darkmagenta: '8B008B', darkolivegreen: '556B2F',
    darkorange: 'FF8C00', darkorchid: '9932CC', darkred: '8B0000', darksalmon: 'E9967A', darkseagreen: '8FBC8F',
    darkslateblue: '483D8B', darkslategray: '2F4F4F', darkslategrey: '2F4F4F', darkturquoise: '00CED1', darkviolet: '9400D3',
    deeppink: 'FF1493', deepskyblue: '00BFFF', dimgray: '696969', dimgrey: '696969', dodgerblue: '1E90FF',
    firebrick: 'B22222', floralwhite: 'FFFAF0', forestgreen: '228B22', fuchsia: 'FF00FF', gainsboro: 'DCDCDC',
    ghostwhite: 'F8F8FF', gold: 'FFD700', goldenrod: 'DAA520', gray: '808080', green: '008000',
    greenyellow: 'ADFF2F', grey: '808080', honeydew: 'F0FFF0', hotpink: 'FF69B4', indianred: 'CD5C5C',
    indigo: '4B0082', ivory: 'FFFFF0', khaki: 'F0E68C', lavender: 'E6E6FA', lavenderblush: 'FFF0F5',
    lawngreen: '7CFC00', lemonchiffon: 'FFFACD', lightblue: 'ADD8E6', lightcoral: 'F08080', lightcyan: 'E0FFFF',
    lightgoldenrodyellow: 'FAFAD2', lightgray: 'D3D3D3', lightgreen: '90EE90', lightgrey: 'D3D3D3', lightpink: 'FFB6C1',
    lightsalmon: 'FFA07A', lightseagreen: '20B2AA', lightskyblue: '87CEFA', lightslategray: '778899', lightslategrey: '778899',
    lightsteelblue: 'B0C4DE', lightyellow: 'FFFFE0', lime: '00FF00', limegreen: '32CD32', linen: 'FAF0E6',
    magenta: 'FF00FF', maroon: '800000', mediumaquamarine: '66CDAA', mediumblue: '0000CD', mediumorchid: 'BA55D3',
    mediumpurple: '9370DB', mediumseagreen: '3CB371', mediumslateblue: '7B68EE', mediumspringgreen: '00FA9A', mediumturquoise: '48D1CC',
    mediumvioletred: 'C71585', midnightblue: '191970', mintcream: 'F5FFFA', mistyrose: 'FFE4E1', moccasin: 'FFE4B5',
    navajowhite: 'FFDEAD', navy: '000080', oldlace: 'FDF5E6', olive: '808000', olivedrab: '6B8E23',
    orange: 'FFA500', orangered: 'FF4500', orchid: 'DA70D6', palegoldenrod: 'EEE8AA', palegreen: '98FB98',
    paleturquoise: 'AFEEEE', palevioletred: 'DB7093', papayawhip: 'FFEFD5', peachpuff: 'FFDAB9', peru: 'CD853F',
    pink: 'FFC0CB', plum: 'DDA0DD', powderblue: 'B0E0E6', purple: '800080', rebeccapurple: '663399',
    red: 'FF0000', rosybrown: 'BC8F8F', royalblue: '4169E1', saddlebrown: '8B4513', salmon: 'FA8072',
    sandybrown: 'F4A460', seagreen: '2E8B57', seashell: 'FFF5EE', sienna: 'A0522D', silver: 'C0C0C0',
    skyblue: '87CEEB', slateblue: '6A5ACD', slategray: '708090', slategrey: '708090', snow: 'FFFAFA',
    springgreen: '00FF7F', steelblue: '4682B4', tan: 'D2B48C', teal: '008080', thistle: 'D8BFD8',
    tomato: 'FF6347', turquoise: '40E0D0', violet: 'EE82EE', wheat: 'F5DEB3', white: 'FFFFFF',
    whitesmoke: 'F5F5F5', yellow: 'FFFF00', yellowgreen: '9ACD32',
  }),
)

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** A plain number, or undefined. `none` (CSS Color 4) is 0. */
function number(s: string): number | undefined {
  if (s === 'none') return 0
  return NUMBER.test(s) ? Number(s) : undefined
}

/** A percentage as 0-1, or undefined. */
function percent(s: string): number | undefined {
  if (s === 'none') return 0
  const n = s.endsWith('%') ? number(s.slice(0, -1)) : undefined
  return n === undefined ? undefined : n / 100
}

/** An alpha as 0-1: a number or a percentage. */
function alpha(s: string | undefined): number | undefined {
  if (s === undefined) return 1
  const n = percent(s) ?? number(s)
  return n === undefined ? undefined : clamp(n, 0, 1)
}

/** A hue in degrees: unitless, deg, grad, rad or turn. */
function hue(s: string): number | undefined {
  const unit = /(deg|grad|rad|turn)$/.exec(s)?.[1]
  const n = number(unit ? s.slice(0, -unit.length) : s)
  if (n === undefined) return undefined
  const deg = unit === 'grad' ? n * 0.9 : unit === 'rad' ? (n * 180) / Math.PI : unit === 'turn' ? n * 360 : n
  return ((deg % 360) + 360) % 360
}

/** An rgb() channel 0-255: a number or a percentage. */
function channel(s: string): number | undefined {
  const p = percent(s)
  const n = p === undefined ? number(s) : p * 255
  return n === undefined ? undefined : clamp(n, 0, 255)
}

/** A saturation, lightness, whiteness or blackness as 0-1 (a bare number is a percentage, as CSS Color 4 allows). */
function amount(s: string): number | undefined {
  const n = percent(s) ?? number(s)
  if (n === undefined) return undefined
  return clamp(s.endsWith('%') || s === 'none' ? n : n / 100, 0, 1)
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h / 30) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

/** The arguments of a color function: three values and an alpha, comma or space separated. */
function argumentsOf(inner: string): [string[], string | undefined] | undefined {
  const text = inner.trim()
  if (text.includes(',')) {
    const parts = text.split(',').map((p) => p.trim())
    if (parts.some((p) => !p || /\s/.test(p) || p === 'none')) return undefined
    if (parts.length === 3) return [parts, undefined]
    if (parts.length === 4) return [parts.slice(0, 3), parts[3]]
    return undefined
  }
  const [main, a, extra] = text.split('/').map((p) => p.trim())
  if (extra !== undefined || a === '') return undefined
  const parts = main.split(/\s+/).filter(Boolean)
  return parts.length === 3 ? [parts, a] : undefined
}

/**
 * A CSS color value: its color, or the keyword `transparent` or `currentcolor`
 * (lower-cased), or undefined when it is no color at all (inherit, initial,
 * unset, a typo, a var()).
 */
export function parseCssColor(css: string): Rgba | 'transparent' | 'currentcolor' | undefined {
  const value = css.trim().toLowerCase()
  if (value === 'transparent' || value === 'currentcolor') return value
  const named = NAMED_COLORS[value]
  const hex = named ?? /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? hex.replace(/./g, '$&$&') : hex
    const [r, g, b, a = 255] = (full.match(/../g) ?? []).map((pair) => parseInt(pair, 16))
    return { r, g, b, a: a / 255 }
  }
  const fn = /^(rgba?|hsla?|hwb)\(([^()]*)\)$/.exec(value)
  if (!fn) return undefined
  const args = argumentsOf(fn[2])
  if (!args) return undefined
  const [[x, y, z], alphaText] = args
  const a = alpha(alphaText)
  if (a === undefined) return undefined
  if (fn[1].startsWith('rgb')) {
    const [r, g, b] = [x, y, z].map(channel)
    return r === undefined || g === undefined || b === undefined ? undefined : { r, g, b, a }
  }
  const h = hue(x)
  const [p, q] = [y, z].map(amount)
  if (h === undefined || p === undefined || q === undefined) return undefined
  if (fn[1].startsWith('hsl')) {
    const [r, g, b] = hslToRgb(h, p, q)
    return { r, g, b, a }
  }
  // hwb(): white and black together past 100% make a gray.
  if (p + q >= 1) {
    const gray = (p / (p + q)) * 255
    return { r: gray, g: gray, b: gray, a }
  }
  const [r, g, b] = hslToRgb(h, 1, 0.5).map((c) => c * (1 - p - q) + p * 255)
  return { r, g, b, a }
}

/**
 * A CSS color as Word's RRGGBB, or undefined for none: transparent, fully
 * transparent, currentColor (the caller resolves it) or not a color. Word has
 * no alpha, so a semi-transparent color is blended with the white page, as a
 * browser shows it there.
 */
export function wordHex(css: string): string | undefined {
  const color = parseCssColor(css)
  if (color === undefined || typeof color === 'string' || color.a === 0) return undefined
  const { r, g, b, a } = color
  return [r, g, b]
    .map((c) => Math.round(c * a + 255 * (1 - a)).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/**
 * WCAG 2.x relative luminance of a CSS color, 0 (black) to 1 (white), or
 * undefined when it is no opaque color. Alpha is ignored: the callers measure
 * palettes, which are opaque.
 */
export function relativeLuminance(css: string): number | undefined {
  const color = parseCssColor(css)
  if (color === undefined || typeof color === 'string') return undefined
  const linear = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

/** WCAG 2.x contrast ratio of two CSS colors, 1 to 21, either way round. */
export function contrastRatio(a: string, b: string): number | undefined {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)]
  if (la === undefined || lb === undefined) return undefined
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
