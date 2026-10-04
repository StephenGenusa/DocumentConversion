import { textToBase64 } from './encoding'
import type { BatchItemReq, SourceFormat } from '../../../preload/types'

/**
 * One input in the list. The list is the ONLY state that outlives the edit
 * pane: the pane is unmounted whenever a result is on screen and rebuilt from
 * here when the result is dismissed. Anything that exists only inside the pane
 * is gone at that moment, which is why edits are written back here before a
 * result is shown (see `applyLiveEdit`).
 */
export interface ListItem {
  id: string
  label: string
  filename: string
  source: SourceFormat
  imageMode: 'embed' | 'ocr'
  /** Sanitized hub HTML: clipboard/URL input, or any input opened in the pane. */
  html?: string
  base64?: string
  /** Folder this input came from, when it came from disk; drives the save dialog. */
  sourceDir?: string
  /** Token for the file on disk. Conversions re-read the file through it. */
  handle?: string
  /** What the file looked like when `html` was read from it. */
  diskStamp?: string
  /** Set when the file no longer matches `diskStamp`: the disk moved on under the pane. */
  staleStamp?: string
  /** Bumped when `html` is replaced from outside the pane, to rebuild the editor. */
  rev?: number
}

/** What the open edit pane holds right now. */
export interface LiveEdit {
  id: string
  html: string
}

/** Write the pane's content back onto its item. Pure: safe inside a state updater. */
export function applyLiveEdit(list: ListItem[], live: LiveEdit | null): ListItem[] {
  if (live === null) return list
  return list.map((i) => (i.id === live.id ? { ...i, html: live.html } : i))
}

/**
 * What the main process is asked to convert.
 *
 * Edits win: once an input has been opened in the pane its HTML is the
 * document, whatever the file it came from has become since. Otherwise a file
 * on disk is named by its handle and read at convert time, and NO stored bytes
 * are sent with it - if the handle were ever ignored, the result would be an
 * obviously empty document rather than a silently stale one.
 */
export function toRequest(item: ListItem, ocrLanguage: string): BatchItemReq {
  const edited = item.html !== undefined
  const fromDisk = !edited && item.handle !== undefined
  return {
    base64: edited ? textToBase64(item.html!) : fromDisk ? '' : (item.base64 ?? ''),
    handle: fromDisk ? item.handle : undefined,
    filename: item.filename,
    source: edited ? 'html' : item.source,
    ocr: item.source === 'image' && item.imageMode === 'ocr',
    ocrLanguage,
    sourceDir: item.sourceDir,
  }
}

/**
 * Record whether the file behind an edited input has changed on disk.
 *
 * Only an input open in the pane can go stale this way; one that is not is
 * re-read at every conversion. The edits are never touched here: the flag
 * exists so the app can offer a reload and leave the choice to the user.
 * Returns the same object when nothing changed, so React can skip the render.
 */
export function markDiskState(item: ListItem, stamp: string | null): ListItem {
  if (item.html === undefined || item.diskStamp === undefined || stamp === null) return item
  const stale = stamp === item.diskStamp ? undefined : stamp
  return stale === item.staleStamp ? item : { ...item, staleStamp: stale }
}

/** "Keep my edits": accept the file as it is now, until it changes again. */
export function keepEdits(item: ListItem): ListItem {
  if (item.staleStamp === undefined) return item
  return { ...item, diskStamp: item.staleStamp, staleStamp: undefined }
}
