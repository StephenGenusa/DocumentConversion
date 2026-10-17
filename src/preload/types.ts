import type { Settings, SettingKey, SettingValue, SettingsSection } from '../core/settings'

export type { Settings, SettingKey, SettingValue, SettingsSection }

/** What a settings change answers: the settings now in force, or why nothing changed. */
export type SettingsResult = { ok: true; settings: Settings } | { ok: false; message: string }

/** Diagrams embedded as SVG or as PNG (spec B4). */
export type RenderedFormat = 'svg' | 'png'

/** How a document is cut into slides. `auto` uses <hr> if present, else h1. */
export interface SlideOptions {
  splitOn?: 'auto' | 'hr' | 'h1' | 'h2'
}

export type TargetFormat =
  | 'txt'
  | 'md'
  | 'docx'
  | 'pdf'
  | 'html'
  | 'epub'
  | 'revealjs'
  | 'azw3'
  | 'azw4'
  | 'csv'
  | 'json'
  | 'xlsx'
/**
 * Targets this app can write but cannot read back.
 *
 * `SourceFormat` used to be `TargetFormat | ...`, which quietly assumed every
 * output is also an input. That held while the two lists matched. It stopped
 * holding with slide decks - and stops harder with the Kindle formats - so the
 * divergence is named rather than left implicit, and adding an output-only
 * format now fails to compile until it is listed here.
 */
export type OutputOnlyFormat = 'revealjs' | 'azw3' | 'azw4'

export type SourceFormat =
  | Exclude<TargetFormat, OutputOnlyFormat>
  | 'eml'
  | 'msg'
  | 'csv'
  | 'xlsx'
  | 'rtf'
  | 'image'
  | 'svg'
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
  | 'subtitles'
  | 'opml'
  | 'vcard'
  | 'djot'
  | 'textile'
  | 'sqlite'

export type DetectResult =
  | {
      kind: 'ok'
      format: SourceFormat
      /** JSON that reads as a table of records. */
      jsonTable?: boolean
      /** A SQLite database's number of views. */
      viewCount?: number
      /** Diagrams and formulas it holds (spec B1), for the Diagrams choice. */
      features?: { diagrams: boolean; math: boolean }
    }
  | { kind: 'archive' }
  | { kind: 'unsupported'; reason: string }

export interface OcrLanguageListing {
  code: string
  name: string
  script: string
  installed: boolean
  source?: 'bundled' | 'downloaded'
  set?: 'fast' | 'best'
  size: { fast: number; best: number }
}

export interface OcrLanguageListing {
  code: string
  name: string
  script: string
  installed: boolean
  source?: 'bundled' | 'downloaded'
  set?: 'fast' | 'best'
  size: { fast: number; best: number }
}

export type PdfPageSize = 'Letter' | 'A4' | 'Legal' | 'A3' | 'Tabloid'

export interface PdfOptions {
  /** Zoom factor, 0.1–2.0 (clamped in the main process). */
  scale?: number
  pageSize?: PdfPageSize
  landscape?: boolean
  headerFooter?: boolean
}

export interface LoadedInput {
  filename: string
  base64: string
  detected: DetectResult
  /** Folder this input came from, when it came from disk. */
  sourceDir?: string
  /** Token for re-reading the file at convert time, when it has one on disk. */
  handle?: string
}

export type SaveResult =
  | {
      status: 'saved'
      path: string
      paths?: string[]
      /** Page-fit advice: shown as a "try Landscape" tip. */
      advice?: string
      /** Other notices, shown as they are (e.g. "Diagram 2 could not be drawn: …"). */
      notes?: string[]
    }
  | { status: 'copied'; totalParts?: number }
  | { status: 'cancelled' }
  | { status: 'error'; code: string; message: string }

/** The reading choices made on one input's card (mirrors core's ReadOptions). */
export interface ReadOptions {
  /** JSON records: as a table or as formatted text. */
  jsonAs?: 'table' | 'text'
  /** Transcripts: show each turn's time (the default) or leave times out. */
  transcriptTimestamps?: boolean
  /** SQLite: each view's results after the tables. */
  sqliteViews?: boolean
}

export interface BatchItemReq {
  /** The input's bytes. Empty when `handle` is set: the file is read instead. */
  base64: string
  /** Token for the file on disk. The main process reads it at convert time. */
  handle?: string
  filename?: string
  source: SourceFormat
  ocr?: boolean
  /** Folder this input came from; drives where the save dialog opens. */
  sourceDir?: string
  /** Which OCR language to recognise with, when ocr is set. */
  ocrLanguage?: string
  /** The reading choices made on this input's card. */
  read?: ReadOptions
}

export interface BatchRow {
  filename: string
  status: 'saved' | 'error' | 'cancelled'
  path?: string
  message?: string
}

export type BatchResult = { status: 'batch'; outDir: string; rows: BatchRow[] } | { status: 'cancelled' }

export type UrlLoadResponse =
  | { kind: 'html'; html: string; title?: string; sourceName: string }
  | { kind: 'file'; base64: string; filename: string; detected: DetectResult }
  | { kind: 'error'; code: string; message: string }

export type ClipboardContent =
  | { kind: 'html'; html: string }
  | { kind: 'text'; text: string }
  | { kind: 'image' }
  | { kind: 'empty' }

