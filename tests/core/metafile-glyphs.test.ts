import { describe, expect, it } from 'vitest'
import { DOMParser } from 'linkedom'
import { drawMetafile, GlyphFonts, type FontFiles, type MetafileDrawing, type MetafileResult } from '../../src/core/metafile'
import { fromGlyphName, glyphCharacters, sfntFaces, sfntName, sfntTables } from '../../src/core/metafile/sfnt'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { EmfWriter, PlusWriter } from '../../scripts/fixtures/lib-metafile.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { collection, sfnt } from '../../scripts/fixtures/lib-sfnt.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { READING_ROOM } from '../../scripts/fixtures/vocabulary.mjs'

/*
 * Text given as glyph numbers (ETO_GLYPH_INDEX, EMF+ DrawDriverString
 * without a cmap lookup), read back to characters with the font the
 * metafile names (src/core/metafile/sfnt.ts, fonts.ts). The fonts are
 * synthetic (scripts/fixtures/lib-sfnt.mjs): no font file is committed.
 */

const WORD: string = READING_ROOM.signs[2] // "Returns"

/** A font whose glyph for each letter of `text` is 10 + its place in the alphabet run of the word. */
function wordFont(family: string, style = 'Regular', extra: [number, number][] = []): { font: Buffer; glyphs: number[] } {
  const letters = [...new Set(WORD)]
  const cmap: [number, number][] = letters.map((c, i) => [c.codePointAt(0)!, 10 + i])
  const glyphs = [...WORD].map((c) => 10 + letters.indexOf(c))
  return { font: sfnt({ family, style, cmap: [...cmap, ...extra] }), glyphs }
}

const filesOf =
  (fonts: Record<string, Buffer>): FontFiles =>
  (family) =>
    fonts[family] ?? null

function drawn(r: MetafileResult): MetafileDrawing {
  if ('error' in r) throw new Error(r.error)
  return r
}

function texts(r: MetafileDrawing): Element[] {
  const doc = new DOMParser().parseFromString(r.svg, 'image/svg+xml') as unknown as Document
  return [...doc.documentElement.querySelectorAll('text')]
}

describe('sfnt: a font read backward', () => {
  it('reads the family, the style and the character of each glyph', () => {
    const font = sfnt({ family: 'Reading Sans', style: 'Bold', cmap: [[0x41, 3], [0x20, 1], [0xa0, 1], [0xe000, 5], [0x42, 5]] })
    const [face] = sfntFaces(font)
    const tables = sfntTables(font, face)
    expect(sfntName(font, tables)).toEqual({ families: ['Reading Sans'], styles: ['bold'], full: ['Reading Sans Bold'] })
    const chars = glyphCharacters(font, tables)!
    expect(chars.get(3)).toBe('A')
    // A glyph several characters share is the first, outside the private use area.
    expect(chars.get(1)).toBe(' ')
    expect(chars.get(5)).toBe('B')
  })

  it('reads characters beyond the BMP from format 12', () => {
    const font = sfnt({ family: 'Reading Sans', cmap: [[0x41, 3], [0x1f4d6, 7]] })
    const chars = glyphCharacters(font, sfntTables(font, 0))!
    expect(chars.get(7)).toBe('\u{1f4d6}')
    expect(chars.get(3)).toBe('A')
  })

  it("names glyphs no character maps to by the 'post' table", () => {
    const font = sfnt({ family: 'Reading Sans', cmap: [[0x66, 3]], names: { 8: 'f_i', 9: 'uni00E9.sc', 10: 'ffl', 11: 'swash.alt' } })
    const chars = glyphCharacters(font, sfntTables(font, 0))!
    expect([chars.get(8), chars.get(9), chars.get(10), chars.get(11)]).toEqual(['fi', 'é', 'ffl', undefined])
    expect(fromGlyphName('u1F4D6')).toBe('\u{1f4d6}')
    expect(fromGlyphName('uniD800')).toBe('')
    expect(fromGlyphName('.notdef')).toBe('')
  })

  it('picks the face of a collection that is the family and style asked for', () => {
    const regular = { family: 'Reading Sans', style: 'Regular', cmap: [[0x41, 3]] }
    const bold = { family: 'Reading Sans', style: 'Bold', cmap: [[0x42, 3]] }
    const other = { family: 'Reading Serif', style: 'Bold', cmap: [[0x43, 3]] }
    const ttc = collection([other, regular, bold])
    expect(sfntFaces(ttc)).toHaveLength(3)
    const fonts = new GlyphFonts(() => ttc)
    expect(fonts.characters('Reading Sans', true, false)!.get(3)).toBe('B')
    expect(fonts.characters('Reading Sans', false, false)!.get(3)).toBe('A')
    expect(fonts.characters('Reading Mono', false, false)).toBeNull()
  })

  it('asks for each font once', () => {
    let asked = 0
    const fonts = new GlyphFonts(() => {
      asked++
      return null
    })
    fonts.characters('Calibri', false, false)
    fonts.characters('Calibri', false, false)
    expect(asked).toBe(1)
  })
})

