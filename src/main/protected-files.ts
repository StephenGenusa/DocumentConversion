import { realpathSync, statSync, existsSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { uniqueName } from '../core/naming'

/**
 * The files the user added, which nothing the app writes may replace.
 *
 * A conversion is never a copy. The editor holds what the reader understood,
 * and writing that back over the file it came from deletes the rest: a
 * Markdown file's front matter and comments, a Word file's styles and tracked
 * changes. Convert notes.md to Markdown and the save dialog offered notes.md
 * itself, with only the system's "Replace?" between the user and the loss.
 *
 * A file is matched by where it really is and by what it is: another spelling
 * of its path, a symlink to it or to its folder, and a hard link all name the
 * same file. Over-matching costs a second dialog; under-matching costs a file.
 *
 * Deliberately Electron-free, so it is tested against real files.
 */
interface Guarded {
  /** The path as given, resolved. Kept for a file that has since gone. */
  path: string
  /** Where it really was when added, links followed. */
  real?: string
  /** Device and inode: the file itself, whatever it is called. */
  id?: string
}

const guarded: Guarded[] = []

/** Windows and macOS file systems ignore case by default: NOTES.md is notes.md. */
const foldCase = process.platform === 'win32' || process.platform === 'darwin'
const key = (p: string): string => (foldCase ? p.toLowerCase() : p)

/** Never write over this file. Called for every file read from disk. */
export function protectFile(path: string): void {
  const entry: Guarded = { path: resolve(path) }
  try {
    entry.real = realpathSync(path)
    const s = statSync(entry.real)
    entry.id = `${s.dev}:${s.ino}`
  } catch {
    // Read a moment ago, gone now: the path alone still guards it.
  }
  if (!guarded.some((g) => g.path === entry.path && g.id === entry.id)) guarded.push(entry)
}

/** Where a path really leads, and the file there if there is one. */
async function locate(target: string): Promise<{ real: string; id?: string }> {
  try {
    const real = await realpath(target)
    const s = await stat(real)
    return { real, id: `${s.dev}:${s.ino}` }
  } catch {
    // No file there yet: its folder, links followed, and the name in it.
    try {
      return { real: join(await realpath(dirname(target)), basename(target)) }
    } catch {
      return { real: resolve(target) }
    }
  }
}

/** Whether writing to `target` would replace a file the user added. */
export async function isProtected(target: string): Promise<boolean> {
  if (guarded.length === 0) return false
  const at = await locate(target)
  const given = key(resolve(target))
  return guarded.some(
    (g) => (g.id !== undefined && g.id === at.id) || key(g.real ?? g.path) === key(at.real) || key(g.path) === given,
  )
}

/** `suggested`, or when that is an original, the next free name beside it (notes-1.md). */
export async function safeSavePath(suggested: string): Promise<string> {
  if (!(await isProtected(suggested))) return suggested
  const dir = dirname(suggested)
  const ext = extname(suggested)
  const name = uniqueName(basename(suggested, ext), ext, (n) => existsSync(join(dir, n)))
  return join(dir, name)
}

/**
 * Ask for a path to save to until it is not an original, or the user cancels.
 *
 * `ask` is the save dialog, opened on the path given; `refuse` tells the user
 * the path picked is a file they added and cannot be saved over. The dialog
 * opens on a free name, and opens again after each refusal.
 */
export async function chooseSavePath(
  suggested: string,
  ask: (defaultPath: string) => Promise<string | null>,
  refuse: (picked: string) => Promise<void>,
): Promise<string | null> {
  const offer = await safeSavePath(suggested)
  for (;;) {
    const picked = await ask(offer)
    if (!picked) return null
    if (!(await isProtected(picked))) return picked
    await refuse(picked)
  }
}

/** Forget every protected file. For tests. */
export function resetProtected(): void {
  guarded.length = 0
}
