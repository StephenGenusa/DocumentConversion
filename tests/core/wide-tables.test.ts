import { describe, it, expect } from 'vitest'
import { AUTO_TABLE_ROWS, AUTO_TABLE_WORD, renderDocumentShell } from '../../src/core/shell'
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

  it('sizes the columns of modest tables by their content, and keeps large ones fixed', () => {
    const small = renderDocumentShell({ html: wideTable() }, { target: 'pdf' })
    expect(small).toContain('table { table-layout: auto; }')
    const rows = '<tr><td>a</td><td>b</td></tr>'.repeat(AUTO_TABLE_ROWS + 1)
    const large = renderDocumentShell({ html: `<table><tbody>${rows}</tbody></table>` }, { target: 'pdf' })
    expect(large).not.toContain('table-layout: auto')
    expect(large).toContain('table-layout: fixed')
  })

  it('keeps the fixed layout when a table holds a word too long to stay whole', () => {
    const long = 'x'.repeat(AUTO_TABLE_WORD + 1)
    const shell = renderDocumentShell({ html: `<table><tbody><tr><td>${long}</td><td>b</td></tr></tbody></table>` }, { target: 'pdf' })
    expect(shell).not.toContain('table-layout: auto')
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

describe('task lists in PDF and HTML output', () => {
  it('draws a list of ballot-box items without bullets', () => {
    const shell = renderDocumentShell({ html: '<ul><li>☐ Call the movers</li><li><p>☑ Book the lift</p></li></ul>' }, { target: 'pdf' })
    expect(shell).toContain('<ul class="task-list"><li>☐ Call the movers</li>')
    expect(shell).toContain('ul.task-list { list-style: none;')
  })

  it('leaves a list alone when any item is not a task, or an item holds a list', () => {
    const mixed = '<ul><li>☐ Call the movers</li><li>Notes</li></ul>'
    const nested = '<ul><li>☐ Pack<ul><li>Books</li></ul></li></ul>'
    for (const html of [mixed, nested]) expect(renderDocumentShell({ html }, { target: 'html' })).not.toContain('task-list')
  })
})

describe('task lists, serialized', () => {
  it('finds the ballot boxes written as character references too', () => {
    const shell = renderDocumentShell({ html: '<ul>\n<li>&#x2610; Call the movers</li>\n<li>&#9745; Book the lift</li>\n</ul>' }, { target: 'pdf' })
    expect(shell).toContain('<ul class="task-list">')
  })
})
