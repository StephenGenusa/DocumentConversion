/**
 * ADVERSARIAL suite — writers, table extraction, merge, options.
 *
 * Every expectation below is derived from the design specs ONLY:
 *   docs/superpowers/specs/2026-08-31-io-expansion-design.md  (§F6, §F8, §F10, §F0)
 *   docs/superpowers/specs/2026-08-31-format-additions-2-design.md (§F22)
 * plus src/core/types.ts for shapes. Implementation bodies were not read.
 */
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { PDFDocument } from 'pdf-lib'

import { extractTables, writeCsv } from '../../src/core/writers/csv'
import { writeJson } from '../../src/core/writers/json'
import { writeXlsx } from '../../src/core/writers/xlsx'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeTxt } from '../../src/core/writers/txt'
import { mergeHubDocuments } from '../../src/core/merge'
import { mergePdfs } from '../../src/core/pdf-merge'
import { normalizePdfOptions } from '../../src/core/pdf-options'
import { uniqueName } from '../../src/core/naming'
import { allowedMergeTargets, allowedTargets } from '../../src/core/target-validity'
import type { HubDocument, WriteResult } from '../../src/core/types'

// ---------------------------------------------------------------- helpers

const doc = (html: string, extra: Partial<HubDocument> = {}): HubDocument => ({ html, ...extra })

async function grab(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

function textParts(res: WriteResult): { suffix: string; text: string }[] {
  return res.parts.map((p) => ({ suffix: p.suffix, text: p.bytes.toString('utf8') }))
}

/** Strict-ish RFC 4180 reader used to prove the writer's quoting is sound. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let started = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && field === '') {
      inQuotes = true
      started = true
      i++
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      started = true
      i++
      continue
    }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      started = false
      i += 2
      continue
    }
    if (c === '\n' || c === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      started = false
      i++
      continue
    }
    field += c
    started = true
    i++
  }
  if (started || field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Lines of a GFM pipe table. */
function tableLines(md: string): string[] {
  return md
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
}

/** Split a pipe-table row on UNESCAPED pipes. */
function pipeCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '\\') {
      cur += t[i + 1] ?? ''
      i++
      continue
    }
    if (c === '|') {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur.trim())
  return out
}

const isDelimiterRow = (line: string) => /^\|[\s:|-]+\|?\s*$/.test(line) && line.includes('-')

async function makePdf(pages: [number, number][]): Promise<Buffer> {
  const d = await PDFDocument.create()
  for (const [w, h] of pages) d.addPage([w, h])
  return Buffer.from(await d.save())
}

const T = (rows: string) => `<table>${rows}</table>`
const tr = (cells: string) => `<tr>${cells}</tr>`

// ================================================================
// extractTables — structure
// ================================================================

describe('extractTables — structure', () => {
  it('reads a simple table into a rectangular grid', () => {
    const t = extractTables(T(tr('<th>A</th><th>B</th>') + tr('<td>1</td><td>2</td>')))
    expect(t).toEqual([[['A', 'B'], ['1', '2']]])
  })

  it('flattens thead/tbody/tfoot into document order', () => {
    const html = `<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>B</td></tr></tbody><tfoot><tr><td>F</td></tr></tfoot></table>`
    expect(extractTables(html)).toEqual([[['H'], ['B'], ['F']]])
  })

  it('counts two <table> elements as two tables', () => {
    const html = T(tr('<td>a</td>')) + T(tr('<td>b</td>'))
    expect(extractTables(html)).toHaveLength(2)
  })

  it('a nested table does not splice its rows into the outer table', () => {
    const inner = T(tr('<td>i1</td><td>i2</td>'))
    const html = T(tr(`<td>${inner}</td>`) + tr('<td>outer2</td>'))
    const tables = extractTables(html)
    // Whatever the extractor decides about nesting, the OUTER table is a
    // 1-column, 2-row table — inner rows must not become outer rows.
    const outer = tables[0]
    expect(outer.length).toBe(2)
    expect(outer[0].length).toBe(1)
  })

  it('a nested table is reported as its own table (one file per table)', () => {
    const inner = T(tr('<td>i1</td><td>i2</td>'))
    const html = T(tr(`<td>${inner}</td>`))
    expect(extractTables(html)).toHaveLength(2)
  })

  it('never leaves HTML markup inside a cell value', () => {
    const inner = T(tr('<td>i1</td>'))
    const html = T(tr(`<td>${inner}</td><td><p>x</p></td>`))
    for (const table of extractTables(html)) {
      for (const row of table) {
        for (const cell of row) {
          expect(cell).not.toMatch(/<\/?[a-z]/i)
        }
      }
    }
  })

  it('a table with only <th> rows still yields a table', () => {
    expect(extractTables(T(tr('<th>A</th><th>B</th>')))).toEqual([[['A', 'B']]])
  })

  it('an empty <table></table> is not an extractable table', () => {
    expect(extractTables('<p>x</p><table></table>')).toEqual([])
  })

  it('an empty table alongside a real one leaves exactly one table', () => {
    const html = '<table></table>' + T(tr('<td>a</td>'))
    expect(extractTables(html)).toEqual([[['a']]])
  })

  it('ragged rows are padded to a rectangular grid (RFC 4180 records)', () => {
    const html = T(tr('<td>a</td><td>b</td><td>c</td>') + tr('<td>d</td><td>e</td>'))
    expect(extractTables(html)).toEqual([
      [
        ['a', 'b', 'c'],
        ['d', 'e', ''],
      ],
    ])
  })
})

// ================================================================
// extractTables — cell text
// ================================================================

