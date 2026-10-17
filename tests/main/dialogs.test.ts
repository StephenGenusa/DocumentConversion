import { describe, it, expect, vi } from 'vitest'
import { createDialogGate, type DialogOwner } from '../../src/main/dialogs'

// The app's native dialogs (open, save, folder): one at a time, each on top
// of the window that asked, which is brought forward first (owner's bug,
// 2026-10-17: they opened behind the app, and several could be open at once).

function fakeWindow(state: { minimized?: boolean; destroyed?: boolean } = {}): DialogOwner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    restore: () => void calls.push('restore'),
    show: () => void calls.push('show'),
    focus: () => void calls.push('focus'),
    moveTop: () => void calls.push('moveTop'),
  }
}

/** A dialog the test closes when it likes, as the user would. */
function pendingDialog<T>(): { show: (win: DialogOwner | null) => Promise<T>; close: (value: T) => void; owners: Array<DialogOwner | null> } {
  let close: (value: T) => void = () => {}
  const owners: Array<DialogOwner | null> = []
  return {
    owners,
    show: (win) => {
      owners.push(win)
      return new Promise<T>((resolve) => (close = resolve))
    },
    close: (value) => close(value),
  }
}

describe('the dialog gate', () => {
  it('shows a dialog on the window that asked, brought forward first', async () => {
    const gate = createDialogGate()
    const win = fakeWindow({ minimized: true })
    const d = pendingDialog<string>()
    const shown = gate.show(win, d.show, 'busy')
    expect(d.owners).toEqual([win])
    expect(win.calls).toEqual(['restore', 'show', 'moveTop', 'focus'])
    d.close('picked')
    expect(await shown).toBe('picked')
  })

  it('refuses a second dialog while one is open, and brings the open one forward instead', async () => {
    const gate = createDialogGate()
    const win = fakeWindow()
    const first = pendingDialog<string>()
    const second = vi.fn(async () => 'second')
    const shown = gate.show(win, first.show, 'busy')
    expect(gate.isOpen()).toBe(true)
    win.calls.length = 0
    expect(await gate.show(win, second, 'busy')).toBe('busy')
    expect(second).not.toHaveBeenCalled()
    expect(win.calls).toContain('focus')
    first.close('first')
    expect(await shown).toBe('first')
    expect(gate.isOpen()).toBe(false)
  })

  it('takes the next dialog once the open one has closed, even if it failed', async () => {
    const gate = createDialogGate()
    const win = fakeWindow()
    await expect(gate.show(win, async () => Promise.reject(new Error('no dialog')), 'busy')).rejects.toThrow('no dialog')
    expect(gate.isOpen()).toBe(false)
    expect(await gate.show(win, async () => 'next', 'busy')).toBe('next')
  })

  it('shows a dialog with no owner when the window has gone', async () => {
    const gate = createDialogGate()
    const gone = fakeWindow({ destroyed: true })
    const show = vi.fn(async (owner: DialogOwner | null) => (owner === null ? 'unowned' : 'owned'))
    expect(await gate.show(gone, show, 'busy')).toBe('unowned')
    expect(await gate.show(null, show, 'busy')).toBe('unowned')
    expect(gone.calls).toEqual([])
  })
})
