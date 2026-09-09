import type { BatchRow } from '../../../preload/types'

const ICON: Record<BatchRow['status'], string> = { saved: '✅', error: '⚠️', cancelled: '⏹️' }

export function BatchResults({
  outDir,
  rows,
  onRetry,
  onDone,
}: {
  outDir: string
  rows: BatchRow[]
  onRetry: (index: number) => void
  onDone: () => void
}): React.JSX.Element {
  const saved = rows.filter((r) => r.status === 'saved').length
  const failed = rows.filter((r) => r.status === 'error').length
  const cancelled = rows.filter((r) => r.status === 'cancelled').length
  return (
    <div className={`result ${failed ? 'result--err' : 'result--ok'}`}>
      <p>
        {saved} converted{failed ? `, ${failed} failed` : ''}
        {cancelled ? `, ${cancelled} cancelled` : ''} → <code>{outDir}</code>
      </p>
      <ul className="batch-rows">
        {rows.map((r, i) => (
          <li key={i} className="batch-rows__row">
            <span>{ICON[r.status]}</span>
            <span className="batch-rows__name" title={r.message ?? r.path}>
              {r.filename}
              {r.message ? ` — ${r.message}` : ''}
            </span>
            {r.status === 'error' && (
              <button className="btn btn--mini" onClick={() => onRetry(i)}>
                Retry
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="result__actions">
        <button className="btn" onClick={() => window.api.openPath(outDir)}>
          Open folder
        </button>
        <button className="btn btn--ghost" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}