describe('extractTables — cell text', () => {
  it('decodes &amp; and &lt; entities', () => {
    const t = extractTables(T(tr('<td>a &amp; b</td><td>&lt;tag&gt;</td>')))
    expect(t[0][0]).toEqual(['a & b', '<tag>'])
  })

  it('does not emit a literal <br> in a cell', () => {
    const t = extractTables(T(tr('<td>line1<br>line2</td>')))
    expect(t[0][0][0]).not.toMatch(/<br/i)
    expect(t[0][0][0]).toContain('line1')
    expect(t[0][0][0]).toContain('line2')
  })

  it('trims leading/trailing whitespace in cells', () => {
    const t = extractTables(T(tr('<td>   padded   </td>')))
    expect(t[0][0][0]).toBe('padded')
  })

  it('does not leave a raw non-breaking space entity in a cell', () => {
    const t = extractTables(T(tr('<td>a&nbsp;b</td>')))
    expect(t[0][0][0]).not.toContain('&nbsp;')
    expect(t[0][0][0]).not.toContain(' ')
  })

  it('preserves non-ASCII text', () => {
    const t = extractTables(T(tr('<td>café</td><td>中文</td>')))
    expect(t[0][0]).toEqual(['café', '中文'])
  })
})

// ================================================================
// extractTables — span rule (§F6, fixture-tested per spec)
// ================================================================

describe('extractTables — span rule', () => {
  it('colspan expands to the value THEN empty cells', () => {
    const html = T(tr('<td colspan="3">wide</td>') + tr('<td>a</td><td>b</td><td>c</td>'))
    expect(extractTables(html)).toEqual([
      [
        ['wide', '', ''],
        ['a', 'b', 'c'],
      ],
    ])
  })

  it('rowspan repeats the value down the rows it covers (data exports)', () => {
    // RULING (superseded): blanking the continuation rows meant a merged
    // category label vanished from every row but its first, so filtering a
    // CSV/JSON export silently lost it. Markdown still blanks them, because
    // it renders the merge visually — see the md hygiene tests.
    const html = T(
      tr('<td rowspan="2">tall</td><td>r1</td>') + tr('<td>r2</td>'),
    )
    expect(extractTables(html)).toEqual([
      [
        ['tall', 'r1'],
        ['tall', 'r2'],
      ],
    ])
  })

  it('rowspan + colspan on the SAME cell repeats only the anchor column', () => {
    const html = T(
      tr('<td rowspan="2" colspan="2">big</td><td>x</td>') + tr('<td>y</td>'),
    )
    expect(extractTables(html)).toEqual([
      [
        ['big', '', 'x'],
        ['big', '', 'y'],
      ],
    ])
  })

  it('colspan="0" behaves as a single cell', () => {
    const html = T(tr('<td colspan="0">a</td><td>b</td>'))
    expect(extractTables(html)).toEqual([[['a', 'b']]])
  })

  it('colspan="abc" behaves as a single cell', () => {
    const html = T(tr('<td colspan="abc">a</td><td>b</td>'))
    expect(extractTables(html)).toEqual([[['a', 'b']]])
  })

  it('colspan="-2" behaves as a single cell', () => {
    const html = T(tr('<td colspan="-2">a</td><td>b</td>'))
    expect(extractTables(html)).toEqual([[['a', 'b']]])
  })

  it('an absurd colspan is bounded (no unbounded allocation)', () => {
    const html = T(tr('<td colspan="1000000">a</td>'))
    const t = extractTables(html)
    expect(t[0][0].length).toBeLessThanOrEqual(1000)
  })

  it('an absurd rowspan does not invent rows that do not exist', () => {
    const html = T(tr('<td rowspan="1000">a</td><td>b</td>') + tr('<td>c</td>'))
    expect(extractTables(html)[0].length).toBe(2)
  })
})

// ================================================================
// writeCsv — one file per table, suffixes, RFC 4180
// ================================================================

describe('writeCsv — file model', () => {
  it('single table → exactly one part with suffix ""', async () => {
    const res = await writeCsv(doc(T(tr('<td>a</td>'))))
    expect(res.parts).toHaveLength(1)
    expect(res.parts[0].suffix).toBe('')
  })

  it('two tables → ".table-1" and ".table-2"', async () => {
    const html = T(tr('<td>a</td>')) + T(tr('<td>b</td>'))
    const parts = textParts(await writeCsv(doc(html)))
    expect(parts.map((p) => p.suffix)).toEqual(['.table-1', '.table-2'])
    expect(parts[0].text).toContain('a')
    expect(parts[1].text).toContain('b')
  })

  it('three tables → three .table-N parts in document order', async () => {
    const html = [1, 2, 3].map((n) => T(tr(`<td>t${n}</td>`))).join('')
    const parts = textParts(await writeCsv(doc(html)))
    expect(parts.map((p) => p.suffix)).toEqual(['.table-1', '.table-2', '.table-3'])
    expect(parts.map((p) => p.text.trim())).toEqual(['t1', 't2', 't3'])
  })

  it('no tables → ConversionError code "no-tables"', async () => {
    const err = await grab(() => writeCsv(doc('<p>just prose</p>')))
    expect(err).toBeTruthy()
    expect(err.name).toBe('ConversionError')
    expect(err.code).toBe('no-tables')
  })

  it('an empty layout <table> does not push a real table onto the .table-N path', async () => {
    const html = '<table></table>' + T(tr('<td>a</td>'))
    const parts = textParts(await writeCsv(doc(html)))
    expect(parts).toHaveLength(1)
    expect(parts[0].suffix).toBe('')
    expect(parts[0].text.trim()).toBe('a')
  })

  it('a document whose only <table> is empty has no tables to extract', async () => {
    const err = await grab(() => writeCsv(doc('<p>text</p><table></table>')))
    expect(err, 'expected no-tables rather than a zero-byte csv').toBeTruthy()
    expect(err?.code).toBe('no-tables')
  })

  it('never writes a zero-byte csv part', async () => {
    const html = '<table></table>' + T(tr('<td>a</td>')) + '<table><tbody></tbody></table>'
    const res = await writeCsv(doc(html))
    for (const p of res.parts) expect(p.bytes.length).toBeGreaterThan(0)
  })

  it('a nested table does not concatenate the inner cells into the outer cell', async () => {
    const inner = T(tr('<td>i1</td><td>i2</td>'))
    const parts = textParts(await writeCsv(doc(T(tr(`<td>${inner}</td>`)))))
    for (const p of parts) expect(p.text).not.toContain('i1i2')
  })

  it('emits no UTF-8 BOM', async () => {
    const res = await writeCsv(doc(T(tr('<td>abc</td>'))))
    expect(res.parts[0].bytes.subarray(0, 3).toString('hex')).not.toBe('efbbbf')
  })
})

