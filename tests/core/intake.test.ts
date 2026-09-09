// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DragEvent, ClipboardEvent } from 'react'
import { createIntake, type LoadedPayload, type PaneSource } from '../../src/renderer/src/lib/intake'
import type { ClipboardContent, DetectResult, LoadedInput } from '../../src/preload/types'

const ok = (format: string): DetectResult => ({ kind: 'ok', format }) as DetectResult
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

interface ApiStub {
  detect: ReturnType<typeof vi.fn>
  detectText: ReturnType<typeof vi.fn>
  expandArchive: ReturnType<typeof vi.fn>
  loadUriList: ReturnType<typeof vi.fn>
  openFile: ReturnType<typeof vi.fn>
  readClipboard: ReturnType<typeof vi.fn>
  sanitizeHtml: ReturnType<typeof vi.fn>
  textToHtml: ReturnType<typeof vi.fn>
  dirForFile: ReturnType<typeof vi.fn>
}

let api: ApiStub
let loaded: LoadedPayload[]
let clipboardHtml: string[]
let clipboardSources: (PaneSource | undefined)[]
let urls: string[]
let notices: (string | null)[]

function intake() {
  return createIntake({
    onLoaded: (p) => loaded.push(p),
    onClipboard: (html, source) => {
      clipboardHtml.push(html)
      clipboardSources.push(source)
    },
    onUrl: (url) => urls.push(url),
    onNotice: (n) => notices.push(n),
  })
}

/** Minimal stand-ins for the DOM objects the handlers actually touch. */
const fakeFile = (name: string, content: string): File =>
  ({
    name,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  }) as unknown as File

const dropEvent = (opts: { files?: File[]; data?: Record<string, string> }): DragEvent =>
  ({
    preventDefault: vi.fn(),
    dataTransfer: {
      files: opts.files ?? [],
      getData: (type: string) => opts.data?.[type] ?? '',
    },
  }) as unknown as DragEvent

const pasteEvent = (data: Record<string, string>): ClipboardEvent =>
  ({ clipboardData: { getData: (type: string) => data[type] ?? '' } }) as unknown as ClipboardEvent

beforeEach(() => {
  loaded = []
  clipboardHtml = []
  clipboardSources = []
  urls = []
  notices = []
  api = {
    detect: vi.fn(async () => ok('md')),
    detectText: vi.fn(async () => ok('txt')),
    expandArchive: vi.fn(async () => [] as LoadedInput[]),
    loadUriList: vi.fn(async () => null),
    openFile: vi.fn(async () => null),
    readClipboard: vi.fn(async () => ({ kind: 'empty' }) as ClipboardContent),
    sanitizeHtml: vi.fn(async (html: string) => `sanitized:${html}`),
    textToHtml: vi.fn(async (text: string, format: string) => `rendered(${format}):${text}`),
    dirForFile: vi.fn(() => '/home/me/docs'),
  }
  ;(window as unknown as { api: ApiStub }).api = api
})

