import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readDoc, looksLikeDocTable, DOC_TABLES_ADVICE } from '../../src/core/readers/doc'
import type { ReadContext } from '../../src/core/types'

const DOCS = join(__dirname, '../corpus')
const describeIfCorpus = existsSync(DOCS) ? describe : describe.skip

/**
 * The `readDoc` cases below read real .doc files off disk through
 * word-extractor, whose first call in the process is a cold start. Warm that
 * is a tenth of a second; on a cold filesystem cache it goes past the 5 s
 * default and the file fails for a reason unrelated to what it tests. Heavy
 * tests in this repo carry an explicit timeout; this sets one for the file.
 */
vi.setConfig({ testTimeout: 60_000 })

/** Read a real legacy Word file and collect whatever advice the reader gives. */
async function adviceFor(name: string): Promise<Array<[string, string]>> {
  const calls: Array<[string, string]> = []
  const ctx: ReadContext = { onAdvice: (kind, message) => calls.push([kind, message]) }
  await readDoc({ bytes: await readFile(join(DOCS, name)), filename: name }, ctx)
  return calls
}

describe('looksLikeDocTable', () => {
  it('fires on a row with two or more cell marks', () => {
    expect(looksLikeDocTable('7.2 MAX \t \t \t \t20.0 EXC')).toBe(true)
  })

  it('fires on two rows in a row', () => {
    expect(looksLikeDocTable('Bolt\t10\nNut\t4')).toBe(true)
  })

  it('stays silent on a single tabbed line', () => {
    expect(looksLikeDocTable('Name\tValue\n\nOrdinary prose follows.')).toBe(false)
  })

  it('ignores tab indentation, however much of it there is', () => {
    // Word writers indent paragraphs with tabs; two indented paragraphs in a
    // row must never read as two table rows.
    expect(looksLikeDocTable('\tFirst indented paragraph.\n\tSecond indented paragraph.')).toBe(false)
    expect(looksLikeDocTable('\t\tDeeply indented line.\n\t\tAnother one.')).toBe(false)
  })

  it('stays silent on prose with no tabs at all', () => {
    expect(looksLikeDocTable('Broadband - in simple terms.\n\nBits - a single thing.')).toBe(false)
  })

  it('breaks a run of rows on a line that is not a row', () => {
    expect(looksLikeDocTable('Bolt\t10\nA plain sentence.\nNut\t4')).toBe(false)
  })
})

describeIfCorpus('readDoc table advice', () => {
  it('warns about a real legacy table, naming .docx as the fix', async () => {
    // Scoped to the table notice for the same reason the prose cases below
    // are: this file also holds six embedded PNGs that cannot reach the
    // output, which rightly earns a separate 'doc-images' notice (pinned in
    // doc-images-notice.test.ts). The point kept here is that the TABLE notice
    // is said exactly once, and says the right thing.
    const tables = (await adviceFor('loan-calculations.doc')).filter(([kind]) => kind === 'doc-tables')
    expect(tables).toHaveLength(1)
    expect(tables[0][1]).toBe(DOC_TABLES_ADVICE)
    expect(tables[0][1]).toMatch(/table/i)
    expect(tables[0][1]).toMatch(/Word 97-2003/)
    expect(tables[0][1]).toMatch(/\.docx/)
  })

  it.each([
    'definitions.doc',
    'classification-explanation.doc',
    'reading-group-questions.doc',
    'volunteer-induction-questions.doc',
    'cataloguing-questions.doc',
  ])('stays silent on prose: %s', async (name) => {
    // Scoped to the table notice on purpose. This assertion used to be
    // `toEqual([])` over EVERY notice, which only held while 'doc-tables' was
    // the reader's only advice key; the three Review Questions files now
    // rightly earn a 'doc-lists' notice (see doc-lists-notice.test.ts, which
    // pins their exact advice). Widening the filter back out would make this
    // test fail for a reason that has nothing to do with tables.
    const tables = (await adviceFor(name)).filter(([kind]) => kind === 'doc-tables')
    expect(tables).toEqual([])
  })

  it.each([
    'definitions.doc',
    'classification-explanation.doc',
    'reading-group-questions.doc',
    'volunteer-induction-questions.doc',
    'cataloguing-questions.doc',
  ])('gives no notice at all it cannot justify: %s', async (name) => {
    // Everything the reader says about these five files, in one place, so a new
    // advice key cannot appear here unnoticed.
    // Named explicitly rather than matched on the filename: keying off a
    // substring of the name meant renaming a fixture silently changed what
    // this test expected of it.
    const QUIZZES = [
      'reading-group-questions.doc',
      'volunteer-induction-questions.doc',
      'cataloguing-questions.doc',
    ]
    const expected = QUIZZES.includes(name) ? ['doc-lists'] : []
    expect((await adviceFor(name)).map(([kind]) => kind)).toEqual(expected)
  })

  it('warns about a document laid out in a one-column table', async () => {
    // Every heading line in this one ends in a cell mark, so the notice is
    // earned even though the extracted text reads acceptably.
    //
    // 'doc-images' joins it because the file really does carry a picture: an
    // OfficeArt JPEG blip that no route through word-extractor can reach.
    // Both notices are true, so both are listed.
    const calls = await adviceFor('shelving-instructions.doc')
    expect(calls.map(([kind]) => kind)).toEqual(['doc-tables', 'doc-images'])
  })

  it('rejects a picture-only document before any advice is given', async () => {
    const onAdvice = vi.fn()
    const name = 'picture-only-figure.doc'
    await expect(
      readDoc({ bytes: await readFile(join(DOCS, name)), filename: name }, { onAdvice }),
    ).rejects.toMatchObject({ code: 'read-failed' })
    expect(onAdvice).not.toHaveBeenCalled()
  })

  it('still returns the document text when it warns', async () => {
    const bytes = await readFile(join(DOCS, 'loan-calculations.doc'))
    const hub = await readDoc({ bytes, filename: 'loan-calculations.doc' })
    expect(hub.html).toContain('EXC')
    expect(hub.title).toBe('loan-calculations.doc')
  })

  it('works without a context and without an onAdvice callback', async () => {
    const bytes = await readFile(join(DOCS, 'loan-calculations.doc'))
    await expect(readDoc({ bytes })).resolves.toBeTruthy()
    await expect(readDoc({ bytes }, {})).resolves.toBeTruthy()
  })

  it('does not warn when the extractor returns ordinary prose', async () => {
    const onAdvice = vi.fn()
    await readDoc({ bytes: Buffer.from('x'), filename: 'a.doc' }, { onAdvice }, async () => 'Just a sentence.')
    expect(onAdvice).not.toHaveBeenCalled()
  })
})
