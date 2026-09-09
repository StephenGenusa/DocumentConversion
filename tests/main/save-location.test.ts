import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import {
  defaultSaveDir,
  defaultSavePath,
  rememberSaveDir,
  resetSaveLocation,
} from '../../src/main/save-location'

/**
 * Where a save dialog should open.
 *
 * The rule is: the input's own folder if it has one, otherwise wherever the
 * last save landed, otherwise leave it to the OS. That last case matters —
 * returning a bogus directory would be worse than the old behaviour.
 */
beforeEach(() => resetSaveLocation())

describe('defaultSaveDir', () => {
  it('uses the folder the input came from', () => {
    expect(defaultSaveDir(join('/home', 'me', 'reports'))).toBe(join('/home', 'me', 'reports'))
  })

  it('has no opinion until something is known', () => {
    expect(defaultSaveDir(undefined)).toBeUndefined()
  })

  it('falls back to the last folder saved to when the input has no origin', () => {
    rememberSaveDir(join('/home', 'me', 'out', 'notes.pdf'))
    expect(defaultSaveDir(undefined)).toBe(join('/home', 'me', 'out'))
  })

  it("prefers the input's own folder over the last one saved to", () => {
    rememberSaveDir(join('/home', 'me', 'out', 'notes.pdf'))
    expect(defaultSaveDir(join('/srv', 'docs'))).toBe(join('/srv', 'docs'))
  })

  it('ignores an empty source directory rather than treating it as a location', () => {
    rememberSaveDir(join('/home', 'me', 'out', 'notes.pdf'))
    expect(defaultSaveDir('')).toBe(join('/home', 'me', 'out'))
    expect(defaultSaveDir('   ')).toBe(join('/home', 'me', 'out'))
  })
})

describe('rememberSaveDir', () => {
  it('stores the folder, not the file that was saved into it', () => {
    rememberSaveDir(join('/home', 'me', 'out', 'notes.pdf'))
    expect(defaultSaveDir()).toBe(join('/home', 'me', 'out'))
  })

  it('moves with the most recent save', () => {
    rememberSaveDir(join('/home', 'me', 'first', 'a.pdf'))
    rememberSaveDir(join('/home', 'me', 'second', 'b.pdf'))
    expect(defaultSaveDir()).toBe(join('/home', 'me', 'second'))
  })

  it('ignores a bare filename, which names no folder to return to', () => {
    rememberSaveDir('notes.pdf')
    expect(defaultSaveDir()).toBeUndefined()
  })
})

describe('defaultSavePath', () => {
  it('puts the suggested name in the folder the input came from', () => {
    expect(defaultSavePath(join('/srv', 'docs'), 'report.pdf')).toBe(join('/srv', 'docs', 'report.pdf'))
  })

  it('falls back to the bare name, leaving the dialog as it was before', () => {
    expect(defaultSavePath(undefined, 'report.pdf')).toBe('report.pdf')
  })
})
