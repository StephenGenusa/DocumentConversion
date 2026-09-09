import type { SourceFormat } from '../../../preload/types'

export interface ListItem {
  id: string
  label: string
  filename: string
  source: SourceFormat
  imageMode: 'embed' | 'ocr'
  /** Sanitized hub HTML for clipboard/URL inputs (re-openable in the pane). */
  html?: string
  base64?: string
  /** Folder this input came from, when it came from disk; drives the save dialog. */
  sourceDir?: string
}

const SHORT: Record<SourceFormat, string> = {
  txt: 'txt',
  md: 'md',
  docx: 'docx',
  pdf: 'pdf',
  html: 'html',
  eml: 'eml',
  msg: 'msg',
  csv: 'csv',
  xlsx: 'xlsx',
  rtf: 'rtf',
  image: 'image',
  code: 'code',
  ipynb: 'nb',
  pptx: 'pptx',
  doc: 'doc',
  epub: 'epub',
  mbox: 'mbox',
  json: 'json',
  odt: 'odt',
  odp: 'odp',
  ics: 'ics',
  asciidoc: 'adoc',
  rst: 'rst',
}

export function InputList({
  items,
  mode,
  headings,
  onModeChange,
  onHeadingsChange,
  onMove,
  onRemove,
  onEdit,
  onImageModeChange,
  onAddFile,
  onAddClipboard,
  onClear,
}: {
  items: ListItem[]
  mode: 'batch' | 'merge'
  headings: boolean
  onModeChange: (m: 'batch' | 'merge') => void
  onHeadingsChange: (v: boolean) => void
  onMove: (id: string, dir: -1 | 1) => void
  onRemove: (id: string) => void
  onEdit: (id: string) => void
  onImageModeChange: (id: string, m: 'embed' | 'ocr') => void
  onAddFile: () => void
  onAddClipboard: () => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <div className="card">
      <div className="card__row">
        <span className="card__label">Inputs ({items.length})</span>
        <div className="chips" style={{ margin: 0 }}>
          <button className={`chip${mode === 'batch' ? ' chip--active' : ''}`} onClick={() => onModeChange('batch')}>
            Batch — one output per file
          </button>
          <button className={`chip${mode === 'merge' ? ' chip--active' : ''}`} onClick={() => onModeChange('merge')}>
            Merge — one document
          </button>
        </div>
      </div>
      <ul className="input-list">
        {items.map((item, i) => (
          <li key={item.id} className="input-list__row">
            <span className="input-list__badge">{SHORT[item.source]}</span>
            <span className="input-list__name" title={item.label}>
              {item.label}
            </span>
            {item.source === 'image' && (
              <select
                aria-label={`How to handle the image ${item.label}`}
                value={item.imageMode}
                onChange={(e) => onImageModeChange(item.id, e.target.value as 'embed' | 'ocr')}
              >
                <option value="embed">Embed</option>
                <option value="ocr">OCR</option>
              </select>
            )}
            {/* Offered for every input, not only those that already carry hub
                HTML. A dropped file is read when Edit is pressed. */}
            <button
              className="btn btn--mini"
              onClick={() => onEdit(item.id)}
              title="Open this input in the editor before converting"
            >
              Edit
            </button>
            <button className="btn btn--mini" disabled={i === 0} onClick={() => onMove(item.id, -1)} title="Move up">
              ↑
            </button>
            <button
              className="btn btn--mini"
              disabled={i === items.length - 1}
              onClick={() => onMove(item.id, 1)}
              title="Move down"
            >
              ↓
            </button>
            <button className="btn btn--mini" onClick={() => onRemove(item.id)} title="Remove">
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="input-list__footer">
        <button className="btn" onClick={onAddFile}>
          Add file…
        </button>
        <button className="btn" onClick={onAddClipboard}>
          Add from clipboard
        </button>
        {mode === 'merge' && (
          <label className="input-list__headings">
            <input type="checkbox" checked={headings} onChange={(e) => onHeadingsChange(e.target.checked)} />
            Add source headings
          </label>
        )}
        <button className="btn btn--ghost" onClick={onClear}>
          Clear all
        </button>
      </div>
    </div>
  )
}
