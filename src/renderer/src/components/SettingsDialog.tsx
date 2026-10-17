import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { Settings, SettingKey, SettingsSection, TargetFormat } from '../../../preload/types'
import { settingOf } from '../../../core/settings'
import { PDF_PAGE_SIZES } from '../../../core/pdf-options'
import { zoomLevels } from './OutputPicker'
import { OcrLanguagePicker, announcePacksChanged, megabytes, useOcrLanguages } from './OcrLanguagePicker'
import { IconClose } from './editor-icons'

/**
 * The Settings dialog (settings spec 4 and 7): remembered defaults for
 * conversion choices.
 *
 * Instant apply. Each change goes to `setSetting` as it is made and the main
 * process saves it; there is nothing pending, so Done just closes, as do
 * Escape and the close button. A conversion takes its copy of the settings when it
 * starts, so a change here is for the next one.
 *
 * Every setting is shown, whatever the window holds: these are defaults for
 * documents not yet opened, so the conversion screen's "hidden when it would
 * do nothing" rule has nothing to look at. The one exception is a setting that
 * only means something under another one that is off (local network under
 * fetching). Each says what it changes in its "Affects:" line.
 *
 * OCR (spec 4.7) also manages the downloaded language packs: removing one is
 * housekeeping, not a setting, so it is not undone by Reset.
 */

/** The outputs, as an "Affects:" line names them, in the order it lists them. */
const TARGET_NAMES: [TargetFormat, string][] = [
  ['pdf', 'PDF'],
  ['html', 'HTML'],
  ['revealjs', 'slides'],
  ['epub', 'EPUB'],
  ['azw3', 'AZW3'],
  ['azw4', 'AZW4'],
  ['docx', 'Word'],
  ['md', 'Markdown'],
  ['txt', 'plain text'],
  ['csv', 'CSV'],
  ['json', 'JSON'],
  ['xlsx', 'Excel'],
]

/** "PDF, HTML, slides, EPUB, Kindle (AZW3, AZW4), Word": the two Kindle formats as one entry. */
export function targetList(targets: readonly TargetFormat[]): string {
  const names: string[] = []
  const kindle: string[] = []
  for (const [format, name] of TARGET_NAMES) {
    if (!targets.includes(format)) continue
    if (format === 'azw3' || format === 'azw4') {
      if (kindle.length === 0) names.push('')
      kindle.push(name)
    } else names.push(name)
  }
  return names.map((n) => (n === '' ? `Kindle (${kindle.join(', ')})` : n)).join(', ')
}

// The outputs each setting changes. Kept here rather than imported: the lists
// live in core modules the window does not otherwise load (pictures.ts) or in
// the CLI (CODE_COLOR_TARGETS). tests/renderer/settings-dialog.test.ts checks
// that they agree.
const PICTURE_TARGETS: TargetFormat[] = ['html', 'revealjs', 'pdf', 'azw4', 'epub', 'azw3', 'md', 'docx']
const DRAWING_TARGETS: TargetFormat[] = ['pdf', 'html', 'revealjs', 'epub', 'azw4']
const CODE_TARGETS: TargetFormat[] = ['pdf', 'html', 'revealjs', 'epub', 'azw3', 'azw4', 'docx']

interface Choice {
  value: string | number
  label: string
}

/** One setting as the dialog shows it. */
export interface SettingView {
  key: SettingKey
  title: string
  /** `ocr-language`: the conversion screen's language picker, which can also download one. */
  kind: 'radio' | 'check' | 'select' | 'ocr-language'
  /** Radio and select choices. A select's may depend on the value (a zoom off the steps). */
  choices?: (value: unknown) => Choice[]
  help?: string
  affects: string
  /** Shown only while this checkbox is on. */
  under?: SettingKey
}

export interface SettingsPage {
  id: string
  label: string
  /** What "Reset this section" resets. */
  section: SettingsSection
  settings: SettingView[]
  /** The installed OCR languages, each with Remove, after the settings. */
  packs?: true
}

/** What the OCR section's settings change. */
const OCR_AFFECTS = 'images and scanned PDFs with OCR on'