describe('writeCsv — RFC 4180 quoting', () => {
  it('quotes a field containing a comma', async () => {
    const parts = textParts(await writeCsv(doc(T(tr('<td>a,b</td><td>c</td>')))))
    expect(parts[0].text.trim()).toBe('"a,b",c')
  })

  it('doubles embedded quotes and wraps the field', async () => {
    const parts = textParts(await writeCsv(doc(T(tr('<td>He said "hi"</td>')))))
    expect(parts[0].text.trim()).toBe('"He said ""hi"""')
  })

  it('a field that is exactly one double quote becomes """"', async () => {
    const parts = textParts(await writeCsv(doc(T(tr('<td>"</td>')))))
    expect(parts[0].text.trim()).toBe('""""')
  })

  it('does not silently mutate a leading "=" (no formula mangling either way)', async () => {
    const parts = textParts(await writeCsv(doc(T(tr('<td>=1+1</td>')))))
    const grid = parseCsv(parts[0].text)
    expect(grid[0][0]).toBe('=1+1')
  })

  it('a cell with comma AND quote AND newline round-trips through an RFC 4180 parser', async () => {
    const nasty = 'x,y "q"\nsecond'
    const html = T(tr(`<td>${nasty}</td><td>plain</td>`) + tr('<td>1</td><td>2</td>'))
    const grid = extractTables(html)[0]
    const parts = textParts(await writeCsv(doc(html)))
    expect(parseCsv(parts[0].text)).toEqual(grid)
  })

  it('empty trailing fields survive the round trip', async () => {
    const html = T(tr('<td colspan="3">only</td>') + tr('<td>a</td><td>b</td><td>c</td>'))
    const grid = extractTables(html)[0]
    const parts = textParts(await writeCsv(doc(html)))
    expect(parseCsv(parts[0].text)).toEqual(grid)
  })

  it('unicode and nbsp cells round-trip through an RFC 4180 parser', async () => {
    const html = T(tr('<td>café</td><td>a&nbsp;b</td><td>中文,x</td>'))
    const grid = extractTables(html)[0]
    const parts = textParts(await writeCsv(doc(html)))
    expect(parseCsv(parts[0].text)).toEqual(grid)
  })
})

// ================================================================
// writeJson (§F22)
// ================================================================

