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
import { textToBase64 } from './lib/encoding'
import { allowedMergeTargets, allowedTargets } from '../../core/target-validity'
import type {
  BatchItemReq,
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
  const [pdfOptions, setPdfOptions] = useState<PdfOptions>({ scale: 1, pageSize: 'Letter', landscape: false })
  const [slideOptions, setSlideOptions] = useState<SlideOptions>({ splitOn: 'auto' })
  const [ocrLanguage, setOcrLanguage] = useState('eng')
  const [progress, setProgress] = useState<{ stage: string; percent?: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const jobRef = useRef<string | null>(null)
  const clipGetterRef = useRef<(() => string) | null>(null)
  const lastKindRef = useRef<'save' | 'copy'>('save')

  useEffect(() => {
    return window.api.onProgress((p) => {
      if (p.jobId === jobRef.current) setProgress({ stage: p.stage, percent: p.percent })
    })
  }, [])

  const editingItem = editingId !== null ? (items.find((i) => i.id === editingId) ?? null) : null

  /** Adding an input while the pane is open silently commits the current edits (spec F0). */
  function commitEditing(list: ListItem[]): ListItem[] {
    if (editingId === null) return list
    const html = clipGetterRef.current?.()
    setEditingId(null)
    window.api.resizeContent({ reset: true })
    if (html === undefined) return list
    return list.map((i) => (i.id === editingId ? { ...i, html } : i))
  }

  function addItem(item: Omit<ListItem, 'id'>, edit = false): void {
    const id = crypto.randomUUID()
    setItems((prev) => [...commitEditing(prev), { ...item, id }])
    setResult(null)
    setBatch(null)
    if (edit) {
      setEditingId(id)
      window.api.resizeContent({ height: PANE_HEIGHT })
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
    })
  }

  function onClipboard(html: string, source: PaneSource = { label: 'Clipboard', filename: 'Clipboard' }): void {
    addItem({ ...source, source: 'html', imageMode: 'embed', html }, true)
  }

  async function onUrl(url: string): Promise<void> {
    setBusy(true)
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
          setResult({ status: 'error', code: 'unsupported', message: res.detected.reason })
        }
      } else {
        setResult({ status: 'error', code: res.code, message: res.message })
      }
    } finally {
      jobRef.current = null
      setProgress(null)
      setBusy(false)
    }
  }

  const intakeCore = createIntake({ onLoaded, onClipboard, onUrl: (url) => void onUrl(url), onNotice: setNotice })
  const intake: Intake = { ...intakeCore, submitUrl: (url) => void onUrl(url) }

  function reset(): void {
    if (editingId !== null || items.some((i) => i.html !== undefined)) window.api.resizeContent({ reset: true })
    setItems([])
    setEditingId(null)
    setResult(null)
    setBatch(null)
  }

  function toRequest(item: ListItem): BatchItemReq {
    const base64 = item.html !== undefined ? textToBase64(item.html) : (item.base64 ?? '')
    const source: SourceFormat = item.html !== undefined ? 'html' : item.source
    return {
      base64,
      filename: item.filename,
      source,
      ocr: item.source === 'image' && item.imageMode === 'ocr',
      ocrLanguage,
      sourceDir: item.sourceDir,
    }
  }

  function currentItems(): ListItem[] {
    // Serialize live edits before converting.
    if (editingId !== null) {
      const html = clipGetterRef.current?.()
      if (html !== undefined) return items.map((i) => (i.id === editingId ? { ...i, html } : i))
    }
    return items
  }

  async function withJob<T>(fn: (jobId: string) => Promise<T>): Promise<T> {
    setBusy(true)
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
      const req = toRequest(list[0])
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
        setResult(res)
      })
      return
    }
    if (mode === 'merge') {
      await withJob(async (jobId) => {
        const res = await window.api.convertMerge({
          items: list.map(toRequest),
          target,
          pdf: target === 'pdf' ? pdfOptions : undefined,
        slides: target === 'revealjs' ? slideOptions : undefined,
          headings,
          jobId,
        })
        setResult(res)
      })
      return
    }
    await withJob(async (jobId) => {
      const res = await window.api.convertBatch({
        items: list.map(toRequest),
        target,
        pdf: target === 'pdf' ? pdfOptions : undefined,
        slides: target === 'revealjs' ? slideOptions : undefined,
        jobId,
      })
      if (res.status === 'batch') setBatch({ outDir: res.outDir, rows: res.rows })
    })
  }

  async function retryRow(index: number): Promise<void> {
    if (!batch) return
    const item = items[index]
    if (!item) return
    const outDir = batch.outDir
    await withJob(async (jobId) => {
      const res = await window.api.convertBatch({
        items: [toRequest(item)],
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
    const list = commitEditing(items)
    setItems(list)
    const item = list.find((i) => i.id === id)
    if (!item) return

    if (item.html === undefined) {
      if (item.base64 === undefined) return
      const result = await withJob((jobId) =>
        window.api.fileToHtml({
          base64: item.base64!,
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
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, html: result.html } : i)))
    }
    setEditingId(id)
    window.api.resizeContent({ height: PANE_HEIGHT })
  }

  const hasInput = items.length > 0
  const single = items.length === 1 ? items[0] : null
  const validityInputs = currentItems().map((i) => ({
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
                key={editingItem.id}
                html={editingItem.html ?? ''}
                sourceLabel={editingItem.label}
                getHtmlRef={clipGetterRef}
                onReset={() => {
                  if (items.length === 1) reset()
                  else setItems((prev) => commitEditing(prev))
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
              Cancel
            </button>
          </div>
        )}
        {result && <ResultView result={result} onDone={() => setResult(null)} onOcrRetry={retryWithOcr} />}
        {batch && <BatchResults outDir={batch.outDir} rows={batch.rows} onRetry={retryRow} onDone={reset} />}
      </main>
    </div>
  )
}

export default App
