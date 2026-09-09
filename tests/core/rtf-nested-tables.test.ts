import { describe, it, expect } from 'vitest'
import { readRtf, extractTables } from '../../src/core/readers/rtf'
import { tableGrid } from '../../src/core/table-grid'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeCsv } from '../../src/core/writers/csv'

/**
 * Two defects in the segmenting table pre-pass (src/core/readers/rtf.ts):
 *
 *  1. A table inside a cell (`\nestcell`/`\nestrow`/`\itap`) kept its text but
 *     lost its grid — it was flattened into the parent cell.
 *  2. A bare `\par` between two `\row`s of ONE table split it into two tables,
 *     because any paragraph mark after a row was read as "the table ended".
 *
 * Both are fixed here, and the pre-pass's core invariant is asserted directly:
 * everything the pre-pass does not claim as a table region must reach the
 * @iarna/rtf-to-html converter byte-for-byte unchanged.
 */

const doc = (body: string): Buffer =>
  Buffer.from(`{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}\n${body}\n}`, 'latin1')

const hub = async (body: string): Promise<string> => (await readRtf({ bytes: doc(body) })).html

const tableCount = (html: string): number => (html.match(/<table\b/g) ?? []).length

/* -------------------------------------------------------------------------- */
/* The pre-pass invariant                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `extractTables` is only allowed to do one thing: delete whole table regions
 * and drop a placeholder paragraph in each one's place. Two halves have to be
 * proved together, and proving only the first is worthless — an `extractTables`
 * that did nothing at all would satisfy it.
 *
 *   1. Every byte it did NOT claim survives, in order, unmodified.
 *   2. Every byte it DID claim was a real table region, and none of that
 *      markup is left behind in the prose stream.
 *
 * `segment()` below recovers both halves: splitting the segmented RTF on the
 * placeholder gives the surviving prose PIECES, and walking those back through
 * the original gives the GAPS between them — which are, byte for byte, the
 * regions the pre-pass cut out. Pieces interleaved with gaps must rebuild the
 * original exactly, so nothing is invented, lost, reordered or double-counted.
 */
const PLACEHOLDER = /\{\\pard\\plain zZrTfTbL\d+Zz\\par\}/g

/** Table markup, none of which may survive in the prose stream. */
const TABLE_CONTROL = /\\(trowd|row|cell|cellx|nestrow|nestcell|intbl)(?![a-zA-Z])/

interface Segmentation {
  /** Prose that reached the converter, in order, split at each placeholder. */
  pieces: string[]
  /** The byte ranges the pre-pass claimed, in order. */
  gaps: string[]
  /** Placeholder paragraphs the pre-pass left behind. */
  marks: string[]
  /** The rendered tables it returned. */
  tables: string[]
  changed: boolean
  problems: string[]
}

function segment(original: string): Segmentation {
  const out = extractTables(original)
  const pieces = out.rtf.split(PLACEHOLDER)
  const marks = out.rtf.match(PLACEHOLDER) ?? []
  const gaps: string[] = []
  const problems: string[] = []
  let cursor = 0
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]
    // The first piece must start at offset 0; later pieces follow the gap left
    // by the region that was cut out just before them.
    const at = i === 0 ? 0 : original.indexOf(piece, cursor)
    if (at < cursor) {
      problems.push(`piece ${i} does not occur in the original after offset ${cursor}`)
      break
    }
    if (original.slice(at, at + piece.length) !== piece) {
      problems.push(`piece ${i} is not byte-identical`)
      break
    }
    if (i > 0) gaps.push(original.slice(cursor, at))
    cursor = at + piece.length
  }
  if (problems.length === 0) {
    if (cursor !== original.length) problems.push(`trailing ${original.length - cursor} bytes unaccounted for`)
    let rebuilt = pieces[0] ?? ''
    for (let i = 0; i < gaps.length; i++) rebuilt += gaps[i] + pieces[i + 1]
    if (rebuilt !== original) problems.push('prose pieces plus cut regions do not rebuild the original')
    if (marks.length !== gaps.length) {
      problems.push(`${marks.length} placeholders but ${gaps.length} cut regions`)
    }
    pieces.forEach((piece, i) => {
      const left = TABLE_CONTROL.exec(piece)
      if (left) problems.push(`table markup ${left[0]} left behind in prose piece ${i}`)
    })
    gaps.forEach((gap, i) => {
      if (gap === '') problems.push(`region ${i} is empty: a placeholder replaced nothing`)
      else if (!/\\trowd(?![a-zA-Z])/.test(gap)) problems.push(`region ${i} contains no \\trowd: ${gap}`)
    })
  }
  return { pieces, gaps, marks, tables: out.tables, changed: out.rtf !== original, problems }
}

