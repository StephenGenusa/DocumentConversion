import { useState } from 'react'
import type { Intake } from '../lib/intake-types'

export type { LoadedPayload } from '../lib/intake'

export function DropZone({
  intake,
  notice,
  busy,
}: {
  intake: Intake
  notice: string | null
  busy?: boolean
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const [urlField, setUrlField] = useState<string | null>(null)

  function submitUrl(value: string): void {
    const url = value.trim()
    if (!/^https?:\/\/\S+$/i.test(url)) return
    setUrlField(null)
    intake.submitUrl(url)
  }

  return (
    <div
      className={`dropzone${hover ? ' dropzone--hover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setHover(true)
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        setHover(false)
        void intake.onDrop(e)
      }}
      onPaste={(e) => void intake.onPaste(e)}
      tabIndex={0}
      role="group"
      aria-label="Drop files or text here, or press Ctrl+V to paste from the clipboard"
    >
      <div className="dropzone__icon" aria-hidden="true">📄</div>
      <p className="dropzone__title">Drop files or text here</p>
      {/*
        Ordered by how often each is actually wanted, not alphabetically or by
        the order of SOURCE_FORMATS: pdf and Word lead because that is what
        people come here to convert. Aliases are listed where the app accepts
        them (see EXT_MAP in src/core/detect.ts) so nobody has to guess whether
        .htm or .pptm will be taken.
      */}
      <p className="dropzone__hint">
        pdf · docx/doc/docm · md · html/htm · txt · xlsx/xls/ods · pptx/pptm · eml/msg/mbox · epub · odt/odp ·
        rtf · csv/tsv · images · ipynb · source code · ics/ical · adoc/rst · zip
      </p>
      <p className="dropzone__hint">
        Ctrl+V pastes with formatting · paste a URL to fetch the page · scanned PDFs and images use offline OCR
      </p>
      <p className="dropzone__hint">
        Converts to PDF, Word, Markdown, HTML, text, EPUB, Kindle and reveal.js slides — or pulls tables out to CSV, JSON and Excel.
      </p>
      <p className="dropzone__hint">
        Add several files to convert as a batch or merge them into one · edit anything before you convert it
      </p>
      {notice && (
        <p className="dropzone__notice" role="alert">
          {notice}
        </p>
      )}
      <div className="dropzone__actions">
        <button className="btn btn--primary" onClick={() => void intake.openDialog()} disabled={busy}>
          Open files…
        </button>
        <button className="btn" onClick={() => void intake.pasteFromClipboard()} disabled={busy}>
          Paste from clipboard
        </button>
        <button className="btn" onClick={() => setUrlField(urlField === null ? '' : null)} disabled={busy}>
          From URL…
        </button>
      </div>
      {urlField !== null && (
        <form
          className="dropzone__url"
          onSubmit={(e) => {
            e.preventDefault()
            submitUrl(urlField)
          }}
        >
          <input
            autoFocus
            type="text"
            placeholder="https://example.com/spec"
            value={urlField}
            onChange={(e) => setUrlField(e.target.value)}
          />
          <button className="btn btn--primary" type="submit" disabled={busy}>
            Load
          </button>
        </form>
      )}
    </div>
  )
}
