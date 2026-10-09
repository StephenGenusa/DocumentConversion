import { useEffect, useRef, useState } from 'react'
import { DropZone } from './components/DropZone'
import { createIntake, type LoadedPayload, type PaneSource } from './lib/intake'
import type { Intake } from './lib/intake-types'
import { InputCard } from './components/InputCard'
import { InputList, type ListItem } from './components/InputList'
import { ClipboardPane } from './components/ClipboardPane'
import { OutputPicker } from './components/OutputPicker'
import { ResultView } from './components/ResultView'
import { BatchResults } from './components/BatchResults'
import { applyLiveEdit, keepEdits, markDiskState, toRequest, type LiveEdit } from './lib/items'
import { allowedMergeTargets, allowedTargets } from '../../core/target-validity'
import { DEFAULT_PDF_SCALE } from '../../core/pdf-options'
import type {
  BatchRow,
  PdfOptions,
  SaveResult,
  SlideOptions,
  SourceFormat,
  TargetFormat,
} from '../../preload/types'

const PANE_HEIGHT = 860

function App(): React.JSX.Element {
  const [items, setItems] = useState<ListItem[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [mode, setMode] = useState<'batch' | 'merge'>('batch')
  const [headings, setHeadings] = useState(true)
  const [target, setTarget] = useState<TargetFormat>('pdf')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SaveResult | null>(null)
  const [batch, setBatch] = useState<{ outDir: string; rows: BatchRow[] } | null>(null)
  // Session-persistent so repeated conversions keep the chosen page setup.
  const [pdfOptions, setPdfOptions] = useState<PdfOptions>({ scale: DEFAULT_PDF_SCALE, pageSize: 'Letter', landscape: false })
  const [slideOptions, setSlideOptions] = useState<SlideOptions>({ splitOn: 'auto' })
  const [ocrLanguage, setOcrLanguage] = useState('eng')
  const [progress, setProgress] = useState<{ stage: string; percent?: number } | null>(null)
  /** What stopping the current job means: a paste keeps what it has fetched. */
  const [cancelLabel, setCancelLabel] = useState('Cancel')
  const [notice, setNotice] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const jobRef = useRef<string | null>(null)
  /** Set by the mounted edit pane; null whenever no pane is on screen. */
  const liveRef = useRef<(() => LiveEdit) | null>(null)
  const lastKindRef = useRef<'save' | 'copy'>('save')
  /** The current list, for the window-focus listener, which outlives any one render. */
  const itemsRef = useRef<ListItem[]>(items)
  itemsRef.current = items

  useEffect(() => {
    return window.api.onProgress((p) => {
      if (p.jobId === jobRef.current) setProgress({ stage: p.stage, percent: p.percent })
    })
  }, [])

  const editingItem = editingId !== null ? (items.find((i) => i.id === editingId) ?? null) : null

  /**
   * Write the open pane's content into the list.
   *
   * The editor's content exists only inside the pane, and the pane is
   * unmounted whenever a result is on screen. A conversion used to read the
   * edits out for its request and never store them, so dismissing the result
   * rebuilt the pane from the ORIGINAL text - and the next conversion quietly
   * produced that original. Cancelling the save dialog lost edits the same way.
   *
   * The pane is read here, outside any state updater, and the updater itself
   * is pure: updaters run twice under StrictMode and must not have effects.
   */
  function commitLive(): void {
    const live = liveRef.current?.() ?? null
    if (live !== null) setItems((prev) => applyLiveEdit(prev, live))
  }

  /** Commit the pane's edits and close it. */
  function closePane(): void {
    commitLive()
    setEditingId(null)
    window.api.resizeContent({ reset: true })
  }

  /**
   * Every result goes through these two. Showing one unmounts the pane, so the
   * edits are stored first - whatever the result is: saved, copied, cancelled
   * or failed, from a conversion or from a URL that would not load.
   */
  function showResult(res: SaveResult): void {
    commitLive()
    setResult(res)
  }

  function showBatch(b: { outDir: string; rows: BatchRow[] }): void {
    commitLive()
    setBatch(b)
  }

  /** Adding an input while the pane is open silently commits the current edits (spec F0). */
  function addItem(item: Omit<ListItem, 'id'>, edit = false): void {
    const id = crypto.randomUUID()
    const live = liveRef.current?.() ?? null
    setItems((prev) => [...applyLiveEdit(prev, live), { ...item, id }])
    setResult(null)
    setBatch(null)
    if (edit) {
      setEditingId(id)
      window.api.resizeContent({ height: PANE_HEIGHT })
    } else if (editingId !== null) {
      setEditingId(null)
      window.api.resizeContent({ reset: true })
    }
  }

  function onLoaded(p: LoadedPayload): void {
    addItem({
      label: p.filename ?? 'Pasted text',
      filename: p.filename ?? 'document',
      source: p.detected,
      imageMode: 'embed',
      base64: p.base64,
      sourceDir: p.sourceDir,
      handle: p.handle,
    })
  }

  function onClipboard(html: string, source: PaneSource = { label: 'Clipboard', filename: 'Clipboard' }): void {
    addItem({ ...source, source: 'html', imageMode: 'embed', html }, true)
  }

  async function onUrl(url: string): Promise<void> {
    setBusy(true)
    setCancelLabel('Cancel')
    const jobId = crypto.randomUUID()
    jobRef.current = jobId
    try {
      const res = await window.api.loadUrl({ url, jobId })
      if (res.kind === 'html') {
        const filename = res.title?.trim() || new URL(url).hostname
        addItem({ label: url, filename, source: 'html', imageMode: 'embed', html: res.html }, true)
      } else if (res.kind === 'file') {
        if (res.detected.kind === 'ok') {
          onLoaded({ filename: res.filename, base64: res.base64, detected: res.detected.format })
        } else if (res.detected.kind === 'archive') {
          for (const entry of await window.api.expandArchive({ base64: res.base64, filename: res.filename })) {
            if (entry.detected.kind === 'ok') {
              onLoaded({ filename: entry.filename, base64: entry.base64, detected: entry.detected.format })
            }
          }
        } else {
          showResult({ status: 'error', code: 'unsupported', message: res.detected.reason })
        }
      } else {
        showResult({ status: 'error', code: res.code, message: res.message })
      }
    } finally {
      jobRef.current = null
      setProgress(null)
      setBusy(false)
    }
  }

  const intakeCore = createIntake({
    onLoaded,
    onClipboard,
    onUrl: (url) => void onUrl(url),
    onNotice: setNotice,
    // Stopping a paste skips the images still downloading; what has arrived is kept.
    runPasteJob: (work) => withJob(work, 'Skip remaining images'),
  })
  const intake: Intake = { ...intakeCore, submitUrl: (url) => void onUrl(url) }

  function reset(): void {
    if (editingId !== null || items.some((i) => i.html !== undefined)) window.api.resizeContent({ reset: true })
    setItems([])
    setEditingId(null)
    setResult(null)
    setBatch(null)
    // A notice describes the inputs that were just cleared ("skipped 2
    // unsupported"); left up, it reappeared on the empty drop zone.
    setNotice(null)
  }

  /** The list as it should be converted: with the pane's live edits in it. */
  function currentItems(): ListItem[] {
    return applyLiveEdit(items, liveRef.current?.() ?? null)
  }

  /**
   * See whether any file open in the pane has been written since it was read.
   *
   * Edits win: nothing is reloaded here. The item is only flagged, and the
   * notice it raises offers the reload. An input that is NOT open in the pane
   * needs no check - it is read from disk again at every conversion.
   */
  async function checkDisk(): Promise<void> {
    for (const item of itemsRef.current) {
      if (item.html === undefined || item.handle === undefined || item.diskStamp === undefined) continue
      const stamp = await window.api.fileStamp(item.handle)
      setItems((prev) => {
        const next = prev.map((i) => (i.id === item.id ? markDiskState(i, stamp) : i))
        return next.some((n, k) => n !== prev[k]) ? next : prev
      })
    }
  }

  // Coming back to the window is when a file is most likely to have changed:
  // the user went to another program to edit it.
  useEffect(() => {
    const onFocus = (): void => void checkDisk()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // checkDisk reads only refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Replace an edited input with the file as it is on disk now. Discards the edits. */
  async function reloadFromDisk(id: string): Promise<void> {
    const item = items.find((i) => i.id === id)
    if (!item?.handle) return
    const result = await withJob((jobId) =>
      window.api.fileToHtml({
        base64: '',
        handle: item.handle,
        filename: item.filename,
        source: item.source,
        ocr: item.source === 'image' && item.imageMode === 'ocr',
        ocrLanguage,
        jobId,
      }),
    )
    if (result.kind !== 'ok') {
      setNotice(result.message)
      return
    }
    // `rev` rebuilds the editor: it reads its content once, when it mounts.
    setItems((prev) =>
      prev.map((i) =>
        i.id === id
          ? { ...i, html: result.html, diskStamp: result.stamp, staleStamp: undefined, rev: (i.rev ?? 0) + 1 }
          : i,
      ),
    )
  }

  async function withJob<T>(fn: (jobId: string) => Promise<T>, label = 'Cancel'): Promise<T> {
    setBusy(true)
    setCancelLabel(label)
    const jobId = crypto.randomUUID()
    jobRef.current = jobId
    try {
      return await fn(jobId)
    } finally {
      jobRef.current = null
      setProgress(null)
      setBusy(false)
    }
  }

  async function run(kind: 'save' | 'copy', forceOcr = false): Promise<void> {
    const list = currentItems()
    if (list.length === 0) return
    lastKindRef.current = kind
    if (list.length === 1) {
      const req = toRequest(list[0], ocrLanguage)
      if (forceOcr) req.ocr = true
      await withJob(async (jobId) => {
        const payload = {
          ...req,
          target,
          pdf: target === 'pdf' ? pdfOptions : undefined,
          slides: target === 'revealjs' ? slideOptions : undefined,
          jobId,
        }
        const res =
          kind === 'save' ? await window.api.convertAndSave(payload) : await window.api.convertAndCopy(payload)
        showResult(res)
      })
      return
    }
    if (mode === 'merge') {
      await withJob(async (jobId) => {
        const res = await window.api.convertMerge({
          items: list.map((i) => toRequest(i, ocrLanguage)),
          target,
          pdf: target === 'pdf' ? pdfOptions : undefined,
          slides: target === 'revealjs' ? slideOptions : undefined,
          headings,
          jobId,
        })
        showResult(res)
      })
      return
    }
    await withJob(async (jobId) => {
      const res = await window.api.convertBatch({
        items: list.map((i) => toRequest(i, ocrLanguage)),
        target,
        pdf: target === 'pdf' ? pdfOptions : undefined,
        slides: target === 'revealjs' ? slideOptions : undefined,
        jobId,
      })
      if (res.status === 'batch') showBatch({ outDir: res.outDir, rows: res.rows })
    })
  }

  async function retryRow(index: number): Promise<void> {
    if (!batch) return
    const item = items[index]
    if (!item) return
    const outDir = batch.outDir
    await withJob(async (jobId) => {
      const res = await window.api.convertBatch({
        items: [toRequest(item, ocrLanguage)],
        target,
        pdf: target === 'pdf' ? pdfOptions : undefined,
        slides: target === 'revealjs' ? slideOptions : undefined,
        jobId,
        outDir,
      })
      if (res.status === 'batch') {
        setBatch((prev) =>
          prev ? { ...prev, rows: prev.rows.map((r, i) => (i === index ? res.rows[0] : r)) } : prev,
        )
      }
    })
  }

  function retryWithOcr(): void {
    setResult(null)
    void run(lastKindRef.current, true)
  }

  function updateItem(id: string, patch: Partial<ListItem>): void {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  }

  function moveItem(id: string, dir: -1 | 1): void {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.id === id)
      const to = idx + dir
      if (idx < 0 || to < 0 || to >= prev.length) return prev
      const next = [...prev]
      ;[next[idx], next[to]] = [next[to], next[idx]]
      return next
    })
  }

  function removeItem(id: string): void {
    if (editingId === id) {
      setEditingId(null)
      window.api.resizeContent({ reset: true })
    }
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  /**
   * Open an input in the edit pane.
   *
   * Clipboard and URL input already carry hub HTML, so they open immediately.
   * A dropped file does not: it has to be read first, which is the same read
   * the conversion would do. It can take a moment for a large PDF, so it runs
   * as a cancellable job with progress, like any other conversion.
   */
  async function editItem(id: string): Promise<void> {
    if (editingId !== null) closePane()
    const item = currentItems().find((i) => i.id === id)
    if (!item) return

    if (item.html === undefined) {
      if (item.base64 === undefined) return
      const result = await withJob((jobId) =>
        window.api.fileToHtml({
          // A file on disk is read again here, so the pane opens on what the
          // file holds now rather than on what it held when it was added.
          base64: item.handle !== undefined ? '' : item.base64!,
          handle: item.handle,
          filename: item.filename,
          source: item.source,
          ocr: item.source === 'image' && item.imageMode === 'ocr',
          ocrLanguage,
          jobId,
        }),
      )
      if (result.kind !== 'ok') {
        setNotice(result.message)
        return
      }
      // The stamp is what a later change on disk is measured against.
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, html: result.html, diskStamp: result.stamp } : i)))
    }
    setEditingId(id)
    window.api.resizeContent({ height: PANE_HEIGHT })
  }

  const hasInput = items.length > 0
  const single = items.length === 1 ? items[0] : null
  // `items`, not the live pane: validity depends only on WHETHER an input is
  // html, which opening it in the pane already recorded. Rendering must not
  // read the pane.
  const validityInputs = items.map((i) => ({
    format: (i.html !== undefined ? 'html' : i.source) as SourceFormat,
    imageMode: i.imageMode,
  }))
  const allowed =
    items.length > 1 && mode === 'merge' ? allowedMergeTargets(validityInputs) : allowedTargets(validityInputs)
  const restrictor =
    items.find((i) => i.html === undefined && !allowedTargets([{ format: i.source, imageMode: i.imageMode }]).includes(target))
      ?.label ?? 'this input'

  useEffect(() => {
    if (hasInput && !allowed.includes(target)) setTarget(allowed[0] ?? 'pdf')
  }, [hasInput, allowed, target])

  const showResults = result !== null || batch !== null

  return (
    <div className="app">
      <header className="app__header">
        <h1>Document Converter</h1>
        <p>
          Files, web pages and the clipboard → PDF, Word, Markdown, HTML, EPUB, Kindle and slides. Runs entirely on your
          computer.
        </p>
      </header>
      <main
        className={`app__main${dragOver ? ' app__main--drag' : ''}`}
        // Drops and pastes work anywhere in the app, not just on the empty drop zone.
        onDragOver={(e) => {
          e.preventDefault()
          if (hasInput) setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
        }}
        onDrop={(e) => {
          setDragOver(false)
          if (hasInput) void intake.onDrop(e)
        }}
        onPaste={(e) => {
          // Let the editor pane and text fields handle their own pastes.
          const el = e.target as HTMLElement
          if (el.closest('.clip-pane__editor') || el.closest('input')) return
          if (hasInput) void intake.onPaste(e)
        }}
      >
        {!hasInput && !showResults && <DropZone intake={intake} notice={notice} busy={busy} />}
        {hasInput && !showResults && (
          <>
            {editingItem !== null ? (
              <ClipboardPane
                key={`${editingItem.id}:${editingItem.rev ?? 0}`}
                itemId={editingItem.id}
                html={editingItem.html ?? ''}
                sourceLabel={editingItem.label}
                liveRef={liveRef}
                onReset={() => {
                  if (items.length === 1) reset()
                  else closePane()
                }}
              />
            ) : single ? (
              <InputCard
                filename={single.base64 !== undefined ? single.label : undefined}
                source={single.source}
                onSourceChange={(f) => updateItem(single.id, { source: f })}
                onReset={reset}
                imageMode={single.imageMode}
                onImageModeChange={(m) => updateItem(single.id, { imageMode: m })}
                ocrLanguage={ocrLanguage}
                onOcrLanguageChange={setOcrLanguage}
                onEdit={() => void editItem(single.id)}
              />
            ) : (
              <InputList
                items={items}
                mode={mode}
                headings={headings}
                onModeChange={setMode}
                onHeadingsChange={setHeadings}
                onMove={moveItem}
                onRemove={removeItem}
                onEdit={editItem}
                onImageModeChange={(id, m) => updateItem(id, { imageMode: m })}
                onAddFile={() => void intake.openDialog()}
                onAddClipboard={() => void intake.pasteFromClipboard()}
                onClear={reset}
              />
            )}
            {notice && (
              <p className="app__notice" role="alert">
                {notice}
              </p>
            )}
            {/*
              Edits win. A file open in the pane is never re-read behind the
              user's back; this says the disk has moved on and leaves the
              choice with them. Reloading discards the edits, so it is asked,
              not assumed.
            */}
            {items
              .filter((i) => i.staleStamp !== undefined)
              .map((i) => (
                <div className="app__notice app__notice--action" role="alert" key={i.id}>
                  <span>{i.label} changed on disk. Reload? Your edits are kept until you do.</span>
                  <button className="btn btn--mini" disabled={busy} onClick={() => void reloadFromDisk(i.id)}>
                    Reload from disk
                  </button>
                  <button
                    className="btn btn--mini"
                    disabled={busy}
                    onClick={() => setItems((prev) => prev.map((x) => (x.id === i.id ? keepEdits(x) : x)))}
                  >
                    Keep my edits
                  </button>
                </div>
              ))}
            <OutputPicker
              target={target}
              onTargetChange={setTarget}
              onConvert={() => run('save')}
              onCopy={() => run('copy')}
              busy={busy}
              pdfOptions={pdfOptions}
              slideOptions={slideOptions}
              onSlideOptionsChange={setSlideOptions}
              onPdfOptionsChange={setPdfOptions}
              allowed={allowed}
              restrictionLabel={restrictor}
              copyHidden={items.length > 1}
            />
            {items.length === 1 && (
              <div className="add-row">
                <span>Drop or paste more to convert several at once:</span>
                <button className="btn btn--mini" onClick={() => void intake.openDialog()}>
                  Add files…
                </button>
                <button className="btn btn--mini" onClick={() => void intake.pasteFromClipboard()}>
                  Add from clipboard
                </button>
              </div>
            )}
          </>
        )}
        {/*
          Conversion progress and its result change with no visible focus move,
          so without a live region a screen-reader user presses Convert and
          hears nothing at all — not while it runs, and not when it finishes.
          Polite, so an announcement waits for a pause rather than cutting over
          whatever the user is reading.
        */}
        {busy && progress && (
          <div className="progress" role="status" aria-live="polite">
            <span>
              {progress.stage}
              {progress.percent != null ? ` — ${Math.round(progress.percent)}%` : ''}
            </span>
            <button className="btn" onClick={() => jobRef.current && window.api.cancel(jobRef.current)}>
              {cancelLabel}
            </button>
          </div>
        )}
        {result && (
          <ResultView
            result={result}
            onDone={() => {
              setResult(null)
              void checkDisk()
            }}
            onOcrRetry={retryWithOcr}
          />
        )}
        {batch && <BatchResults outDir={batch.outDir} rows={batch.rows} onRetry={retryRow} onDone={reset} />}
      </main>
    </div>
  )
}

export default App
