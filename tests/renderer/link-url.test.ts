import { describe, it, expect } from 'vitest'
import { normalizeLinkUrl } from '../../src/renderer/src/lib/link-url'

/**
 * The editor's output is NOT re-sanitized on its way to conversion — `read()`
 * only strips XML-illegal characters — so whatever href this returns reaches
 * the docx, epub and HTML writers as written. It is the boundary, and it has
 * to agree with `hubSanitizeOptions().allowedSchemes`.
 */
describe('normalizeLinkUrl', () => {
  it('keeps the three schemes the hub allows', () => {
    expect(normalizeLinkUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(normalizeLinkUrl('http://example.com/a')).toBe('http://example.com/a')
    expect(normalizeLinkUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
  })

  it('assumes https for a bare host, which is what people type', () => {
    expect(normalizeLinkUrl('example.com/page')).toBe('https://example.com/page')
    expect(normalizeLinkUrl('  example.com  ')).toBe('https://example.com/')
  })

  it('refuses every scheme the hub would strip', () => {
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeLinkUrl('JaVaScRiPt:alert(1)')).toBeNull()
    expect(normalizeLinkUrl('data:text/html,<script>x</script>')).toBeNull()
    expect(normalizeLinkUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeLinkUrl('vbscript:msgbox')).toBeNull()
  })

  it('is not fooled by whitespace or control characters inside the scheme', () => {
    expect(normalizeLinkUrl('java\tscript:alert(1)')).toBeNull()
    expect(normalizeLinkUrl(' javascript:alert(1)')).toBeNull()
    expect(normalizeLinkUrl('java\nscript:alert(1)')).toBeNull()
  })

  it('rejects empty and unparseable input', () => {
    expect(normalizeLinkUrl('')).toBeNull()
    expect(normalizeLinkUrl('   ')).toBeNull()
    expect(normalizeLinkUrl('http://')).toBeNull()
  })
})
