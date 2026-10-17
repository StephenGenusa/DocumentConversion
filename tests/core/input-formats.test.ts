import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { INPUT_FORMAT_GROUPS, inputFormatHint } from '../../src/core/input-formats'
import { EXTENSION_FORMATS } from '../../src/core/extensions'
import { detect, detectByExtension } from '../../src/core/detect'
import { SOURCE_FORMATS } from '../../src/core/types'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { tiff, emf, wmf } from '../../scripts/fixtures/lib-tiff.mjs'

/** The start screen's list of what the app reads, built from the detector's own tables. */
describe('input format list', () => {
  const tokens = new Set(inputFormatHint().split(/[\s·/(),]+/).filter(Boolean))

  it('names every extension the detector knows', () => {
    const missing = [...EXTENSION_FORMATS.keys()].filter((ext) => !tokens.has(ext))
    expect(missing).toEqual([])
  })

  it('names every format the app reads, once', () => {
    const listed = INPUT_FORMAT_GROUPS.flatMap((g) => g.formats)
    expect([...listed].sort()).toEqual([...SOURCE_FORMATS].sort())
    // Source code and archives go by a word, not by an extension list.
    expect(tokens.has('code')).toBe(true)
    expect(tokens.has('zip')).toBe(true)
  })

  it('lists only what is read: each extension shown is detected as its group says', () => {
    for (const group of INPUT_FORMAT_GROUPS) {
      for (const ext of group.extensions) {
        // A .db is a database by its first bytes only (the name is shared by other formats).
        if (ext === 'db') expect(detect(Buffer.from('SQLite format 3\0'), 'x.db')).toEqual({ kind: 'ok', format: 'sqlite' })
        else expect(group.formats, ext).toContain(detectByExtension(`x.${ext}`))
      }
    }
  })

  it('lists TIFF, the other pictures Chromium shows, and EMF/WMF drawings, each read by its bytes', () => {
    const groupOf = (ext: string) => INPUT_FORMAT_GROUPS.find((g) => g.extensions.includes(ext))
    for (const ext of ['tif', 'tiff', 'bmp', 'avif', 'ico']) expect(groupOf(ext)?.formats, ext).toEqual(['image'])
    for (const ext of ['emf', 'wmf']) expect(groupOf(ext)?.formats, ext).toContain('metafile')
    expect(inputFormatHint()).toContain('images (png/jpg/jpeg/gif/webp/tif/tiff/bmp/avif/ico)')
    expect(inputFormatHint()).toContain('svg/emf/wmf')
    // HEIC is not among them: Chromium cannot decode it.
    expect(tokens.has('heic')).toBe(false)
    const page = { width: 8, height: 8, pixel: () => [0, 0, 0], kind: 'gray' }
    expect(detect(tiff(page), 'x.tif')).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(tiff({ pages: [page, page] }), 'x.tiff')).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(emf(), 'x.emf')).toEqual({ kind: 'ok', format: 'metafile' })
    expect(detect(wmf(), 'x.wmf')).toEqual({ kind: 'ok', format: 'metafile' })
  })

  it('stays short: the usual name first in its group, an extension at most once', () => {
    expect(inputFormatHint()).toMatch(/^pdf · docx\/docm\/doc · md\//)
    const all = INPUT_FORMAT_GROUPS.flatMap((g) => g.extensions)
    expect(new Set(all).size).toBe(all.length)
  })

  it('matches the README', () => {
    const readme = readFileSync('README.md', 'utf8')
    const block = /## What it reads[\s\S]*?```\n([\s\S]*?)```/.exec(readme)?.[1] ?? ''
    expect(block.split(/[\s,]+/).filter(Boolean)).toEqual(SOURCE_FORMATS)
    expect(readme).toContain(`between ${SOURCE_FORMATS.length} input formats`)
    const section = /## What it reads([\s\S]*?)\n## /.exec(readme)?.[1] ?? ''
    const missing = [...EXTENSION_FORMATS.keys()].filter((ext) => !section.includes(`\`.${ext}\``))
    expect(missing).toEqual([])
  })
})
