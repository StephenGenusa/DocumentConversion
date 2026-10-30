import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LINUX_MIME_TYPES, desktopEntry, execArg, installDesktopEntry } from '../../src/main/desktop-entry'

const yml = readFileSync('electron-builder.yml', 'utf8')
const nsh = readFileSync('build/installer.nsh', 'utf8')

/** The extensions in mac.fileAssociations, in order. */
function macExtensions(): string[] {
  const out: string[] = []
  for (const m of yml.matchAll(/^\s*- \{ name: [^,]+, ext: (\[[^\]]*\]|[a-z0-9]+),/gm)) {
    out.push(...m[1].replace(/[[\]]/g, '').split(',').map((e) => e.trim()))
  }
  return out
}

/** linux.mimeTypes, in order. */
function linuxMimeTypes(): string[] {
  const block = /^ {2}mimeTypes:\n((?: {4}- .+\n)+)/m.exec(yml)?.[1] ?? ''
  return [...block.matchAll(/- (.+)/g)].map((m) => m[1].trim())
}

describe('file associations', () => {
  it('offers the Windows installer the same extensions as the Mac app', () => {
    const windows = [...nsh.matchAll(/!insertmacro \$\{MACRO\} (\S+)/g)].map((m) => m[1])
    expect(macExtensions().length).toBeGreaterThan(50)
    expect(windows).toEqual(macExtensions())
  })

  it("never makes the Windows app an extension's default", () => {
    // Writing `Software\Classes\.<ext>`'s own (default) value is what claims it.
    expect(nsh).not.toMatch(/WriteRegStr SHCTX "Software\\Classes\\\.\$\{EXT\}" ""/)
    expect(yml).not.toMatch(/^fileAssociations:/m)
    expect(yml).not.toMatch(/^ {2}fileAssociations:[\s\S]*?^win:/m)
  })

  it('removes on uninstall only the values the installer added under each extension', () => {
    expect(nsh).toMatch(/DeleteRegValue SHCTX "Software\\Classes\\\.\$\{EXT\}\\OpenWithProgids" "\$\{DOCCONV_PROGID\}"/)
    expect(nsh).not.toMatch(/DeleteRegKey[^\n]*\\\.\$\{EXT\}/)
  })

  it("writes the AppImage's entry with the Linux build's MIME types", () => {
    expect(LINUX_MIME_TYPES).toEqual(linuxMimeTypes())
  })
})

describe('AppImage desktop entry', () => {
  const opts = { productName: 'Document Converter', comment: 'Convert documents', version: '9.8.7' }

  it('quotes the path and escapes what the Desktop Entry spec reserves', () => {
    expect(execArg('/home/a b/x.AppImage')).toBe('"/home/a b/x.AppImage"')
    expect(execArg('/x/100%/a$b"c`d\\e')).toBe('"/x/100%%/a\\\\$b\\\\"c\\\\`d\\\\\\\\e"')
  })

  it('opens files as URIs and names the window class', () => {
    const entry = desktopEntry('/opt/apps/dc.AppImage', opts)
    expect(entry).toContain('Exec="/opt/apps/dc.AppImage" %U\n')
    expect(entry).toContain('StartupWMClass=docconversion\n')
    expect(entry).toMatch(/^MimeType=.*;text\/markdown;.*;$/m)
    expect(entry).not.toContain('--no-sandbox')
  })

  let dataHome: string
  beforeEach(() => {
    dataHome = mkdtempSync(join(tmpdir(), 'docconv-desktop-'))
  })
  afterEach(() => rmSync(dataHome, { recursive: true, force: true }))

  const icon = Buffer.from('png bytes')
  const entryPath = () => join(dataHome, 'applications', 'docconversion.desktop')
  const iconPath = () => join(dataHome, 'icons', 'hicolor', '512x512', 'apps', 'docconversion.png')

  it('writes the entry and icon, then leaves them be until something changes', () => {
    const entry = desktopEntry('/a/dc.AppImage', opts)
    expect(installDesktopEntry({ dataHome, entry, icon })).toBe('written')
    expect(readFileSync(entryPath(), 'utf8')).toBe(entry)
    expect(readFileSync(iconPath())).toEqual(icon)
    expect(installDesktopEntry({ dataHome, entry, icon })).toBe('current')

    const moved = desktopEntry('/b/dc.AppImage', opts)
    expect(installDesktopEntry({ dataHome, entry: moved, icon })).toBe('written')
    expect(readFileSync(entryPath(), 'utf8')).toBe(moved)
  })

  it("leaves alone an entry the user wrote", () => {
    mkdirSync(join(dataHome, 'applications'), { recursive: true })
    writeFileSync(entryPath(), '[Desktop Entry]\nName=Mine\n')
    expect(installDesktopEntry({ dataHome, entry: desktopEntry('/a/dc.AppImage', opts), icon })).toBe('theirs')
    expect(readFileSync(entryPath(), 'utf8')).toBe('[Desktop Entry]\nName=Mine\n')
  })
})
