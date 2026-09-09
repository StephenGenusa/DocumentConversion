import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readPptx } from '../../src/core/readers/pptx'

/**
 * The deck exists because replacing the private corpus cost `pptx.ts` 31 points
 * of line coverage: nothing opened a .pptx on purpose, so the list, table and
 * picture paths ran only incidentally, under an assertion that merely checked
 * no image placeholder appeared. Reaching a line is not testing it — these
 * assert what the reader produced.
 *
 * See scripts/fixtures/build-pptx-fixture.mjs for how the deck is built.
 */
const DECK = join(__dirname, '../corpus/quarterly-review-deck.pptx')

describe.skipIf(!existsSync(DECK))('pptx: the synthetic deck', () => {
  async function html(): Promise<string> {
    const bytes = await readFile(DECK)
    return (await readPptx({ bytes, filename: 'quarterly-review-deck.pptx' })).html
  }

  it('nests the outline levels rather than flattening them', async () => {
    const h = await html()
    // Level 2 sits inside level 1, which sits inside level 0.
    expect(h).toMatch(/<li>Northern district<ul><li>Third level, to clamp the depth<\/li><\/ul><\/li>/)
  })

  it('starts a new list when the bullet style changes, and returns to bullets after', async () => {
    const h = await html()
    // Arabic numbering is the browser default, so it carries no type attribute.
    expect(h).toContain('<ol><li>Steps to complete</li><li>Second numbered step</li></ol>')
    // A lettered run must, or it renders as 1. 2. instead of a. b.
    expect(h).toContain('<ol type="a"><li>Lettered sub-procedure</li><li>Second lettered step</li></ol>')
    expect(h).toContain('<li>Back to a plain bullet</li>')
    // Separate runs, not one merged list.
    expect((h.match(/<ul>/g) ?? []).length).toBe(4)
    expect((h.match(/<ol/g) ?? []).length).toBe(2)
  })

  it('carries table spans and drops the cells a merge continues into', async () => {
    const h = await html()
    expect(h).toContain('<td colspan="2">Spanning header</td>')
    expect(h).toContain('<td rowspan="2">North</td>')
    expect(h).not.toContain('skipped')
  })

  it('inlines a slide picture through the slide relationships', async () => {
    expect(await html()).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="slide image">/)
  })

  it('orders slide10 after slide2, which a lexical sort would not', async () => {
    const h = await html()
    expect(h.indexOf('Quarterly Branch Review')).toBeLessThan(h.indexOf('Spanning header'))
    expect(h.indexOf('Spanning header')).toBeLessThan(h.indexOf('Site photograph'))
  })
})