describe('writeJson', () => {
  it('single table → one part with suffix ""', async () => {
    const res = await writeJson(doc(T(tr('<th>A</th>') + tr('<td>1</td>'))))
    expect(res.parts).toHaveLength(1)
    expect(res.parts[0].suffix).toBe('')
  })

  it('two tables → ".table-1"/".table-2"', async () => {
    const html = T(tr('<td>a</td>')) + T(tr('<td>b</td>'))
    const res = await writeJson(doc(html))
    expect(res.parts.map((p) => p.suffix)).toEqual(['.table-1', '.table-2'])
  })

  it('no tables → ConversionError "no-tables"', async () => {
    const err = await grab(() => writeJson(doc('<p>nope</p>')))
    expect(err?.code).toBe('no-tables')
  })

  it('a document whose only <table> is empty → "no-tables", not an empty array file', async () => {
    const err = await grab(() => writeJson(doc('<p>text</p><table></table>')))
    expect(err?.code).toBe('no-tables')
  })

  it('emits parseable JSON', async () => {
    const res = await writeJson(doc(T(tr('<th>A</th>') + tr('<td>1</td>'))))
    expect(() => JSON.parse(res.parts[0].bytes.toString('utf8'))).not.toThrow()
  })

  it('header-looking first row → header-keyed row objects', async () => {
    const html = T(tr('<th>Name</th><th>Age</th>') + tr('<td>Ada</td><td>36</td>'))
    const parsed = JSON.parse((await writeJson(doc(html))).parts[0].bytes.toString('utf8'))
    expect(parsed).toEqual([{ Name: 'Ada', Age: 36 }])
  })

  it('non-header first row → arrays of cells', async () => {
    const html = T(tr('<td>1</td><td>2</td>') + tr('<td>3</td><td>4</td>'))
    const parsed = JSON.parse((await writeJson(doc(html))).parts[0].bytes.toString('utf8'))
    expect(parsed).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('numeric cells become numbers, but only when the text round-trips', async () => {
    // RULING (superseded): typing everything as a string forced every
    // consumer to re-parse. Values are typed now, EXCEPT where the string
    // form carries meaning a number would destroy.
    const html = T(tr('<th>Qty</th><th>Code</th><th>Price</th>') + tr('<td>3</td><td>0302</td><td>1.50</td>'))
    const parsed = JSON.parse((await writeJson(doc(html))).parts[0].bytes.toString('utf8'))
    expect(parsed[0].Qty).toBe(3)
    expect(parsed[0].Code).toBe('0302')
    expect(parsed[0].Price).toBe('1.50')
  })

  // D4. A header row that names two columns the same thing cannot be keyed:
  // the second value would overwrite the first and a whole column would leave
  // the file with nothing said about it. The table degrades to arrays instead,
  // header row included, so every cell survives and the degradation is visible.
  //
  // The fixture has to be one the writer actually reads as header-led — a
  // header of words over a body of words is NOT (looksLikeHeader wants a
  // numeric somewhere in the body), and such a table degrades to arrays for a
  // reason that has nothing to do with duplicate names.
  it('duplicate header names degrade the table to arrays instead of losing a column', async () => {
    const html = T(tr('<th>Q1</th><th>Q1</th>') + tr('<td>10</td><td>20</td>'))
    const parsed = JSON.parse((await writeJson(doc(html))).parts[0].bytes.toString('utf8'))
    expect(parsed).toEqual([
      ['Q1', 'Q1'],
      [10, 20],
    ])
  })

  it('a header/body pair with NO duplicate name still gets objects (the degradation is not blanket)', async () => {
    const html = T(tr('<th>Q1</th><th>Q2</th>') + tr('<td>10</td><td>20</td>'))
    const parsed = JSON.parse((await writeJson(doc(html))).parts[0].bytes.toString('utf8'))
    expect(parsed).toEqual([{ Q1: 10, Q2: 20 }])
  })

  it('only the offending table degrades; a clean sibling in the same document keeps objects', async () => {
    const dirty = T(tr('<th>Notes</th><th>Notes</th>') + tr('<td>1</td><td>2</td>'))
    const clean = T(tr('<th>A</th><th>B</th>') + tr('<td>3</td><td>4</td>'))
    const parts = (await writeJson(doc(dirty + clean))).parts
    expect(JSON.parse(parts[0].bytes.toString('utf8'))).toEqual([
      ['Notes', 'Notes'],
      [1, 2],
    ])
    expect(JSON.parse(parts[1].bytes.toString('utf8'))).toEqual([{ A: 3, B: 4 }])
  })

  it('a blank header cell colliding with a positional name degrades too, rather than losing a column', async () => {
    // The blank second column is named "column2" — the same name the first
    // column was literally given. Keying it would drop one of the two.
    const html = T(tr('<th>column2</th><th></th>') + tr('<td>x</td><td>9</td>'))
    const parsed = JSON.parse((await writeJson(doc(html))).parts[0].bytes.toString('utf8'))
    expect(parsed).toEqual([
      ['column2', ''],
      ['x', 9],
    ])
  })

  it('an empty header cell does not lose its column of data', async () => {
    const html = T(tr('<th>Name</th><th></th>') + tr('<td>Ada</td><td>1</td>'))
    const parsed = JSON.parse((await writeJson(doc(html))).parts[0].bytes.toString('utf8'))
    // Not a duplicate: the blank column gets its positional name and is keyed.
    expect(parsed).toEqual([{ Name: 'Ada', column2: 1 }])
  })

  it('a body row with MORE cells than the header keeps the extra value', async () => {
    const html = T(tr('<th>A</th><th>B</th>') + tr('<td>1</td><td>2</td><td>EXTRA</td>'))
    const text = (await writeJson(doc(html))).parts[0].bytes.toString('utf8')
    expect(text).toContain('EXTRA')
  })

  it('a body row with FEWER cells than the header still emits every key', async () => {
    const html = T(tr('<th>A</th><th>B</th><th>C</th>') + tr('<td>1</td><td>2</td>'))
    const parsed = JSON.parse((await writeJson(doc(html))).parts[0].bytes.toString('utf8'))
    expect(Object.keys(parsed[0]).sort()).toEqual(['A', 'B', 'C'])
  })

  it('does not treat a header-only table as zero rows of data', async () => {
    const html = T(tr('<th>A</th><th>B</th>'))
    const parsed = JSON.parse((await writeJson(doc(html))).parts[0].bytes.toString('utf8'))
    expect(Array.isArray(parsed)).toBe(true)
    expect(JSON.stringify(parsed)).toContain('A')
  })
})

// ================================================================
// writeXlsx (§F22) — ONE workbook, one sheet per table
// ================================================================

describe('writeXlsx', () => {
  it('three tables → ONE part, three sheets', async () => {
    const html = [1, 2, 3].map((n) => T(tr(`<td>t${n}</td>`))).join('')
    const res = await writeXlsx(doc(html))
    expect(res.parts).toHaveLength(1)
    expect(res.parts[0].suffix).toBe('')
    const wb = XLSX.read(res.parts[0].bytes, { type: 'buffer' })
    expect(wb.SheetNames).toHaveLength(3)
  })

  it('sheet contents match the extracted grid, in order', async () => {
    const html =
      T(tr('<th>A</th><th>B</th>') + tr('<td>1</td><td>2</td>')) + T(tr('<td>zz</td>'))
    const res = await writeXlsx(doc(html))
    const wb = XLSX.read(res.parts[0].bytes, { type: 'buffer' })
    const s1 = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
      header: 1,
      raw: false,
      defval: '',
    })
    expect(s1).toEqual([
      ['A', 'B'],
      ['1', '2'],
    ])
    const s2 = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[1]], {
      header: 1,
      raw: false,
      defval: '',
    })
    expect(s2).toEqual([['zz']])
  })

  it('sheet names are unique and legal for the xlsx format', async () => {
    const html = [1, 2, 3, 4].map((n) => T(tr(`<td>t${n}</td>`))).join('')
    const wb = XLSX.read((await writeXlsx(doc(html))).parts[0].bytes, { type: 'buffer' })
    expect(new Set(wb.SheetNames).size).toBe(wb.SheetNames.length)
    for (const n of wb.SheetNames) {
      expect(n.length).toBeGreaterThan(0)
      expect(n.length).toBeLessThanOrEqual(31)
      expect(n).not.toMatch(/[:\\/?*\[\]]/)
    }
  })

  it('a cell starting with "=" is written as text, not a formula', async () => {
    const res = await writeXlsx(doc(T(tr('<td>=1+1</td>'))))
    const wb = XLSX.read(res.parts[0].bytes, { type: 'buffer' })
    const cell: any = wb.Sheets[wb.SheetNames[0]]['A1']
    expect(cell.f).toBeUndefined()
    expect(cell.t).toBe('s')
    expect(cell.v).toBe('=1+1')
  })

  it('no tables → ConversionError "no-tables"', async () => {
    const err = await grab(() => writeXlsx(doc('<p>nope</p>')))
    expect(err?.code).toBe('no-tables')
  })

  it('a document whose only <table> is empty → "no-tables"', async () => {
    const err = await grab(() => writeXlsx(doc('<p>text</p><table></table>')))
    expect(err?.code).toBe('no-tables')
  })

  it('does not emit a sheet for an empty <table></table>', async () => {
    const html = '<table></table>' + T(tr('<td>real</td>'))
    const wb = XLSX.read((await writeXlsx(doc(html))).parts[0].bytes, { type: 'buffer' })
    expect(wb.SheetNames).toHaveLength(1)
  })
})