describe('rtf pre-pass: table regions are cut out and nothing else is touched', () => {
  interface Case {
    body: string
    /** How many table regions the pre-pass must claim. */
    regions: number
    /** Prose that must still be in the stream handed to the converter. */
    keeps: string[]
    /** Cell text that must have left the prose stream with its region. */
    cuts: string[]
  }

  const cases: Record<string, Case> = {
    'no tables at all': {
      body: String.raw`\pard\b Title\b0\par Plain prose with \i italics\i0  and a \{brace\}.\par`,
      regions: 0,
      keeps: ['Title', 'Plain prose with', String.raw`\{brace\}`],
      cuts: [],
    },
    'one table between prose': {
      body: String.raw`\pard Intro\par
\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\pard Outro\par`,
      regions: 1,
      keeps: ['Intro', 'Outro'],
      cuts: [String.raw`\cellx3000`],
    },
    'two tables separated by prose': {
      body: String.raw`\pard One\par
\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\pard Middle\par
\trowd\cellx3000\cellx6000\intbl C\cell D\cell\row
\pard End\par`,
      regions: 2,
      keeps: ['One', 'Middle', 'End'],
      cuts: [],
    },
    'rows joined across a bare \\par': {
      body: String.raw`\pard Intro\par
\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\par
\trowd\cellx3000\cellx6000\intbl C\cell D\cell\row
\pard Outro\par`,
      // One region, not two: the \par between the rows belongs to the table.
      regions: 1,
      keeps: ['Intro', 'Outro'],
      cuts: [],
    },
    'a genuine split at a \\par': {
      body: String.raw`\pard Intro\par
\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\par
\trowd\cellx2000\cellx4000\intbl C\cell D\cell\row
\pard Outro\par`,
      // Two regions, and the \par between them stays in the prose stream.
      regions: 2,
      keeps: ['Intro', 'Outro'],
      cuts: [],
    },
    // \binN declares N raw bytes; a brace among them is data, and the walk that
    // skips the object group must land exactly on its `}` or the region
    // boundaries slide and prose is lost.
    'a \\bin object beside a table': {
      body: String.raw`\pard Intro\par
{\*\objdata \bin5 AB{CD}
\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\pard Outro\par`,
      regions: 1,
      keeps: ['Intro', String.raw`{\*\objdata \bin5 AB{CD}`, 'Outro'],
      cuts: [],
    },
    'a \\bin object inside a table cell': {
      body: String.raw`\pard Intro\par
\trowd\cellx3000\cellx6000\intbl A{\*\objdata \bin5 A}BCD}\cell B\cell\row
\pard Outro\par`,
      regions: 1,
      keeps: ['Intro', 'Outro'],
      cuts: [String.raw`\bin5`],
    },
    'a nested table': {
      body: String.raw`\pard\trowd\itap1\cellx3000\cellx6000
\pard\intbl\itap2 Widget\nestcell\pard\intbl\itap2 3\nestcell{\*\nesttableprops\trowd\itap2\cellx1500\cellx3000\nestrow}{\nonesttables\par}
\pard\intbl\itap1\cell Ready\cell\row
\pard After\par`,
      regions: 1,
      keeps: ['After'],
      cuts: ['Widget', 'Ready', String.raw`\nestcell`],
    },
  }

  for (const [name, spec] of Object.entries(cases)) {
    it(`cuts ${spec.regions} region(s) and leaves the rest byte-identical: ${name}`, () => {
      const rtf = doc(spec.body).toString('latin1')
      const seg = segment(rtf)

      expect(seg.problems).toEqual([])
      // The pre-pass really claimed something: an identity transform, or one
      // that quietly declined this shape, fails here.
      expect(seg.gaps).toHaveLength(spec.regions)
      expect(seg.marks).toHaveLength(spec.regions)
      expect(seg.tables).toHaveLength(spec.regions)
      expect(seg.changed).toBe(spec.regions > 0)

      const prose = seg.pieces.join(' ')
      for (const kept of spec.keeps) expect(prose, `kept: ${kept}`).toContain(kept)
      for (const cut of spec.cuts) expect(prose, `cut: ${cut}`).not.toContain(cut)
      // Every cut region is table markup, and every one of them ended up in a
      // rendered table rather than being dropped on the floor.
      for (const table of seg.tables) expect(table).toMatch(/^<table\b/)
    })
  }

  it('rebuilds the original exactly from the prose it kept and the regions it cut', () => {
    const rtf = doc(String.raw`\pard Intro\par
\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\pard Outro\par`).toString('latin1')
    const seg = segment(rtf)
    expect(seg.pieces[0] + seg.gaps[0] + seg.pieces[1]).toBe(rtf)
    // Pinned in full, because "the prose is untouched" is only meaningful if
    // the boundary between prose and region is pinned too.
    expect(seg.pieces).toEqual([
      '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}\n\\pard Intro\\par',
      '\n\\pard Outro\\par\n}',
    ])
    expect(seg.gaps).toEqual(['\n\\trowd\\cellx3000\\cellx6000\\intbl A\\cell B\\cell\\row'])
  })

  it('cuts nothing at all out of a document with no \\trowd', () => {
    const rtf = doc(String.raw`\pard Just prose.\par`).toString('latin1')
    const segmented = extractTables(rtf)
    expect(segmented.rtf).toBe(rtf)
    expect(segmented.tables).toEqual([])
  })

  it('the invariant check itself catches a pre-pass that does nothing', () => {
    // Guard on the guard: if `segment` reported "ok" for an untouched document
    // that plainly contains a table, every case above would prove nothing.
    const rtf = doc(String.raw`\pard Intro\par
\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\pard Outro\par`).toString('latin1')
    const identity = { rtf, tables: [] as string[] }
    const pieces = identity.rtf.split(PLACEHOLDER)
    expect(pieces).toHaveLength(1)
    expect(TABLE_CONTROL.test(pieces[0])).toBe(true) // ...which `segment` reports as a problem
    expect(segment(rtf).problems).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Defect 1 — nested tables                                                    */
/* -------------------------------------------------------------------------- */

/** Word's shape: \itap2 paragraphs, \nestcell, and the row props in {\*\nesttableprops}. */
const WORD_NESTED = String.raw`\pard\trowd\itap1\cellx3000\cellx6000
\pard\intbl\itap2 Widget\nestcell\pard\intbl\itap2 3\nestcell{\*\nesttableprops\trowd\itap2\cellx1500\cellx3000\nestrow}{\nonesttables\par}
\pard\intbl\itap2 Gadget\nestcell\pard\intbl\itap2 7\nestcell{\*\nesttableprops\trowd\itap2\cellx1500\cellx3000\nestrow}{\nonesttables\par}
\pard\intbl\itap1\cell Ready\cell\row`

describe('rtf tables: nested tables keep their grid', () => {
  it('emits a real <table> inside the parent cell (Word \\itap shape)', async () => {
    const html = await hub(WORD_NESTED)
    expect(tableCount(html)).toBe(2)
    // The inner table lives inside the outer cell, not beside it.
    expect(html).toMatch(/<td>\s*<table\b/)
    expect(html).toContain('<td>Widget</td>')
    expect(html).toContain('<td>Gadget</td>')
    expect(html).toContain('<td>Ready</td>')
  })

  it('models the nested table as its own grid, with two rows', async () => {
    const grids = tableGrid(await hub(WORD_NESTED))
    expect(grids).toHaveLength(2)
    // The parent grid keeps the nested text with the parent cell (table-grid's
    // ownRows() deliberately does not recurse), so nothing is lost there.
    expect(grids[0]).toEqual([['Widget 3 Gadget 7', 'Ready']])
    expect(grids[1]).toEqual([
      ['Widget', '3'],
      ['Gadget', '7'],
    ])
  })

  it('keeps the nested grid for the legacy shape (bare \\nestrow, no \\itap)', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000
\intbl Widget\nestcell 3\nestcell\nestrow{\*\nesttableprops\trowd\cellx1500\cellx3000\row}\cell Ready\cell\row`,
    )
    expect(tableCount(html)).toBe(2)
    const grids = tableGrid(html)
    expect(grids[0]).toEqual([['Widget 3', 'Ready']])
    expect(grids[1]).toEqual([['Widget', '3']])
    expect(html).not.toContain('Widget3')
  })

  it('keeps text the parent cell holds alongside the nested table', async () => {
    const html = await hub(
      String.raw`\pard\trowd\itap1\cellx3000\cellx6000
\pard\intbl\itap1 Parts:\par
\pard\intbl\itap2 Bolt\nestcell\pard\intbl\itap2 9\nestcell{\*\nesttableprops\trowd\itap2\cellx1500\cellx3000\nestrow}
\pard\intbl\itap1\cell Ready\cell\row`,
    )
    expect(tableCount(html)).toBe(2)
    expect(html).toContain('Parts:')
    expect(tableGrid(html)[0]).toEqual([['Parts: Bolt 9', 'Ready']])
    expect(tableGrid(html)[1]).toEqual([['Bolt', '9']])
  })

  it('does not invent a nested table from a bare \\itap2 with no \\nestcell', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl\itap2 Loose\cell Ready\cell\row`,
    )
    expect(tableCount(html)).toBe(1)
    expect(tableGrid(html)).toEqual([[['Loose', 'Ready']]])
  })

  it('carries a nested table through the markdown and csv writers', async () => {
    const html = await hub(WORD_NESTED)
    const md = (await writeMarkdown({ html })).toString('utf8')
    // GFM pipe tables cannot nest. writeMarkdown rebuilds every table from its
    // grid, which folds the inner table's text into the parent cell and drops
    // the inner grid: one flat table, no text lost. That is the only lossless
    // shape available, so it is the recorded behaviour, not a defect.
    expect(md.trim()).toBe('| Widget 3 Gadget 7 | Ready |\n| --- | --- |')
    expect(md).not.toContain('Widget3')

    // csv/json/xlsx get one file per table: the parent (nested text folded into
    // its cell) and the nested table on its own.
    const parts = (await writeCsv({ html })).parts
    expect(parts).toHaveLength(2)
    expect(parts[0].bytes.toString('utf8')).toContain('Widget 3 Gadget 7,Ready')
    const inner = parts[1].bytes.toString('utf8')
    expect(inner).toContain('Widget,3')
    expect(inner).toContain('Gadget,7')
  })
})

/* -------------------------------------------------------------------------- */
/* Defect 2 — a bare \par between rows                                         */
/* -------------------------------------------------------------------------- */

describe('rtf tables: a bare \\par between rows does not split the table', () => {
  it('merges two rows separated only by \\par when the \\cellx grid matches', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\par
\trowd\cellx3000\cellx6000\intbl C\cell D\cell\row`,
    )
    expect(tableCount(html)).toBe(1)
    expect(tableGrid(html)).toEqual([
      [
        ['A', 'B'],
        ['C', 'D'],
      ],
    ])
  })

  it('merges across \\par when the next row merges cells (a subset of the same \\cellx grid)', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\par
\trowd\cellx6000\intbl Total\cell\row`,
    )
    expect(tableCount(html)).toBe(1)
    expect(tableGrid(html)).toEqual([
      [
        ['A', 'B'],
        ['Total', ''],
      ],
    ])
  })

  it('merges across several blank paragraphs between rows', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\par\par
\trowd\cellx3000\cellx6000\intbl C\cell D\cell\row`,
    )
    expect(tableCount(html)).toBe(1)
    expect(tableGrid(html)[0]).toHaveLength(2)
  })

  it('still splits when the next row declares a different \\cellx grid', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\par
\trowd\cellx2000\cellx4000\intbl C\cell D\cell\row`,
    )
    expect(tableCount(html)).toBe(2)
    const grids = tableGrid(html)
    expect(grids[0]).toEqual([['A', 'B']])
    expect(grids[1]).toEqual([['C', 'D']])
  })

  it('still splits when the next row has a different column count on the same right edge', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\par
\trowd\cellx2000\cellx4000\cellx6000\intbl C\cell D\cell E\cell\row`,
    )
    expect(tableCount(html)).toBe(2)
    expect(tableGrid(html)).toEqual([[['A', 'B']], [['C', 'D', 'E']]])
  })

  it('still splits at \\itap0, which says the table is over', async () => {
    const html = await hub(
      String.raw`\pard\trowd\itap1\cellx3000\cellx6000\intbl\itap1 A\cell B\cell\row
\pard\plain\itap0\par
\trowd\itap1\cellx3000\cellx6000\intbl\itap1 C\cell D\cell\row`,
    )
    expect(tableCount(html)).toBe(2)
    expect(tableGrid(html)).toEqual([[['A', 'B']], [['C', 'D']]])
  })

  it('still splits when real prose sits between the rows', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl A\cell B\cell\row
\pard Between\par
\trowd\cellx3000\cellx6000\intbl C\cell D\cell\row`,
    )
    expect(tableCount(html)).toBe(2)
    expect(html).toContain('Between')
    expect(tableGrid(html)).toEqual([[['A', 'B']], [['C', 'D']]])
  })

  it('keeps a \\par inside a cell as a line break, not a table break', async () => {
    const html = await hub(
      String.raw`\pard\trowd\cellx3000\cellx6000\intbl From\par Alice\cell B\cell\row
\par
\trowd\cellx3000\cellx6000\intbl C\cell D\cell\row`,
    )
    expect(tableCount(html)).toBe(1)
    expect(html).toContain('From<br />Alice')
    expect(tableGrid(html)).toEqual([
      [
        ['From Alice', 'B'],
        ['C', 'D'],
      ],
    ])
  })
})
