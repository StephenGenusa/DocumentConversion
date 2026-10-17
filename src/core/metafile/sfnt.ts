/*
 * Just enough of a TrueType/OpenType font (an sfnt) to turn glyph numbers
 * back into characters: its names (which family and style it is) and its
 * character map, read backward. A metafile that writes text as glyph
 * numbers (EMF's ETO_GLYPH_INDEX, EMF+ DrawDriverString without a cmap
 * lookup) only says which glyphs of its font to draw; the font itself says
 * which character each glyph is.
 *
 * Glyph numbers belong to one font: a metric-compatible twin (Carlito for
 * Calibri) has the same widths but its own glyph order, so only the font
 * the metafile names, by its exact family, is any use (fonts.ts).
 *
 * The font is read as untrusted, like the metafile: every read is checked
 * against the buffer, tables and records are capped, and every loop moves
 * forward through bounded ranges.
 */

/** A font's family and style, as its 'name' table gives them. */
export interface SfntName {
  /** Family names (nameID 1 and 16), in any language the font gives. */
  families: string[]
  /** Its style names (nameID 2 and 17), lower case: "regular", "bold italic". */
  styles: string[]
  /** The full name (nameID 4) and the PostScript name (nameID 6), when given. */
  full: string[]
}

/** A table directory entry: where a table lies in the file. */
interface Table {
  offset: number
  length: number
}

const MAX_TABLES = 256
const MAX_FACES = 64
const MAX_NAME_RECORDS = 4096
const MAX_SUBTABLES = 64
/** The most code points looked at in one character map (Unicode's whole range is 1.1M). */
const MAX_CODES = 1_200_000
/** Glyph numbers are 16-bit. */
const MAX_GLYPHS = 0x10000

/** A bounded big-endian reader over the whole font file. */
class Be {
  constructor(readonly buf: Buffer) {}
  has(at: number, n: number): boolean {
    return Number.isSafeInteger(at) && Number.isSafeInteger(n) && at >= 0 && n >= 0 && at + n <= this.buf.length
  }
  private at(at: number, n: number): number {
    if (!this.has(at, n)) throw new RangeError('past the end of the font')
    return at
  }
  u16(at: number): number {
    return this.buf.readUInt16BE(this.at(at, 2))
  }
  i16(at: number): number {
    return this.buf.readInt16BE(this.at(at, 2))
  }
  u32(at: number): number {
    return this.buf.readUInt32BE(this.at(at, 4))
  }
  tag(at: number): string {
    return this.buf.toString('latin1', this.at(at, 4), at + 4)
  }
}

/** Where each face of a font file starts: one for a .ttf/.otf, several for a collection (.ttc). */
export function sfntFaces(buf: Buffer): number[] {
  const b = new Be(buf)
  if (!b.has(0, 12)) return []
  const tag = b.tag(0)
  if (tag === 'ttcf') {
    const n = Math.min(b.u32(8), MAX_FACES)
    const faces: number[] = []
    for (let i = 0; i < n && b.has(12 + i * 4, 4); i++) faces.push(b.u32(12 + i * 4))
    return faces.filter((at) => b.has(at, 12) && isSfnt(b.tag(at)))
  }
  return isSfnt(tag) ? [0] : []
}

function isSfnt(tag: string): boolean {
  return tag === '\0\x01\0\0' || tag === 'OTTO' || tag === 'true'
}

/** The tables of the face at `face`, by tag (only those wholly inside the file). */
export function sfntTables(buf: Buffer, face: number): Map<string, Table> {
  const b = new Be(buf)
  const tables = new Map<string, Table>()
  if (!b.has(face, 12)) return tables
  const n = Math.min(b.u16(face + 4), MAX_TABLES)
  for (let i = 0; i < n; i++) {
    const at = face + 12 + i * 16
    if (!b.has(at, 16)) break
    const t = { offset: b.u32(at + 8), length: b.u32(at + 12) }
    if (b.has(t.offset, t.length)) tables.set(b.tag(at), t)
  }
  return tables
}

