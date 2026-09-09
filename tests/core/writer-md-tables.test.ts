import { describe, it, expect } from 'vitest'
import { writeMarkdown } from '../../src/core/writers/md'

describe('writeMarkdown tables (gfm)', () => {
  it('renders hub tables as pipe tables, not flattened text', async () => {
    const out = await writeMarkdown({
      html: '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Widget</td><td>3</td></tr></tbody></table>',
    })
    const md = out.toString('utf8')
    expect(md).toContain('| Name | Qty |')
    expect(md).toContain('| Widget | 3 |')
  })
})