// ================================================================
// writeMarkdown — GFM pipe tables
// ================================================================

describe('writeMarkdown — tables', () => {
  it('emits a GFM pipe table, not raw HTML', async () => {
    const html = T(tr('<th>A</th><th>B</th>') + tr('<td>1</td><td>2</td>'))
    const md = (await writeMarkdown(doc(html))).toString('utf8')
    expect(md).not.toMatch(/<table/i)
    const lines = tableLines(md)
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(isDelimiterRow(lines[1])).toBe(true)
  })

  it('a cell containing "|" does not break the pipe table', async () => {
    const html = T(tr('<th>A</th><th>B</th>') + tr('<td>a|b</td><td>c</td>'))
    const md = (await writeMarkdown(doc(html))).toString('utf8')
    const dataRow = tableLines(md).filter((l) => !isDelimiterRow(l)).pop()!
    expect(pipeCells(dataRow)).toEqual(['a|b', 'c'])
  })

  it('a headerless table uses its first row as the GFM header', async () => {
    // RULING (superseded): a synthesized EMPTY header was worse than using the
    // real first row — every all-text table (no numeric body, so the header
    // heuristic never fired) rendered as "|  |  |" with its header demoted.
    const html = T(tr('<td>a</td><td>b</td>') + tr('<td>c</td><td>d</td>'))
    const md = (await writeMarkdown(doc(html))).toString('utf8')
    expect(md).not.toMatch(/<table|<tr|<td/i)
    const lines = tableLines(md)
    expect(lines.length).toBe(3) // header + delimiter + 1 data row
    expect(isDelimiterRow(lines[1])).toBe(true)
    expect(pipeCells(lines[0])).toEqual(['a', 'b'])
    expect(pipeCells(lines[2])).toEqual(['c', 'd'])
  })

  it('block elements inside a cell are flattened onto one line', async () => {
    const html = T(tr('<td><p>one</p><p>two</p></td><td>x</td>'))
    const md = (await writeMarkdown(doc(html))).toString('utf8')
    const lines = tableLines(md)
    const dataRow = lines.filter((l) => !isDelimiterRow(l)).find((l) => l.includes('one'))
    expect(dataRow, 'a single table row should carry both paragraphs').toBeTruthy()
    expect(dataRow!).toContain('two')
    expect(pipeCells(dataRow!)).toHaveLength(2)
    // flattened, but the two paragraphs must not run together (cf. the round-2
    // "FromAlice"/"Widget3" defect recorded for txt output)
    expect(dataRow!).not.toContain('onetwo')
  })

  it('a list inside a cell does not break the table', async () => {
    const html = T(tr('<td><ul><li>a</li><li>b</li></ul></td><td>x</td>'))
    const md = (await writeMarkdown(doc(html))).toString('utf8')
    expect(md).not.toMatch(/<table|<li>/i)
    const lines = tableLines(md)
    const counts = new Set(lines.map((l) => pipeCells(l).length))
    expect(counts.size, `ragged pipe table: ${JSON.stringify(lines)}`).toBe(1)
    const dataRow = lines.filter((l) => !isDelimiterRow(l)).pop()!
    expect(pipeCells(dataRow)[0], 'list items must not run together').not.toBe('ab')
  })

  it('every row of a headerless ragged table has the same column count', async () => {
    const html = T(tr('<td>a</td><td>b</td><td>c</td>') + tr('<td>d</td>'))
    const md = (await writeMarkdown(doc(html))).toString('utf8')
    const counts = new Set(tableLines(md).map((l) => pipeCells(l).length))
    expect(counts.size).toBe(1)
  })

  it('flattens inline formatting inside a cell to its text (accepted loss)', async () => {
    // RULING (2026-08-31): tables are rebuilt from the extracted text grid so
    // that spans, ragged rows, block content and pipes cannot corrupt a GFM
    // table. Inline emphasis and links inside cells are lost as a consequence.
    // Structural correctness beats cell-level styling for a content-focused
    // converter; recorded in the round-3 spec addendum.
    const html = T(
      tr('<th>A</th><th>B</th>') +
        tr('<td><strong>bold</strong></td><td><a href="http://x/">L</a></td>'),
    )
    const md = (await writeMarkdown(doc(html))).toString('utf8')
    expect(md).toContain('| bold | L |')
    expect(md).not.toContain('<td>')
  })

  it('colspan/rowspan tables still produce a rectangular pipe table', async () => {
    const html = T(
      tr('<th colspan="2">wide</th>') + tr('<td>a</td><td>b</td>'),
    )
    const md = (await writeMarkdown(doc(html))).toString('utf8')
    const counts = new Set(tableLines(md).map((l) => pipeCells(l).length))
    expect(counts.size, `lines: ${JSON.stringify(tableLines(md))}`).toBe(1)
  })
})

// ================================================================
// writeTxt — table cells must not run together (§F22 "fix found")
// ================================================================

