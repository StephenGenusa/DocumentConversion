import { useEffect, useRef, useState } from 'react'
import type { Intake } from '../lib/intake-types'
import { SAMPLES } from '../../../core/samples'
import { inputFormatHint } from '../../../core/input-formats'

export type { LoadedPayload } from '../lib/intake'

export function DropZone({
  intake,
  notice,
  busy,
  onOpenSettings,
}: {
  intake: Intake
  notice: string | null
  busy?: boolean
  onOpenSettings?: () => void
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
      {/* Built from the detector's own extension table: see src/core/input-formats.ts. */}
      <p className="dropzone__hint">{inputFormatHint()}</p>
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
      {/*
        The menu bar is hidden until Alt on Windows and Linux, so the About and
        Sample Documents items of Help and File → Settings would go unfound
        without a way in from here.
      */}
      <p className="dropzone__about">
        {onOpenSettings && (
          <>
            <button type="button" className="link-button" onClick={onOpenSettings}>
              Settings
            </button>
            <span aria-hidden="true"> · </span>
          </>
        )}
        <SampleMenu />
        <span aria-hidden="true"> · </span>
        <button type="button" className="link-button" onClick={() => void window.api.openAbout()}>
          About and licenses
        </button>
      </p>
    </div>
  )
}

/**
 * The start screen's Sample documents link: a menu button (the Enter key, the
 * Space bar or Down opens it on its first sample, Up and Down move, Escape closes it and
 * returns to the link) offering the samples of Help → Sample Documents.
 * Choosing one asks main to open it exactly as that menu item does.
 */
function SampleMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const focusItem = (i: number): void => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    items[(i + items.length) % items.length]?.focus()
  }
  useEffect(() => {
    if (!open) return
    focusItem(0)
    const close = (e: MouseEvent): void => {
      if (!(e.target as Element | null)?.closest?.('.sample-menu')) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  function close(): void {
    setOpen(false)
    buttonRef.current?.focus()
  }

  function onListKeys(e: React.KeyboardEvent<HTMLDivElement>): void {
    const items = Array.from(listRef.current?.querySelectorAll('[role="menuitem"]') ?? [])
    const at = items.indexOf(document.activeElement as Element)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusItem(at + (e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      focusItem(e.key === 'Home' ? 0 : -1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') setOpen(false)
    e.stopPropagation()
  }

  return (
    <span className="sample-menu">
      <button
        ref={buttonRef}
        type="button"
        className="link-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        Sample documents
      </button>
      {open && (
        <div className="sample-menu__list" role="menu" aria-label="Sample documents" ref={listRef} onKeyDown={onListKeys}>
          {SAMPLES.map((sample) => (
            <button
              key={sample.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="sample-menu__item"
              onClick={() => {
                close()
                void window.api.openSample(sample.id)
              }}
            >
              {sample.menu}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
