import { describe, expect, it } from 'vitest'
import { DOMParser } from 'linkedom'
import { drawMetafile, GlyphFonts, type FontFiles, type MetafileDrawing, type MetafileResult } from '../../src/core/metafile'
import { characterAdvances, sfntTables } from '../../src/core/metafile/sfnt'
import { sanitizeSvg } from '../../src/core/svg-sanitize'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { EmfWriter, PlusWriter } from '../../scripts/fixtures/lib-metafile.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { sfnt } from '../../scripts/fixtures/lib-sfnt.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { READING_ROOM } from '../../scripts/fixtures/vocabulary.mjs'

/*
 * Metafile text laid out by its own advances, so it keeps its layout in
 * any reader whatever font that reader draws it with: the advances a
 * record gives, or, for text without them, the widths of the font it
 * names or of its metric-compatible twin when one is installed
 * (src/core/metafile/fonts.ts, sfnt.ts characterAdvances). The fonts are
 * synthetic (scripts/fixtures/lib-sfnt.mjs).
 */

const WORD: string = READING_ROOM.signs[2] // "Returns"

/** A font with each letter of WORD and a space, at 500 units of a 1,000 em, but the first letter 800. */
function widthFont(family: string, style = 'Regular'): Buffer {
  const letters = [' ', ...new Set(WORD)]
  const cmap: [number, number][] = letters.map((c, i) => [c.codePointAt(0)!, 1 + i])
  const advances = [0, ...letters.map((c) => (c === WORD[0] ? 800 : 500))]
  return sfnt({ family, style, cmap, advances, unitsPerEm: 1000 })
}

const filesOf =
  (fonts: Record<string, Buffer>): FontFiles =>
  (family) =>
    fonts[family] ?? null

function drawn(r: MetafileResult): MetafileDrawing {
  if ('error' in r) throw new Error(r.error)
  return r
}

function texts(svg: string): Element[] {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml') as unknown as Document
  return [...doc.documentElement.querySelectorAll('text')]
}

const xs = (t: Element): number[] => t.getAttribute('x')!.split(' ').map(Number)
/** WORD's places at `em`, from `x0`: its first letter 0.8 em, the rest 0.5. */
const places = (x0: number, em: number): number[] => [...WORD].map((_, i) => x0 + (i === 0 ? 0 : 0.8 * em + (i - 1) * 0.5 * em))

describe('sfnt: widths', () => {
  it("reads each character's advance in ems, glyphs past the last metric taking its advance", () => {
    const font = sfnt({ family: 'Reading Sans', cmap: [[0x41, 1], [0x42, 2], [0x43, 3]], advances: [0, 1024, 512], unitsPerEm: 2048 })
    const widths = characterAdvances(font, sfntTables(font, 0))!
    expect([widths.get(0x41), widths.get(0x42), widths.get(0x43)]).toEqual([0.5, 0.25, 0.25])
  })

  it('has none without the metric tables, or with an em out of range', () => {
    const bare = sfnt({ family: 'Reading Sans', cmap: [[0x41, 1]] })
    expect(characterAdvances(bare, sfntTables(bare, 0))).toBeNull()
    const odd = sfnt({ family: 'Reading Sans', cmap: [[0x41, 1]], advances: [0, 500], unitsPerEm: 1 })
    expect(characterAdvances(odd, sfntTables(odd, 0))).toBeNull()
  })

  it('measures with the font, then its twin, and only in the style asked for', () => {
    const fonts = new GlyphFonts(filesOf({ Carlito: widthFont('Carlito') }))
    expect(fonts.advances(['Calibri', 'Carlito'], false, false)!.get(WORD.codePointAt(0)!)).toBe(0.8)
    expect(fonts.advances(['Calibri', 'Carlito'], true, false)).toBeNull()
  })
})

describe('GDI text without advances', () => {
  const emf = (face: string): Buffer =>
    new EmfWriter({ width: 200, height: 40 }).font(1, { face, height: -20 }).select(1).text(10, 20, WORD).bytes()

  it("is placed character by character by the font's widths, measured with its metric twin", () => {
    const r = drawn(drawMetafile(emf('Calibri'), { fonts: new GlyphFonts(filesOf({ Carlito: widthFont('Carlito') })) }))
    const [t] = texts(sanitizeSvg(r.svg))
    expect(t.textContent).toBe(WORD)
    expect(xs(t)).toEqual(places(0, 20))
    expect(t.getAttribute('font-family')).toBe("'Calibri','Carlito',sans-serif")
  })

  it('is written whole from its point when no font for it is here, as before', () => {
    const [t] = texts(drawn(drawMetafile(emf('Calibri'))).svg)
    expect(t.getAttribute('x')).toBe('0')
    const [u] = texts(drawn(drawMetafile(emf('Calibri'), { fonts: new GlyphFonts(filesOf({})) })).svg)
    expect(u.getAttribute('x')).toBe('0')
  })

  it('is written whole when a character is not in the font', () => {
    const e = new EmfWriter({ width: 200, height: 40 }).font(1, { face: 'Calibri', height: -20 }).select(1).text(10, 20, `${WORD}?`).bytes()
    const [t] = texts(drawn(drawMetafile(e, { fonts: new GlyphFonts(filesOf({ Calibri: widthFont('Calibri') })) })).svg)
    expect(t.getAttribute('x')).toBe('0')
  })

  it('keeps the advances the record gives over the font', () => {
    const e = new EmfWriter({ width: 200, height: 40 }).font(1, { face: 'Calibri', height: -20 }).select(1).text(10, 20, WORD, { advance: 9 }).bytes()
    const [t] = texts(drawn(drawMetafile(e, { fonts: new GlyphFonts(filesOf({ Calibri: widthFont('Calibri') })) })).svg)
    expect(xs(t)).toEqual([...WORD].map((_, i) => i * 9))
  })
})

