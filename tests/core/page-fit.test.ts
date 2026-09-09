import { describe, it, expect } from 'vitest'
import { advisePageFit } from '../../src/core/page-fit'

const table = (cols: number, cellText = 'value'): string => {
  const head = Array.from({ length: cols }, (_, i) => `<th>Column${i}</th>`).join('')
  const body = Array.from({ length: cols }, () => `<td>${cellText}</td>`).join('')
  return `<table><thead><tr>${head}</tr></thead><tbody><tr>${body}</tr></tbody></table>`
}

describe('advisePageFit', () => {
  it('says nothing for a document with no tables', () => {
    const advice = advisePageFit('<p>Just prose, no tables at all.</p>')
    expect(advice.recommendLandscape).toBe(false)
    expect(advice.widestTable).toBe(0)
  })

  it('does not recommend landscape for a narrow table that already fits', () => {
    const advice = advisePageFit(table(3))
    expect(advice.recommendLandscape).toBe(false)
    expect(advice.columns).toBe(3)
  })

  it('recommends landscape when a table overflows portrait but fits sideways', () => {
    const advice = advisePageFit(table(11))
    expect(advice.recommendLandscape).toBe(true)
    expect(advice.widestTable).toBeGreaterThan(advice.portraitFits)
    expect(advice.reason).toMatch(/11 columns/)
  })

  it('suggests a larger page when Letter landscape alone cannot fit it', () => {
    // 15 columns need ~150 chars: past Letter landscape (~123), within Legal.
    const advice = advisePageFit(table(15))
    expect(advice.suggestion).toBeDefined()
    expect(advice.suggestion!.pageSize).not.toBe('Letter')
    expect(advice.suggestion!.landscape).toBe(true)
    expect(advice.reason).toMatch(/fits about/)
    expect(advice.reason).not.toMatch(/still wrap/)
  })

  it('is honest when nothing fits, and still names the roomiest setup', () => {
    const advice = advisePageFit(table(60))
    expect(advice.suggestion).toBeDefined()
    expect(advice.reason).toMatch(/wider than any page setup/)
    expect(advice.reason).toMatch(/still wrap/)
  })

  it('says plainly that no page fits, and names the formats that have no page', () => {
    const advice = advisePageFit(table(60))
    expect(advice.fitsAnyPage).toBe(false)
    // The concrete alternative, not just "sorry": these targets have no width.
    expect(advice.reason).toMatch(/xlsx/)
    expect(advice.reason).toMatch(/csv/)
    expect(advice.reason).toMatch(/html/)
  })

  it('does not claim a fit problem when there is one page that fits', () => {
    expect(advisePageFit(table(3)).fitsAnyPage).toBe(true)
    expect(advisePageFit(table(11)).fitsAnyPage).toBe(true)
    expect(advisePageFit(table(15)).fitsAnyPage).toBe(true)
    expect(advisePageFit('<p>no tables here at all</p>').fitsAnyPage).toBe(true)
    expect(advisePageFit(table(15)).reason).not.toMatch(/xlsx/)
  })

  it('still leaves the chosen page setup alone when nothing fits', () => {
    // The advice names the roomiest setup so the user can choose it; it never
    // reports the current setup as already correct just because none is.
    const advice = advisePageFit(table(60), 'A3', true)
    expect(advice.fitsAnyPage).toBe(false)
    expect(advice.suggestion).toBeDefined()
    expect(advice.reason).toMatch(/wider than any page setup/)
    expect(advice.reason).toMatch(/xlsx/)
  })

  it('reports a sheet-sized grid as unfittable', () => {
    // The 24-to-47-column shape that turns one workbook into 19,511 PDF pages.
    const advice = advisePageFit(table(47, 'quantity'))
    expect(advice.fitsAnyPage).toBe(false)
    expect(advice.columns).toBe(47)
  })

  it('stays quiet when the chosen setup already fits', () => {
    // 11 columns overflow Letter portrait but fit Letter landscape.
    expect(advisePageFit(table(11), 'Letter', false).recommendLandscape).toBe(true)
    expect(advisePageFit(table(11), 'Letter', true).recommendLandscape).toBe(false)
    expect(advisePageFit(table(11), 'Letter', true).suggestion).toBeUndefined()
  })

  it('accounts for page size — A3 fits in portrait what Letter cannot', () => {
    expect(advisePageFit(table(11), 'Letter').recommendLandscape).toBe(true)
    expect(advisePageFit(table(11), 'A3').recommendLandscape).toBe(false)
  })

  it('never advises a column narrower than its longest unbreakable word', () => {
    const wide = advisePageFit(table(6, 'Supercalifragilistic'))
    const narrow = advisePageFit(table(6, 'ok'))
    expect(wide.widestTable).toBeGreaterThan(narrow.widestTable)
  })

  it('measures the widest table when a document has several', () => {
    const advice = advisePageFit(table(3) + table(12) + table(2))
    expect(advice.columns).toBe(12)
  })
})
