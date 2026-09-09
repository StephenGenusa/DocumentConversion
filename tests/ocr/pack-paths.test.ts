import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { packPathIn } from '../../src/ocr/pack-install'

/**
 * Any language code that reaches a filesystem path is attacker-controlled from
 * the renderer's point of view. `installPack` checked it against the catalogue;
 * `removePack` did not, and built a path straight from the string - so
 * `removeOcrLanguage('../../../../tmp/victim', 'fast')` resolved outside the
 * pack directory and unlinked whatever was there.
 *
 * The check belongs where the path is built, not at each call site, so that
 * the next function to take a code cannot forget it.
 */
const DIR = '/packs'

describe('packPathIn', () => {
  it('builds a path for a known language', () => {
    expect(packPathIn(DIR, 'deu', 'fast')).toBe(join(DIR, 'deu.traineddata'))
    expect(packPathIn(DIR, 'deu', 'best')).toBe(join(DIR, 'deu.best.traineddata'))
  })

  it('refuses a traversal that would escape the pack directory', () => {
    expect(packPathIn(DIR, '../../../../tmp/victim', 'fast')).toBeNull()
    expect(packPathIn(DIR, '..', 'fast')).toBeNull()
    expect(packPathIn(DIR, '/etc/passwd', 'fast')).toBeNull()
  })

  it('refuses anything not in the catalogue, however innocent it looks', () => {
    expect(packPathIn(DIR, 'xyz', 'fast')).toBeNull()
    expect(packPathIn(DIR, '', 'fast')).toBeNull()
  })

  it('never returns a path outside the directory it was given', () => {
    for (const code of ['../x', 'a/../../b', './deu', 'deu/../../eng', '\\..\\x']) {
      const path = packPathIn(DIR, code, 'fast')
      if (path !== null) expect(path.startsWith(join(DIR, ''))).toBe(true)
    }
  })
})
