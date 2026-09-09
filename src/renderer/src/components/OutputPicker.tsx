import type { PdfOptions, PdfPageSize, SlideOptions, TargetFormat } from '../../../preload/types'
import { isClipboardTarget } from '../../../core/target-validity'

export type { TargetFormat }

const LABELS: Record<TargetFormat, string> = {
  txt: 'Plain text',
  md: 'Markdown',
  docx: 'Word',
  pdf: 'PDF',
  html: 'HTML',
  epub: 'EPUB e-book',
  revealjs: 'Slides',
  azw3: 'Kindle (AZW3)',
  azw4: 'Kindle (AZW4)',
  csv: 'CSV (tables)',
  json: 'JSON (tables)',
  xlsx: 'Excel (tables)',
}
const FORMATS: TargetFormat[] = [
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

const ZOOM_LEVELS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2]
const PAGE_SIZES: PdfPageSize[] = ['Letter', 'A4', 'Legal', 'A3', 'Tabloid']

export function OutputPicker({
  target,
  onTargetChange,
  onConvert,
  onCopy,
  busy,
  pdfOptions,
  onPdfOptionsChange,
  slideOptions,
  onSlideOptionsChange,
  allowed,
  restrictionLabel,
  copyHidden,
}: {
  target: TargetFormat
  onTargetChange: (f: TargetFormat) => void
  onConvert: () => void
  onCopy: () => void
  busy: boolean
  pdfOptions: PdfOptions
  onPdfOptionsChange: (o: PdfOptions) => void
  slideOptions: SlideOptions
  onSlideOptionsChange: (o: SlideOptions) => void
  allowed?: TargetFormat[]
  restrictionLabel?: string
  copyHidden?: boolean
}): React.JSX.Element {
  const copyable = !copyHidden && isClipboardTarget(target)
  const isAllowed = (f: TargetFormat): boolean => !allowed || allowed.includes(f)
  return (
    <div className="card">
      <span className="card__label">Convert to</span>
      {/*
        A toggle group. `chip--active` is paint only — without aria-pressed
        every chip announces identically and there is no way to hear which
        output format is currently selected.
      */}
      <div className="chips">
        {FORMATS.map((f) => (
          <button
            key={f}
            className={`chip${target === f ? ' chip--active' : ''}`}
            aria-pressed={target === f}
            onClick={() => onTargetChange(f)}
            disabled={!isAllowed(f)}
            title={!isAllowed(f) ? `Not valid for ${restrictionLabel ?? 'this input'}` : undefined}
          >
            {LABELS[f]}
          </button>
        ))}
      </div>
      {target === 'revealjs' && (
        <div className="pdf-options">
          <label>
            New slide at
            <select
              value={slideOptions.splitOn ?? 'auto'}
              onChange={(e) =>
                onSlideOptionsChange({ splitOn: e.target.value as SlideOptions['splitOn'] })
              }
            >
              <option value="auto">Automatic</option>
              <option value="hr">A horizontal rule</option>
              <option value="h1">Every heading 1</option>
              <option value="h2">Every heading 2</option>
            </select>
          </label>
          <span className="pdf-options__note">
            Automatic splits on a rule if the document has one, otherwise on heading 1.
          </span>
        </div>
      )}
      {target === 'pdf' && (
        <div className="pdf-options">
          <label>
            Zoom
            <select
              value={String(pdfOptions.scale ?? 1)}
              onChange={(e) => onPdfOptionsChange({ ...pdfOptions, scale: Number(e.target.value) })}
            >
              {ZOOM_LEVELS.map((z) => (
                <option key={z} value={z}>
                  {Math.round(z * 100)}%
                </option>
              ))}
            </select>
          </label>
          <label>
            Page
            <select
              value={pdfOptions.pageSize ?? 'Letter'}
              onChange={(e) => onPdfOptionsChange({ ...pdfOptions, pageSize: e.target.value as PdfPageSize })}
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Orientation
            <select
              value={pdfOptions.landscape ? 'landscape' : 'portrait'}
              onChange={(e) => onPdfOptionsChange({ ...pdfOptions, landscape: e.target.value === 'landscape' })}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={pdfOptions.headerFooter ?? false}
              onChange={(e) => onPdfOptionsChange({ ...pdfOptions, headerFooter: e.target.checked })}
            />
            Header &amp; footer
          </label>
        </div>
      )}
      <div className="convert-actions">
        <button className="btn btn--primary btn--block" onClick={onConvert} disabled={busy}>
          {busy ? 'Converting…' : 'Convert & Save'}
        </button>
        {copyable && (
          <button className="btn btn--block" onClick={onCopy} disabled={busy}>
            Convert to clipboard
          </button>
        )}
      </div>
    </div>
  )
}