describe('writeTxt — tables', () => {
  it('does not concatenate adjacent cells', async () => {
    const html = T(tr('<td>From</td><td>Alice</td>'))
    const txt = (await writeTxt(doc(html))).toString('utf8')
    expect(txt).not.toContain('FromAlice')
    expect(txt).toMatch(/From\s+Alice/)
  })

  it('does not concatenate a label with a number', async () => {
    const html = T(tr('<th>Item</th><th>Qty</th>') + tr('<td>Widget</td><td>3</td>'))
    const txt = (await writeTxt(doc(html))).toString('utf8')
    expect(txt).not.toContain('Widget3')
    expect(txt).not.toContain('ItemQty')
  })

  it('does not concatenate cells of a headerless table', async () => {
    const html = T(tr('<td>alpha</td><td>beta</td>') + tr('<td>gamma</td><td>delta</td>'))
    const txt = (await writeTxt(doc(html))).toString('utf8')
    expect(txt).not.toMatch(/alphabeta|gammadelta/)
  })

  it('does not concatenate cells of a nested table', async () => {
    const inner = T(tr('<td>in1</td><td>in2</td>'))
    const txt = (await writeTxt(doc(T(tr(`<td>${inner}</td><td>out</td>`))))).toString('utf8')
    expect(txt).not.toContain('in1in2')
  })
})

// ================================================================
// mergeHubDocuments (§F8)
// ================================================================

const pageBreaks = (html: string) => (html.match(/page-break-after/gi) ?? []).length

describe('mergeHubDocuments', () => {
  it('empty list → ConversionError "merge-empty"', () => {
    let err: any = null
    try {
      mergeHubDocuments([], { headings: true })
    } catch (e) {
      err = e
    }
    expect(err).toBeTruthy()
    expect(err.name).toBe('ConversionError')
    expect(err.code).toBe('merge-empty')
  })

  it('concatenates fragments in list order', () => {
    const out = mergeHubDocuments(
      [doc('<p>one</p>', { sourceName: 'a' }), doc('<p>two</p>', { sourceName: 'b' })],
      { headings: false },
    )
    expect(out.html.indexOf('one')).toBeLessThan(out.html.indexOf('two'))
    expect(out.html).toContain('<p>one</p>')
    expect(out.html).toContain('<p>two</p>')
  })

  it('a single document gets NO page break (break is BETWEEN fragments)', () => {
    const out = mergeHubDocuments([doc('<p>only</p>', { sourceName: 'a' })], { headings: true })
    expect(pageBreaks(out.html)).toBe(0)
  })

  it('two documents get exactly one page break, and none trailing', () => {
    const out = mergeHubDocuments(
      [doc('<p>one</p>', { sourceName: 'a' }), doc('<p>two</p>', { sourceName: 'b' })],
      { headings: false },
    )
    expect(pageBreaks(out.html)).toBe(1)
    expect(out.html.trimEnd()).not.toMatch(/page-break-after[^>]*>\s*(<\/div>)?\s*$/i)
  })

  it('N documents get N-1 page breaks (N = 50)', () => {
    const docs = Array.from({ length: 50 }, (_, i) => doc(`<p>d${i}</p>`, { sourceName: `f${i}` }))
    const out = mergeHubDocuments(docs, { headings: true })
    expect(pageBreaks(out.html)).toBe(49)
  })

  it('headings:true emits <h1 class="doc-title"> per fragment', () => {
    const out = mergeHubDocuments(
      [doc('<p>one</p>', { sourceName: 'a.md' }), doc('<p>two</p>', { sourceName: 'b.md' })],
      { headings: true },
    )
    expect((out.html.match(/<h1 class="doc-title">/g) ?? []).length).toBe(2)
    expect(out.html).toContain('a.md')
    expect(out.html).toContain('b.md')
  })

  it('headings:false emits no doc-title headings', () => {
    const out = mergeHubDocuments(
      [doc('<p>one</p>', { sourceName: 'a.md' }), doc('<p>two</p>', { sourceName: 'b.md' })],
      { headings: false },
    )
    expect(out.html).not.toContain('doc-title')
  })

  it('an undefined sourceName never renders the string "undefined"', () => {
    const out = mergeHubDocuments([doc('<p>one</p>'), doc('<p>two</p>')], { headings: true })
    expect(out.html).not.toContain('undefined')
  })

  it('HTML characters in sourceName are escaped, not injected', () => {
    const evil = 'a<script>alert(1)</script>&"b'
    const out = mergeHubDocuments(
      [doc('<p>one</p>', { sourceName: evil }), doc('<p>two</p>', { sourceName: 'ok' })],
      { headings: true },
    )
    expect(out.html).not.toContain('<script>')
    expect(out.html).toContain('&lt;script&gt;')
  })

  it('title and sourceName come from the first document', () => {
    const out = mergeHubDocuments(
      [
        doc('<p>one</p>', { title: 'First Title', sourceName: 'first.md' }),
        doc('<p>two</p>', { title: 'Second Title', sourceName: 'second.md' }),
      ],
      { headings: false },
    )
    expect(out.title).toBe('First Title')
    expect(out.sourceName).toBe('first.md')
  })

  it('fragment bodies are preserved verbatim (no re-sanitizing surprises)', () => {
    const frag = '<table><tr><td>keep</td></tr></table><pre><code>x = 1</code></pre>'
    const out = mergeHubDocuments([doc(frag), doc('<p>b</p>')], { headings: false })
    expect(out.html).toContain(frag)
  })
})

// ================================================================
// mergePdfs (§F8)
// ================================================================