describe('intake: dropping files', () => {
  it('loads every dropped file, in order', async () => {
    api.detect.mockImplementation(async ({ filename }: { filename?: string }) =>
      ok(filename?.endsWith('.csv') ? 'csv' : 'md'),
    )
    await intake().onDrop(dropEvent({ files: [fakeFile('a.md', '# A'), fakeFile('b.csv', 'x,y')] }))
    expect(loaded.map((l) => l.filename)).toEqual(['a.md', 'b.csv'])
    expect(loaded.map((l) => l.detected)).toEqual(['md', 'csv'])
    expect(loaded[0].base64).toBe(b64('# A'))
  })

  it('remembers the folder a dropped file came from', async () => {
    await intake().onDrop(dropEvent({ files: [fakeFile('a.md', '# A')] }))
    expect(api.dirForFile).toHaveBeenCalled()
    expect(loaded[0].sourceDir).toBe('/home/me/docs')
  })

  it('treats a file with no folder on disk as having no origin', async () => {
    api.dirForFile.mockReturnValue('')
    await intake().onDrop(dropEvent({ files: [fakeFile('a.md', '# A')] }))
    expect(loaded[0].sourceDir).toBeUndefined()
  })

  it("gives a zip's entries the folder the archive itself came from", async () => {
    api.detect.mockResolvedValue({ kind: 'archive' })
    api.expandArchive.mockResolvedValue([
      { filename: 'spec.md', base64: b64('# spec'), detected: ok('md') },
    ] as LoadedInput[])
    await intake().onDrop(dropEvent({ files: [fakeFile('bundle.zip', 'PK')] }))
    expect(api.expandArchive).toHaveBeenCalledWith({
      base64: b64('PK'),
      filename: 'bundle.zip',
      sourceDir: '/home/me/docs',
    })
    expect(loaded[0].sourceDir).toBe('/home/me/docs')
  })

  it('names the file when one is unsupported, and does not load it', async () => {
    api.detect.mockResolvedValue({ kind: 'unsupported', reason: 'Legacy PowerPoint (.ppt) is not supported' })
    await intake().onDrop(dropEvent({ files: [fakeFile('old.ppt', 'junk')] }))
    expect(loaded).toHaveLength(0)
    expect(notices.at(-1)).toBe('old.ppt: Legacy PowerPoint (.ppt) is not supported')
  })

  it('clears a stale notice once a good file loads', async () => {
    const i = intake()
    api.detect.mockResolvedValueOnce({ kind: 'unsupported', reason: 'nope' })
    await i.onDrop(dropEvent({ files: [fakeFile('bad.ppt', 'x')] }))
    await i.onDrop(dropEvent({ files: [fakeFile('good.md', '# ok')] }))
    expect(notices.at(-1)).toBeNull()
  })
})

describe('intake: archives', () => {
  it('expands a dropped zip into its convertible entries', async () => {
    api.detect.mockResolvedValue({ kind: 'archive' })
    api.expandArchive.mockResolvedValue([
      { filename: 'spec.md', base64: b64('# spec'), detected: ok('md') },
      { filename: 'data.csv', base64: b64('a,b'), detected: ok('csv') },
    ] as LoadedInput[])
    await intake().onDrop(dropEvent({ files: [fakeFile('bundle.zip', 'PK')] }))
    expect(loaded.map((l) => l.filename)).toEqual(['spec.md', 'data.csv'])
    expect(notices.at(-1)).toBeNull()
    expect(api.expandArchive).toHaveBeenCalledWith({
      base64: b64('PK'),
      filename: 'bundle.zip',
      sourceDir: '/home/me/docs',
    })
  })

  it('reports how many entries were skipped', async () => {
    api.detect.mockResolvedValue({ kind: 'archive' })
    api.expandArchive.mockResolvedValue([
      { filename: 'spec.md', base64: b64('# spec'), detected: ok('md') },
      { filename: 'a.exe', base64: '', detected: { kind: 'unsupported', reason: 'x' } },
      { filename: 'b.bin', base64: '', detected: { kind: 'unsupported', reason: 'x' } },
    ] as LoadedInput[])
    await intake().onDrop(dropEvent({ files: [fakeFile('bundle.zip', 'PK')] }))
    expect(loaded).toHaveLength(1)
    expect(notices.at(-1)).toBe('Added 1 file · skipped 2 unsupported')
  })

  it('says so when an archive has nothing convertible', async () => {
    api.detect.mockResolvedValue({ kind: 'archive' })
    api.expandArchive.mockResolvedValue([
      { filename: 'a.exe', base64: '', detected: { kind: 'unsupported', reason: 'x' } },
    ] as LoadedInput[])
    await intake().onDrop(dropEvent({ files: [fakeFile('bundle.zip', 'PK')] }))
    expect(loaded).toHaveLength(0)
    expect(notices.at(-1)).toBe('That archive has no convertible files')
  })
})

