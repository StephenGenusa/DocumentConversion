import type { DragEvent, ClipboardEvent } from 'react'

/** The shared intake surface, available to every view that accepts input. */
export interface Intake {
  onDrop(e: DragEvent): Promise<void>
  onPaste(e: ClipboardEvent): Promise<void>
  openDialog(): Promise<void>
  pasteFromClipboard(): Promise<void>
  submitUrl(url: string): void
}
