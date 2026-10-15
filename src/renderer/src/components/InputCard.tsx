import { OcrLanguagePicker } from './OcrLanguagePicker'
import { editedCopyNote, showsInput } from '../lib/controls'
import type { ReadOptions, SourceFormat } from '../../../preload/types'

const LABELS: Record<SourceFormat, string> = {
  txt: 'Plain text',
  md: 'Markdown',
  docx: 'Word (.docx)',
  pdf: 'PDF',
  html: 'HTML',
  eml: 'Email (.eml)',
  msg: 'Outlook (.msg)',
  csv: 'CSV',
  xlsx: 'Excel (.xlsx)',
  rtf: 'Rich text (.rtf)',
  image: 'Image',
  svg: 'SVG image',
  code: 'Source code',
  ipynb: 'Jupyter notebook',
  pptx: 'PowerPoint (.pptx)',
  doc: 'Word 97–2003 (.doc)',
  epub: 'EPUB book',
  mbox: 'Mail archive (mbox)',
  json: 'JSON',
  odt: 'OpenDocument text',
  odp: 'OpenDocument slides',
  ics: 'Calendar (.ics)',
  asciidoc: 'AsciiDoc',
  rst: 'reStructuredText',
  subtitles: 'Subtitles / transcript',
  opml: 'Outline (.opml)',
  vcard: 'Contacts (vCard)',
  djot: 'Djot',
  textile: 'Textile',
  sqlite: 'SQLite database',
}

// Binary formats are what their magic bytes say — no override. Text inputs can
// be reinterpreted as any text format that has a reader (extended per phase).
const BINARY: SourceFormat[] = ['docx', 'pdf', 'xlsx', 'msg', 'image', 'pptx', 'doc', 'epub', 'odt', 'odp', 'sqlite']
const TEXT_OVERRIDES: SourceFormat[] = [
  'txt',
  'md',
  'html',
  'csv',
  'eml',
  'mbox',
  'rtf',
  'code',
  'ipynb',
  'ics',
  'asciidoc',
  'rst',
  'json',
  'subtitles',
  'opml',
  'vcard',
  'djot',
  'textile',
]

export function InputCard({
  filename,
  source,
  onSourceChange,
  onReset,
  imageMode,
  ocrLanguage,
  onOcrLanguageChange,
  onImageModeChange,
  onEdit,
  jsonTable,
  viewCount,
  read = {},
  onReadChange,
  edited,
  editedLimited,
}: {
  filename?: string
  /** JSON that reads as a table of records. */
  jsonTable?: boolean
  /** A SQLite database's number of views. */
  viewCount?: number
  /** The reading choices made on this card. */
  read?: ReadOptions
  onReadChange?: (patch: ReadOptions) => void
  /** The input has been opened in the editor: its edited copy is what converts. */
  edited?: boolean
  /** The pane holds an edited copy read cut to the print limit. */
  editedLimited?: boolean
  source: SourceFormat
  onSourceChange: (f: SourceFormat) => void
  onReset: () => void
  imageMode?: 'embed' | 'ocr'
  ocrLanguage?: string
  onOcrLanguageChange?: (code: string) => void
  /** Opens this input in the edit pane. Absent when there is nothing to edit. */
  onEdit?: () => void
  onImageModeChange?: (m: 'embed' | 'ocr') => void
}): React.JSX.Element {
  const jsonAs = read.jsonAs ?? 'table'
  const options = BINARY.includes(source)
    ? [source]
    : TEXT_OVERRIDES.includes(source)
      ? TEXT_OVERRIDES
      : [source, ...TEXT_OVERRIDES]
  return (
    <div className="card">
      <div className="card__row">
        <span className="card__label">Input</span>
        <span className="card__name">{filename ?? 'Pasted text'}</span>
        {onEdit && (
          <button
            className="btn btn--mini"
            onClick={onEdit}
            title="Open this input in the editor before converting"
          >
            Edit
          </button>
        )}
        <button className="btn btn--ghost" onClick={onReset}>
          Change
        </button>
      </div>
      <label className="card__row">
        <span className="card__label">Detected as</span>
        <select value={source} onChange={(e) => onSourceChange(e.target.value as SourceFormat)}>
          {options.map((f) => (
            <option key={f} value={f}>
              {LABELS[f]}
            </option>
          ))}
        </select>
      </label>
      {showsInput('imageMode', { source }) && onImageModeChange && (
        <div className="card__row">
          <span className="card__label">Image mode</span>
          <div className="chips" style={{ margin: 0 }}>
            <button
              className={`chip${imageMode === 'embed' ? ' chip--active' : ''}`}
              aria-pressed={imageMode === 'embed'}
              onClick={() => onImageModeChange('embed')}
              title="Embed the image in the output document"
            >
              Embed
            </button>
            <button
              className={`chip${imageMode === 'ocr' ? ' chip--active' : ''}`}
              aria-pressed={imageMode === 'ocr'}
              onClick={() => onImageModeChange('ocr')}
              title="Recognize the text in the image (English)"
            >
              OCR to text
            </button>
          </div>
        </div>
      )}
      {showsInput('ocrLanguage', { source, imageMode }) && onOcrLanguageChange && (
        <OcrLanguagePicker value={ocrLanguage ?? 'eng'} onChange={onOcrLanguageChange} />
      )}
      {showsInput('jsonAs', { source, jsonTable }) && onReadChange && (
        <div className="card__row">
          <span className="card__label">Read as</span>
          <div className="chips" style={{ margin: 0 }}>
            <button
              className={`chip${jsonAs === 'table' ? ' chip--active' : ''}`}
              aria-pressed={jsonAs === 'table'}
              onClick={() => onReadChange({ jsonAs: 'table' })}
              title="One row per record: ready for CSV, JSON and Excel"
            >
              Table
            </button>
            <button
              className={`chip${jsonAs === 'text' ? ' chip--active' : ''}`}
              aria-pressed={jsonAs === 'text'}
              onClick={() => onReadChange({ jsonAs: 'text' })}
              title="The JSON itself, indented and highlighted"
            >
              Formatted JSON
            </button>
          </div>
        </div>
      )}
      {showsInput('timestamps', { source }) && onReadChange && (
        <div className="card__row">
          <span className="card__label">Transcript</span>
          <label>
            <input
              type="checkbox"
              checked={read.transcriptTimestamps ?? true}
              onChange={(e) => onReadChange({ transcriptTimestamps: e.target.checked })}
            />
            Include timestamps
          </label>
        </div>
      )}
      {showsInput('timestamps', { source }) && edited && (
        <p className="card__note">This transcript has been edited, so changing timestamps does not change it.</p>
      )}
      {showsInput('sqliteViews', { source, viewCount }) && onReadChange && (
        <div className="card__row">
          <span className="card__label">Database</span>
          <label>
            <input
              type="checkbox"
              checked={read.sqliteViews ?? false}
              onChange={(e) => onReadChange({ sqliteViews: e.target.checked })}
            />
            Include view results
          </label>
        </div>
      )}
      {showsInput('sqliteViews', { source, viewCount }) && edited && (
        <p className="card__note">This database has been edited, so changing view results does not change it.</p>
      )}
      {editedLimited && <p className="card__note">{editedCopyNote(source)}</p>}
    </div>
  )
}
