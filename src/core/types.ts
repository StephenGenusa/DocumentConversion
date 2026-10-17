import type { HubFeatures, PictureFormat, RenderFormat } from './rendered-blocks'

/** Formats the app can write. csv/json/xlsx are table extraction, not documents. */
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

/** Formats the app can read. Read-only formats have no writer. */
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
  | 'json'
  | 'subtitles'
  | 'opml'
  | 'vcard'
  | 'djot'
  | 'textile'
  | 'sqlite'

export const TARGET_FORMATS: TargetFormat[] = [
  'txt',
  'md',
  'docx',
  'pdf',
  'html',
  'epub',
  'revealjs',
  'azw3',
  'azw4',
  'csv',
  'json',
  'xlsx',
]

/**
 * Targets that present a document as slides, and so keep speaker notes.
 * Every other target has them removed at the write boundary.
 */
export const SLIDE_TARGETS: TargetFormat[] = ['revealjs']

/** Targets that extract tables rather than producing a document. */
export const TABLE_TARGETS: TargetFormat[] = ['csv', 'json', 'xlsx']

/**
 * The formats pasted or dropped text may open in the edit pane, rendered.
 *
 * Pasted text detected as anything else — an .eml body, an mbox archive, a
 * notebook, an iCalendar invite — stays an input card. Those carry structure
 * the pane's schema has no model for (message headers, cell prompts, event
 * fields), and rendering them for editing would quietly discard it.
 */
export const EDITABLE_TEXT_FORMATS = ['md', 'txt'] as const satisfies readonly SourceFormat[]

export type EditableTextFormat = (typeof EDITABLE_TEXT_FORMATS)[number]

export function isEditableTextFormat(format: string): format is EditableTextFormat {
  return (EDITABLE_TEXT_FORMATS as readonly string[]).includes(format)
}

/** One output file. suffix '' is the primary file; '.table-2' etc. insert before the extension. */
export interface WritePart {
  suffix: string
  bytes: Buffer
}

export interface WriteResult {
  parts: WritePart[]
}

export const SOURCE_FORMATS: SourceFormat[] = [
  'txt',
  'md',
  'docx',
  'pdf',
  'html',
  'eml',
  'msg',
  'csv',
  'xlsx',
  'rtf',
  'image',
  'svg',
  'code',
  'ipynb',
  'pptx',
  'doc',
  'epub',
  'mbox',
  'odt',
  'odp',
  'ics',
  'asciidoc',
  'rst',
  'json',
  'subtitles',
  'opml',
  'vcard',
  'djot',
  'textile',
  'sqlite',
]

export const EXTENSIONS: Record<TargetFormat, string> = {
  txt: '.txt',
  md: '.md',
  docx: '.docx',
  pdf: '.pdf',
  html: '.html',
  epub: '.epub',
  revealjs: '.html',
  azw3: '.azw3',
  azw4: '.azw4',
  csv: '.csv',
  json: '.json',
  xlsx: '.xlsx',
}

export interface HubDocument {
  /** Body-level HTML fragment (no <html>/<body> wrapper). */
  html: string
  title?: string
  /** Original filename / URL / "Clipboard" — used for merge headings and PDF header text. */
  sourceName?: string
  /** Dominant code language, when source is 'code'. */
  language?: string
  /**
   * A record source cut to PRINT_RECORD_LIMIT for printing (see records.ts).
   * The editor tells the user an edited copy holds only these records.
   */
  limited?: boolean
  /**
   * Diagrams and formulas the document holds (spec B1), set where every
   * reader's output passes (`convert.ts` `read()`). The input card keeps it,
   * so a control that acts on them is shown only when there are some.
   */
  features?: HubFeatures
}

export interface SourceInput {
  bytes: Buffer
  filename?: string
}

/**
 * The reading choices made on one input's card (spec 2a, V2). Each applies to
 * one kind of input and is ignored by every other reader.
 */
export interface ReadOptions {
  /** JSON records: as a table (the default) or as formatted JSON text. */
  jsonAs?: 'table' | 'text'
  /** Transcripts: show each turn's time (the default) or leave times out. */
  transcriptTimestamps?: boolean
  /** SQLite: each view's results after the tables (off by default: views are listed in the schema). */
  sqliteViews?: boolean
}

