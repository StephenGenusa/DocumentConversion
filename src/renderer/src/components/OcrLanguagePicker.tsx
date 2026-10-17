import { useCallback, useEffect, useRef, useState } from 'react'
import type { OcrLanguageListing } from '../../../preload/types'

/**
 * Sent on `window` when a pack is installed or removed, so every list of
 * languages on screen (a card's picker, the Settings dialog's) reads again.
 */
export const OCR_PACKS_CHANGED = 'docconv:ocr-packs-changed'

export function announcePacksChanged(): void {
  window.dispatchEvent(new Event(OCR_PACKS_CHANGED))
}

/** The installed languages and the rest, kept current as packs come and go. */
export function useOcrLanguages(): [OcrLanguageListing[], () => Promise<void>] {
  const [languages, setLanguages] = useState<OcrLanguageListing[]>([])
  const live = useRef(true)
  const refresh = useCallback(async (): Promise<void> => {
    const listed = await window.api.listOcrLanguages()
    if (live.current) setLanguages(listed)
  }, [])
  useEffect(() => {
    live.current = true
    void refresh()
    const again = (): void => void refresh()
    window.addEventListener(OCR_PACKS_CHANGED, again)
    return () => {
      live.current = false
      window.removeEventListener(OCR_PACKS_CHANGED, again)
    }
  }, [refresh])
  return [languages, refresh]
}

export const megabytes = (bytes: number): string => `${Math.round(bytes / 100_000) / 10} MB`

/**
 * Choosing the OCR language, and installing one that is not there yet.
 *
 * A download is never automatic. The app's claim is that nothing leaves the
 * machine, so fetching a model has to be something the user asked for, with
 * the size shown before they agree - not a surprise on first use of a feature
 * they thought was local.
 *
 * On an input card it is a labeled row; in the Settings dialog (`id` given)
 * the dialog draws the label and the description.
 */
export function OcrLanguagePicker({
  value,
  onChange,
  id,
  describedBy,
}: {
  value: string
  onChange: (code: string) => void
  /** For the Settings dialog: the select's id, for its own <label>. */
  id?: string
  describedBy?: string
}): React.JSX.Element {
  const [languages, refresh] = useOcrLanguages()
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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
        announcePacksChanged()
        onChange(code)
        setNotice(`${language.name} is installed.`)
      } else if (result.kind === 'error') {
        setNotice(result.message)
      }
    } finally {
      setBusy(null)
    }
  }

  const picker = (
    <div className="ocr-lang">
      <select
        id={id}
        aria-label={id ? undefined : 'OCR language'}
        aria-describedby={describedBy}
        data-setting={id ? 'ocr.language' : undefined}
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
                {l.name} — {megabytes(l.size.fast)}
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
      {!busy && selected?.source === 'bundled' && <span className="ocr-lang__status">Included — works offline</span>}
      {notice && (
        <span className="ocr-lang__notice" role="alert">
          {notice}
        </span>
      )}
    </div>
  )
  if (id) return picker
  return (
    <div className="card__row">
      <span className="card__label">Language</span>
      {picker}
    </div>
  )
}
