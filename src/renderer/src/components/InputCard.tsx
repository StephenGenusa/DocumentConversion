import { OcrLanguagePicker } from './OcrLanguagePicker'
import type { SourceFormat } from '../../../preload/types'

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
}

// Binary formats are what their magic bytes say — no override. Text inputs can
// be reinterpreted as any text format that has a reader (extended per phase).
const BINARY: SourceFormat[] = ['docx', 'pdf', 'xlsx', 'msg', 'image', 'pptx', 'doc', 'epub', 'odt', 'odp']
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
}: {
  filename?: string
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
      {source === 'image' && onImageModeChange && (
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
      {source === 'image' && imageMode === 'ocr' && onOcrLanguageChange && (
        <OcrLanguagePicker value={ocrLanguage ?? 'eng'} onChange={onOcrLanguageChange} />
      )}
    </div>
  )
}
