import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, symlink, link, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { protectFile, isProtected, safeSavePath, chooseSavePath, resetProtected } from '../../src/main/protected-files'

/**
 * A conversion is never a copy: the editor holds what the reader understood,
 * and writing that back over the file it came from deletes the rest (a
 * Markdown file's front matter and comments, a Word file's styles and
 * tracked changes). Convert notes.md to Markdown and the save dialog offered
 * notes.md itself, with only the system's "Replace?" in the way.
 *
 * So a file the user added is never written to, by any route: picked in the
 * dialog, typed back in, or reached through another name for the same file.
 *
 * Real files in a real temp directory; nothing here is mocked.
 */
let dir: string
let original: string

beforeEach(async () => {
  resetProtected()
  dir = await mkdtemp(join(tmpdir(), 'docconv-protected-'))
  original = join(dir, 'notes.md')
  await writeFile(original, '---\ntitle: Notes\n---\n\n# Notes\n')
  protectFile(original)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('isProtected', () => {
  it('protects a file the user added', async () => {
    expect(await isProtected(original)).toBe(true)
  })

  it('sees through another spelling of the same path', async () => {
    expect(await isProtected(join(dir, '.', 'sub', '..', 'notes.md'))).toBe(true)
  })

  it('sees through a symlink to it, and a link to its folder', async () => {
    await symlink(original, join(dir, 'alias.md'))
    await symlink(dir, join(dir, 'folder-link'))
    expect(await isProtected(join(dir, 'alias.md'))).toBe(true)
    expect(await isProtected(join(dir, 'folder-link', 'notes.md'))).toBe(true)
  })

  it('sees through a hard link, which is the same file under another name', async () => {
    await link(original, join(dir, 'hard.md'))
    expect(await isProtected(join(dir, 'hard.md'))).toBe(true)
  })

  it('leaves a new name free, and an existing file the user did not add', async () => {
    await writeFile(join(dir, 'other.md'), 'x')
    expect(await isProtected(join(dir, 'notes-1.md'))).toBe(false)
    expect(await isProtected(join(dir, 'other.md'))).toBe(false)
    expect(await isProtected(join(dir, 'notes.pdf'))).toBe(false)
  })

  it('still protects the path when the original has been deleted since', async () => {
    await rm(original)
    expect(await isProtected(original)).toBe(true)
  })

  it('protects every file added, not only the last', async () => {
    const second = join(dir, 'report.docx')
    await writeFile(second, 'docx bytes')
    protectFile(second)
    expect(await isProtected(original)).toBe(true)
    expect(await isProtected(second)).toBe(true)
  })
})

describe('safeSavePath', () => {
  it('suggests the next free name instead of the original', async () => {
    expect(await safeSavePath(original)).toBe(join(dir, 'notes-1.md'))
  })

  it('skips names already taken', async () => {
    await writeFile(join(dir, 'notes-1.md'), 'earlier copy')
    expect(await safeSavePath(original)).toBe(join(dir, 'notes-2.md'))
  })

  it('keeps any suggestion that is not an original', async () => {
    expect(await safeSavePath(join(dir, 'notes.pdf'))).toBe(join(dir, 'notes.pdf'))
  })
})

describe('chooseSavePath', () => {
  /** A save dialog that answers each time with the next of `answers`, recording what it was offered. */
  function dialog(answers: (string | null)[]): { ask: (p: string) => Promise<string | null>; offered: string[]; refused: string[]; refuse: (p: string) => Promise<void> } {
    const offered: string[] = []
    const refused: string[] = []
    return {
      offered,
      refused,
      ask: async (p) => {
        offered.push(p)
        return answers.shift() ?? null
      },
      refuse: async (p) => {
        refused.push(p)
      },
    }
  }

  it('opens on a free name, never the original', async () => {
    const d = dialog([join(dir, 'notes-1.md')])
    expect(await chooseSavePath(original, d.ask, d.refuse)).toBe(join(dir, 'notes-1.md'))
    expect(d.offered).toEqual([join(dir, 'notes-1.md')])
    expect(d.refused).toEqual([])
  })

  it('refuses the original typed back in, says so, and asks again', async () => {
    const d = dialog([original, original, join(dir, 'copy.md')])
    expect(await chooseSavePath(original, d.ask, d.refuse)).toBe(join(dir, 'copy.md'))
    expect(d.refused).toEqual([original, original])
    expect(d.offered).toEqual([join(dir, 'notes-1.md'), join(dir, 'notes-1.md'), join(dir, 'notes-1.md')])
  })

  it('a cancel after a refusal is a cancel, and nothing is written', async () => {
    const d = dialog([original, null])
    expect(await chooseSavePath(original, d.ask, d.refuse)).toBeNull()
    expect(await readFile(original, 'utf8')).toContain('title: Notes')
  })

  it('lets an existing file the user did not add be chosen (the system asks to replace it)', async () => {
    const other = join(dir, 'other.md')
    await mkdir(join(dir, 'x'))
    await writeFile(other, 'x')
    const d = dialog([other])
    expect(await chooseSavePath(original, d.ask, d.refuse)).toBe(other)
  })
})
