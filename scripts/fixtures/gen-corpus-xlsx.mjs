// Generates catalogue-codes.xlsx and form-with-merged-cells.xls for
// tests/corpus/. Run with: node scripts/fixtures/gen-corpus-xlsx.mjs
//
// All content is invented — generic component descriptions and a generic
// form layout, no real catalogue codes, customers or reference numbers.
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'
import * as V from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus')

/* -------------------------------------------------------------------------- */
/* catalogue-codes.xlsx — reader-xlsx.test.ts, pdf-table-recall.test.ts       */
/*                                                                            */
/* reader-xlsx.test.ts needs exactly 410 rows (1 header + 409 data), all 3    */
/* columns wide, no blank cells anywhere (so trimTrailingEmpty is a no-op).   */
/*                                                                            */
/* pdf-table-recall.test.ts prints this same data onto a synthetic PDF at    */
/* 9pt in a 140pt description column and measures how many of the 409 rows a  */
/* table-recovery pass can still find. That means the DESCRIPTION column's    */
/* length distribution is itself part of the fixture: too short and nothing   */
/* wraps (the test would stop exercising the wrap-and-rejoin path this        */
/* reader exists for); too long throughout and recall could legitimately      */
/* fall under the test's floor. The generator below mixes short (~15-30 char) */
/* and long (~55-100 char) descriptions, deterministically, and was tuned by  */
/* running the actual recall test against the output (see the report).       */
/* -------------------------------------------------------------------------- */
{
  // Deterministic PRNG (mulberry32) so the fixture is reproducible byte-for-byte.
  function mulberry32(seed) {
    let a = seed
    return function () {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const rand = mulberry32(20260907)
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]

  const materials = V.MATERIALS
  const items = V.ITEMS
  const specs = V.SPECS
  const sizes = V.SIZES
  const groups = V.GROUPS

  function description(long) {
    const parts = [pick(materials), pick(items), pick(sizes)]
    if (long) parts.push(pick(specs), pick(specs))
    else if (rand() > 0.5) parts.push(pick(specs))
    return parts.join(' ').slice(0, 100)
  }

  const rows = [V.CATALOGUE_HEADERS]
  for (let i = 1; i <= 409; i++) {
    const code = `C-${String(1000 + i)}`
    const long = rand() < 0.62 // ~62% of rows get a longer, wrap-prone description
    rows.push([code, description(long), pick(groups)])
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), V.CATALOGUE_SHEET)
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  await writeFile(join(OUT, 'catalogue-codes.xlsx'), bytes)
  console.log('catalogue-codes.xlsx: rows =', rows.length)
}

/* -------------------------------------------------------------------------- */
/* form-with-merged-cells.xls — reader-xlsx.test.ts                           */
/*                                                                            */
/* A legacy .xls whose used range starts at column B (Excel never touched A), */
/* with two section-header rows merged across B:C — the shape that used to    */
/* land one column to the right because merges are absolute while             */
/* sheet_to_json indexes from the used-range origin.                          */
/* -------------------------------------------------------------------------- */
{
  const ws = {}
  const set = (addr, v) => {
    ws[addr] = { t: typeof v === 'number' ? 'n' : 's', v }
  }
  // Column B is field labels, column C is values — a 2-column form.
  set('B1', V.FORM_XLS.header)
  set('C1', '')
  V.FORM_XLS.fields.forEach(([label, value], i) => {
    set(`B${i + 2}`, label)
    set(`C${i + 2}`, value)
  })
  set('B6', V.FORM_XLS.instructionsLabel)
  set('C6', '')
  V.FORM_XLS.instructions.forEach((line, i) => {
    set(`B${i + 7}`, line)
    set(`C${i + 7}`, '')
  })
  ws['!ref'] = 'B1:C8'
  ws['!merges'] = [
    { s: { r: 0, c: 1 }, e: { r: 0, c: 2 } }, // B1:C1 "Transmittal Data"
    { s: { r: 5, c: 1 }, e: { r: 5, c: 2 } }, // B6:C6 "Special Instructions:"
  ]

  const wb = { SheetNames: ['Form'], Sheets: { Form: ws } }
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xls' })
  await writeFile(join(OUT, 'form-with-merged-cells.xls'), bytes)
}

console.log('xlsx/xls corpus fixtures written to', OUT)