/** The installed-languages list's help: also what removing the default does. */
export const PACKS_HELP =
  "Languages are downloaded once and kept on this computer. English is included and can't be removed. " +
  'If you remove the default language, English is used instead until you install it again.'

const percent = (z: number): string => `${Math.round(z * 100)}%`

export const SETTINGS_PAGES: SettingsPage[] = [
  {
    id: 'pictures',
    label: 'Pictures',
    section: 'pictures',
    settings: [
      {
        key: 'pictures.format',
        title: "Pictures the output can't hold",
        kind: 'radio',
        choices: () => [
          { value: 'jpeg', label: 'JPG (smaller)' },
          { value: 'png', label: 'PNG (exact)' },
        ],
        help:
          "Some outputs can't hold every kind of picture, for example a TIFF in a PDF or a WebP in a Kindle book. " +
          'Those pictures are converted to this. JPG files are much smaller for photographs; PNG keeps every pixel. ' +
          'Pictures with see-through parts always stay PNG. Drawings (EMF, WMF, SVG) stay sharp: SVG where the ' +
          'output allows it, otherwise PNG.',
        affects: targetList(PICTURE_TARGETS),
      },
    ],
  },
  {
    id: 'web',
    label: 'Web',
    section: 'web',
    settings: [
      {
        key: 'web.fetchPictures',
        title: 'Fetch pictures from the web',
        kind: 'check',
        help:
          'Pictures in web pages, pasted content and Markdown that point to a web address are downloaded and saved ' +
          'into the output, so it works offline. Turn off to convert without using the network; those pictures are ' +
          'replaced by their description. Email and calendar invitations never load web pictures, whatever this says.',
        affects: 'every output',
      },
      {
        key: 'web.allowLocalNetwork',
        title: 'Allow pictures from your local network',
        kind: 'check',
        under: 'web.fetchPictures',
        help:
          'Lets pictures load from company intranet addresses (for example http://intranet/logo.png). This computer ' +
          'itself and cloud metadata addresses are always blocked.',
        affects: 'every output, and web pages opened from an address',
      },
    ],
  },
  {
    id: 'rendered',
    label: 'Formulas & diagrams',
    section: 'rendered',
    settings: [
      {
        key: 'rendered.format',
        title: 'Draw diagrams and formulas as',
        kind: 'radio',
        choices: () => [
          { value: 'svg', label: 'Sharp (SVG)' },
          { value: 'png', label: 'Image (PNG)' },
        ],
        help:
          'Sharp drawings stay crisp at any zoom and keep formula text selectable. Images work in more programs. ' +
          'Word and Kindle (AZW3) always get images. You can still change it on the conversion screen.',
        affects: targetList(DRAWING_TARGETS),
      },
    ],
  },
  {
    id: 'code',
    label: 'Code',
    section: 'code',
    settings: [
      {
        key: 'code.color',
        title: 'Color code by language',
        kind: 'check',
        help:
          'Code blocks whose language is known are colored, as in an editor. Turn off for plain black code, for ' +
          "example for printing. The editor's own colors stay either way.",
        affects: targetList(CODE_TARGETS),
      },
    ],
  },
  {
    id: 'pdf',
    label: 'PDF',
    section: 'pdf',
    settings: [
      {
        key: 'pdf.pageSize',
        title: 'Page size',
        kind: 'select',
        choices: () => PDF_PAGE_SIZES.map((s) => ({ value: s, label: s })),
        help: 'The page size new PDFs start with. You can still change it on the conversion screen.',
        affects: 'PDF',
      },
      {
        key: 'pdf.scale',
        title: 'Zoom',
        kind: 'select',
        // A saved zoom off the toolbar's steps (any from 10% to 200% is valid) is listed too.
        choices: (value) => zoomLevels(value as number).map((z) => ({ value: z, label: percent(z) })),
        help: 'How large the content is printed on the page. You can still change it on the conversion screen.',
        affects: 'PDF',
      },
      {
        key: 'pdf.headerFooter',
        title: 'Header and footer',
        kind: 'check',
        help: 'Title and date at the top, page numbers at the bottom.',
        affects: 'PDF',
      },
    ],
  },
  {
    id: 'reading',
    label: 'Reading',
    section: 'read',
    settings: [
      {
        key: 'read.transcriptTimestamps',
        title: 'Transcripts: show times',
        kind: 'check',
        help: 'Each paragraph of a subtitle file or meeting transcript starts with the time it was said.',
        affects: 'subtitles and transcripts (SRT, VTT), in every output',
      },
      {
        key: 'read.sqliteViews',
        title: 'SQLite: include view results',
        kind: 'check',
        help: 'Views are always listed in the schema; this adds the rows each view returns.',
        affects: 'SQLite databases, in every output',
      },
    ],
  },
  {
    id: 'ocr',
    label: 'OCR',
    section: 'ocr',
    settings: [
      {
        key: 'ocr.language',
        title: 'Default language',
        kind: 'ocr-language',
        help:
          'The language text in pictures and scanned PDFs is read in. You can still change it on the conversion ' +
          "screen. Choosing one that isn't installed downloads it first, after showing its size.",
        affects: OCR_AFFECTS,
      },
    ],
    packs: true,
  },
]