describe('intake: dropped text and uri-lists', () => {
  it('loads file:// uri-lists through the main process', async () => {
    api.loadUriList.mockResolvedValue([
      { filename: 'x.md', base64: b64('# x'), detected: ok('md') },
      { filename: 'y.md', base64: b64('# y'), detected: ok('md') },
    ] as LoadedInput[])
    await intake().onDrop(dropEvent({ data: { 'text/uri-list': 'file:///tmp/x.md\nfile:///tmp/y.md' } }))
    expect(api.loadUriList).toHaveBeenCalled()
    expect(loaded.map((l) => l.filename)).toEqual(['x.md', 'y.md'])
  })

  it('treats a dropped file:// URL delivered as plain text as a uri-list', async () => {
    api.loadUriList.mockResolvedValue([{ filename: 'z.md', base64: b64('# z'), detected: ok('md') }] as LoadedInput[])
    await intake().onDrop(dropEvent({ data: { 'text/plain': 'file:///tmp/z.md' } }))
    expect(api.loadUriList).toHaveBeenCalled()
    expect(loaded).toHaveLength(1)
  })

  it('routes a dropped http URL to the URL loader, not to text detection', async () => {
    await intake().onDrop(dropEvent({ data: { 'text/plain': '  https://example.com/spec  ' } }))
    expect(urls).toEqual(['https://example.com/spec'])
    expect(loaded).toHaveLength(0)
    expect(api.detectText).not.toHaveBeenCalled()
  })

  it('renders ordinary dropped text into the edit pane', async () => {
    api.detectText.mockResolvedValue(ok('md'))
    await intake().onDrop(dropEvent({ data: { 'text/plain': '# Heading' } }))
    expect(clipboardHtml).toEqual(['rendered(md):# Heading'])
    expect(loaded).toHaveLength(0)
  })

  it('ignores an empty drop', async () => {
    await intake().onDrop(dropEvent({}))
    expect(loaded).toHaveLength(0)
    expect(urls).toHaveLength(0)
  })
})

describe('intake: pasting', () => {
  it('prefers the formatted flavor and sanitizes it before the editor sees it', async () => {
    await intake().onPaste(pasteEvent({ 'text/html': '<p>rich</p>', 'text/plain': 'rich' }))
    expect(api.sanitizeHtml).toHaveBeenCalledWith('<p>rich</p>')
    expect(clipboardHtml).toEqual(['sanitized:<p>rich</p>'])
    expect(loaded).toHaveLength(0)
  })

  it('falls back to the plain flavor when there is no HTML flavor', async () => {
    api.detectText.mockResolvedValue(ok('txt'))
    await intake().onPaste(pasteEvent({ 'text/plain': 'just words' }))
    expect(api.textToHtml).toHaveBeenCalledWith('just words', 'txt')
    expect(clipboardHtml).toEqual(['rendered(txt):just words'])
    expect(loaded).toHaveLength(0)
  })

  it('opens pasted markdown in the pane as formatted text, not as an input card', async () => {
    api.detectText.mockResolvedValue(ok('md'))
    await intake().onPaste(pasteEvent({ 'text/plain': '# Heading' }))
    expect(api.textToHtml).toHaveBeenCalledWith('# Heading', 'md')
    expect(clipboardHtml).toEqual(['rendered(md):# Heading'])
    expect(loaded).toHaveLength(0)
  })

  it('names pane content that came from pasted text', async () => {
    api.detectText.mockResolvedValue(ok('md'))
    await intake().onPaste(pasteEvent({ 'text/plain': '# Heading' }))
    expect(clipboardSources.at(-1)).toEqual({ label: 'Pasted text', filename: 'document' })
  })

  it('leaves rich clipboard HTML named as the clipboard', async () => {
    await intake().onPaste(pasteEvent({ 'text/html': '<p>rich</p>', 'text/plain': 'rich' }))
    expect(clipboardSources.at(-1)).toBeUndefined()
    expect(api.textToHtml).not.toHaveBeenCalled()
  })

  it('clears a stale notice when pasted text opens the pane', async () => {
    const i = intake()
    api.detect.mockResolvedValueOnce({ kind: 'unsupported', reason: 'nope' })
    await i.onDrop(dropEvent({ files: [fakeFile('bad.ppt', 'x')] }))
    api.detectText.mockResolvedValue(ok('md'))
    await i.onPaste(pasteEvent({ 'text/plain': '# fresh' }))
    expect(notices.at(-1)).toBeNull()
  })

  it('still loads pasted text detected as another format as an input card', async () => {
    api.detectText.mockResolvedValue(ok('eml'))
    await intake().onPaste(pasteEvent({ 'text/plain': 'From: a@b.example\n\nbody' }))
    expect(loaded).toHaveLength(1)
    expect(clipboardHtml).toHaveLength(0)
    expect(api.textToHtml).not.toHaveBeenCalled()
  })

  it('reads markdown from the plain flavor when the HTML flavor is only a whitespace wrapper', async () => {
    // What a browser or chat window puts on the clipboard when you copy
    // markdown SOURCE: the pipes are literal characters in both flavors.
    api.detectText.mockResolvedValue(ok('md'))
    await intake().onPaste(
      pasteEvent({
        'text/html': `<meta charset='utf-8'><span style="white-space:pre-wrap">| a | b |<br>|---|---|</span>`,
        'text/plain': '| a | b |\n|---|---|',
      }),
    )
    expect(api.textToHtml).toHaveBeenCalledWith('| a | b |\n|---|---|', 'md')
    expect(api.sanitizeHtml).not.toHaveBeenCalled()
  })

  it('still prefers the HTML flavor when it carries real formatting', async () => {
    await intake().onPaste(
      pasteEvent({ 'text/html': '<p>rich <b>text</b></p>', 'text/plain': 'rich text' }),
    )
    expect(api.sanitizeHtml).toHaveBeenCalledWith('<p>rich <b>text</b></p>')
    expect(api.textToHtml).not.toHaveBeenCalled()
  })

  it('uses the HTML flavor when there is no plain flavor to fall back to', async () => {
    await intake().onPaste(pasteEvent({ 'text/html': '<span>only html</span>' }))
    expect(api.sanitizeHtml).toHaveBeenCalledWith('<span>only html</span>')
  })

  it('gives pasted text no folder of its own', async () => {
    api.detectText.mockResolvedValue(ok('eml'))
    await intake().onPaste(pasteEvent({ 'text/plain': 'From: a@b.example\n\nbody' }))
    expect(loaded[0].sourceDir).toBeUndefined()
  })

  it('routes a pasted URL to the URL loader', async () => {
    await intake().onPaste(pasteEvent({ 'text/plain': 'https://example.com/page' }))
    expect(urls).toEqual(['https://example.com/page'])
  })
})

