import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Linux "Open with" for the AppImage.
 *
 * A file manager offers an app under Open With only when a .desktop entry
 * naming the file's type is installed in an applications folder. The .deb
 * installs one; an AppImage is a single file nobody installs, so its entry
 * (with linux.mimeTypes from electron-builder.yml) sat inside the image unseen
 * unless the user ran AppImageLauncher or the like. So each launch of the
 * AppImage writes the entry to ~/.local/share/applications, pointing at
 * wherever the image now is, and its icon beside the user's other icons.
 * Listing a type there does not make the app its default.
 *
 * An entry of the same name that this app did not write (no `X-DocConversion`
 * line) is the user's own, and is left alone.
 */

/** linux.mimeTypes in electron-builder.yml (tests/build/file-associations.test.ts holds them equal). */
export const LINUX_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/msword',
  'application/pdf',
  'application/rtf',
  'text/rtf',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  'application/epub+zip',
  'text/html',
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'text/asciidoc',
  'text/x-rst',
  'text/x-opml+xml',
  'message/rfc822',
  'application/vnd.ms-outlook',
  'application/mbox',
  'text/calendar',
  'text/vcard',
  'text/x-vcard',
  'application/x-ipynb+json',
  'text/vtt',
  'application/x-subrip',
  'image/svg+xml',
  'image/emf',
  'image/wmf',
  'image/x-emf',
  'image/x-wmf',
  'image/tiff',
  'application/json',
  'application/x-ndjson',
  'application/vnd.sqlite3',
  'application/x-sqlite3',
]

/** package.json's desktopName, and the icon's name; also the window's WM_CLASS. */
const ENTRY_NAME = 'docconversion'
const MARKER = 'X-DocConversion=AppImage'

/**
 * One argument of an Exec line: quoted, with the characters the Desktop Entry
 * spec reserves inside quotes escaped, then `%` doubled (a field code
 * otherwise) and backslashes doubled again for the string value itself.
 */
export function execArg(path: string): string {
  const quoted = '"' + path.replace(/["`$\\]/g, '\\$&') + '"'
  return quoted.replace(/%/g, '%%').replace(/\\/g, '\\\\')
}

/** The .desktop entry for an AppImage at `appImage`, as electron-builder writes it inside the image. */
export function desktopEntry(appImage: string, opts: { productName: string; comment: string; version: string }): string {
  // No --no-sandbox, unlike the entry inside the image: the image's AppRun
  // adds it itself when this system needs it.
  return [
    '[Desktop Entry]',
    `Name=${opts.productName}`,
    `Exec=${execArg(appImage)} %U`,
    'Terminal=false',
    'Type=Application',
    `Icon=${ENTRY_NAME}`,
    `StartupWMClass=${ENTRY_NAME}`,
    `X-AppImage-Version=${opts.version}`,
    `Comment=${opts.comment}`,
    `MimeType=${LINUX_MIME_TYPES.join(';')};`,
    'Categories=Office;',
    MARKER,
    '',
  ].join('\n')
}

const readOrNull = (path: string): Buffer | null => {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

/**
 * Writes the entry and icon under `dataHome` if they are missing or out of
 * date. Returns what it did: 'written' (then the caller refreshes the
 * desktop's cache), 'current', or 'theirs' (an entry the user wrote).
 */
export function installDesktopEntry(opts: {
  dataHome: string
  entry: string
  icon: Buffer
}): 'written' | 'current' | 'theirs' {
  const appsDir = join(opts.dataHome, 'applications')
  const entryPath = join(appsDir, `${ENTRY_NAME}.desktop`)
  const iconDir = join(opts.dataHome, 'icons', 'hicolor', '512x512', 'apps')
  const iconPath = join(iconDir, `${ENTRY_NAME}.png`)

  const existing = readOrNull(entryPath)?.toString('utf8')
  if (existing !== undefined && !existing.includes(MARKER)) return 'theirs'
  const iconNow = readOrNull(iconPath)
  if (existing === opts.entry && iconNow?.equals(opts.icon)) return 'current'

  mkdirSync(iconDir, { recursive: true })
  if (!iconNow?.equals(opts.icon)) writeFileSync(iconPath, opts.icon)
  mkdirSync(appsDir, { recursive: true })
  writeFileSync(entryPath, opts.entry)
  return 'written'
}

/**
 * At launch of the window (not the CLI), on Linux, when running from an
 * AppImage. Never throws: Open With is a convenience, not worth a failed start.
 */
export function integrateAppImage(opts: {
  appImage: string | undefined
  iconPath: string
  productName: string
  comment: string
  version: string
}): void {
  if (process.platform !== 'linux' || !opts.appImage) return
  try {
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
    const result = installDesktopEntry({
      dataHome,
      entry: desktopEntry(opts.appImage, opts),
      icon: readFileSync(opts.iconPath),
    })
    if (result !== 'written') return
    // Refresh the MIME-type cache file managers read. Absent on some systems;
    // they then rescan the folder on their own.
    execFile('update-desktop-database', [join(dataHome, 'applications')], () => {})
  } catch (err) {
    console.warn(`Could not add Document Converter to Open With: ${(err as Error).message}`)
  }
}
