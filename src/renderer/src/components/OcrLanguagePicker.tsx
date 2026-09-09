import { useEffect, useState } from 'react'
import type { OcrLanguageListing } from '../../../preload/types'

/**
 * Choosing the OCR language, and installing one that is not there yet.
 *
 * A download is never automatic. The app's claim is that nothing leaves the
 * machine, so fetching a model has to be something the user asked for, with
 * the size shown before they agree - not a surprise on first use of a feature
 * they thought was local.
 */
export function OcrLanguagePicker({
  value,
  onChange,
}: {
  value: string
  onChange: (code: string) => void
}): React.JSX.Element {
  const [languages, setLanguages] = useState<OcrLanguageListing[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = async (): Promise<void> => setLanguages(await window.api.listOcrLanguages())
  useEffect(() => {
    void refresh()
  }, [])

  const installed = languages.filter((l) => l.installed)
  const available = languages.filter((l) => !l.installed)
  const selected = languages.find((l) => l.code === value)

  async function install(code: string): Promise<void> {
    const language = languages.find((l) => l.code === code)
    if (!language) return
    setBusy(code)
    setNotice(null)
    try {
      const result = await window.api.downloadOcrLanguage(code, 'fast')
      if (result.kind === 'ok') {
        await refresh()
        onChange(code)
        setNotice(`${language.name} is installed.`)
      } else if (result.kind === 'error') {
        setNotice(result.message)
      }
    } finally {
      setBusy(null)
    }
  }

  const mb = (bytes: number): string => `${Math.round(bytes / 100_000) / 10} MB`

  return (
    <div className="card__row">
      <span className="card__label">Language</span>
      <div className="ocr-lang">
        <select
          aria-label="OCR language"
          value={value}
          onChange={(e) => {
            const code = e.target.value
            const language = languages.find((l) => l.code === code)
            if (language && !language.installed) void install(code)
            else onChange(code)
          }}
        >
          <optgroup label="Installed">
            {installed.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </optgroup>
          {available.length > 0 && (
            <optgroup label="Download on demand">
              {available.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} — {mb(l.size.fast)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {busy && (
          <span className="ocr-lang__status" role="status">
            Downloading {languages.find((l) => l.code === busy)?.name}…
          </span>
        )}
        {!busy && selected?.source === 'bundled' && (
          <span className="ocr-lang__status">Included — works offline</span>
        )}
        {notice && (
          <span className="ocr-lang__notice" role="alert">
            {notice}
          </span>
        )}
      </div>
    </div>
  )
}
