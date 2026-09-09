import { describe, it, expect } from 'vitest'
import { readRtf, extractTables } from '../../src/core/readers/rtf'
import { tableGrid } from '../../src/core/table-grid'

/**
 * R1 (CRITICAL) — `\binN` declares N *raw* bytes that follow the control word.
 * A `{` or `}` inside that payload is data, not structure. Three brace walks in
 * this reader did not know that (`stripGroups`, `groupEnd`, `isBalanced`), so a
 * single `0x7B` byte inside an embedded object desynchronised the walk and it
 * swallowed the rest of the document — silently, with no error and no warning.
 * Word emits `\bin` routinely for embedded objects and pictures.
 *
 * R9 (MEDIUM) — `SYMBOL_WORDS` was a plain object literal, so a `\toString`
 * control word resolved to `Object.prototype.toString` and threw inside
 * `addText`. The throw was swallowed by the table pre-pass's catch, so every
 * table in the document silently degraded to prose.
 */

const doc = (body: string): Buffer =>
  Buffer.from(`{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}\n${body}\n}`, 'latin1')

const hub = async (body: string): Promise<string> => (await readRtf({ bytes: doc(body) })).html

const tableCount = (html: string): number => (html.match(/<table\b/g) ?? []).length

/* -------------------------------------------------------------------------- */
/* R1 — \bin payloads must not be scanned for braces                          */
/* -------------------------------------------------------------------------- */

describe('rtf \\bin: a brace inside a binary payload does not eat the document', () => {
  /** The control: the same document with a harmless byte where the `{` goes. */
  const withPayload = (payload: string): string =>
    String.raw`\pard One\par
{\*\objdata \bin5 ${payload}}
\pard Two\par
\pard Three\par`

  it('keeps every paragraph when the payload holds a plain byte (control)', async () => {
    const html = await hub(withPayload('ABXCD'))
    expect(html).toContain('One')
    expect(html).toContain('Two')
    expect(html).toContain('Three')
  })

  it('keeps every paragraph when the payload holds a { byte (stripGroups)', async () => {
    const html = await hub(withPayload('AB{CD'))
    expect(html).toContain('One')
    expect(html).toContain('Two')
    expect(html).toContain('Three')
  })

  it('keeps every paragraph when the payload holds a } byte (stripGroups)', async () => {
    const html = await hub(withPayload('A}BCD'))
    expect(html).toContain('One')
    expect(html).toContain('Two')
    expect(html).toContain('Three')
  })

  it('drops only the object group itself, not the prose around it', async () => {
    const html = await hub(withPayload('AB{CD'))
    expect(html).not.toContain('objdata')
    expect(html).not.toContain('AB')
  })

  it('survives a byte count that runs past the end of the input', async () => {
    const html = await hub(String.raw`\pard One\par
{\*\objdata \bin99999 AB}`)
    expect(html).toContain('One')
  })

  it('treats \\bin with no digits as declaring no payload', async () => {
    const html = await hub(String.raw`\pard One\par
{\*\objdata \bin }
\pard Two\par`)
    expect(html).toContain('One')
    expect(html).toContain('Two')
  })

  it('treats \\bin0 as declaring no payload', async () => {
    const html = await hub(String.raw`\pard One\par
{\*\objdata \bin0 XY}
\pard Two\par`)
    expect(html).toContain('One')
    expect(html).toContain('Two')
    expect(html).not.toContain('XY')
  })

  it('treats a negative byte count as declaring no payload', async () => {
    const html = await hub(String.raw`\pard One\par
{\*\objdata \bin-5 XY}
\pard Two\par`)
    expect(html).toContain('One')
    expect(html).toContain('Two')
  })

  it('does not mistake \\binary for \\bin', async () => {
    const html = await hub(String.raw`\pard One\par
{\*\objdata \binary5 AB}
\pard Two\par`)
    expect(html).toContain('One')
    expect(html).toContain('Two')
  })

  it('keeps reading groups that follow a \\bin group', async () => {
    // Two stripped destinations back to back, each with a brace in its payload:
    // the walk has to land exactly on the end of the first to find the second.
    const html = await hub(String.raw`\pard One\par
{\*\objdata \bin5 AB{CD}{\*\datastore \bin3 X{Y}
\pard Two \b bold\b0  tail\par`)
    expect(html).toContain('One')
    expect(html).toContain('Two')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('tail')
    expect(html).not.toContain('datastore')
    expect(html).not.toContain('CD')
  })

  it('honours \\bin inside a group nested in the stripped group', async () => {
    const html = await hub(String.raw`\pard One\par
{\*\objdata {\*\objclass \bin4 A{BC} tail}
\pard Two\par`)
    expect(html).toContain('One')
    expect(html).toContain('Two')
  })
})