describe('text given as glyph numbers', () => {
  it('is drawn as its characters, each at its advance, with the font the metafile names', () => {
    const { font, glyphs } = wordFont('Calibri')
    const emf = new EmfWriter({ width: 200, height: 40 })
      .font(1, { face: 'Calibri' })
      .select(1)
      .text(4, 20, String.fromCharCode(...glyphs), { options: 0x10, advance: 9 })
      .bytes()
    const r = drawn(drawMetafile(emf, { fonts: new GlyphFonts(filesOf({ Calibri: font })) }))
    const [t] = texts(r)
    expect(t.textContent).toBe(WORD)
    expect(t.getAttribute('x')!.split(' ').map(Number)).toEqual([...WORD].map((_, i) => i * 9))
    expect(t.getAttribute('font-family')).toMatch(/Calibri/)
    expect(r.lost).toEqual([])
  })

  it('is not drawn, and is noted, when the font is not here (a metric twin is no use: its glyphs are numbered its own way)', () => {
    const { font, glyphs } = wordFont('Carlito')
    const emf = new EmfWriter({ width: 200, height: 40 })
      .stock(4)
      .rectangle(0, 0, 10, 10)
      .font(1, { face: 'Calibri' })
      .select(1)
      .text(4, 20, String.fromCharCode(...glyphs), { options: 0x10, advance: 9 })
      .bytes()
    const r = drawn(drawMetafile(emf, { fonts: new GlyphFonts(filesOf({ Carlito: font })) }))
    expect(texts(r)).toHaveLength(0)
    expect(r.lost).toEqual(['text given as glyph numbers, in a font not found here (Calibri)'])
    expect(drawn(drawMetafile(emf)).lost).toEqual(['text given as glyph numbers, in a font not found here (Calibri)'])
  })

  it('leaves a glyph the font does not name out, and what follows keeps its place', () => {
    const { font, glyphs } = wordFont('Calibri')
    const emf = new EmfWriter({ width: 200, height: 40 })
      .font(1, { face: 'Calibri' })
      .select(1)
      .text(4, 20, String.fromCharCode(glyphs[0], 99, ...glyphs.slice(1)), { options: 0x10, advance: 9 })
      .bytes()
    const r = drawn(drawMetafile(emf, { fonts: new GlyphFonts(filesOf({ Calibri: font })) }))
    const [t] = texts(r)
    expect(t.textContent).toBe(WORD)
    expect(t.getAttribute('x')!.split(' ').map(Number)).toEqual([0, ...[...WORD].slice(1).map((_, i) => (i + 2) * 9)])
    expect(r.lost).toEqual(['glyph numbers the font does not name (Calibri)'])
  })

  it('shares a ligature glyph’s advance among its letters', () => {
    const font = sfnt({ family: 'Calibri', cmap: [[0x61, 3]], names: { 8: 'f_i' } })
    const emf = new EmfWriter({ width: 200, height: 40 })
      .font(1, { face: 'Calibri' })
      .select(1)
      .text(4, 20, String.fromCharCode(8, 3), { options: 0x10, advance: 10 })
      .bytes()
    const [t] = texts(drawn(drawMetafile(emf, { fonts: new GlyphFonts(filesOf({ Calibri: font })) })))
    expect(t.textContent).toBe('fia')
    expect(t.getAttribute('x')).toBe('0 5 10')
  })

  it('EMF+ DrawDriverString by glyph number is drawn as its characters at their places', () => {
    const { font, glyphs } = wordFont('Calibri')
    const positions = glyphs.map((_, i) => [10 + i * 8, 30])
    const plus = new PlusWriter().header(false).font(1, 12, 'Calibri').drawDriverString(1, 0xff000000, glyphs, positions, { cmap: false }).eof()
    const emf = new EmfWriter({ width: 200, height: 40 }).comment(plus.bytes()).bytes()
    const r = drawn(drawMetafile(emf, { fonts: new GlyphFonts(filesOf({ Calibri: font })) }))
    const [t] = texts(r)
    expect(t.textContent).toBe(WORD)
    expect(t.getAttribute('x')!.split(' ').map(Number)).toEqual(positions.map(([x]) => x))
    expect(drawMetafile(emf)).toEqual({ error: 'it draws nothing this app can show' })
  })

  it('EMF+ DrawDriverString by character is drawn as before', () => {
    const units = [...WORD].map((c) => c.charCodeAt(0))
    const plus = new PlusWriter().header(false).font(1, 12, 'Calibri').drawDriverString(1, 0xff000000, units, units.map((_, i) => [10 + i * 8, 30])).eof()
    const [t] = texts(drawn(drawMetafile(new EmfWriter({ width: 200, height: 40 }).comment(plus.bytes()).bytes())))
    expect(t.textContent).toBe(WORD)
  })
})
