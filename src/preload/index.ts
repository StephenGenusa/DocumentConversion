import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { dirname } from 'node:path'
import { electronAPI } from '@electron-toolkit/preload'

type TargetFormat = 'txt' | 'md' | 'docx' | 'pdf' | 'html' | 'csv' | 'json' | 'xlsx'
type SourceFormat =
  | TargetFormat
  | 'eml'
  | 'msg'
  | 'rtf'
  | 'image'
  | 'code'
  | 'ipynb'
  | 'pptx'
  | 'doc'
  | 'epub'
  | 'mbox'
  | 'odt'
  | 'odp'
  | 'ics'
  | 'asciidoc'
  | 'rst'

const api = {
  openFile: () => ipcRenderer.invoke('app:open-file'),
  detect: (req: { base64: string; filename?: string }) => ipcRenderer.invoke('app:detect', req),
  expandArchive: (req: { base64: string; filename: string; sourceDir?: string }) =>
    ipcRenderer.invoke('app:expand-archive', req),
  /**
   * The folder a dropped File came from, or '' when it is not backed by disk.
   * Only the preload can answer this — a File in the renderer carries no path —
   * and it returns the folder rather than the full path, which is all the save
   * dialog needs.
   */
  dirForFile: (file: File): string => {
    try {
      const path = webUtils.getPathForFile(file)
      return path ? dirname(path) : ''
    } catch {
      return ''
    }
  },
  loadUriList: (uriList: string) => ipcRenderer.invoke('app:load-uri-list', { uriList }),
  detectText: (text: string) => ipcRenderer.invoke('app:detect-text', { text }),
  convertAndSave: (req: {
    base64: string
    filename?: string
    source: SourceFormat
    target: TargetFormat
    pdf?: { scale?: number; pageSize?: string; landscape?: boolean }
    ocr?: boolean
    jobId?: string
    sourceDir?: string
  }) => ipcRenderer.invoke('app:convert-save', req),
  convertBatch: (req: unknown) => ipcRenderer.invoke('app:convert-batch', req),
  convertMerge: (req: unknown) => ipcRenderer.invoke('app:convert-merge', req),
  cancel: (jobId: string) => ipcRenderer.invoke('app:cancel', { jobId }),
  readClipboard: () => ipcRenderer.invoke('app:read-clipboard'),
  sanitizeHtml: (html: string) => ipcRenderer.invoke('app:sanitize-html', { html }),
  textToHtml: (text: string, format: string) => ipcRenderer.invoke('app:text-to-html', { text, format }),
  loadUrl: (req: { url: string; jobId?: string }) => ipcRenderer.invoke('app:load-url', req),
  fileToHtml: (req: {
    base64: string
    filename?: string
    source: string
    ocr?: boolean
    ocrLanguage?: string
    jobId?: string
  }) => ipcRenderer.invoke('app:file-to-html', req),
  listOcrLanguages: () => ipcRenderer.invoke('ocr:list-languages'),
  downloadOcrLanguage: (code: string, set: 'fast' | 'best', sha256?: string) =>
    ipcRenderer.invoke('ocr:download-language', { code, set, sha256 }),
  removeOcrLanguage: (code: string, set: 'fast' | 'best') =>
    ipcRenderer.invoke('ocr:remove-language', { code, set }),
  resizeContent: (req: { height?: number; reset?: boolean }) => ipcRenderer.invoke('app:resize-content', req),
  convertAndCopy: (req: {
    base64: string
    filename?: string
    source: SourceFormat
    target: TargetFormat
    pdf?: { scale?: number; pageSize?: string; landscape?: boolean }
    ocr?: boolean
    jobId?: string
  }) => ipcRenderer.invoke('app:convert-copy', req),
  onProgress: (cb: (p: { jobId: string; stage: string; percent?: number }) => void) => {
    const listener = (_e: unknown, p: { jobId: string; stage: string; percent?: number }): void => cb(p)
    ipcRenderer.on('app:progress', listener)
    return () => {
      ipcRenderer.removeListener('app:progress', listener)
    }
  },
  reveal: (path: string) => ipcRenderer.invoke('app:reveal', { path }),
  openPath: (path: string) => ipcRenderer.invoke('app:open-path', { path }),
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore fallback for non-isolated context
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