describe('rtf \\bin: the table pre-pass keeps its bearings', () => {
  it('still finds the table when a skipped destination holds a { byte (groupEnd)', () => {
    const rtf = doc(String.raw`\pard Intro\par
\trowd\cellx3000\cellx6000\intbl A{\*\objdata \bin5 AB{CD}\cell B\cell\row
\pard Outro\par`).toString('latin1')
    const segmented = extractTables(rtf)
    expect(segmented.tables).toHaveLength(1)
    expect(segmented.tables[0]).toContain('<td>A</td>')
    expect(segmented.tables[0]).toContain('<td>B</td>')
  })

  it('still emits the table when a cell group holds a { byte (isBalanced)', async () => {
    const html = await hub(String.raw`\pard Intro\par
\trowd\cellx3000\cellx6000\intbl A{\bin5 AB{CD}\cell B\cell\row
\pard Outro\par`)
    expect(tableCount(html)).toBe(1)
    expect(tableGrid(html)).toEqual([[['A', 'B']]])
    expect(html).toContain('Intro')
    expect(html).toContain('Outro')
  })

  it('still emits the table when a cell group holds a } byte (isBalanced)', async () => {
    const html = await hub(String.raw`\pard Intro\par
\trowd\cellx3000\cellx6000\intbl A{\bin5 A}BCD}\cell B\cell\row
\pard Outro\par`)
    expect(tableCount(html)).toBe(1)
    expect(tableGrid(html)).toEqual([[['A', 'B']]])
  })
})

/* -------------------------------------------------------------------------- */
/* R9 — control words that collide with Object.prototype                       */
/* -------------------------------------------------------------------------- */

const TABLE_BODY = String.raw`\pard\trowd\cellx3000\cellx6000\intbl Alpha\cell Beta\cell\row
\trowd\cellx3000\cellx6000\intbl Gamma\cell Delta\cell\row`

describe('rtf: an Object.prototype control word does not disable table extraction', () => {
  it('extracts the table from the clean document (control)', async () => {
    const html = await hub(TABLE_BODY)
    expect(tableCount(html)).toBe(1)
    expect(tableGrid(html)).toEqual([
      [
        ['Alpha', 'Beta'],
        ['Gamma', 'Delta'],
      ],
    ])
    expect(html).not.toContain('Alpha | Beta')
  })

  for (const word of [
    'toString',
    'constructor',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
  ]) {
    it(`extracts the table with a \\${word} control word present`, async () => {
      const html = await hub(`\\pard\\${word} ` + TABLE_BODY)
      expect(tableCount(html)).toBe(1)
      expect(tableGrid(html)).toEqual([
        [
          ['Alpha', 'Beta'],
          ['Gamma', 'Delta'],
        ],
      ])
      expect(html).not.toContain('Alpha | Beta')
    })
  }

  it('emits nothing at all for an unknown control word', async () => {
    const html = await hub(String.raw`\pard Text \toString more\par`)
    expect(html).toContain('Text')
    expect(html).toContain('more')
    expect(html).not.toContain('function')
    expect(html).not.toContain('[object')
  })
})

/* -------------------------------------------------------------------------- */
/* \bin outside a stripped destination                                        */
/* -------------------------------------------------------------------------- */

describe('rtf \bin: a payload outside a picture group', () => {
  it('drops an embedded-font payload instead of handing it to the prose parser', async () => {
    // rtf-parser does not understand \bin. Left in, this payload's `{` reached
    // it and the whole document failed: "Cannot read properties of undefined".
    // Word writes fonts as hex, so this is rare — but a crash is a crash.
    const html = await hub(String.raw`\pard One\par
{\*\fontemb\ftruetype{\*\fontfile\bin5 AB{CD}}
\pard Two\par`)
    expect(html).toContain('One')
    expect(html).toContain('Two')
    expect(html).not.toContain('CD')
  })

  it('drops a bare \bin payload in prose, and nothing around it', async () => {
    // Not from any destination at all: the bytes must not print as text, and
    // the brace inside them must not desynchronise anything.
    const html = await hub(String.raw`\pard One \bin4 Q{ZW tail\par
\pard Two\par`)
    expect(html).toContain('One')
    expect(html).toContain('tail')
    expect(html).toContain('Two')
    expect(html).not.toContain('Q{ZW')
    expect(html).not.toContain('ZW')
  })
})

/* -------------------------------------------------------------------------- */
/* \itap depth is bounded                                                     */
/* -------------------------------------------------------------------------- */

describe('rtf \itap: an absurd nesting depth cannot exhaust memory', () => {
  it('reads a table whose \itap claims fifty million levels', async () => {
    // `ensureLevel` pushed one level object per claimed depth. Fifty million of
    // them was a fatal V8 heap OOM in the Electron main process — uncatchable,
    // so the pre-pass's own try/catch never saw it. Real nesting is ≤ 3.
    const html = await hub(String.raw`\trowd\cellx3000\cellx6000\intbl\itap50000000 A\cell B\cell\row`)
    expect(html).toContain('A')
    expect(html).toContain('B')
  }, 20_000)
})
