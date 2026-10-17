// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SettingsDialog, SETTINGS_PAGES, targetList } from '../../src/renderer/src/components/SettingsDialog'
import { DEFAULT_SETTINGS, SETTING_KEYS, checkSetting, withSetting, parseSettings, type Settings } from '../../src/core/settings'
import { PICTURE_TARGET_FORMATS } from '../../src/core/pictures'
import { SVG_TARGETS } from '../../src/core/rendered-blocks'
import { CODE_COLOUR_TARGETS } from '../../src/cli/args'

/** The Settings dialog (settings spec 4 and 7), against a stand-in for the preload's settings calls. */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let saved: Settings
let raw: Record<string, unknown>
let changed: ((s: Settings) => void) | null
const api = {
  getSettings: vi.fn(async () => saved),
  setSetting: vi.fn(async (key: string, value: unknown) => {
    const ok = checkSetting({ key, value })
    if ('refused' in ok) return { ok: false, message: ok.refused }
    raw = withSetting(raw, ok.key, ok.value)
    saved = parseSettings(raw).settings
    return { ok: true, settings: saved }
  }),
  resetSettings: vi.fn(async (section?: string) => {
    raw = section ? { ...raw, [section]: undefined } : {}
    saved = parseSettings(JSON.parse(JSON.stringify(raw))).settings
    return { ok: true, settings: saved }
  }),
  onSettingsChanged: vi.fn((cb: (s: Settings) => void) => {
    changed = cb
    return () => (changed = null)
  }),
}

