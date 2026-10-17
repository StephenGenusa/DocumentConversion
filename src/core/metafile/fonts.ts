import { glyphCharacters, sfntFaces, sfntName, sfntTables } from './sfnt'

/*
 * The fonts a metafile's glyph numbers are read with (sfnt.ts). Core reads
 * no files: the caller may give a FontFiles that finds a font file by its
 * family (main/local-fonts.ts looks among the fonts installed on this
 * computer). Only the font the metafile names will do - glyph numbers are
 * that font's own - so there is no substitute here: a picture made with
 * Calibri reads its glyph numbers on a computer that has Calibri, and on
 * one that has only Carlito that text is not drawn (and is noted).
 */

/** The font file of `family` in the style asked for (or its family's nearest), or null when there is none. */
export type FontFiles = (family: string, bold: boolean, italic: boolean) => Buffer | null

/** Glyph numbers to characters, per font, each font read once. */
export class GlyphFonts {
  private seen = new Map<string, Map<number, string> | null>()

  constructor(private readonly files: FontFiles) {}

  /** What character each glyph of `family` is, or null when the font is not here (or cannot be read). */
  characters(family: string, bold: boolean, italic: boolean): Map<number, string> | null {
    const name = family.replace(/\0[\s\S]*$/, '').trim()
    if (!name) return null
    const key = `${name.toLowerCase()}|${bold ? 'b' : ''}${italic ? 'i' : ''}`
    if (this.seen.has(key)) return this.seen.get(key)!
    let found: Map<number, string> | null = null
    try {
      const file = this.files(name, bold, italic)
      if (file) found = readFace(file, name, bold, italic)
    } catch {
      found = null
    }
    this.seen.set(key, found)
    return found
  }
}

/** The face of a font file that is `family` (the best match for the style, in a collection), read. */
function readFace(file: Buffer, family: string, bold: boolean, italic: boolean): Map<number, string> | null {
  const want = family.toLowerCase()
  let best: { score: number; tables: ReturnType<typeof sfntTables> } | null = null
  for (const face of sfntFaces(file)) {
    const tables = sfntTables(file, face)
    const name = sfntName(file, tables)
    if (!name || !name.families.some((f) => f.toLowerCase() === want)) continue
    const style = name.styles.join(' ')
    const score = (/bold/.test(style) === bold ? 2 : 0) + (/italic|oblique/.test(style) === italic ? 1 : 0)
    if (!best || score > best.score) best = { score, tables }
  }
  return best ? glyphCharacters(file, best.tables) : null
}
