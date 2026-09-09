import { describe, it, expect } from 'vitest'
import { uniqueName } from '../../src/core/naming'

describe('uniqueName', () => {
  it('returns base.ext when free', () => {
    expect(uniqueName('report', '.pdf', () => false)).toBe('report.pdf')
  })
  it('suffixes -1, -2 on collisions', () => {
    const taken = new Set(['report.pdf', 'report-1.pdf'])
    expect(uniqueName('report', '.pdf', (n) => taken.has(n))).toBe('report-2.pdf')
  })
})