/** The face's names (see SfntName), or null when it has no readable 'name' table. */
export function sfntName(buf: Buffer, tables: Map<string, Table>): SfntName | null {
  const t = tables.get('name')
  if (!t) return null
  const b = new Be(buf)
  try {
    const count = Math.min(b.u16(t.offset + 2), MAX_NAME_RECORDS)
    const strings = t.offset + b.u16(t.offset + 4)
    const out: SfntName = { families: [], styles: [], full: [] }
    for (let i = 0; i < count; i++) {
      const at = t.offset + 6 + i * 12
      if (!b.has(at, 12) || at + 12 > t.offset + t.length) break
      const [platform, encoding, id, length, offset] = [b.u16(at), b.u16(at + 2), b.u16(at + 6), b.u16(at + 8), b.u16(at + 10)]
      const list = id === 1 || id === 16 ? out.families : id === 2 || id === 17 ? out.styles : id === 4 || id === 6 ? out.full : null
      if (!list || !b.has(strings + offset, length)) continue
      const raw = buf.subarray(strings + offset, strings + offset + length)
      let text: string
      if (platform === 3 || platform === 0) text = utf16be(raw)
      else if (platform === 1 && encoding === 0) text = raw.toString('latin1')
      else continue
      text = text.replace(/\0+$/, '').trim()
      if (list === out.styles) text = text.toLowerCase()
      if (text && !list.includes(text)) list.push(text)
    }
    return out
  } catch {
    return null
  }
}

function utf16be(raw: Buffer): string {
  const swapped = Buffer.from(raw.subarray(0, raw.length & ~1))
  swapped.swap16()
  return swapped.toString('utf16le')
}

/**
 * What character each glyph of the face is: the character map read
 * backward (a glyph that several characters share is the first, preferring
 * one outside the private use areas, so a space is U+0020 rather than
 * U+00A0), then, for glyphs no character maps to (ligatures, alternates),
 * what the 'post' table's glyph names say ("f_i", "uni00E9.sc"). Null when
 * the face has no character map this can read.
 */
export function glyphCharacters(buf: Buffer, tables: Map<string, Table>): Map<number, string> | null {
  const b = new Be(buf)
  const cmap = tables.get('cmap')
  if (!cmap) return null
  const glyphs = new Map<number, number>()
  const keep = (code: number, glyph: number): void => {
    if (glyph === 0 || glyph >= MAX_GLYPHS || code > 0x10ffff) return
    const had = glyphs.get(glyph)
    if (had === undefined || better(code, had)) glyphs.set(glyph, code)
  }
  let read = false
  try {
    const n = Math.min(b.u16(cmap.offset + 2), MAX_SUBTABLES)
    // The subtables worth reading, the fullest first: Unicode full range, Unicode BMP, symbol.
    const picks: { rank: number; at: number }[] = []
    for (let i = 0; i < n; i++) {
      const at = cmap.offset + 4 + i * 8
      if (!b.has(at, 8)) break
      const [platform, encoding] = [b.u16(at), b.u16(at + 2)]
      const rank =
        (platform === 3 && encoding === 10) || (platform === 0 && (encoding === 4 || encoding === 6)) ? 3
        : (platform === 3 && encoding === 1) || platform === 0 ? 2
        : platform === 3 && encoding === 0 ? 1
        : 0
      if (rank) picks.push({ rank, at: cmap.offset + b.u32(at + 4) })
    }
    picks.sort((x, y) => y.rank - x.rank)
    let budget = MAX_CODES
    for (const { at } of picks) {
      const used = subtable(b, at, keep, budget)
      if (used < 0) continue
      read = true
      budget -= used
      if (budget <= 0) break
    }
  } catch {
    // A broken character map: what was read before it broke is kept.
  }
  if (!read) return null
  const chars = new Map<number, string>()
  for (const [glyph, code] of glyphs) chars.set(glyph, String.fromCodePoint(code))
  try {
    postNames(b, tables.get('post'), chars)
  } catch {
    // Names are only a help.
  }
  return chars
}

