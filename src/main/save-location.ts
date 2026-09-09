import { dirname, join } from 'node:path'

/**
 * Where a save dialog should open.
 *
 * A converted file belongs next to the file it came from — that is where the
 * user was working, and it is what "save" means everywhere else. The dialog
 * used to be handed a bare filename, so the OS picked the folder and the
 * location appeared to reset on every conversion.
 *
 * Clipboard, URL and pasted-text inputs have no folder of their own, so they
 * fall back to wherever the last save actually landed. That is remembered for
 * the life of the process only; there is no settings file in this app to
 * persist it to, and inventing one for this would be a larger change than the
 * problem warrants.
 */
let lastSaveDir: string | undefined

/** The folder to open in, or undefined to leave the choice to the OS. */
export function defaultSaveDir(sourceDir?: string): string | undefined {
  return sourceDir?.trim() || lastSaveDir
}

/** Record a folder that was saved into — a batch picks one directly. */
export function rememberDir(dir: string): void {
  if (dir && dir !== '.') lastSaveDir = dir
}

/**
 * Record where a save landed, given the saved file's path — which is what the
 * save dialog hands back. A path with no folder in it, a bare filename, names
 * nowhere to return to, so it is ignored rather than stored as ".".
 */
export function rememberSaveDir(savedFilePath: string): void {
  rememberDir(dirname(savedFilePath))
}

/** The full path to suggest: `name` in the folder from `defaultSaveDir`. */
export function defaultSavePath(sourceDir: string | undefined, name: string): string {
  const dir = defaultSaveDir(sourceDir)
  return dir ? join(dir, name) : name
}

/** Forget the remembered folder. For tests, and for a full app reset. */
export function resetSaveLocation(): void {
  lastSaveDir = undefined
}
