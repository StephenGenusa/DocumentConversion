import { describe, it, expect } from 'vitest'
import { renderDocumentShell } from '../../src/core/shell'
import { writeMarkdown } from '../../src/core/writers/md'

const wideTable = (): string => {
  const cols = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'ZEBRA_LAST']
  const head = cols.map((c) => `<th>${c}</th>`).join('')
  const body = cols.map((c, i) => `<td>${c}${i}</td>`).join('')
  return `<table><thead><tr>${head}</tr></thead><tbody><tr>${body}</tr></tbody></table>`
}

describe('wide tables in PDF output', () => {
  it('lets a table use the full page instead of the prose reading width', () => {
    const shell = renderDocumentShell({ html: wideTable() }, { target: 'pdf' })
    // printToPDF clips overflow, so the 46rem cage silently dropped columns.
    expect(shell).toMatch(/body\s*\{\s*max-width:\s*none/)
    expect(shell).toContain('table-layout: fixed')
    expect(shell).toContain('overflow-wrap: anywhere')
  })

  it('keeps the prose reading width for documents without tables', () => {
    const shell = renderDocumentShell({ html: '<p>just prose</p>' }, { target: 'pdf' })
    expect(shell).not.toMatch(/body\s*\{\s*max-width:\s*none/)
  })

  it('repeats headers across pages and avoids splitting rows', () => {
    const shell = renderDocumentShell({ html: wideTable() }, { target: 'pdf' })
    expect(shell).toContain('display: table-header-group')
    expect(shell).toContain('break-inside: avoid')
  })

  it('carries every column of a wide table into markdown', async () => {
    const md = (await writeMarkdown({ html: wideTable() })).toString('utf8')
    // turndown escapes the underscore, so match the stem.
    expect(md).toContain('ZEBRA')
    expect(md.split('\n')[0].split('|').filter((c) => c.trim()).length).toBe(12)
  })
})

describe('markdown headers for all-text tables', () => {
  it('uses the real first row rather than a blank header', async () => {
    // No numeric body, so the header heuristic never fired and every such
    // table got "|  |  |" with its real header demoted into the body.
    const md = (
      await writeMarkdown({
        html: '<table><tbody><tr><td>Salvage:</td><td>Don’t Salvage:</td></tr><tr><td>Wire</td><td>Poles</td></tr></tbody></table>',
      })
    ).toString('utf8')
    expect(md.split('\n')[0]).toContain('Salvage:')
    expect(md).not.toMatch(/^\|\s*\|\s*\|$/m)
  })
})