/**
 * The installed OCR languages, with their size and Remove (spec 4.7). English
 * is part of the app and has no Remove. Removing the default language leaves
 * English in force (the store's rule, spec 5.3): the status line says so.
 */
function OcrPacks({
  defaultLanguage,
  onStatus,
  onRemoved,
}: {
  defaultLanguage: string
  onStatus: (text: string) => void
  onRemoved?: (code: string) => void
}): React.JSX.Element {
  const ids = useId()
  const [languages, refresh] = useOcrLanguages()
  const [busy, setBusy] = useState<string | null>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const installed = languages.filter((l) => l.installed)

  async function remove(code: string): Promise<void> {
    const language = installed.find((l) => l.code === code)
    if (!language?.set) return
    const wasDefault = code === defaultLanguage
    setBusy(code)
    onStatus('')
    try {
      const res = await window.api.removeOcrLanguage(code, language.set)
      if (!res.ok) {
        onStatus(`Not removed: ${res.message ?? 'the pack could not be deleted'}`)
        return
      }
      await refresh()
      announcePacksChanged()
      onRemoved?.(code)
      onStatus(wasDefault ? `${language.name} is removed. The default language is now English.` : `${language.name} is removed.`)
      // Its button is gone; the focus stays in the list rather than falling to the page.
      groupRef.current?.focus()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      ref={groupRef}
      className="setting"
      role="group"
      tabIndex={-1}
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-help ${ids}-affects`}
      data-ocr-packs=""
    >
      <span className="setting__title" id={`${ids}-title`}>
        Installed languages
      </span>
      <ul className="ocr-packs">
        {installed.map((l) => (
          <li key={l.code} className="ocr-packs__item" data-language={l.code}>
            <span className="ocr-packs__name">{l.name}</span>
            <span className="ocr-packs__size">
              {l.source === 'bundled' ? 'Included' : megabytes(l.size[l.set ?? 'fast'])}
            </span>
            {l.source === 'downloaded' && (
              <button
                type="button"
                className="btn btn--mini"
                aria-label={`Remove ${l.name}`}
                disabled={busy !== null}
                onClick={() => void remove(l.code)}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="setting__help" id={`${ids}-help`}>
        {PACKS_HELP}
      </p>
      <p className="setting__affects" id={`${ids}-affects`}>
        Affects: {OCR_AFFECTS}
      </p>
    </div>
  )
}

/** The window width below which the section list is a row of tabs (styles.css has the same number). */
const NARROW = '(max-width: 719px)'

function useNarrow(): boolean {
  const query = (): MediaQueryList | null => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null)
  const [narrow, setNarrow] = useState(() => query()?.matches ?? false)
  useEffect(() => {
    const mq = query()
    if (!mq) return
    const update = (): void => setNarrow(mq.matches)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return narrow
}

export function SettingsDialog({
  onClose,
  notice,
  onOcrPackRemoved,
}: {
  onClose: () => void
  /** "Your settings file could not be read and was reset.", when it was. */
  notice?: string | null
  /** A language pack was removed here, for a screen value that names it. */
  onOcrPackRemoved?: (code: string) => void
}): React.JSX.Element {
  const ids = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const cancelRef = useRef<HTMLButtonElement>(null)
  const resetAllRef = useRef<HTMLButtonElement>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [page, setPage] = useState(0)
  const [status, setStatus] = useState('')
  const [confirming, setConfirming] = useState(false)
  const narrow = useNarrow()

  // Opened as a modal: the rest of the window is inert and the focus stays
  // in here. Closing gives the focus back to whatever had it - the gear, the
  // start screen's link, or the editor when the shortcut opened it.
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    tabRefs.current[0]?.focus()
    return () => {
      if (dialog?.open) dialog.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => {
    let live = true
    void window.api.getSettings().then(
      (s) => live && setSettings(s),
      () => {},
    )
    const stop = window.api.onSettingsChanged((s) => setSettings(s))
    return () => {
      live = false
      stop()
    }
  }, [])

  useEffect(() => {
    if (confirming) cancelRef.current?.focus()
  }, [confirming])

  async function save(key: SettingKey, value: unknown): Promise<void> {
    setStatus('')
    const res = await window.api.setSetting(key, value as never)
    if (res.ok) {
      setSettings(res.settings)
      setStatus('Saved')
    } else setStatus(`Not saved: ${res.message}`)
  }

  async function reset(section?: SettingsSection): Promise<void> {
    setStatus('')
    const res = await window.api.resetSettings(section)
    if (res.ok) {
      setSettings(res.settings)
      setStatus(section ? 'This section is back to its defaults' : 'Every setting is back to its default')
    } else setStatus(`Not reset: ${res.message}`)
  }

  function selectPage(i: number): void {
    const n = SETTINGS_PAGES.length
    const next = (i + n) % n
    setPage(next)
    setStatus('')
    tabRefs.current[next]?.focus()
  }

  function onTabKey(e: React.KeyboardEvent): void {
    const moves: Record<string, number> = {
      ArrowDown: page + 1,
      ArrowRight: page + 1,
      ArrowUp: page - 1,
      ArrowLeft: page - 1,
      Home: 0,
      End: SETTINGS_PAGES.length - 1,
    }
    if (!(e.key in moves)) return
    e.preventDefault()
    selectPage(moves[e.key])
  }

  const current = SETTINGS_PAGES[page]
  const tabId = (i: number): string => `${ids}-tab-${SETTINGS_PAGES[i].id}`
  const panelId = `${ids}-panel`

  function view(s: SettingView): React.JSX.Element | null {
    if (!settings) return null
    if (s.under && settingOf(settings, s.under) !== true) return null
    const value = settingOf(settings, s.key)
    const id = `${ids}-${s.key}`
    const described = `${id}-help ${id}-affects`
    const text = (
      <>
        {s.help && (
          <p className="setting__help" id={`${id}-help`}>
            {s.help}
          </p>
        )}
        <p className="setting__affects" id={`${id}-affects`}>
          Affects: {s.affects}
        </p>
      </>
    )
    if (s.kind === 'radio') {
      return (
        <fieldset className="setting" key={s.key} data-setting={s.key} aria-describedby={described}>
          <legend className="setting__title">{s.title}</legend>
          <div className="setting__choices">
            {s.choices!(value).map((c) => (
              <label key={c.value} className="setting__choice">
                <input
                  type="radio"
                  name={id}
                  value={c.value}
                  checked={value === c.value}
                  onChange={() => void save(s.key, c.value)}
                />
                {c.label}
              </label>
            ))}
          </div>
          {text}
        </fieldset>
      )
    }
    if (s.kind === 'ocr-language') {
      return (
        <div className="setting" key={s.key}>
          <label className="setting__title" htmlFor={id}>
            {s.title}
          </label>
          <OcrLanguagePicker
            id={id}
            describedBy={described}
            value={String(value)}
            onChange={(code) => void save(s.key, code)}
          />
          {text}
        </div>
      )
    }
    if (s.kind === 'check') {
      return (
        <div className={`setting${s.under ? ' setting--under' : ''}`} key={s.key}>
          <label className="setting__check">
            <input
              type="checkbox"
              data-setting={s.key}
              checked={value === true}
              aria-describedby={described}
              onChange={(e) => void save(s.key, e.target.checked)}
            />
            <span className="setting__title">{s.title}</span>
          </label>
          {text}
        </div>
      )
    }
    return (
      <div className="setting" key={s.key}>
        <label className="setting__title" htmlFor={id}>
          {s.title}
        </label>
        <select
          id={id}
          data-setting={s.key}
          value={String(value)}
          aria-describedby={described}
          onChange={(e) => void save(s.key, typeof value === 'number' ? Number(e.target.value) : e.target.value)}
        >
          {s.choices!(value).map((c) => (
            <option key={c.value} value={String(c.value)}>
              {c.label}
            </option>
          ))}
        </select>
        {text}
      </div>
    )
  }

  // At the foot of the section list; on a narrow window, where the list is a
  // row of tabs that needs all the width, in the footer.
  const resetAll = (
    <button ref={resetAllRef} type="button" className="link-button settings__reset-all" onClick={() => setConfirming(true)}>
      Reset all settings…
    </button>
  )

  return (
    <dialog
      ref={dialogRef}
      className="settings"
      aria-labelledby={`${ids}-title`}
      // Escape: the dialog closes through its owner, which unmounts it. With
      // the Reset all question up, Escape backs out of the question instead.
      onCancel={(e) => {
        e.preventDefault()
        if (!confirming) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && confirming) {
          e.preventDefault()
          e.stopPropagation()
          setConfirming(false)
          resetAllRef.current?.focus()
        }
      }}
    >
      <header className="settings__head">
        <h2 id={`${ids}-title`}>Settings</h2>
        <button type="button" className="btn btn--icon btn--ghost settings__close" aria-label="Close settings" onClick={onClose}>
          <IconClose />
        </button>
      </header>
      <div className="settings__body">
        <nav className="settings__nav">
          <div
            role="tablist"
            aria-label="Settings sections"
            aria-orientation={narrow ? 'horizontal' : 'vertical'}
            className="settings__tabs"
            onKeyDown={onTabKey}
          >
            {SETTINGS_PAGES.map((p, i) => (
              <button
                key={p.id}
                ref={(el) => {
                  tabRefs.current[i] = el
                }}
                type="button"
                role="tab"
                id={tabId(i)}
                aria-selected={i === page}
                aria-controls={panelId}
                tabIndex={i === page ? 0 : -1}
                className={`settings__tab${i === page ? ' settings__tab--on' : ''}`}
                onClick={() => selectPage(i)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {!narrow && resetAll}
        </nav>
        <div className="settings__panel" role="tabpanel" id={panelId} aria-labelledby={tabId(page)}>
          {notice && (
            <p className="app__notice" role="alert">
              {notice}
            </p>
          )}
          {current.settings.map(view)}
          {current.packs && settings && (
            <OcrPacks defaultLanguage={settings.ocr.language} onStatus={setStatus} onRemoved={onOcrPackRemoved} />
          )}
        </div>
      </div>
      <footer className="settings__foot">
        {confirming ? (
          <div className="settings__confirm" role="group" aria-labelledby={`${ids}-confirm`}>
            <span id={`${ids}-confirm`}>Put every setting back to its default?</span>
            <button
              type="button"
              className="btn btn--mini"
              onClick={() => {
                setConfirming(false)
                void reset()
                resetAllRef.current?.focus()
              }}
            >
              Reset all
            </button>
            <button
              ref={cancelRef}
              type="button"
              className="btn btn--mini"
              onClick={() => {
                setConfirming(false)
                resetAllRef.current?.focus()
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button type="button" className="btn btn--mini" onClick={() => void reset(current.section)}>
              Reset this section
            </button>
            {narrow && resetAll}
          </>
        )}
        <span className="settings__status" role="status">
          {status}
        </span>
        <button type="button" className="btn btn--primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </dialog>
  )
}