describe('EMF+ DrawString', () => {
  const fonts = new GlyphFonts(filesOf({ Carlito: widthFont('Carlito') }))
  const draw = (plus: { bytes(): Buffer }, f?: GlyphFonts): Element[] =>
    texts(sanitizeSvg(drawn(drawMetafile(new EmfWriter({ width: 300, height: 120 }).comment(plus.bytes()).bytes(), { fonts: f })).svg))

  it('places each character by the measured widths, from where its alignment puts the line', () => {
    const plus = new PlusWriter().header(false).font(1, 20, 'Calibri').stringFormat(2, { align: 1 }).drawString(1, 0xff000000, [0, 0, 200, 40], WORD, 2).eof()
    const [t] = draw(plus, fonts)
    const width = 0.8 * 20 + (WORD.length - 1) * 10
    expect(xs(t)).toEqual(places(100 - width / 2, 20))
    expect(t.getAttribute('text-anchor')).toBeNull()
  })

  it('wraps at the layout rectangle’s width, dropping the space it breaks at', () => {
    // Each word is 0.8 + 6 × 0.5 = 3.8 em = 76 units at 20; two do not fit in 120, with its padding.
    const plus = new PlusWriter().header(false).font(1, 20, 'Calibri').drawString(1, 0xff000000, [0, 0, 120, 100], `${WORD} ${WORD}`).eof()
    const lines = draw(plus, fonts)
    expect(lines.map((t) => t.textContent)).toEqual([WORD, WORD])
    const pad = 20 / 6
    expect(xs(lines[1])).toEqual(places(pad, 20).map((x) => Number(x.toFixed(2))))
    expect(Number(lines[1].getAttribute('y')!.split(' ')[0])).toBeCloseTo(Number(lines[0].getAttribute('y')) + 24, 1)
  })

  it('does not wrap when the format says no wrap', () => {
    const plus = new PlusWriter().header(false).font(1, 20, 'Calibri').stringFormat(2, { flags: 0x1000 }).drawString(1, 0xff000000, [0, 0, 120, 100], `${WORD} ${WORD}`, 2).eof()
    expect(draw(plus, fonts).map((t) => t.textContent)).toEqual([`${WORD} ${WORD}`])
  })

  it('without the font, is written whole from its anchor, as before', () => {
    const plus = new PlusWriter().header(false).font(1, 20, 'Calibri').stringFormat(2, { align: 1 }).drawString(1, 0xff000000, [0, 0, 200, 40], WORD, 2).eof()
    const [t] = draw(plus)
    expect(t.getAttribute('x')).toBe('100')
    expect(t.getAttribute('text-anchor')).toBe('middle')
  })
})

describe('advances the record gives, kept by the sanitizer', () => {
  it('ExtTextOut dx and DrawDriverString positions stay per-character x (and y) lists', () => {
    const e = new EmfWriter({ width: 200, height: 40 }).font(1, { face: 'Calibri' }).select(1).text(4, 20, WORD, { advance: 9 }).bytes()
    const [t] = texts(sanitizeSvg(drawn(drawMetafile(e)).svg))
    expect(xs(t)).toEqual([...WORD].map((_, i) => i * 9))
    const units = [...WORD].map((c) => c.charCodeAt(0))
    const positions = units.map((_, i) => [10 + i * 8, 30 + i])
    const plus = new PlusWriter().header(false).font(1, 12, 'Calibri').drawDriverString(1, 0xff000000, units, positions).eof()
    const [u] = texts(sanitizeSvg(drawn(drawMetafile(new EmfWriter({ width: 200, height: 40 }).comment(plus.bytes()).bytes())).svg))
    expect(xs(u)).toEqual(positions.map(([x]) => x))
    expect(u.getAttribute('y')!.split(' ').map(Number)).toEqual(positions.map(([, y]) => y))
  })

  it('right-to-left text keeps its textLength and lengthAdjust', () => {
    const e = new EmfWriter({ width: 200, height: 40 }).font(1, { face: 'Arial' }).select(1).text(100, 20, READING_ROOM.rtlSign, { advance: 9, options: 0x80 }).bytes()
    const [t] = texts(sanitizeSvg(drawn(drawMetafile(e)).svg))
    expect(t.getAttribute('textLength')).not.toBeNull()
    expect(t.getAttribute('lengthAdjust')).toBe('spacingAndGlyphs')
  })
})
