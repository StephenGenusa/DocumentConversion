import type { DragEvent } from 'react'
import { arrayBufferToBase64, textToBase64 } from './encoding'
import { isEditableTextFormat } from '../../../core/types'
import { shouldUseHtmlFlavor } from '../../../core/paste-flavors'
import type { DetectResult, LoadedInput, SourceFormat } from '../../../preload/types'

export interface LoadedPayload {
  filename?: string
  base64: string
  detected: SourceFormat
  /** Folder the input came from, when it came from disk. Drives the save dialog. */
  sourceDir?: string
}

/** How an input that opens in the edit pane is named in the list and on disk. */
export interface PaneSource {
  label: string
  filename: string
}

/** Pasted and dropped text has no filename of its own, so it borrows these. */
const PASTED_TEXT: PaneSource = { label: 'Pasted text', filename: 'document' }

export interface IntakeHandlers {
  onLoaded: (p: LoadedPayload) => void
  /** Opens the edit pane. Defaults to naming the input after the clipboard. */
  onClipboard: (sanitizedHtml: string, source?: PaneSource) => void
  onUrl: (url: string) => void
  onNotice: (message: string | null) => void
}

/**
 * Shared intake: dropping, pasting and dialogs behave identically wherever
 * they happen — the empty drop zone or the loaded input list.
 */
export function createIntake(handlers: IntakeHandlers) {
  const { onLoaded, onClipboard, onUrl, onNotice } = handlers

  async function accept(
    base64: string,
    detected: DetectResult,
    filename?: string,
    sourceDir?: string,
  ): Promise<void> {
    if (detected.kind === 'unsupported') {
      onNotice(filename ? `${filename}: ${detected.reason}` : detected.reason)
      return
    }
    if (detected.kind === 'archive') {
      // A zip becomes its (supported) entries in the input list.
      // Entries have no folder of their own, so they inherit the archive's:
      // that is where the user would look for the output.
      const entries = await window.api.expandArchive({ base64, filename: filename ?? 'archive.zip', sourceDir })
      let added = 0
      for (const entry of entries) {
        if (entry.detected.kind !== 'ok') continue
        onLoaded({ filename: entry.filename, base64: entry.base64, detected: entry.detected.format, sourceDir })
        added++
      }
      const skipped = entries.length - added
      onNotice(
        added === 0
          ? 'That archive has no convertible files'
          : skipped > 0
            ? `Added ${added} file${added === 1 ? '' : 's'} · skipped ${skipped} unsupported`
            : null,
      )
      return
    }
    onNotice(null)
    onLoaded({ filename, base64, detected: detected.format, sourceDir })
  }

  async function acceptLoaded(loaded: LoadedInput[] | null): Promise<void> {
    // Main resolved these from real paths, so it already knows their folders.
    for (const l of loaded ?? []) await accept(l.base64, l.detected, l.filename, l.sourceDir)
  }

  async function handleFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const base64 = arrayBufferToBase64(await file.arrayBuffer())
      const detected = await window.api.detect({ base64, filename: file.name })
      // A dropped File carries no path of its own; only the preload can say
      // where it came from, and it says '' for one not backed by disk.
      await accept(base64, detected, file.name, window.api.dirForFile(file) || undefined)
    }
  }

  /**
   * Pasted and dropped text.
   *
   * Markdown and plain text open in the edit pane as formatted content — a
   * pasted heading should look like a heading, not like `# heading` — which
   * also means it can be trimmed before converting. Text detected as anything
   * else keeps its own reader and stays an input card; see
   * EDITABLE_TEXT_FORMATS for why.
   */
  async function handleText(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    if (/^https?:\/\/\S+$/i.test(trimmed)) return onUrl(trimmed)
    const detected = await window.api.detectText(text)
    if (detected.kind === 'ok' && isEditableTextFormat(detected.format)) {
      const html = await window.api.textToHtml(text, detected.format)
      onNotice(null)
      return onClipboard(html, PASTED_TEXT)
    }
    await accept(textToBase64(text), detected)
  }

  async function onDrop(e: DragEvent): Promise<void> {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) return handleFiles(files)
    // Some file managers drop file:// URIs instead of File objects.
    const uriList = e.dataTransfer.getData('text/uri-list')
    const plain = e.dataTransfer.getData('text/plain')
    const fileUris = uriList || (/^file:\/\//i.test(plain.trim()) ? plain : '')
    if (fileUris) {
      const loaded = await window.api.loadUriList(fileUris)
      if (loaded) return acceptLoaded(loaded)
    }
    if (plain) return handleText(plain)
  }

  /**
   * Rich paste: take the formatted flavor when it is genuinely formatted, and
   * main sanitizes before the editor sees it. A HTML flavor that is only the
   * plain text in a whitespace wrapper is passed over, so copied markdown
   * source still reaches its reader — see `shouldUseHtmlFlavor`.
   */
  async function onPaste(e: { clipboardData: DataTransfer }): Promise<void> {
    const html = e.clipboardData.getData('text/html')
    const plain = e.clipboardData.getData('text/plain')
    if (shouldUseHtmlFlavor(html, plain)) {
      onClipboard(await window.api.sanitizeHtml(html))
      return
    }
    await handleText(plain)
  }

  async function openDialog(): Promise<void> {
    await acceptLoaded(await window.api.openFile())
  }

  async function pasteFromClipboard(): Promise<void> {
    const content = await window.api.readClipboard()
    switch (content.kind) {
      case 'html':
        return onClipboard(content.html)
      case 'text':
        return handleText(content.text)
      case 'image':
        return onNotice("Images aren't supported yet")
      default:
        return onNotice('The clipboard has no text')
    }
  }

  return { onDrop, onPaste, openDialog, pasteFromClipboard, handleText }
}
