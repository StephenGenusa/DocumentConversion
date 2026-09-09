import { describe, it, expect } from 'vitest'
import { firstFileUriToPath, allFileUrisToPaths } from '../../src/core/uri'

describe('allFileUrisToPaths', () => {
  it('returns every file uri as a path, in order', () => {
    const list = '# comment\r\nfile:///home/x/a.md\r\nfile:///home/x/b%20c.md\r\nhttp://example.com/skip\r\n'
    expect(allFileUrisToPaths(list)).toEqual(['/home/x/a.md', '/home/x/b c.md'])
  })
  it('returns an empty array when nothing matches', () => {
    expect(allFileUrisToPaths('http://example.com/a.md')).toEqual([])
    expect(allFileUrisToPaths('')).toEqual([])
  })
})

describe('firstFileUriToPath', () => {
  it('returns the path of a simple file uri', () => {
    expect(firstFileUriToPath('file:///home/x/a.md')).toBe('/home/x/a.md')
  })
  it('handles CRLF-separated lists and comment lines', () => {
    const list = '# comment\r\nfile:///home/x/a.md\r\nfile:///home/x/b.md\r\n'
    expect(firstFileUriToPath(list)).toBe('/home/x/a.md')
  })
  it('decodes percent-encoded characters (spaces)', () => {
    expect(firstFileUriToPath('file:///home/x/a%20b.md')).toBe('/home/x/a b.md')
  })
  it('returns null when there is no file uri', () => {
    expect(firstFileUriToPath('http://example.com/a.md')).toBeNull()
    expect(firstFileUriToPath('')).toBeNull()
    expect(firstFileUriToPath('   \r\n# only a comment')).toBeNull()
  })
})
