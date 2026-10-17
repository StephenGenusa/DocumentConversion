import { characterAdvances, glyphCharacters, sfntFaces, sfntName, sfntTables } from './sfnt'

/*
 * The fonts a metafile's glyph numbers are read with (sfnt.ts). Core reads
 * no files: the caller may give a FontFiles that finds a font file by its
 * family (main/local-fonts.ts looks among the fonts installed on this
 * computer). Only the font the metafile names will do - glyph numbers are
 * that font's own - so there is no substitute here: a picture made with
 * Calibri reads its glyph numbers on a computer that has Calibri, and on
 * one that has only Carlito that text is not drawn (and is noted).
 *
 * Widths are different: a twin is made to the original's widths, so text
 * that comes without its advances (GDI text with no dx, EMF+ DrawString)
 * is measured with the font or, failing it, its twin (advances), and
 * written with each character's place: it keeps its layout in any reader,
 * whatever font that reader draws it with.
 */

/** The font file of `family` in the style asked for (or its family's nearest), or null when there is none. */
export type FontFiles = (family: string, bold: boolean, italic: boolean) => Buffer | null

/** Glyph numbers to characters and characters to widths, per font, each font read once. */
export class GlyphFonts {
  private seen = new Map<string, Map<number, string> | null>()
  private widths = new Map<string, Map<number, number> | null>()

  constructor(private readonly files: FontFiles) {}

  /** What character each glyph of `family` is, or null when the font is not here (or cannot be read). */
  characters(family: string, bold: boolean, italic: boolean): Map<number, string> | null {
    return this.cached(this.seen, family, bold, italic, glyphCharacters)
  }

  /**
   * Each character's advance in ems, in the first of `families` that is
   * here in the style asked for (the font, then its metric-compatible
   * twins), or null: a regular face's widths are not its bold one's.
   */
  advances(families: string[], bold: boolean, italic: boolean): Map<number, number> | null {
    for (const family of families) {
      const found = this.cached(this.widths, family, bold, italic, characterAdvances, true)
      if (found) return found
    }
    return null
  }

  private cached<T>(cache: Map<string, T | null>, family: string, bold: boolean, italic: boolean, read: (file: Buffer, tables: Map<string, { offset: number; length: number }>) => T | null, exact = false): T | null {
    const name = family.replace(/\0[\s\S]*$/, '').trim()
    if (!name) return null
    const key = `${name.toLowerCase()}|${bold ? 'b' : ''}${italic ? 'i' : ''}`
    if (cache.has(key)) return cache.get(key)!
    let found: T | null = null
    try {
      const file = this.files(name, bold, italic)
      const face = file ? faceOf(file, name, bold, italic) : null
      const tables = face && (!exact || face.score === 3) ? face.tables : null
      if (file && tables) found = read(file, tables)
    } catch {
      found = null
    }
    cache.set(key, found)
    return found
  }
}

/** The face of a font file that is `family` (the best match for the style, in a collection): its tables, and 3 when its style is the one asked for. */
function faceOf(file: Buffer, family: string, bold: boolean, italic: boolean): { score: number; tables: ReturnType<typeof sfntTables> } | null {
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
  return best
}
