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

export type DetectResult =
  | { kind: 'ok'; format: SourceFormat }
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
}

export type SaveResult =
  | { status: 'saved'; path: string; paths?: string[]; advice?: string }
  | { status: 'copied'; totalParts?: number }
  | { status: 'cancelled' }
  | { status: 'error'; code: string; message: string }

export interface BatchItemReq {
  base64: string
  filename?: string
  source: SourceFormat
  ocr?: boolean
  /** Folder this input came from; drives where the save dialog opens. */
  sourceDir?: string
  /** Which OCR language to recognise with, when ocr is set. */
  ocrLanguage?: string
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
  loadUriList(uriList: string): Promise<LoadedInput[] | null>
  detectText(text: string): Promise<DetectResult>
  convertAndSave(req: {
    base64: string
    filename?: string
    source: SourceFormat
    target: TargetFormat
    pdf?: PdfOptions
    slides?: SlideOptions
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
    jobId?: string
    outDir?: string
  }): Promise<BatchResult>
  convertMerge(req: {
    items: BatchItemReq[]
    target: TargetFormat
    pdf?: PdfOptions
    slides?: SlideOptions
    headings?: boolean
    jobId?: string
  }): Promise<SaveResult>
  cancel(jobId: string): Promise<void>
  onProgress(cb: (p: ProgressEvent) => void): () => void
  readClipboard(): Promise<ClipboardContent>
  sanitizeHtml(html: string): Promise<string>
  /** Render pasted md/txt to sanitized hub HTML for the edit pane. */
  textToHtml(text: string, format: string): Promise<string>
  loadUrl(req: { url: string; jobId?: string }): Promise<UrlLoadResponse>
  /** Read an input into hub HTML so it can be opened in the edit pane. */
  fileToHtml(req: {
    base64: string
    filename?: string
    source: SourceFormat
    ocr?: boolean
    ocrLanguage?: string
    jobId?: string
  }): Promise<
    { kind: 'ok'; html: string; title?: string } | { kind: 'error'; code: string; message: string }
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
    filename?: string
    source: SourceFormat
    target: TargetFormat
    pdf?: PdfOptions
    slides?: SlideOptions
    ocr?: boolean
    jobId?: string
  }): Promise<SaveResult>
  reveal(path: string): Promise<void>
  openPath(path: string): Promise<void>
}