describe('intake: dialog and clipboard button', () => {
  it('loads every file chosen in the open dialog', async () => {
    api.openFile.mockResolvedValue([
      { filename: 'a.md', base64: b64('a'), detected: ok('md') },
      { filename: 'b.md', base64: b64('b'), detected: ok('md') },
    ] as LoadedInput[])
    await intake().openDialog()
    expect(loaded).toHaveLength(2)
  })

  it('does nothing when the dialog is cancelled', async () => {
    api.openFile.mockResolvedValue(null)
    await intake().openDialog()
    expect(loaded).toHaveLength(0)
  })

  it('opens rich clipboard HTML in the pane', async () => {
    api.readClipboard.mockResolvedValue({ kind: 'html', html: '<p>from teams</p>' })
    await intake().pasteFromClipboard()
    // Main sanitizes before returning, so it is used as-is.
    expect(clipboardHtml).toEqual(['<p>from teams</p>'])
    expect(api.sanitizeHtml).not.toHaveBeenCalled()
  })

  it('renders plain clipboard text into the pane', async () => {
    api.readClipboard.mockResolvedValue({ kind: 'text', text: '# notes' })
    api.detectText.mockResolvedValue(ok('md'))
    await intake().pasteFromClipboard()
    expect(clipboardHtml).toEqual(['rendered(md):# notes'])
    expect(loaded).toHaveLength(0)
  })

  it('explains the image and empty clipboard cases', async () => {
    api.readClipboard.mockResolvedValue({ kind: 'image' })
    await intake().pasteFromClipboard()
    expect(notices.at(-1)).toMatch(/image/i)
    api.readClipboard.mockResolvedValue({ kind: 'empty' })
    await intake().pasteFromClipboard()
    expect(notices.at(-1)).toMatch(/no text/i)
  })
})