describe('mergePdfs', () => {
  it('empty list → ConversionError "merge-empty"', async () => {
    const err = await grab(() => mergePdfs([]))
    expect(err).toBeTruthy()
    expect(err.name).toBe('ConversionError')
    expect(err.code).toBe('merge-empty')
  })

  it('page counts add up and page order/sizes are preserved verbatim', async () => {
    const a = await makePdf([
      [200, 400],
      [200, 400],
    ])
    const b = await makePdf([
      [300, 500],
      [300, 500],
      [300, 500],
    ])
    const merged = await mergePdfs([
      { bytes: a, name: 'a.pdf' },
      { bytes: b, name: 'b.pdf' },
    ])
    const out = await PDFDocument.load(merged)
    expect(out.getPageCount()).toBe(5)
    const sizes = out.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())])
    expect(sizes).toEqual([
      [200, 400],
      [200, 400],
      [300, 500],
      [300, 500],
      [300, 500],
    ])
  })

  it('a single input keeps its page count', async () => {
    const a = await makePdf([[100, 100]])
    const out = await PDFDocument.load(await mergePdfs([{ bytes: a, name: 'a.pdf' }]))
    expect(out.getPageCount()).toBe(1)
  })

  it('an invalid input names the offending file', async () => {
    const a = await makePdf([[100, 100]])
    const err = await grab(() =>
      mergePdfs([
        { bytes: a, name: 'good.pdf' },
        { bytes: Buffer.from('this is not a pdf'), name: 'broken.pdf' },
      ]),
    )
    expect(err).toBeTruthy()
    expect(String(err.message)).toContain('broken.pdf')
  })

  it('a nameless invalid input still fails cleanly', async () => {
    const err = await grab(() => mergePdfs([{ bytes: Buffer.from('nope') }]))
    expect(err).toBeTruthy()
    expect(String(err.message)).not.toContain('undefined')
  })

  it('page count is exactly the sum of the inputs own page counts', async () => {
    const a = await makePdf([[100, 100]])
    const b = await makePdf([
      [120, 130],
      [140, 150],
      [160, 170],
    ])
    const expected =
      (await PDFDocument.load(a)).getPageCount() + (await PDFDocument.load(b)).getPageCount()
    const out = await PDFDocument.load(
      await mergePdfs([
        { bytes: a, name: 'a.pdf' },
        { bytes: b, name: 'b.pdf' },
      ]),
    )
    expect(out.getPageCount()).toBe(expected)
  })
})

// ================================================================
// normalizePdfOptions (§F10, §2.3)
// ================================================================

describe('normalizePdfOptions', () => {
  it('empty object → documented defaults', () => {
    expect(normalizePdfOptions({})).toEqual({
      scale: 1,
      pageSize: 'Letter',
      landscape: false,
      headerFooter: false,
    })
  })

  it.each([null, undefined, 'nope', 42, [], true])('non-object input %p → defaults', (raw) => {
    const o = normalizePdfOptions(raw as unknown)
    expect(o.scale).toBe(1)
    expect(o.pageSize).toBe('Letter')
    expect(o.landscape).toBe(false)
    expect(o.headerFooter).toBe(false)
  })

  it('scale is clamped to the 0.1–2.0 window', () => {
    expect(normalizePdfOptions({ scale: 0.05 }).scale).toBe(0.1)
    expect(normalizePdfOptions({ scale: 5 }).scale).toBe(2)
    expect(normalizePdfOptions({ scale: -1 }).scale).toBe(0.1)
  })

  it('the exact boundary values pass through untouched', () => {
    expect(normalizePdfOptions({ scale: 0.1 }).scale).toBe(0.1)
    expect(normalizePdfOptions({ scale: 2.0 }).scale).toBe(2)
  })

  it.each([['abc'], [NaN], [null], [undefined], [{}], [[]], [true]])(
    'non-numeric scale %p → 1',
    (v) => {
      expect(normalizePdfOptions({ scale: v }).scale).toBe(1)
    },
  )

  it('a numeric STRING scale is non-numeric → 1', () => {
    expect(normalizePdfOptions({ scale: '1.5' }).scale).toBe(1)
  })

  it('treats a non-finite scale as absent rather than clamping it', () => {
    // RULING: Infinity/NaN signal a broken caller, not an intent to zoom to
    // the limit, so they fall back to the 1.0 default.
    expect(normalizePdfOptions({ scale: Infinity }).scale).toBe(1)
    expect(normalizePdfOptions({ scale: -Infinity }).scale).toBe(1)
  })

  it.each(['Letter', 'A4', 'Legal', 'A3', 'Tabloid'])('whitelisted pageSize %s passes', (p) => {
    expect(normalizePdfOptions({ pageSize: p }).pageSize).toBe(p)
  })

  it.each(['a4', 'LETTER', 'A5', '', 'Letter ', 4, null, {}])(
    'non-whitelisted pageSize %p → Letter',
    (p) => {
      expect(normalizePdfOptions({ pageSize: p }).pageSize).toBe('Letter')
    },
  )

  it('landscape is a strict boolean', () => {
    expect(normalizePdfOptions({ landscape: true }).landscape).toBe(true)
    expect(normalizePdfOptions({ landscape: false }).landscape).toBe(false)
    expect(normalizePdfOptions({ landscape: 'true' }).landscape).toBe(false)
    expect(normalizePdfOptions({ landscape: 1 }).landscape).toBe(false)
    expect(normalizePdfOptions({ landscape: 'false' }).landscape).toBe(false)
  })

  it('headerFooter is a strict boolean, default false', () => {
    expect(normalizePdfOptions({ headerFooter: true }).headerFooter).toBe(true)
    expect(normalizePdfOptions({ headerFooter: 'yes' }).headerFooter).toBe(false)
    expect(normalizePdfOptions({ headerFooter: 1 }).headerFooter).toBe(false)
  })

  it('headerText is NEVER accepted from the caller (derived, §F10)', () => {
    const o: any = normalizePdfOptions({ headerText: 'attacker <b>text</b>', headerFooter: true })
    expect(o.headerText).toBeUndefined()
  })

  it('unknown keys are not carried through', () => {
    const o: any = normalizePdfOptions({ scale: 1, evil: 'x', __proto__mock: 1 })
    expect(Object.keys(o).sort()).toEqual(['headerFooter', 'landscape', 'pageSize', 'scale'])
  })

  it('a __proto__ payload does not pollute Object.prototype', () => {
    const raw = JSON.parse('{"__proto__":{"polluted":"yes"},"scale":1.5}')
    const o = normalizePdfOptions(raw)
    expect(({} as any).polluted).toBeUndefined()
    expect((o as any).polluted).toBeUndefined()
    expect(o.scale).toBe(1.5)
  })

  it('the returned object is a fresh object, not the caller input', () => {
    const raw: any = { scale: 1.5, pageSize: 'A4', landscape: true, headerFooter: true }
    const o = normalizePdfOptions(raw)
    expect(o).not.toBe(raw)
  })
})

