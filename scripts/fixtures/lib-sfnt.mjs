/*
 * Tiny synthetic TrueType fonts for tests: no outlines, only the tables a
 * glyph-number reader looks at (src/core/metafile/sfnt.ts) - 'name' (family
 * and style), 'cmap' (format 4 for the BMP, format 12 when a code point is
 * beyond it), when glyph names are given 'post' (format 2), and when
 * advances are given 'head', 'hhea' and 'hmtx' (each glyph's advance in
 * units of `unitsPerEm`; glyphs past the last given take its advance). So
 * no third-party font is committed or needed.
 *
 *   sfnt({ family: 'Reading Sans', style: 'Regular',
 *          cmap: [[0x41, 3], [0x42, 4]], names: { 9: 'f_i' }, glyphs: 10,
 *          advances: [0, 0, 0, 1200, 1100], unitsPerEm: 2048 })
 *   collection([fontA, fontB])   // a .ttc of them
 */

function be16(...v) {
  const b = Buffer.alloc(v.length * 2)
  v.forEach((x, i) => b.writeUInt16BE(x & 0xffff, i * 2))
  return b
}
function be32(...v) {
  const b = Buffer.alloc(v.length * 4)
  v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4))
  return b
}
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b)

function nameTable(family, style) {
  const strings = [
    [1, family],
    [2, style],
    [4, `${family} ${style}`],
  ].map(([id, s]) => {
    const text = Buffer.from(s, 'utf16le').swap16()
    return { id, text }
  })
  let offset = 0
  const records = strings.map(({ id, text }) => {
    const r = be16(3, 1, 0x409, id, text.length, offset)
    offset += text.length
    return r
  })
  return Buffer.concat([be16(0, strings.length, 6 + records.length * 12), ...records, ...strings.map((s) => s.text)])
}

function cmapTable(pairs) {
  const bmp = pairs.filter(([c]) => c < 0xffff).sort((a, b) => a[0] - b[0])
  // Format 4: one segment per character, its glyph by delta, then the closing 0xFFFF segment.
  const segs = [...bmp.map(([c, g]) => ({ start: c, end: c, delta: (g - c) & 0xffff })), { start: 0xffff, end: 0xffff, delta: 1 }]
  const n = segs.length
  const body = Buffer.concat([
    be16(...segs.map((s) => s.end)),
    be16(0),
    be16(...segs.map((s) => s.start)),
    be16(...segs.map((s) => s.delta)),
    be16(...segs.map(() => 0)),
  ])
  const f4 = Buffer.concat([be16(4, 14 + body.length, 0, n * 2, 0, 0, 0), body])
  const full = pairs.filter(([c]) => c > 0xffff)
  const subtables = [{ platform: 3, encoding: 1, data: f4 }]
  if (full.length) {
    const all = [...pairs].sort((a, b) => a[0] - b[0])
    const groups = Buffer.concat(all.map(([c, g]) => be32(c, c, g)))
    subtables.push({ platform: 3, encoding: 10, data: Buffer.concat([be16(12, 0), be32(16 + groups.length, 0, all.length), groups]) })
  }
  let at = 4 + subtables.length * 8
  const heads = subtables.map((s) => {
    const h = Buffer.concat([be16(s.platform, s.encoding), be32(at)])
    at += s.data.length
    return h
  })
  return Buffer.concat([be16(0, subtables.length), ...heads, ...subtables.map((s) => s.data)])
}

function postTable(glyphs, names) {
  const own = []
  const index = []
  for (let g = 0; g < glyphs; g++) {
    if (names[g]) {
      index.push(258 + own.length)
      own.push(names[g])
    } else index.push(0)
  }
  const strings = Buffer.concat(own.map((s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s, 'latin1')])))
  return Buffer.concat([be32(0x00020000), Buffer.alloc(28), be16(glyphs, ...index), strings])
}

/** 'head', 'hhea' and 'hmtx' for these advances (left side bearings all 0). */
function metricTables(advances, unitsPerEm) {
  const head = Buffer.alloc(54)
  head.writeUInt32BE(0x00010000, 0)
  head.writeUInt32BE(0x5f0f3cf5, 12)
  head.writeUInt16BE(unitsPerEm, 18)
  const hhea = Buffer.alloc(36)
  hhea.writeUInt32BE(0x00010000, 0)
  hhea.writeUInt16BE(advances.length, 34)
  const hmtx = Buffer.concat(advances.map((a) => be16(a, 0)))
  return { head, hhea, hmtx }
}

/** One face's tables, by tag. */
function tablesOf({ family, style = 'Regular', cmap = [], names = null, glyphs = 0, advances = null, unitsPerEm = 1000 }) {
  const count = Math.max(glyphs, ...cmap.map(([, g]) => g + 1), ...Object.keys(names ?? {}).map((g) => Number(g) + 1))
  const tables = { cmap: cmapTable(cmap), name: nameTable(family, style) }
  if (names) tables.post = postTable(count, names)
  if (advances) Object.assign(tables, metricTables(advances, unitsPerEm))
  return tables
}

/** A whole sfnt from one face's tables, starting at `base` in its file (0, or its place in a collection). */
function faceBytes(tables, base) {
  const tags = Object.keys(tables).sort()
  const head = Buffer.concat([be32(0x00010000), be16(tags.length, 0, 0, 0)])
  let at = base + 12 + tags.length * 16
  const dir = []
  const data = []
  for (const tag of tags) {
    const t = tables[tag]
    dir.push(Buffer.concat([Buffer.from(tag, 'latin1'), be32(0, at, t.length)]))
    data.push(pad4(t))
    at += pad4(t).length
  }
  return { dir: Buffer.concat([head, ...dir]), data: Buffer.concat(data) }
}

/** A font file of one face (see the top of this file). */
export function sfnt(face) {
  const { dir, data } = faceBytes(tablesOf(face), 0)
  return Buffer.concat([dir, data])
}

/** A font collection (.ttc) of these faces. */
export function collection(faces) {
  const head = 12 + faces.length * 4
  const parts = []
  const offsets = []
  let at = head
  for (const face of faces) {
    const tables = tablesOf(face)
    // Each face's directory and then its tables, one after another.
    const dirLength = 12 + Object.keys(tables).length * 16
    const { dir, data } = faceBytes(tables, at)
    offsets.push(at)
    parts.push(dir, data)
    at += dirLength + data.length
  }
  return Buffer.concat([Buffer.from('ttcf', 'latin1'), be32(0x00010000, faces.length, ...offsets), ...parts])
}
