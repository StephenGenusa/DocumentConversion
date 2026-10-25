import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { allFileUrisToPaths } from '../core/uri'

/**
 * Files the OS hands the app rather than the window: dropped on its Dock or
 * dock icon, dropped on its shortcut, or chosen with Open With.
 *
 * Windows and Linux pass them as command-line arguments, to a fresh launch or
 * to the second instance that hands them to the running one. The same argv
 * carries Chromium's switches, AppImage's `--no-sandbox`, and in development
 * the app folder (`electron .`); a .desktop entry's `%U` passes `file://`
 * URIs. Only an argument that names an existing file is kept.
 *
 * Deliberately Electron-free, so it is tested against real files.
 */
export function pathsFromArgs(args: string[], cwd: string): string[] {
  const out: string[] = []
  for (const arg of args) {
    if (!arg || arg.startsWith('-')) continue
    const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? allFileUrisToPaths(arg)[0] : resolve(cwd, arg)
    if (path === undefined || out.includes(path)) continue
    try {
      if (statSync(path).isFile()) out.push(path)
    } catch {
      // Gone, or not ours to read: not a file the user gave the app.
    }
  }
  return out
}

/**
 * Paths waiting for a window that can take them.
 *
 * A launch with a file, or a macOS `open-file` before the app is ready, comes
 * before the page has mounted: sent then, it would be lost. So paths queue
 * until the page asks for them (`take`), and only after that are they sent as
 * they come. `detach` when the window closes, so they queue again for the
 * next one.
 */
export function createOpenQueue(deliver: (paths: string[]) => void): {
  add(paths: string[]): void
  take(): string[]
  detach(): void
} {
  let pending: string[] = []
  let attached = false
  return {
    add(paths) {
      if (paths.length === 0) return
      if (attached) deliver(paths)
      else pending.push(...paths)
    },
    take() {
      attached = true
      const out = pending
      pending = []
      return out
    },
    detach() {
      attached = false
    },
  }
}