// ================================================================
// uniqueName
// ================================================================

describe('uniqueName', () => {
  it('no collision → base + ext', () => {
    expect(uniqueName('report', '.txt', () => false)).toBe('report.txt')
  })

  it('first collision → base-1.ext', () => {
    const taken = new Set(['report.txt'])
    expect(uniqueName('report', '.txt', (n) => taken.has(n))).toBe('report-1.txt')
  })

  it('three taken → base-3.ext', () => {
    const taken = new Set(['report.txt', 'report-1.txt', 'report-2.txt'])
    expect(uniqueName('report', '.txt', (n) => taken.has(n))).toBe('report-3.txt')
  })

  it('exists() true for the first five candidates → base-5.ext', () => {
    let calls = 0
    expect(
      uniqueName('report', '.txt', () => {
        calls += 1
        return calls <= 5
      }),
    ).toBe('report-5.txt')
  })

  it('the suffix goes BEFORE the extension for a dotted base', () => {
    const taken = new Set(['my.file.v2.txt'])
    expect(uniqueName('my.file.v2', '.txt', (n) => taken.has(n))).toBe('my.file.v2-1.txt')
  })

  it('an empty base still produces a name ending in the extension', () => {
    const out = uniqueName('', '.txt', () => false)
    expect(out.endsWith('.txt')).toBe(true)
  })

  it('always returns a name exists() reported as free', () => {
    const taken = new Set(['a.csv', 'a-1.csv', 'a-2.csv', 'a-3.csv'])
    const out = uniqueName('a', '.csv', (n) => taken.has(n))
    expect(taken.has(out)).toBe(false)
  })

  it('terminates against a hostile exists() (200 collisions)', () => {
    let calls = 0
    const out = uniqueName('x', '.pdf', () => {
      calls += 1
      return calls <= 200
    })
    expect(out).toBe('x-200.pdf')
  })
})

// ================================================================
// target-validity (§F0, §F22)
// ================================================================

const sorted = (a: string[]) => [...a].sort()

describe('allowedTargets / allowedMergeTargets', () => {
  it('a plain text input allows every target', () => {
    expect(sorted(allowedTargets([{ format: 'txt' }]))).toEqual(
      sorted(['txt', 'md', 'docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4', 'csv', 'json', 'xlsx']),
    )
  })

  it('image Embed → only docx/pdf/html', () => {
    expect(sorted(allowedTargets([{ format: 'image', imageMode: 'embed' }]))).toEqual(
      sorted(['docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4']),
    )
  })

  it('image with no explicit mode defaults to Embed restrictions', () => {
    expect(sorted(allowedTargets([{ format: 'image' }]))).toEqual(sorted(['docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4']))
  })

  // Supersedes "image OCR → text targets but never csv/json/xlsx". That rule
  // existed only because OCR output was always paragraphs; now that the OCR
  // pipeline reconstructs tables from word boxes, a scanned form must be able
  // to reach a spreadsheet. See src/core/target-validity.ts.
  it('image OCR → every target, table targets included', () => {
    const t = allowedTargets([{ format: 'image', imageMode: 'ocr' }])
    expect(sorted(t)).toEqual(sorted(['txt', 'md', 'docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4', 'csv', 'json', 'xlsx']))
    for (const table of ['csv', 'json', 'xlsx']) expect(t).toContain(table)
  })

  it('validity is the intersection across inputs', () => {
    expect(sorted(allowedTargets([{ format: 'txt' }, { format: 'image', imageMode: 'embed' }]))).toEqual(
      sorted(['docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4']),
    )
    expect(
      sorted(
        allowedTargets([
          { format: 'image', imageMode: 'ocr' },
          { format: 'image', imageMode: 'embed' },
        ]),
      ),
    ).toEqual(sorted(['docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4']))
  })

  it('with no inputs loaded nothing is convertible', () => {
    expect(allowedTargets([])).toEqual([])
  })

  it('results are ordered like TARGET_FORMATS (stable chip order)', () => {
    expect(allowedTargets([{ format: 'txt' }])).toEqual([
      'txt',
      'md',
      'docx',
      'pdf',
      'html',
      'epub',
      'revealjs',
      'azw3',
      'azw4',
      'csv',
      'json',
      'xlsx',
    ])
  })

  it('merge excludes ALL table targets', () => {
    const t = allowedMergeTargets([{ format: 'txt' }, { format: 'docx' }])
    expect(sorted(t)).toEqual(sorted(['txt', 'md', 'docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4']))
  })

  it('merge with an embedded image → docx/pdf/html only', () => {
    expect(sorted(allowedMergeTargets([{ format: 'txt' }, { format: 'image', imageMode: 'embed' }]))).toEqual(
      sorted(['docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4']),
    )
  })

  it('merge with no inputs is empty', () => {
    expect(allowedMergeTargets([])).toEqual([])
  })

  it('offers table targets for any source and errors at conversion instead', () => {
    // RULING: §F0 and §6.3 contradicted each other. §6.3 wins — whether a
    // document HAS tables is not knowable from its format, so csv/json/xlsx
    // stay selectable and a table-free document fails with 'no-tables'.
    expect(allowedTargets([{ format: 'txt' }])).toContain('csv')
    expect(allowedTargets([{ format: 'txt' }])).toContain('json')
  })
})