/** Whether `code` is a better name for a glyph than `had`. */
function better(code: number, had: number): boolean {
  const pua = (c: number): boolean => (c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000
  if (pua(code) !== pua(had)) return pua(had)
  return code < had
}

/** One cmap subtable read into `keep`: how many code points it took, or -1 for a format this does not read. */
function subtable(b: Be, at: number, keep: (code: number, glyph: number) => void, budget: number): number {
  const format = b.u16(at)
  let used = 0
  switch (format) {
    case 0: {
      for (let c = 0; c < 256; c++) keep(c, b.buf[at + 6 + c] ?? 0)
      return 256
    }
    case 4: {
      const segX2 = b.u16(at + 6)
      const segs = segX2 >> 1
      const ends = at + 14
      const starts = ends + segX2 + 2
      const deltas = starts + segX2
      const ranges = deltas + segX2
      for (let i = 0; i < segs; i++) {
        const end = b.u16(ends + i * 2)
        const start = b.u16(starts + i * 2)
        const delta = b.i16(deltas + i * 2)
        const rangeAt = ranges + i * 2
        const range = b.u16(rangeAt)
        if (end < start) continue
        for (let c = start; c <= end && c !== 0xffff; c++) {
          if (++used > budget) return used
          let g: number
          if (range === 0) g = (c + delta) & 0xffff
          else {
            const p = rangeAt + range + (c - start) * 2
            if (!b.has(p, 2)) break
            g = b.u16(p)
            if (g !== 0) g = (g + delta) & 0xffff
          }
          keep(c, g)
        }
      }
      return used
    }
    case 6: {
      const first = b.u16(at + 6)
      const count = b.u16(at + 8)
      for (let i = 0; i < count && b.has(at + 10 + i * 2, 2); i++) keep(first + i, b.u16(at + 10 + i * 2))
      return count
    }
    case 12: {
      const groups = b.u32(at + 12)
      for (let i = 0; i < groups; i++) {
        const g = at + 16 + i * 12
        if (!b.has(g, 12)) break
        const [start, end, glyph] = [b.u32(g), Math.min(b.u32(g + 4), 0x10ffff), b.u32(g + 8)]
        for (let c = start; c <= end; c++) {
          if (++used > budget) return used
          keep(c, glyph + (c - start))
        }
      }
      return used
    }
    default:
      return -1
  }
}

/** Ligature glyph names that are not made of their parts' names. */
const LIGATURES: Record<string, string> = { fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', ft: 'ft', st: 'st' }

/**
 * Glyphs with no character, named by a 'post' table of format 2: names
 * after the Adobe Glyph List's conventions for new names ("uni0041",
 * "u1F600", parts joined by "_", a suffix after "."), single letters and
 * digits, and the common ligatures. Anything else stays unknown.
 */
function postNames(b: Be, post: Table | undefined, chars: Map<number, string>): void {
  if (!post || post.length < 34 || b.u32(post.offset) !== 0x00020000) return
  const n = Math.min(b.u16(post.offset + 32), MAX_GLYPHS)
  const indexAt = post.offset + 34
  const namesAt = indexAt + n * 2
  const end = post.offset + post.length
  if (namesAt > end) return
  // The table's own names, in order (an index of 258 or more picks one).
  const names: string[] = []
  for (let at = namesAt; at < end && names.length < MAX_GLYPHS; ) {
    const len = b.buf[at]
    if (at + 1 + len > end) break
    names.push(b.buf.toString('latin1', at + 1, at + 1 + len))
    at += 1 + len
  }
  for (let g = 0; g < n; g++) {
    if (chars.has(g)) continue
    const index = b.u16(indexAt + g * 2)
    if (index < 258) continue
    const text = fromGlyphName(names[index - 258] ?? '')
    if (text) chars.set(g, text)
  }
}

/** The characters a glyph name stands for, or '' when it says nothing this knows. */
export function fromGlyphName(name: string): string {
  const base = name.split('.')[0]
  if (!base) return ''
  let out = ''
  for (const part of base.split('_')) {
    let m: RegExpExecArray | null
    if ((m = /^uni((?:[0-9A-F]{4})+)$/.exec(part))) {
      for (let i = 0; i < m[1].length; i += 4) {
        const c = parseInt(m[1].slice(i, i + 4), 16)
        if (c >= 0xd800 && c <= 0xdfff) return ''
        out += String.fromCharCode(c)
      }
    } else if ((m = /^u([0-9A-F]{4,6})$/.exec(part))) {
      const c = parseInt(m[1], 16)
      if (c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return ''
      out += String.fromCodePoint(c)
    } else if (/^[A-Za-z0-9]$/.test(part)) out += part
    else if (LIGATURES[part]) out += LIGATURES[part]
    else return ''
  }
  return out
}
