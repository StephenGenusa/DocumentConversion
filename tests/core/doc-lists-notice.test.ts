import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readDoc, looksLikeDocList, DOC_LISTS_ADVICE } from '../../src/core/readers/doc'
import type { ReadContext } from '../../src/core/types'

const DOCS = join(__dirname, '../corpus')
const describeIfCorpus = existsSync(DOCS) ? describe : describe.skip

/** Read a real legacy Word file and collect whatever advice the reader gives. */
async function adviceFor(name: string): Promise<Array<[string, string]>> {
  const calls: Array<[string, string]> = []
  const ctx: ReadContext = { onAdvice: (kind, message) => calls.push([kind, message]) }
  await readDoc({ bytes: await readFile(join(DOCS, name)), filename: name }, ctx)
  return calls
}

/** Just the kinds, so a document that earns two notices is easy to read. */
const kindsFor = async (name: string) => (await adviceFor(name)).map(([kind]) => kind)

describe('looksLikeDocList', () => {
  // Three separate stacks of short unterminated lines, and they are most of
  // the document: the shape a quiz leaves behind once Word's auto-numbers are
  // gone. The blank lines between stacks are the question paragraphs' spacing.
  const QUIZ = [
    'True',
    'False',
    '',
    'KVA',
    'KW',
    'DAYS',
    '',
    'Wye-Wye',
    'Delta-Wye',
    'Delta-Delta',
  ].join('\n')

  it('fires on several stacks of unmarked short lines', () => {
    expect(looksLikeDocList(QUIZ)).toBe(true)
  })

  it('stays silent on prose whose paragraphs are blank-line separated', () => {
    expect(
      looksLikeDocList('Broadband - the speed at which data moves.\n\nBits - a single thing.\n\nBytes - eight bits.'),
    ).toBe(false)
  })

  it('needs more than one stack', () => {
    expect(looksLikeDocList('Alpha\nBravo\nCharlie\n\nA sentence of ordinary prose follows here.')).toBe(false)
  })

  it('needs the stacks to be most of the document', () => {
    // One list buried in a page of prose is not a document whose numbering
    // went missing; the prose would drown any notice we gave.
    const prose = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} of ordinary running prose.`).join('\n')
    expect(looksLikeDocList(`${QUIZ}\n${prose}`)).toBe(false)
  })

  it('stays silent when the markers were typed by hand and survived', () => {
    // These numbers are IN the text stream, so nothing was lost and there is
    // nothing to warn about.
    const typed = ['1. True', '2. False', '', 'a) KVA', 'b) KW', 'c) DAYS', '', '1) Wye-Wye', '2) Delta-Wye', '3) Delta-Delta'].join(
      '\n',
    )
    expect(looksLikeDocList(typed)).toBe(false)
  })

  it('ignores tabbed lines, which belong to the table detector', () => {
    expect(looksLikeDocList('Bolt\t10\nNut\t4\n\nBolt\t10\nNut\t4\n\nBolt\t10\nNut\t4')).toBe(false)
  })

  it('does not count long or sentence-terminated lines as list items', () => {
    const sentences = [
      'The first paragraph ends properly.',
      'So does the second one.',
      '',
      'And the third.',
      'And the fourth.',
      '',
      'And the fifth.',
      'And the sixth.',
    ].join('\n')
    expect(looksLikeDocList(sentences)).toBe(false)
  })
})

describeIfCorpus('readDoc list advice', () => {
  it.each([
    'reading-group-questions.doc',
    'volunteer-induction-questions.doc',
    'cataloguing-questions.doc',
  ])('warns that the numbering is missing from %s', async (name) => {
    const calls = await adviceFor(name)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('doc-lists')
    expect(calls[0][1]).toBe(DOC_LISTS_ADVICE)
    expect(calls[0][1]).toMatch(/number/i)
    expect(calls[0][1]).toMatch(/Word 97-2003/)
    expect(calls[0][1]).toMatch(/\.docx/)
  })

  it.each([
    'definitions.doc',
    'classification-explanation.doc',
    'loan-calculations.doc',
    'shelving-instructions.doc',
  ])('stays silent about lists in %s', async (name) => {
    expect(await kindsFor(name)).not.toContain('doc-lists')
  })

  it('still returns the question text when it warns', async () => {
    const name = 'reading-group-questions.doc'
    const hub = await readDoc({ bytes: await readFile(join(DOCS, name)), filename: name })
    expect(hub.html).toContain('How long is a standard loan?')
    expect(hub.html).toContain('<p>Three weeks</p>')
    expect(hub.title).toBe(name)
  })

  it('does not invent numbers it cannot see', async () => {
    // The whole point of the notice: the markers are not in the text stream,
    // so the reader must not write any. No <ol>, no fabricated "1." prefix.
    const name = 'reading-group-questions.doc'
    const hub = await readDoc({ bytes: await readFile(join(DOCS, name)), filename: name })
    expect(hub.html).not.toContain('<ol')
    expect(hub.html).not.toContain('<li')
    expect(hub.html).not.toMatch(/<p>\s*(\d+[.)]|[a-d][.)])\s/)
  })

  it('works without a context and without an onAdvice callback', async () => {
    const bytes = await readFile(join(DOCS, 'reading-group-questions.doc'))
    await expect(readDoc({ bytes })).resolves.toBeTruthy()
    await expect(readDoc({ bytes }, {})).resolves.toBeTruthy()
  })

  it('does not warn when the extractor returns ordinary prose', async () => {
    const onAdvice = vi.fn()
    await readDoc({ bytes: Buffer.from('x'), filename: 'a.doc' }, { onAdvice }, async () => 'Just a sentence.')
    expect(onAdvice).not.toHaveBeenCalled()
  })
})
