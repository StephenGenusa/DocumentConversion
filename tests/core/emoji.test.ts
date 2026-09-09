import { describe, it, expect } from 'vitest'
import { colorizeStatusEmoji } from '../../src/core/emoji'

describe('colorizeStatusEmoji', () => {
  it('replaces check/x emoji with css-colored glyphs', () => {
    const out = colorizeStatusEmoji('pass ✅ fail ❌')
    expect(out).toContain('color:#16a34a')
    expect(out).toContain('color:#dc2626')
    expect(out).toContain('✓')
    expect(out).toContain('✗')
    expect(out).not.toContain('✅')
    expect(out).not.toContain('❌')
  })

  it('consumes a trailing VS16 (U+FE0F)', () => {
    const out = colorizeStatusEmoji('x ✔️ y')
    expect(out).toContain('color:#16a34a')
    expect(out).not.toContain('️')
  })

  it('maps colored circle emoji', () => {
    expect(colorizeStatusEmoji('\u{1F534}')).toContain('color:#dc2626')
    expect(colorizeStatusEmoji('\u{1F7E2}')).toContain('color:#16a34a')
  })

  it('leaves unmapped emoji and plain text untouched', () => {
    expect(colorizeStatusEmoji('hello 🚀 world')).toBe('hello 🚀 world')
  })
})