/** Options, cancellation, and progress threaded into readers. */
export interface ReadContext extends ReadOptions {
  ocr?: boolean
  signal?: AbortSignal
  onProgress?: (stage: string, percent?: number) => void
  /** Non-fatal suggestions surfaced to the user (e.g. "this would fit landscape"). */
  onAdvice?: AdviceHandler
}

/** The kinds of non-fatal notice a conversion can give. */
export type AdviceKind =
  | 'landscape'
  | 'doc-tables'
  | 'doc-lists'
  | 'doc-images'
  | 'reformatted'
  | 'records-limited'
  | 'record-error'
  | 'photos-omitted'
  | 'sqlite-wal'
  | 'sqlite-stopped'
  /** A Word equation with a part that is only its linear text (spec B12). */
  | 'equation-partial'
  /** A diagram or formula kept as source (spec B7). Given by write(). */
  | 'render-failed'

export type AdviceHandler = (
  kind: AdviceKind,
  message: string,
  suggestion?: { pageSize: PdfPageSize; landscape: boolean },
) => void

/**
 * What write() is handed besides the options: drawing diagrams (spec B7) is
 * the part of writing that can be cancelled and that has notices to give.
 */
export interface WriteContext {
  signal?: AbortSignal
  onAdvice?: AdviceHandler
  /** How far writing has got: drawing a long run of formulas says so a batch at a time. */
  onProgress?: (stage: string, percent?: number) => void
}

export type PdfPageSize = 'Letter' | 'A4' | 'Legal' | 'A3' | 'Tabloid'

/**
 * An explicit page in inches, for targets whose page size is not the user's to
 * choose. Chromium's printToPDF accepts either a named size or these.
 */
export interface PdfPageInches {
  width: number
  height: number
}

/**
 * The page a Kindle actually has.
 *
 * A 6-inch Kindle is 600x800 at about 167 ppi, so a Letter page renders at
 * roughly a third of the size a reader can follow. AZW4 wraps a PDF rather
 * than reflowing it, which means the page size chosen at render time is the
 * page size on the device, permanently.
 */
export const KINDLE_PAGE_INCHES: PdfPageInches = { width: 3.6, height: 4.8 }

export interface PdfRenderOptions {
  scale: number
  pageSize: PdfPageSize | PdfPageInches
  landscape: boolean
  headerFooter: boolean
  /** Derived by the pdf writer from doc.title ?? doc.sourceName (HTML-escaped). Never accepted from the renderer. */
  headerText?: string
}

export interface SlideOptions {
  /**
   * Where one slide ends and the next begins. `auto` uses an explicit rule
   * (`<hr>`) if the document has one, and falls back to `h1` if it does not.
   */
  splitOn?: 'auto' | 'hr' | 'h1' | 'h2'
}

export interface ConvertOptions {
  pdf?: PdfRenderOptions
  ocr?: boolean
  /** Which language OCR should recognise with. Defaults to the bundled English. */
  ocrLanguage?: string
  slides?: SlideOptions
  /** Per input: the card's reading choices. Copied into the read context. */
  read?: ReadOptions
  /**
   * Diagrams as SVG or PNG (spec B3, B4), where the target takes SVG
   * (pdf, html, revealjs, epub, azw4); SVG when not given. Word and Kindle
   * (azw3) are always PNG. Ignored where nothing is drawn.
   */
  renderedFormat?: RenderFormat
  /**
   * PNG copies of the document's SVG images for a target that would keep
   * them as SVG (spec D10's Word rule, for HTML that will be pasted into Word
   * or Outlook: see FOR_PASTING). Word and Kindle get them anyway.
   */
  svgImagesAsPng?: boolean
  /**
   * What a picture the target cannot hold (a TIFF in a PDF, a WebP in a
   * Kindle book) is converted to: PNG when not given (pictures.ts).
   */
  pictureFormat?: PictureFormat
}

export type RenderHtmlToPdf = (html: string, opts?: PdfRenderOptions) => Promise<Buffer>
