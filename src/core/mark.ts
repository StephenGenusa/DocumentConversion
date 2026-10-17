import { contrastRatio, wordHex } from './css-color'

/*
 * Highlighted text, the hub's `<mark>`.
 *
 * A plain `<mark>` is the ordinary highlight: each writer shows it as its own
 * yellow (Word's highlighter yellow, a soft yellow on a page). A highlight of
 * any other color keeps it, as `style="background-color:#RRGGBB"`, because a
 * reviewer's green and a reviewer's yellow can mean different things. That
 * style is the only one the hub keeps anywhere, and it is always built here
 * from the color alone, so the sanitizer, the readers that write the hub
 * themselves (docx) and the editor all write it byte for byte alike.
 */

/** Word's and the browser's default highlight; a mark of exactly this color is a plain mark. */
const YELLOW = 'FFFF00'

/**
 * A highlight's own color as RRGGBB from a CSS style: its `background-color`,
 * else the color word of a `background` shorthand. Undefined for none, for
 * one that is no color (a var(), transparent) and for the ordinary yellow:
 * the mark is then a plain one.
 */
export function markColor(style: string | undefined): string | undefined {
  if (!style) return undefined
  const own = /(?:^|;)\s*background-color\s*:\s*([^;]+)/i.exec(style)?.[1]
  const words = own !== undefined ? [own.trim()] : (/(?:^|;)\s*background\s*:\s*([^;]+)/i.exec(style)?.[1] ?? '').match(/[^\s(]+\([^)]*\)|[^\s]+/g) ?? []
  const hex = words.map((w) => wordHex(w)).findLast(Boolean)
  return hex === YELLOW ? undefined : hex
}

/**
 * The hub's style for a highlight of this RRGGBB. Text on a dark one is
 * white, as Word shows automatic text on its dark highlight colors; black
 * there could not be read in any output.
 */
export function markStyle(hex: string): string {
  const upper = hex.toUpperCase()
  const dark = (contrastRatio(`#${upper}`, '#FFFFFF') ?? 0) > (contrastRatio(`#${upper}`, '#000000') ?? 0)
  return `background-color:#${upper}${dark ? ';color:#FFFFFF' : ''}`
}

/** The opening tag of a highlight of this color, or of a plain one. */
export function markOpenTag(hex: string | undefined): string {
  const color = hex && hex.toUpperCase() !== YELLOW ? hex : undefined
  return color ? `<mark style="${markStyle(color)}">` : '<mark>'
}

/**
 * Word's 16 highlight colors (ST_HighlightColor) by their RRGGBB: the 16
 * colors of HTML 4, one for one. A background that is exactly one of them is
 * written as a highlight, which is what Word's own Text Highlight Color makes
 * and what its highlight tools find and clear; any other is shading, which
 * keeps the exact color. Read back the other way by the docx reader.
 */
export const WORD_HIGHLIGHTS: Readonly<Record<string, string>> = Object.freeze({
  FFFF00: 'yellow', '00FF00': 'green', '00FFFF': 'cyan', FF00FF: 'magenta', '0000FF': 'blue', FF0000: 'red',
  '000000': 'black', FFFFFF: 'white', '000080': 'darkBlue', '008080': 'darkCyan', '008000': 'darkGreen',
  '800080': 'darkMagenta', '800000': 'darkRed', '808000': 'darkYellow', '808080': 'darkGray', C0C0C0: 'lightGray',
})
