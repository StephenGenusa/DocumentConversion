import { describe, it, expect } from 'vitest'
import { mergeHubDocuments } from '../../src/core/merge'

const a = { html: '<p>Alpha body</p>', title: 'Alpha', sourceName: 'alpha.md' }
const b = { html: '<p>Beta body</p>', sourceName: 'beta.docx' }
const c = { html: '<p>Gamma body</p>' }

describe('mergeHubDocuments', () => {
  it('throws merge-empty for an empty list', () => {
    expect(() => mergeHubDocuments([], { headings: true })).toThrowError(/merge/)
    try {
      mergeHubDocuments([], { headings: true })
    } catch (e) {
      expect((e as { code: string }).code).toBe('merge-empty')
    }
  })

  it('concatenates fragments with source headings and page breaks between them', () => {
    const merged = mergeHubDocuments([a, b], { headings: true })
    expect(merged.html).toContain('<h1 class="doc-title">alpha.md</h1>')
    expect(merged.html).toContain('<h1 class="doc-title">beta.docx</h1>')
    expect(merged.html.indexOf('Alpha body')).toBeLessThan(merged.html.indexOf('Beta body'))
    const breaks = merged.html.match(/page-break-after: always/g) ?? []
    expect(breaks).toHaveLength(1) // between fragments only, not trailing
  })

  it('omits headings when disabled', () => {
    const merged = mergeHubDocuments([a, b], { headings: false })
    expect(merged.html).not.toContain('doc-title')
    expect(merged.html).toContain('Alpha body')
  })

  it('escapes heading text and falls back to Untitled', () => {
    const merged = mergeHubDocuments([{ html: '<p>x</p>', sourceName: 'a<b>.md' }, c], { headings: true })
    expect(merged.html).toContain('a&lt;b&gt;.md')
    expect(merged.html).toContain('<h1 class="doc-title">Untitled</h1>')
  })

  it('takes title and sourceName from the first document', () => {
    const merged = mergeHubDocuments([a, b], { headings: true })
    expect(merged.title).toBe('Alpha')
    expect(merged.sourceName).toBe('alpha.md')
  })

  it('returns a single document unchanged apart from the optional heading', () => {
    const merged = mergeHubDocuments([c], { headings: false })
    expect(merged.html).toBe('<p>Gamma body</p>')
  })
})
