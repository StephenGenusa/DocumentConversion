import type { PdfPageSize, ReadOptions, SourceFormat, TargetFormat } from '../../../core/types'
import type { Settings } from '../../../core/settings'
import { drawsSomething, SVG_TARGETS, type HubFeatures, type RenderFormat } from '../../../core/rendered-blocks'

/**
 * Which conversion controls are shown (spec 2a).
 *
 * A control that is visible must change the result; one that would do nothing
 * is HIDDEN, not disabled. Two kinds:
 *
 *   output controls  shown for the selected target, and only when some input
 *                    has content they act on (OutputPicker)
 *   input controls   shown on an input's own card, only for the kind of
 *                    input they act on (InputCard, InputList)
 *
 * The rules live here and nowhere else, so the screen, the options sent with a
 * conversion, and every later control agree. Values live in App state: they
 * last for the session and survive being hidden, so switching the target away
 * and back does not reset them. A control that has a setting starts from it
 * (sessionStart, settings spec 6); a change on the screen is never written
 * back, so a restart starts again from the settings.
 */

export interface ControlInput {
  source: SourceFormat
  imageMode?: 'embed' | 'ocr'
  /** JSON that reads as a table of records. */
  jsonTable?: boolean
  /** A SQLite database's number of views. */
  viewCount?: number
  /** Diagrams and formulas it holds, from the last read or edit, or the hint given when it was added. */
  features?: HubFeatures
}

export type OutputControl = 'pdfOptions' | 'page' | 'slideSplit' | 'renderedFormat'
export type InputControl = 'imageMode' | 'ocrLanguage' | 'jsonAs' | 'timestamps' | 'sqliteViews'

const OUTPUT_RULES: Record<OutputControl, (target: TargetFormat, inputs: ControlInput[]) => boolean> = {
  pdfOptions: (target) => target === 'pdf',
  // The page's size and orientation, with PDF's other page options or on
  // their own for Word, whose page is the same paper with Word's 1-inch
  // margins: Automatic turns it as the PDF's (orientation.ts; writers/docx.ts
  // wordPages). Zoom and the header and footer are the PDF's alone.
  page: (target) => target === 'pdf' || target === 'docx',
  slideSplit: (target) => target === 'revealjs',
  // Diagrams and formulas: Sharp (SVG) / Image (PNG), spec B4. Word is always PNG.
  renderedFormat: (target, inputs) => SVG_TARGETS.has(target) && inputs.some((i) => drawsSomething(i.features)),
}

/** The screen's values that start from a setting (settings spec 6). Orientation and slide split have none: each starts at its automatic choice. */
export interface SessionStart {
  pdf: { pageSize: PdfPageSize; scale: number; headerFooter: boolean }
  renderedFormat: RenderFormat
  ocrLanguage: string
  read: { transcriptTimestamps: boolean; sqliteViews: boolean }
}

/** Where a session's choices start: the saved settings. */
export function sessionStart(settings: Readonly<Settings>): SessionStart {
  return {
    pdf: { pageSize: settings.pdf.pageSize, scale: settings.pdf.scale, headerFooter: settings.pdf.headerFooter },
    renderedFormat: settings.rendered.format,
    ocrLanguage: settings.ocr.language,
    read: { transcriptTimestamps: settings.read.transcriptTimestamps, sqliteViews: settings.read.sqliteViews },
  }
}

/**
 * A screen value once its setting changes from `before` to `after`. A value
 * still at the old setting was never changed this session, so it follows; one
 * the user changed is this session's choice and stays.
 */
export function followSetting<T>(current: T, before: T, after: T): T {
  return Object.is(current, before) ? after : current
}

const INPUT_RULES: Record<InputControl, (input: ControlInput) => boolean> = {
  imageMode: (input) => input.source === 'image',
  ocrLanguage: (input) => input.source === 'image' && input.imageMode === 'ocr',
  // Only where there is a choice: JSON that is records. Other JSON is a listing either way.
  jsonAs: (input) => input.source === 'json' && input.jsonTable === true,
  timestamps: (input) => input.source === 'subtitles',
  // Views are listed in the schema either way; their results only exist if there are views.
  sqliteViews: (input) => input.source === 'sqlite' && (input.viewCount ?? 0) > 0,
}

export function showsOutput(control: OutputControl, target: TargetFormat, inputs: ControlInput[]): boolean {
  return OUTPUT_RULES[control](target, inputs)
}

export function showsInput(control: InputControl, input: ControlInput): boolean {
  return INPUT_RULES[control](input)
}

/** The options a conversion carries: only those of controls that are shown. */
export function appliedOptions<P extends { pageSize?: unknown; landscape?: unknown }, S>(
  target: TargetFormat,
  inputs: ControlInput[],
  values: { pdf: P; slides: S; renderedFormat?: RenderFormat },
): { pdf?: P | Partial<Pick<P, 'pageSize' | 'landscape'>>; slides?: S; renderedFormat?: RenderFormat } {
  // Word shows the page size and orientation alone, so only they are sent.
  const pageOnly = !showsOutput('pdfOptions', target, inputs) && showsOutput('page', target, inputs)
  const page: Partial<Pick<P, 'pageSize' | 'landscape'>> = {
    ...(values.pdf.pageSize !== undefined ? { pageSize: values.pdf.pageSize } : {}),
    ...(values.pdf.landscape !== undefined ? { landscape: values.pdf.landscape } : {}),
  }
  return {
    ...(showsOutput('pdfOptions', target, inputs) ? { pdf: values.pdf } : {}),
    ...(pageOnly && Object.keys(page).length > 0 ? { pdf: page } : {}),
    ...(showsOutput('slideSplit', target, inputs) ? { slides: values.slides } : {}),
    ...(showsOutput('renderedFormat', target, inputs) && values.renderedFormat
      ? { renderedFormat: values.renderedFormat }
      : {}),
  }
}

/**
 * The reading choices sent with an input: only those for its kind of input,
 * with each choice's default filled in.
 */
export function appliedReadOptions(source: SourceFormat, read: ReadOptions = {}): ReadOptions {
  if (source === 'json') return { jsonAs: read.jsonAs ?? 'table' }
  if (source === 'subtitles') return { transcriptTimestamps: read.transcriptTimestamps ?? true }
  if (source === 'sqlite') return { sqliteViews: read.sqliteViews ?? false }
  return {}
}

/**
 * The card's note on an edited copy of a record source: the editor is
 * printing, so the copy holds the first 5,000 records (per table), and
 * exporting it writes only those.
 */
export function editedCopyNote(source: SourceFormat): string {
  if (source === 'sqlite') return (
      'This edited copy holds the first 5,000 rows of each table. Exporting it to CSV, JSON or Excel writes only those; ' +
      'to export every row, remove it and add the file again without opening it in the editor.'
    )
  return (
    'This edited copy holds the first 5,000 records. Exporting it to CSV, JSON or Excel writes only those; to export ' +
    'every record, remove it and add the file again without opening it in the editor.'
  )
}
