import { describe, it, expect, vi, beforeAll } from 'vitest'

/**
 * The page's side of the `settings:*` channels: what the preload sends. The
 * page never sends a whole file, only one { key, value } or a section, and
 * main checks those (tests/main/settings.test.ts).
 */
const invoked: Array<[string, unknown]> = []
const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
let api: Record<string, (...args: unknown[]) => unknown>

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => {
      if (name === 'api') api = value as typeof api
    },
  },
  ipcRenderer: {
    invoke: async (channel: string, payload?: unknown) => void invoked.push([channel, payload]),
    on: (channel: string, fn: (event: unknown, payload: unknown) => void) => void listeners.set(channel, fn),
    removeListener: (channel: string) => void listeners.delete(channel),
  },
  webUtils: { getPathForFile: () => '' },
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

beforeAll(async () => {
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await import('../../src/preload/index')
})

describe('the settings API in the preload', () => {
  it('gets the whole object, and the notice', async () => {
    await api.getSettings()
    await api.settingsNotice()
    expect(invoked.slice(-2)).toEqual([
      ['settings:get', undefined],
      ['settings:notice', undefined],
    ])
  })

  it('sends one { key, value } and nothing more', async () => {
    await api.setSetting('pdf.pageSize', 'A4')
    expect(invoked.at(-1)).toEqual(['settings:set', { key: 'pdf.pageSize', value: 'A4' }])
  })

  it('resets a section, or all of them', async () => {
    await api.resetSettings('pdf')
    await api.resetSettings()
    expect(invoked.slice(-2)).toEqual([
      ['settings:reset', { section: 'pdf' }],
      ['settings:reset', {}],
    ])
  })

  it('passes settings:changed on without the event, and stops when asked', () => {
    const heard: unknown[] = []
    const stop = api.onSettingsChanged((s: unknown) => heard.push(s)) as () => void
    listeners.get('settings:changed')?.({ sender: 'main' }, { version: 1 })
    expect(heard).toEqual([{ version: 1 }])
    stop()
    expect(listeners.has('settings:changed')).toBe(false)
  })

  it('hears the menu asking for the dialog, and stops when asked', () => {
    let opened = 0
    const stop = api.onOpenSettings(() => opened++) as () => void
    listeners.get('app:open-settings')?.({ sender: 'main' }, undefined)
    expect(opened).toBe(1)
    stop()
    expect(listeners.has('app:open-settings')).toBe(false)
  })
})
