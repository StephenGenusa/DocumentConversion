import { describe, it, expect } from 'vitest'
import { writeMarkdown } from '../../src/core/writers/md'

const md = async (html: string): Promise<string> => (await writeMarkdown({ html })).toString('utf8')

describe('writeMarkdown table hygiene', () => {
  it('unwraps block elements inside cells so pipe tables stay intact', async () => {
    // asciidoctor (and some HTML sources) wrap cell content in <p>.
    const out = await md(
      '<table><thead><tr><th>Stage</th><th>Owner</th></tr></thead><tbody>' +
        '<tr><td><p>Readers</p></td><td><p>Alice</p></td></tr>' +
        '<tr><td><p>Writers</p></td><td><p>Bob</p></td></tr></tbody></table>',
    )
    expect(out).toContain('| Readers | Alice |')
    expect(out).toContain('| Writers | Bob |')
    expect(out).not.toContain('<p>')
  })

  it('converts headerless tables to pipe tables instead of leaving raw HTML', async () => {
    // Email headers, calendar details and headerless CSV all produce these.
    const out = await md(
      '<table><tbody><tr><td>When</td><td>2026-09-01</td></tr><tr><td>Location</td><td>Room 4</td></tr></tbody></table>',
    )
    expect(out).not.toContain('<table')
    expect(out).not.toContain('<td>')
    expect(out).toContain('| When | 2026-09-01 |')
    expect(out).toContain('| Location | Room 4 |')
  })

  it('leaves tables that already have a header row alone', async () => {
    const out = await md(
      '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Widget</td><td>3</td></tr></tbody></table>',
    )
    expect(out).toContain('| Name | Qty |')
    expect(out).toContain('| Widget | 3 |')
  })
})
