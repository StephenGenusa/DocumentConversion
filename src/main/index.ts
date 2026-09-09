import { app, shell, BrowserWindow, ipcMain, dialog, clipboard } from 'electron'
import { join, dirname } from 'path'
import { writeFile, readFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { detect } from '../core/detect'
import { allFileUrisToPaths } from '../core/uri'
import { EXTENSIONS, TABLE_TARGETS, type SourceFormat, type TargetFormat } from '../core/types'
import type { DetectResult } from '../core/detect'
import { normalizePdfOptions } from '../core/pdf-options'
import { ConversionError } from '../core/errors'
import { createJob, cancelJob, finishJob, runBatch, throwIfCancelled, type BatchRow } from './jobs'
import { clipboardFlavors, mergeToTarget, readForConversion, runConversion } from './conversion'
import { runCli } from './cli-run'
import { isBinaryTarget } from '../core/target-validity'
import { expandZipArchive } from '../core/zip-expand'

interface BatchItemPayload {
  base64: string
  filename?: string
  source: SourceFormat
  ocrLanguage?: string
  ocr?: unknown
  sourceDir?: string
}
import { downloadPack, listPacks, removePack } from './ocr-packs'
import { normalizeSlideOptions } from '../core/slides'
import { sanitizeToHub } from '../core/allowlist'
import { renderEditableText } from '../core/text-intake'
import { defaultSavePath, defaultSaveDir, rememberDir, rememberSaveDir } from './save-location'
import { shouldUseHtmlFlavor } from '../core/paste-flavors'
import { loadUrl } from '../core/readers/url'
import { lookup as dnsLookup } from 'node:dns/promises'
import type { ReadContext } from '../core/types'
import type { GuardedFetchDeps } from '../core/net/guarded-fetch'

// CLI mode: `DocumentConverter convert ...` (packaged, argv[1]) or
// `electron <app-path> convert ...` (dev, argv[2]).
const CLI_WORDS = ['convert', '--help', '-h', 'help', '--version', '-v']
const cliArgIndex = CLI_WORDS.includes(process.argv[1])
  ? 1
  : CLI_WORDS.includes(process.argv[2])
    ? 2
    : -1
const isCli = cliArgIndex >= 0

if (isCli) {
  // A dependency still uses node's deprecated punycode, and pdfjs narrates
  // font quirks. Both went to stderr on every run, so any script treating
  // stderr as failure misfired on a successful conversion.
  process.noDeprecation = true
}

const urlFetchDeps: GuardedFetchDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((r) => r.address),
}

// Grow-to-fit is suppressed once the user resizes manually (spec §F0: no snap-back).
const resizeState = new WeakMap<BrowserWindow, { lastSet: [number, number]; userResized: boolean; base: number }>()

const FILTERS: Record<TargetFormat, { name: string; extensions: string[] }> = {
  txt: { name: 'Plain text', extensions: ['txt'] },
  md: { name: 'Markdown', extensions: ['md', 'markdown'] },
  docx: { name: 'Word document', extensions: ['docx'] },
  pdf: { name: 'PDF', extensions: ['pdf'] },
  html: { name: 'HTML', extensions: ['html', 'htm'] },
  epub: { name: 'EPUB e-book', extensions: ['epub'] },
  revealjs: { name: 'Slides (HTML)', extensions: ['html'] },
  azw3: { name: 'Kindle e-book (AZW3)', extensions: ['azw3'] },
  azw4: { name: 'Kindle print replica (AZW4)', extensions: ['azw4'] },
  csv: { name: 'CSV', extensions: ['csv'] },
  json: { name: 'JSON', extensions: ['json'] },
  xlsx: { name: 'Excel workbook', extensions: ['xlsx'] },
}

