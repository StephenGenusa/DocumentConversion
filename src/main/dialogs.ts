/**
 * The app's native dialogs (open, save, choose a folder): each is modal on
 * the window that asked for it, and only one is open at a time.
 *
 * Without a parent window a dialog is a window of its own: on Linux it could
 * open behind the app, and a second Open (the start screen's button, Add
 * file) opened a second dialog beside the first, each of which then acted
 * on a window that had moved on. With the window as its parent the dialog
 * stays on top of it and the window takes no input while it is open; the
 * gate refuses a second dialog outright (one could still be asked for while
 * the first is opening, or where the system does not block the parent) and brings the
 * window with the open one forward instead, so the user sees where it is.
 *
 * No Electron here: index.ts passes the BrowserWindow and the electron
 * `dialog` call, so the rules can be tested on their own.
 */

/** What the gate needs of the window that owns a dialog: a BrowserWindow. */
export interface DialogOwner {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  moveTop(): void
}

export interface DialogGate {
  /**
   * Shows a dialog on `owner` (brought forward first), or, while another is
   * open, shows nothing and answers `busy`: what a canceled dialog would.
   * `show` is given the owner, or null when it has gone (a dialog of its own).
   */
  show<W extends DialogOwner, T>(owner: W | null, show: (owner: W | null) => Promise<T>, busy: T): Promise<T>
  /** Whether a dialog is open now. */
  isOpen(): boolean
}

/** The window brought forward, unminimized and focused: where its dialog is about to open. */
function bringForward(win: DialogOwner): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.moveTop()
  win.focus()
}

export function createDialogGate(): DialogGate {
  let openOn: DialogOwner | null | undefined
  let open = false
  return {
    isOpen: () => open,
    async show(owner, show, busy) {
      const live = owner && !owner.isDestroyed() ? owner : null
      if (open) {
        const holder = openOn && !openOn.isDestroyed() ? openOn : live
        if (holder) bringForward(holder)
        return busy
      }
      open = true
      openOn = live
      try {
        if (live) bringForward(live)
        return await show(live)
      } finally {
        open = false
        openOn = undefined
      }
    },
  }
}
