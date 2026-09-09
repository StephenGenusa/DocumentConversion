import { describe, it, expect } from 'vitest'
import { writeDocx } from '../../src/core/writers/docx'
import { readDocx } from '../../src/core/readers/docx'

describe('writeDocx', () => {
  it('produces a docx that reads back to equivalent content', async () => {
    const buf = await writeDocx({ html: '<h1>Rt</h1><p>Hello <strong>world</strong></p>', title: 'Rt' })
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(1000)
    const back = await readDocx({ bytes: buf })
    expect(back.html).toContain('Rt')
    expect(back.html.toLowerCase()).toContain('world')
  })
})
