import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fontFolders, indexFonts, localFontFiles } from '../../src/main/local-fonts'
import { createConverter } from '../../src/core/convert'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { EmfWriter } from '../../scripts/fixtures/lib-metafile.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { collection, sfnt } from '../../scripts/fixtures/lib-sfnt.mjs'
// @ts-expect-error: plain .mjs fixture libraries, no types.
import { READING_ROOM } from '../../scripts/fixtures/vocabulary.mjs'

/*
 * The fonts on this computer, by family (src/main/local-fonts.ts), over a
 * folder of synthetic fonts (scripts/fixtures/lib-sfnt.mjs).
 */

let dir = ''
const WORD: string = READING_ROOM.signs[1] // "Entrance"
const letters = [...new Set(WORD)]

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-fonts-'))
  mkdirSync(join(dir, 'truetype', 'reading'), { recursive: true })
  const cmap = letters.map((c, i) => [c.codePointAt(0)!, 20 + i])
  writeFileSync(join(dir, 'truetype', 'reading', 'ReadingSans-Regular.ttf'), sfnt({ family: 'Reading Sans', style: 'Regular', cmap }))
  writeFileSync(join(dir, 'truetype', 'reading', 'ReadingSans-Bold.TTF'), sfnt({ family: 'Reading Sans', style: 'Bold', cmap: [[0x42, 20]] }))
  writeFileSync(join(dir, 'reading.ttc'), collection([{ family: 'Reading Serif', cmap: [[0x41, 3]] }, { family: 'Reading Mono', style: 'Italic', cmap: [[0x41, 4]] }]))
  writeFileSync(join(dir, 'broken.ttf'), Buffer.from('not a font at all'))
  writeFileSync(join(dir, 'notes.txt'), 'Reading Sans')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('local fonts', () => {
  it('finds each family of each face, collections included, and skips what is not a font', () => {
    const index = indexFonts([dir, join(dir, 'missing')])
    expect([...index.keys()].sort()).toEqual(['reading mono', 'reading sans', 'reading serif'])
    expect(index.get('reading sans')!.map((f) => f.bold).sort()).toEqual([false, true])
    expect(index.get('reading mono')![0].italic).toBe(true)
  })

  it('gives the file of the family in the style asked for, or null', () => {
    const files = localFontFiles([dir])
    expect(files('Reading Sans', true, false)!.length).toBeGreaterThan(0)
    expect(files('reading sans', false, false)).toEqual(files('Reading Sans', false, true))
    expect(files('Calibri', false, false)).toBeNull()
  })

  it('names the usual folders for each platform', () => {
    expect(fontFolders('win32', { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me')[0]).toMatch(/Windows.Fonts$/)
    expect(fontFolders('darwin', {}, '/Users/me')).toContain('/Library/Fonts')
    expect(fontFolders('linux', {}, '/home/me')).toEqual(['/usr/share/fonts', '/usr/local/share/fonts', '/home/me/.local/share/fonts', '/home/me/.fonts'])
  })

  it('a conversion draws an EMF\u2019s glyph-number text with the font installed', async () => {
    const glyphs = [...WORD].map((c) => 20 + letters.indexOf(c))
    const emf = new EmfWriter({ width: 200, height: 40 })
      .font(1, { face: 'Reading Sans' })
      .select(1)
      .text(4, 20, String.fromCharCode(...glyphs), { options: 0x10, advance: 9 })
      .bytes()
    const conv = createConverter(async () => Buffer.from('%PDF-'), { fontFiles: localFontFiles([dir]) })
    const html = `<p><img alt="Sign" src="data:image/x-emf;base64,${emf.toString('base64')}"></p>`
    const out = await conv.write({ html }, 'html')
    const svg = Buffer.from(/data:image\/svg\+xml;base64,([^"]+)/.exec(out.parts[0].bytes.toString())![1], 'base64').toString()
    expect(svg).toContain(`>${WORD}</text>`)
  })
})
