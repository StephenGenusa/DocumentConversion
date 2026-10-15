import type { ReadOptions, SourceFormat } from '../../../preload/types'
import { showsInput } from '../lib/controls'

import type { ListItem } from '../lib/items'

export type { ListItem }

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
  svg: 'svg',
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
  subtitles: 'vtt',
  opml: 'opml',
  vcard: 'vcf',
  djot: 'dj',
  textile: 'textile',
  sqlite: 'db',
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
  onReadChange,
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
  onReadChange?: (id: string, patch: ReadOptions) => void
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
            {showsInput('imageMode', { source: item.source }) && (
              <select
                aria-label={`How to handle the image ${item.label}`}
                value={item.imageMode}
                onChange={(e) => onImageModeChange(item.id, e.target.value as 'embed' | 'ocr')}
              >
                <option value="embed">Embed</option>
                <option value="ocr">OCR</option>
              </select>
            )}
            {showsInput('jsonAs', { source: item.source, jsonTable: item.jsonTable }) && onReadChange && (
              <select
                aria-label={`How to read the JSON ${item.label}`}
                value={item.read?.jsonAs ?? 'table'}
                onChange={(e) => onReadChange(item.id, { jsonAs: e.target.value as 'table' | 'text' })}
              >
                <option value="table">Table</option>
                <option value="text">Formatted JSON</option>
              </select>
            )}
            {showsInput('timestamps', { source: item.source }) && onReadChange && (
              <label title={item.html !== undefined ? 'Edited: changing this does not change the edited transcript' : undefined}>
                <input
                  type="checkbox"
                  aria-label={`Include timestamps in ${item.label}`}
                  checked={item.read?.transcriptTimestamps ?? true}
                  onChange={(e) => onReadChange(item.id, { transcriptTimestamps: e.target.checked })}
                />
                Times
              </label>
            )}
            {showsInput('sqliteViews', { source: item.source, viewCount: item.viewCount }) && onReadChange && (
              <label title={item.html !== undefined ? 'Edited: changing this does not change the edited database' : undefined}>
                <input
                  type="checkbox"
                  aria-label={`Include view results in ${item.label}`}
                  checked={item.read?.sqliteViews ?? false}
                  onChange={(e) => onReadChange(item.id, { sqliteViews: e.target.checked })}
                />
                Views
              </label>
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
