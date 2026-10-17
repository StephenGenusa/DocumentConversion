import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import type { FontFiles } from '../core/metafile'
import { sfntFaces, sfntName } from '../core/metafile/sfnt'

/*
 * The fonts installed on this computer, found by family name: what an
 * EMF's text given as glyph numbers is read with (ConverterDeps.fontFiles,
 * core/metafile/fonts.ts). Only the family the picture names is any use
 * (glyph numbers are that font's own), so this looks the family up by its
 * exact name and offers no substitute.
 *
 * The folders are read once, on the first lookup (only a picture with
 * such text asks), and only each font's 'name' table is read then; the
 * one file a picture needs is read whole when asked for. Bounded: so many
 * files, so deep, each file so large; links to folders are not followed.
 */

const FONT_TYPES = new Set(['.ttf', '.otf', '.ttc', '.otc'])
const MAX_FILES = 20_000
const MAX_DEPTH = 6
/** The largest font file read whole (CJK collections run to ~50 MB). */
const MAX_FONT_BYTES = 80 * 1024 * 1024
const MAX_NAME_BYTES = 1024 * 1024
const MAX_FACES = 64

/** Where this platform keeps its fonts, the user's own included. */
export function fontFolders(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (platform === 'win32') {
    const windows = env.WINDIR || env.SystemRoot || 'C:\\Windows'
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return [join(windows, 'Fonts'), join(local, 'Microsoft', 'Windows', 'Fonts')]
  }
  if (platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library', 'Fonts')]
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share')
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(data, 'fonts'), join(home, '.fonts')]
}

interface Face {
  path: string
  bold: boolean
  italic: boolean
}

/** FontFiles over the fonts in `folders` (fontFolders() unless given). */
export function localFontFiles(folders: string[] = fontFolders()): FontFiles {
  let index: Map<string, Face[]> | null = null
  return (family, bold, italic) => {
    index ??= indexFonts(folders)
    const faces = index.get(family.trim().toLowerCase())
    if (!faces?.length) return null
    const score = (f: Face): number => (f.bold === bold ? 2 : 0) + (f.italic === italic ? 1 : 0)
    const best = faces.reduce((a, b) => (score(b) > score(a) ? b : a))
    try {
      if (statSync(best.path).size > MAX_FONT_BYTES) return null
      return readFileSync(best.path)
    } catch {
      return null
    }
  }
}

/** Every font file under `folders`, by each of its families (lower case). */
export function indexFonts(folders: string[]): Map<string, Face[]> {
  const index = new Map<string, Face[]>()
  let files = 0
  const walk = (dir: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files >= MAX_FILES) return
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) walk(path, depth + 1)
      } else if ((e.isFile() || e.isSymbolicLink()) && FONT_TYPES.has(extname(e.name).toLowerCase())) {
        files++
        for (const { families, styles } of fontNames(path)) {
          const face = { path, bold: /bold|black|heavy/.test(styles), italic: /italic|oblique/.test(styles) }
          for (const family of families) {
            const key = family.toLowerCase()
            const list = index.get(key) ?? []
            if (!list.some((f) => f.path === path && f.bold === face.bold && f.italic === face.italic)) list.push(face)
            index.set(key, list)
          }
        }
      }
    }
  }
  for (const folder of folders) walk(folder, 0)
  return index
}

/** The families and style of each face in a font file, reading only its headers and 'name' tables. */
function fontNames(path: string): { families: string[]; styles: string }[] {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const file = fd
    const size = statSync(path).size
    const read = (at: number, n: number): Buffer => {
      const len = Math.max(0, Math.min(n, size - at))
      const b = Buffer.alloc(len)
      if (len) readSync(file, b, 0, len, at)
      return b
    }
    // A collection lists where its faces start; a single font is one face at 0.
    const head = read(0, 12 + MAX_FACES * 4)
    if (head.length < 12) return []
    const offsets: number[] = []
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      const n = Math.min(head.readUInt32BE(8), MAX_FACES)
      for (let i = 0; i < n && 16 + i * 4 <= head.length; i++) offsets.push(head.readUInt32BE(12 + i * 4))
    } else offsets.push(0)
    const out: { families: string[]; styles: string }[] = []
    for (const at of offsets) {
      const name = nameEntry(read(at, 12 + 256 * 16))
      if (!name || name.length > MAX_NAME_BYTES || name.offset + name.length > size) continue
      const bytes = read(name.offset, name.length)
      const names = sfntName(bytes, new Map([['name', { offset: 0, length: bytes.length }]]))
      if (names?.families.length) out.push({ families: names.families, styles: names.styles.join(' ') })
    }
    return out
  } catch {
    return []
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The 'name' table's place, from a face's table directory (null when it is no sfnt). */
function nameEntry(dir: Buffer): { offset: number; length: number } | null {
  if (dir.length < 12 || sfntFaces(dir).length !== 1) return null
  const n = Math.min(dir.readUInt16BE(4), 256)
  for (let i = 0; i < n && 12 + i * 16 + 16 <= dir.length; i++) {
    const at = 12 + i * 16
    if (dir.toString('latin1', at, at + 4) === 'name') return { offset: dir.readUInt32BE(at + 8), length: dir.readUInt32BE(at + 12) }
  }
  return null
}