export interface ProgressEvent {
  jobId: string
  stage: string
  percent?: number
}

export interface Api {
  openFile(): Promise<LoadedInput[] | null>
  detect(req: { base64: string; filename?: string }): Promise<DetectResult>
  expandArchive(req: { base64: string; filename: string; sourceDir?: string }): Promise<LoadedInput[]>
  /** Folder a dropped File came from; '' when it is not backed by disk. */
  dirForFile(file: File): string
  /** Token for re-reading a dropped File later; undefined when it is not backed by disk. */
  fileHandle(file: File): Promise<string | undefined>
  /** What the file looks like on disk now; null when it is gone. Compare, do not parse. */
  fileStamp(handle: string): Promise<string | null>
  loadUriList(uriList: string): Promise<LoadedInput[] | null>
  detectText(text: string): Promise<DetectResult>
  convertAndSave(req: {
    base64: string
    handle?: string
    filename?: string
    source: SourceFormat
    target: TargetFormat
    pdf?: PdfOptions
    slides?: SlideOptions
    renderedFormat?: RenderedFormat
    ocr?: boolean
    jobId?: string
    /** Folder the input came from; the save dialog opens there. */
    sourceDir?: string
  }): Promise<SaveResult>
  convertBatch(req: {
    items: BatchItemReq[]
    target: TargetFormat
    pdf?: PdfOptions
    slides?: SlideOptions
    renderedFormat?: RenderedFormat
    jobId?: string
    outDir?: string
  }): Promise<BatchResult>
  convertMerge(req: {
    items: BatchItemReq[]
    target: TargetFormat
    pdf?: PdfOptions
    slides?: SlideOptions
    renderedFormat?: RenderedFormat
    headings?: boolean
    jobId?: string
  }): Promise<SaveResult>
  cancel(jobId: string): Promise<void>
  onProgress(cb: (p: ProgressEvent) => void): () => void
  /** `jobId` gives a paste with web images progress and Skip (via `cancel`). */
  readClipboard(jobId?: string): Promise<ClipboardContent>
  sanitizeHtml(html: string, jobId?: string): Promise<string>
  /** Render pasted md/txt to sanitized hub HTML for the edit pane. */
  textToHtml(text: string, format: string): Promise<string>
  loadUrl(req: { url: string; jobId?: string }): Promise<UrlLoadResponse>
  /** Read an input into hub HTML so it can be opened in the edit pane. */
  fileToHtml(req: {
    base64: string
    handle?: string
    filename?: string
    source: SourceFormat
    ocr?: boolean
    ocrLanguage?: string
    read?: ReadOptions
    jobId?: string
  }): Promise<
    | {
        kind: 'ok'
        html: string
        title?: string
        /** Set when read from a file on disk. */
        stamp?: string
        /** A record source cut to the print limit: an edited copy holds only these records. */
        limited?: boolean
        /** Diagrams and formulas the document holds (spec B1). */
        features?: { diagrams: boolean; math: boolean }
      }
    | { kind: 'error'; code: string; message: string }
  >
  listOcrLanguages(): Promise<OcrLanguageListing[]>
  downloadOcrLanguage(
    code: string,
    set: 'fast' | 'best',
    sha256?: string,
  ): Promise<{ kind: 'ok'; path: string } | { kind: 'error'; message: string } | { kind: 'cancelled' }>
  removeOcrLanguage(code: string, set: 'fast' | 'best'): Promise<{ ok: boolean; message?: string }>
  resizeContent(req: { height?: number; reset?: boolean }): Promise<void>
  convertAndCopy(req: {
    base64: string
    handle?: string
    filename?: string
    source: SourceFormat
    target: TargetFormat
    pdf?: PdfOptions
    slides?: SlideOptions
    renderedFormat?: RenderedFormat
    ocr?: boolean
    jobId?: string
  }): Promise<SaveResult>
  reveal(path: string): Promise<void>
  openPath(path: string): Promise<void>
  /** Help → About: the version and every licence notice, in its own window. */
  openAbout(): Promise<void>
  /**
   * A diagram or formula drawn for the editor (spec B11): an `<img>`-ready
   * data URI of the sanitised SVG with its CSS px size, the engine's message,
   * or `unavailable` for a kind this version does not draw.
   */
  renderBlock(req: BlockRenderRequest): Promise<BlockRenderResult>
  /** The saved defaults (settings spec 5.6): the whole object. */
  getSettings(): Promise<Settings>
  /** Change one setting; main checks the key and value and refuses anything else. */
  setSetting<K extends SettingKey>(key: K, value: SettingValue<K>): Promise<SettingsResult>
  /** One section back to its defaults, or every section when none is given. */
  resetSettings(section?: SettingsSection): Promise<SettingsResult>
  /** "Your settings file could not be read and was reset.", once, if that happened at start. */
  settingsNotice(): Promise<string | undefined>
  /** Called with the new settings after each saved change. Returns the way to stop. */
  onSettingsChanged(cb: (settings: Settings) => void): () => void
}

export interface BlockRenderRequest {
  kind: 'mermaid' | 'dot' | 'math'
  source: string
  display: boolean
  priority: 'visible' | 'prefetch'
}

export type BlockRenderResult =
  | { uri: string; width: number; height: number; baseline?: number }
  | { error: string }
  | { unavailable: true }
