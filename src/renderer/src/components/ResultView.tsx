import type { SaveResult } from '../../../preload/types'

export function ResultView({
  result,
  onDone,
  onOcrRetry,
}: {
  result: SaveResult
  onDone: () => void
  onOcrRetry?: () => void
}): React.JSX.Element {
  if (result.status === 'saved') {
    return (
      <div className="result result--ok" role="status" aria-live="polite">
        <p>
          ✅ Saved to <code>{result.path}</code>
          {result.paths && result.paths.length > 1 ? ` (+${result.paths.length - 1} more table file${result.paths.length > 2 ? 's' : ''})` : ''}
        </p>
        {result.advice && (
          <p className="result__advice">
            💡 Tip: {result.advice}. Try Landscape orientation and convert again.
          </p>
        )}
        <div className="result__actions">
          <button className="btn" onClick={() => window.api.openPath(result.path)}>
            Open
          </button>
          <button className="btn" onClick={() => window.api.reveal(result.path)}>
            Show in folder
          </button>
          <button className="btn btn--ghost" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    )
  }
  if (result.status === 'copied') {
    return (
      <div className="result result--ok" role="status" aria-live="polite">
        <p>
          📋 Copied to clipboard — paste it wherever you need it.
          {result.totalParts && result.totalParts > 1
            ? ` (table 1 of ${result.totalParts} — save to get all tables)`
            : ''}
        </p>
        <button className="btn btn--ghost" onClick={onDone}>
          Done
        </button>
      </div>
    )
  }
  if (result.status === 'error') {
    const scanned = result.code === 'scanned-pdf'
    return (
      <div className="result result--err" role="alert">
        <p>⚠️ {scanned ? 'This PDF appears to be scanned — there is no text layer to convert.' : result.message}</p>
        <div className="result__actions">
          {scanned && onOcrRetry && (
            <button className="btn btn--primary" onClick={onOcrRetry}>
              Run OCR (English)
            </button>
          )}
          <button className="btn btn--ghost" onClick={onDone}>
            Back
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="result">
      <p>Save cancelled.</p>
      <button className="btn btn--ghost" onClick={onDone}>
        Back
      </button>
    </div>
  )
}