function baseName(filename?: string): string {
  if (!filename) return 'document'
  const noPath = filename.split(/[\\/]/).pop() ?? filename
  return noPath.replace(/\.[^.]+$/, '') || 'document'
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 820,
    height: 640,
    minWidth: 560,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    const [w, h] = mainWindow.getContentSize()
    resizeState.set(mainWindow, { lastSet: [w, h], userResized: false, base: h })
    mainWindow.on('resize', () => {
      const st = resizeState.get(mainWindow)
      if (!st) return
      const [cw, ch] = mainWindow.getContentSize()
      if (Math.abs(cw - st.lastSet[0]) > 2 || Math.abs(ch - st.lastSet[1]) > 2) st.userResized = true
    })
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

interface LoadedFile {
  filename: string
  base64: string
  detected: DetectResult
  sourceDir?: string
}

/** A ZIP expands into its entries; everything else is a single input. */
async function loadBytes(bytes: Buffer, filename: string, sourceDir?: string): Promise<LoadedFile[]> {
  const detected = detect(bytes, filename)
  if (detected.kind !== 'archive') return [{ filename, base64: bytes.toString('base64'), detected, sourceDir }]
  const entries = await expandZipArchive(bytes)
  // An entry has no folder of its own, so it inherits the archive's.
  return entries.map((entry) => ({
    filename: entry.filename,
    base64: entry.bytes.toString('base64'),
    detected: detect(entry.bytes, entry.filename),
    sourceDir,
  }))
}

async function loadPath(path: string): Promise<LoadedFile[]> {
  const bytes = await readFile(path)
  return loadBytes(bytes, path.split(/[\\/]/).pop() ?? path, dirname(path))
}

function registerIpc(): void {
  ipcMain.handle('app:open-file', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return (await Promise.all(res.filePaths.map(loadPath))).flat()
  })

  // Renderer-side drops arrive as bytes; archives still expand here.
  ipcMain.handle(
    'app:expand-archive',
    async (_e, { base64, filename, sourceDir }: { base64: string; filename: string; sourceDir?: string }) =>
      loadBytes(Buffer.from(base64, 'base64'), filename, sourceDir),
  )

  ipcMain.handle('app:detect', async (_e, { base64, filename }: { base64: string; filename?: string }) => {
    return detect(Buffer.from(base64, 'base64'), filename)
  })

  // Some Linux file managers drop `text/uri-list` instead of File objects.
  ipcMain.handle('app:load-uri-list', async (_e, { uriList }: { uriList: string }) => {
    const paths = allFileUrisToPaths(uriList)
    if (paths.length === 0) return null
    return (await Promise.all(paths.map(loadPath))).flat()
  })

  ipcMain.handle('app:detect-text', async (_e, { text }: { text: string }) => {
    return detect(Buffer.from(text, 'utf8'))
  })

  ipcMain.handle('app:cancel', (_e, { jobId }: { jobId: string }) => cancelJob(jobId))

  // Clipboard intake: HTML is sanitized HERE, before the renderer ever parses it.
  ipcMain.handle('app:read-clipboard', () => {
    const html = clipboard.readHTML()
    const text = clipboard.readText()
    // Same rule as a Ctrl+V paste, so the button and the keystroke agree.
    if (shouldUseHtmlFlavor(html ?? '', text ?? '')) return { kind: 'html' as const, html: sanitizeToHub(html) }
    const image = clipboard.readImage()
    if (!image.isEmpty()) return { kind: 'image' as const }
    if (text && text.trim()) return { kind: 'text' as const, text }
    return { kind: 'empty' as const }
  })

  ipcMain.handle('app:sanitize-html', (_e, { html }: { html: string }) => sanitizeToHub(html))

  // Pasted text that opens in the edit pane is rendered HERE, by the same
  // reader the conversion would use, and sanitized before the renderer parses
  // it — the same contract as `app:sanitize-html` above.
  ipcMain.handle('app:text-to-html', (_e, { text, format }: { text: string; format: string }) =>
    renderEditableText(text, format),
  )

  /**
   * Read an input into hub HTML so it can be opened in the edit pane.
   *
   * The conversion path already understands an item that carries `html` - it
   * sends it as an html source - so this is the only piece that was missing
   * between "a file was dropped" and "you can edit it before converting".
   *
   * It is the same read the conversion performs, run early. Nothing is
   * converted twice: once the pane holds the document, the edited HTML is what
   * gets written, not the original file.
   */
  ipcMain.handle(
    'app:file-to-html',
    async (
      e,
      {
        base64,
        filename,
        source,
        ocr,
        ocrLanguage,
        jobId,
      }: {
        base64: string
        filename?: string
        source: SourceFormat
        ocr?: unknown
        ocrLanguage?: unknown
        jobId?: string
      },
    ) => {
      const ctx: ReadContext = jobId
        ? {
            signal: createJob(jobId),
            onProgress: (stage, percent) => {
              if (!e.sender.isDestroyed()) e.sender.send('app:progress', { jobId, stage, percent })
            },
          }
        : {}
      try {
        const hub = await readForConversion(
          Buffer.from(base64, 'base64'),
          filename,
          source,
          ocr === true,
          ctx,
          typeof ocrLanguage === 'string' ? ocrLanguage : undefined,
        )
        return { kind: 'ok' as const, html: hub.html, title: hub.title }
      } catch (err) {
        const code = err instanceof ConversionError ? err.code : 'read-failed'
        return { kind: 'error' as const, code, message: (err as Error).message }
      } finally {
        if (jobId) finishJob(jobId)
      }
    },
  )

  ipcMain.handle('app:load-url', async (e, { url, jobId }: { url: string; jobId?: string }) => {
    const ctx: ReadContext = jobId
      ? {
          signal: createJob(jobId),
          onProgress: (stage, percent) => {
            if (!e.sender.isDestroyed()) e.sender.send('app:progress', { jobId, stage, percent })
          },
        }
      : {}
    try {
      const res = await loadUrl(url, urlFetchDeps, ctx)
      if (res.kind === 'html') {
        return { kind: 'html' as const, html: res.html, title: res.title, sourceName: res.sourceName }
      }
      // Non-HTML URL: hand back as a normal file load (a URL to a PDF/CSV/image just works).
      return {
        kind: 'file' as const,
        base64: res.bytes.toString('base64'),
        filename: res.filename,
        detected: detect(res.bytes, res.filename),
      }
    } catch (err) {
      const code = err instanceof ConversionError ? err.code : 'unexpected'
      return { kind: 'error' as const, code, message: (err as Error).message }
    } finally {
      if (jobId) finishJob(jobId)
    }
  })

  ipcMain.handle('ocr:list-languages', () => listPacks())

  ipcMain.handle('ocr:download-language', async (_e, { code, set, sha256 }: { code: string; set?: unknown; sha256?: unknown }) =>
    downloadPack(
      String(code),
      set === 'best' ? 'best' : 'fast',
      typeof sha256 === 'string' ? sha256 : undefined,
    ),
  )

  ipcMain.handle('ocr:remove-language', async (_e, { code, set }: { code: string; set?: unknown }) =>
    removePack(String(code), set === 'best' ? 'best' : 'fast'),
  )

  ipcMain.handle('app:resize-content', (e, { height, reset }: { height?: number; reset?: boolean }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed() || win.isMaximized()) return
    const st = resizeState.get(win)
    if (!st || st.userResized) return
    const [w] = win.getContentSize()
    const target = reset ? st.base : Math.min(Math.max(height ?? st.base, st.base), 1000)
    st.lastSet = [w, target]
    win.setContentSize(w, target, false)
  })

  ipcMain.handle(
    'app:convert-copy',
    async (
      e,
      {
        base64,
        filename,
        source,
        target,
        pdf,
        slides,
        ocr,
        ocrLanguage,
        jobId,
      }: {
        base64: string
        filename?: string
        source: SourceFormat
        target: TargetFormat
        pdf?: unknown
        slides?: unknown
        ocr?: unknown
        ocrLanguage?: unknown
        jobId?: string
      },
    ) => {
      // One list in target-validity.ts, not a hand-written pair here: epub
      // and xlsx were both missing from this guard, so a zip was copied to
      // the clipboard as utf8 mojibake and reported as copied.
      if (isBinaryTarget(target)) {
        return {
          status: 'error' as const,
          code: 'clipboard-unsupported',
          message: 'Binary formats cannot be copied to the clipboard',
        }
      }
      const ctx: ReadContext = jobId
        ? {
            signal: createJob(jobId),
            onProgress: (stage, percent) => {
              if (!e.sender.isDestroyed()) e.sender.send('app:progress', { jobId, stage, percent })
            },
          }
        : {}
      try {
        const bytes = Buffer.from(base64, 'base64')
        const opts = { pdf: normalizePdfOptions(pdf), slides: normalizeSlideOptions(slides), ocr: ocr === true, ocrLanguage: typeof ocrLanguage === 'string' ? ocrLanguage : undefined }
        if (target === 'html') {
          // Rich flavor for Word/Teams/Outlook paste targets + plain-text flavor for editors.
          const flavors = await clipboardFlavors(bytes, filename, source, opts, ctx)
          clipboard.write(flavors)
          return { status: 'copied' as const }
        }
        // csv with multiple tables: the clipboard carries table 1 of N.
        const out = await runConversion(bytes, filename, source, target, opts, ctx)
        // The write above resolved, but the user may have cancelled during it;
        // the clipboard is the side effect they were cancelling.
        throwIfCancelled(ctx.signal)
        clipboard.writeText(out.parts[0].bytes.toString('utf8'))
        return { status: 'copied' as const, totalParts: out.parts.length }
      } catch (err) {
        const code = err instanceof ConversionError ? err.code : 'unexpected'
        return { status: 'error' as const, code, message: (err as Error).message }
      } finally {
        if (jobId) finishJob(jobId)
      }
    },
  )

  ipcMain.handle(
    'app:convert-save',
    async (
      e,
      {
        base64,
        filename,
        source,
        target,
        pdf,
        slides,
        ocr,
        ocrLanguage,
        jobId,
        sourceDir,
      }: {
        base64: string
        filename?: string
        source: SourceFormat
        target: TargetFormat
        pdf?: unknown
        slides?: unknown
        ocr?: unknown
        ocrLanguage?: unknown
        jobId?: string
        sourceDir?: string
      },
    ) => {
      let advice: string | undefined
      const ctx: ReadContext = {
        onAdvice: (_kind, message) => {
          advice = message
        },
        ...(jobId
          ? {
              signal: createJob(jobId),
              onProgress: (stage: string, percent?: number) => {
                if (!e.sender.isDestroyed()) e.sender.send('app:progress', { jobId, stage, percent })
              },
            }
          : {}),
      }
      try {
        const bytes = Buffer.from(base64, 'base64')
        const out = await runConversion(bytes, filename, source, target, {
          pdf: normalizePdfOptions(pdf),
          slides: normalizeSlideOptions(slides),
          ocr: ocr === true,
          ocrLanguage: typeof ocrLanguage === 'string' ? ocrLanguage : undefined,
        }, ctx)
        const defaultPath = defaultSavePath(sourceDir, baseName(filename) + EXTENSIONS[target])
        const save = await dialog.showSaveDialog({ defaultPath, filters: [FILTERS[target]] })
        if (save.canceled || !save.filePath) return { status: 'cancelled' as const }
        rememberSaveDir(save.filePath)
        const ext = save.filePath.match(/\.[^.\\/]+$/)?.[0] ?? ''
        const stem = ext ? save.filePath.slice(0, -ext.length) : save.filePath
        const paths: string[] = []
        for (const part of out.parts) {
          // A multi-table csv/json writes N files; a cancel that lands mid-loop
          // used to write the rest anyway.
          throwIfCancelled(ctx.signal)
          const p = part.suffix ? `${stem}${part.suffix}${ext}` : save.filePath
          await writeFile(p, part.bytes)
          paths.push(p)
        }
        return { status: 'saved' as const, path: paths[0], paths, advice }
      } catch (err) {
        const code = err instanceof ConversionError ? err.code : 'unexpected'
        return { status: 'error' as const, code, message: (err as Error).message }
      } finally {
        if (jobId) finishJob(jobId)
      }
    },
  )

  ipcMain.handle(
    'app:convert-batch',
    async (
      e,
      {
        items,
        target,
        pdf,
        slides,
        jobId,
        outDir: givenOutDir,
      }: { items: BatchItemPayload[]; target: TargetFormat; pdf?: unknown
        slides?: unknown; jobId?: string; outDir?: string },
    ) => {
      let outDir = givenOutDir
      if (!outDir) {
        const pick = await dialog.showOpenDialog({
          defaultPath: defaultSaveDir(items[0]?.sourceDir),
          properties: ['openDirectory', 'createDirectory'],
        })
        if (pick.canceled || pick.filePaths.length === 0) return { status: 'cancelled' as const }
        outDir = pick.filePaths[0]
      }
      const signal = jobId ? createJob(jobId) : undefined
      const onProgress = (stage: string, percent?: number): void => {
        if (jobId && !e.sender.isDestroyed()) e.sender.send('app:progress', { jobId, stage, percent })
      }
      const pdfOpts = normalizePdfOptions(pdf)
      const slideOpts = normalizeSlideOptions(slides)
      let rows: BatchRow[]
      try {
        rows = await runBatch(items, target, outDir, { signal, onProgress }, (item, ctx) =>
          runConversion(
            Buffer.from(item.base64, 'base64'),
            item.filename,
            item.source,
            target,
            { pdf: pdfOpts, slides: slideOpts, ocr: item.ocr === true, ocrLanguage: item.ocrLanguage },
            ctx,
          ),
        )
      } finally {
        if (jobId) finishJob(jobId)
      }
      rememberDir(outDir)
      return { status: 'batch' as const, outDir, rows }
    },
  )

  ipcMain.handle(
    'app:convert-merge',
    async (
      e,
      {
        items,
        target,
        pdf,
        slides,
        headings,
        jobId,
      }: { items: BatchItemPayload[]; target: TargetFormat; pdf?: unknown
        slides?: unknown; headings?: unknown; jobId?: string },
    ) => {
      if (TABLE_TARGETS.includes(target)) {
        return {
          status: 'error' as const,
          code: 'write-failed',
          message: `Merge cannot target ${target.toUpperCase()} — use batch for table extraction`,
        }
      }
      const ctx: ReadContext = jobId
        ? {
            signal: createJob(jobId),
            onProgress: (stage, percent) => {
              if (!e.sender.isDestroyed()) e.sender.send('app:progress', { jobId, stage, percent })
            },
          }
        : {}
      try {
        const out = await mergeToTarget(
          items.map((item) => ({
            bytes: Buffer.from(item.base64, 'base64'),
            filename: item.filename,
            source: item.source,
            ocr: item.ocr === true,
          })),
          target,
          { pdf: normalizePdfOptions(pdf), slides: normalizeSlideOptions(slides) },
          headings === true,
          ctx,
        )
        const defaultPath = defaultSavePath(
          items[0]?.sourceDir,
          `${baseName(items[0]?.filename)}-merged${EXTENSIONS[target]}`,
        )
        const save = await dialog.showSaveDialog({ defaultPath, filters: [FILTERS[target]] })
        if (save.canceled || !save.filePath) return { status: 'cancelled' as const }
        rememberSaveDir(save.filePath)
        await writeFile(save.filePath, out.parts[0].bytes)
        return { status: 'saved' as const, path: save.filePath }
      } catch (err) {
        const code = err instanceof ConversionError ? err.code : 'unexpected'
        return { status: 'error' as const, code, message: (err as Error).message }
      } finally {
        if (jobId) finishJob(jobId)
      }
    },
  )

  ipcMain.handle('app:reveal', async (_e, { path }: { path: string }) => {
    shell.showItemInFolder(path)
  })
  ipcMain.handle('app:open-path', async (_e, { path }: { path: string }) => {
    await shell.openPath(path)
  })
}

app.whenReady().then(() => {
  if (isCli) {
    // Headless: no window; hidden printToPDF windows still work.
    // `--help`/`--version` are their own verb; everything else is `convert <args>`.
    runCli(process.argv.slice(process.argv[cliArgIndex] === 'convert' ? cliArgIndex + 1 : cliArgIndex))
      .then((code) => app.exit(code))
      .catch((err) => {
        console.error((err as Error).message)
        app.exit(1)
      })
    return
  }
  electronApp.setAppUserModelId('com.docconversion.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // CLI mode opens (and closes) hidden PDF windows — never quit on their account.
  if (!isCli && process.platform !== 'darwin') app.quit()
})
