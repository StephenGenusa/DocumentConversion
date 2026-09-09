import { describe, it, expect } from 'vitest'
import { resolveExport } from '../../src/core/interop'

describe('resolveExport', () => {
  const parse = (): string => 'ok'

  it('finds the member on the namespace itself', () => {
    expect(resolveExport<{ parse(): string }>({ parse }, 'parse').parse()).toBe('ok')
  })
  it('finds it behind a single default wrapper', () => {
    expect(resolveExport<{ parse(): string }>({ default: { parse } }, 'parse').parse()).toBe('ok')
  })
  it('finds it behind a double default wrapper (rollup interop)', () => {
    expect(resolveExport<{ parse(): string }>({ default: { default: { parse } } }, 'parse').parse()).toBe('ok')
  })
  it('throws a clear error when the member is absent', () => {
    expect(() => resolveExport({ other: parse }, 'parse')).toThrowError(/does not expose parse/)
  })
})