beforeEach(() => {
  saved = structuredClone(DEFAULT_SETTINGS) as Settings
  raw = {}
  changed = null
  for (const f of Object.values(api)) f.mockClear()
  ;(window as unknown as { api: typeof api }).api = api
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}
const onClose = vi.fn()
async function mount(notice?: string): Promise<void> {
  onClose.mockClear()
  act(() => root.render(createElement(SettingsDialog, { onClose, notice })))
  await flush()
}
const dialog = (): HTMLDialogElement => host.querySelector('dialog')!
const tabs = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
const panel = (): HTMLElement => host.querySelector('[role="tabpanel"]')!
const tab = (name: string): HTMLElement => tabs().find((t) => t.textContent === name)!
const labeled = (text: string): HTMLInputElement | HTMLSelectElement => {
  const label = [...panel().querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(text))!
  return (label.control ?? label.querySelector('input, select')) as HTMLInputElement
}
const key = (el: Element, k: string): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}
const button = (text: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!

describe('the Settings dialog', () => {
  it('is a labeled modal dialog with the six sections as tabs', async () => {
    await mount()
    expect(dialog().open).toBe(true)
    const title = document.getElementById(dialog().getAttribute('aria-labelledby')!)
    expect(title?.textContent).toBe('Settings')
    expect(tabs().map((t) => t.textContent)).toEqual(['Pictures', 'Web', 'Formulas & diagrams', 'Code', 'PDF', 'Reading'])
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Settings sections')
    // One tab stop: the selected tab; the panel is labeled by it.
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1])
    expect(panel().getAttribute('aria-labelledby')).toBe(tabs()[0].id)
    expect(tabs()[0].getAttribute('aria-controls')).toBe(panel().id)
    expect(document.activeElement).toBe(tabs()[0])
  })

  it('moves between sections with the arrow keys, Home and End', async () => {
    await mount()
    key(tabs()[0], 'ArrowDown')
    expect(tab('Web').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('Web'))
    key(tab('Web'), 'ArrowUp')
    key(tab('Pictures'), 'ArrowUp')
    expect(document.activeElement).toBe(tab('Reading'))
    key(tab('Reading'), 'Home')
    expect(document.activeElement).toBe(tab('Pictures'))
    key(tab('Pictures'), 'End')
    expect(tab('Reading').getAttribute('aria-selected')).toBe('true')
    // Left and right too: on a narrow window the list is a row of tabs.
    key(tab('Reading'), 'ArrowRight')
    expect(document.activeElement).toBe(tab('Pictures'))
  })

  it('shows every setting with its help and an Affects line, linked as its description', async () => {
    await mount()
    const seen = new Set<string>()
    for (const t of tabs()) {
      act(() => t.click())
      const controls = [...panel().querySelectorAll<HTMLElement>('[data-setting]')]
      expect(controls.length, t.textContent!).toBeGreaterThan(0)
      for (const c of controls) {
        seen.add(c.dataset.setting!)
        const ids = (c.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
        const text = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
        expect(text, c.dataset.setting).toMatch(/Affects: \S/)
      }
    }
    // Every setting but OCR's (step 7) has a control.
    expect([...seen].sort()).toEqual(SETTING_KEYS.filter((k) => !k.startsWith('ocr.')).sort())
  })

  it('says what stays PNG or SVG whatever the picture format, and that email never loads web pictures', async () => {
    await mount()
    expect(panel().textContent).toMatch(/see-through parts always stay PNG/)
    expect(panel().textContent).toMatch(/Drawings \(EMF, WMF, SVG\) stay sharp: SVG where the output allows it, otherwise PNG/)
    act(() => tab('Web').click())
    expect(panel().textContent).toMatch(/Email and calendar invitations never load web pictures/)
  })

  it('saves each change at once and says so', async () => {
    await mount()
    const jpg = labeled('JPG') as HTMLInputElement
    expect(jpg.checked).toBe(true)
    act(() => (labeled('PNG') as HTMLInputElement).click())
    await flush()
    expect(api.setSetting).toHaveBeenLastCalledWith('pictures.format', 'png')
    expect((labeled('PNG') as HTMLInputElement).checked).toBe(true)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Saved')

    act(() => tab('PDF').click())
    const page = labeled('Page size') as HTMLSelectElement
    act(() => {
      page.value = 'A4'
      page.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(api.setSetting).toHaveBeenLastCalledWith('pdf.pageSize', 'A4')
  })

  it('shows a saved zoom that is off the steps', async () => {
    saved = { ...saved, pdf: { ...saved.pdf, scale: 0.8 } }
    await mount()
    act(() => tab('PDF').click())
    const zoom = labeled('Zoom') as HTMLSelectElement
    expect(zoom.value).toBe('0.8')
    expect(zoom.selectedOptions[0].textContent).toBe('80%')
  })

  it('hides Local network only while fetching web pictures is off', async () => {
    await mount()
    act(() => tab('Web').click())
    expect(labeled('Allow pictures from your local network')).toBeTruthy()
    act(() => (labeled('Fetch pictures from the web') as HTMLInputElement).click())
    await flush()
    expect(api.setSetting).toHaveBeenLastCalledWith('web.fetchPictures', false)
    expect(panel().textContent).not.toMatch(/local network/)
    act(() => (labeled('Fetch pictures from the web') as HTMLInputElement).click())
    await flush()
    expect(panel().textContent).toMatch(/local network/)
  })

  it('follows a change made elsewhere', async () => {
    await mount()
    act(() => changed!({ ...saved, pictures: { format: 'png' } }))
    expect((labeled('PNG') as HTMLInputElement).checked).toBe(true)
  })

  it('resets the section on screen, and everything only after a confirm', async () => {
    saved = { ...saved, pictures: { format: 'png' }, code: { colour: false } }
    await mount()
    act(() => button('Reset this section').click())
    await flush()
    expect(api.resetSettings).toHaveBeenLastCalledWith('pictures')

    act(() => tab('Formulas & diagrams').click())
    act(() => button('Reset this section').click())
    await flush()
    expect(api.resetSettings).toHaveBeenLastCalledWith('rendered')

    api.resetSettings.mockClear()
    act(() => button('Reset all settings…').click())
    expect(api.resetSettings).not.toHaveBeenCalled()
    // The confirm takes the focus on its safe answer; Escape backs out of it, not the dialog.
    expect(document.activeElement).toBe(button('Cancel'))
    key(button('Cancel'), 'Escape')
    expect(button('Cancel')).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()
    act(() => button('Reset all settings…').click())
    act(() => button('Reset all').click())
    await flush()
    expect(api.resetSettings).toHaveBeenCalledWith(undefined)
  })

  it('shows the settings-file notice', async () => {
    await mount('Your settings file could not be read and was reset.')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Your settings file could not be read and was reset.')
  })

  it('closes with Done and the close button', async () => {
    await mount()
    act(() => button('Done').click())
    expect(onClose).toHaveBeenCalledOnce()
    await mount()
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')!.click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('gives the focus back to what opened it', async () => {
    const opener = document.body.appendChild(document.createElement('button'))
    opener.focus()
    await mount()
    expect(document.activeElement).not.toBe(opener)
    act(() => root.render(createElement('div')))
    expect(document.activeElement).toBe(opener)
  })
})

describe('the Affects lines', () => {
  it('name the outputs each setting changes', () => {
    expect(targetList(PICTURE_TARGET_FORMATS)).toBe('PDF, HTML, slides, EPUB, Kindle (AZW3, AZW4), Word, Markdown')
    expect(targetList([...SVG_TARGETS])).toBe('PDF, HTML, slides, EPUB, Kindle (AZW4)')
    expect(targetList(CODE_COLOUR_TARGETS)).toBe('PDF, HTML, slides, EPUB, Kindle (AZW3, AZW4), Word')
  })

  it('are the ones the conversions use', () => {
    const affects = Object.fromEntries(SETTINGS_PAGES.flatMap((p) => p.settings.map((s) => [s.key, s.affects])))
    expect(affects['pictures.format']).toBe(targetList(PICTURE_TARGET_FORMATS))
    expect(affects['rendered.format']).toBe(targetList([...SVG_TARGETS]))
    expect(affects['code.colour']).toBe(targetList(CODE_COLOUR_TARGETS))
  })
})
