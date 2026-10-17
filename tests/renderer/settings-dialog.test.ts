// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SettingsDialog, SETTINGS_PAGES, targetList } from '../../src/renderer/src/components/SettingsDialog'
import { DEFAULT_SETTINGS, SETTING_KEYS, checkSetting, withSetting, parseSettings, type Settings } from '../../src/core/settings'
import { PICTURE_TARGET_FORMATS } from '../../src/core/pictures'
import { SVG_TARGETS } from '../../src/core/rendered-blocks'
import { CODE_COLOR_TARGETS } from '../../src/cli/args'

/** The Settings dialog (settings spec 4 and 7), against a stand-in for the preload's settings calls. */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let saved: Settings
let raw: Record<string, unknown>
let changed: ((s: Settings) => void) | null
/** The OCR languages, as `listOcrLanguages` gives them: English bundled, German downloaded, French not installed. */
let packs: { code: string; name: string; script: string; installed: boolean; source?: string; set?: string; downloaded?: string[]; onDisk?: number; size: { fast: number; best: number }; downloadSize?: number }[]
const freshPacks = (): typeof packs => [
  { code: 'eng', name: 'English', script: 'Latin', installed: true, source: 'bundled', set: 'fast', size: { fast: 4_000_000, best: 12_000_000 } },
  { code: 'deu', name: 'German', script: 'Latin', installed: true, source: 'downloaded', set: 'fast', size: { fast: 1_520_000, best: 8_000_000 }, downloadSize: 1_520_000 },
  { code: 'fra', name: 'French', script: 'Latin', installed: false, size: { fast: 1_100_000, best: 7_000_000 } },
]
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
  listOcrLanguages: vi.fn(async () => structuredClone(packs)),
  removeOcrLanguage: vi.fn(async (code: string) => {
    const pack = packs.find((p) => p.code === code)!
    Object.assign(pack, { installed: false, source: undefined, set: undefined })
    return { ok: true }
  }),
  downloadOcrLanguage: vi.fn(async () => ({ kind: 'ok', path: '' })),
}

beforeEach(() => {
  saved = structuredClone(DEFAULT_SETTINGS) as Settings
  raw = {}
  changed = null
  packs = freshPacks()
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
const onOcrPackRemoved = vi.fn()
async function mount(notice?: string): Promise<void> {
  onClose.mockClear()
  onOcrPackRemoved.mockClear()
  act(() => root.render(createElement(SettingsDialog, { onClose, notice, onOcrPackRemoved })))
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
  it('is a labeled modal dialog with the seven sections as tabs', async () => {
    await mount()
    expect(dialog().open).toBe(true)
    const title = document.getElementById(dialog().getAttribute('aria-labelledby')!)
    expect(title?.textContent).toBe('Settings')
    expect(tabs().map((t) => t.textContent)).toEqual(['Pictures', 'Web', 'Formulas & diagrams', 'Code', 'PDF', 'Reading', 'OCR'])
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Settings sections')
    // One tab stop: the selected tab; the panel is labeled by it.
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1])
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
    expect(document.activeElement).toBe(tab('OCR'))
    key(tab('OCR'), 'Home')
    expect(document.activeElement).toBe(tab('Pictures'))
    key(tab('Pictures'), 'End')
    expect(tab('OCR').getAttribute('aria-selected')).toBe('true')
    // Left and right too: on a narrow window the list is a row of tabs.
    key(tab('OCR'), 'ArrowRight')
    expect(document.activeElement).toBe(tab('Pictures'))
  })

  it('shows every setting with its help and an Affects line, linked as its description', async () => {
    await mount()
    const seen = new Set<string>()
    for (const t of tabs()) {
      act(() => t.click())
      await flush()
      const controls = [...panel().querySelectorAll<HTMLElement>('[data-setting]')]
      expect(controls.length, t.textContent!).toBeGreaterThan(0)
      for (const c of controls) {
        seen.add(c.dataset.setting!)
        const ids = (c.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
        const text = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
        expect(text, c.dataset.setting).toMatch(/Affects: \S/)
      }
    }
    expect([...seen].sort()).toEqual([...SETTING_KEYS].sort())
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
    saved = { ...saved, pictures: { format: 'png' }, code: { color: false } }
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

describe('the OCR section', () => {
  const ocrTab = async (): Promise<void> => {
    await mount()
    act(() => tab('OCR').click())
    await flush()
  }
  const items = (): HTMLElement[] => [...panel().querySelectorAll<HTMLElement>('.ocr-packs__item')]
  const status = (): string | null | undefined => host.querySelector('.settings__status')?.textContent
  const question = (): string | null | undefined => panel().querySelector('.ocr-packs__confirm')?.textContent
  /** Remove German, and answer Remove to the question that follows. */
  const removeGerman = async (): Promise<void> => {
    act(() => items()[1].querySelector('button')!.click())
    act(() => button('Remove').click())
    await flush()
  }

  it('picks the default language with the conversion screen\'s picker, and saves it', async () => {
    saved = { ...saved, ocr: { language: 'deu' } }
    await ocrTab()
    const select = labeled('Default language') as HTMLSelectElement
    expect(select.dataset.setting).toBe('ocr.language')
    expect(select.value).toBe('deu')
    // Installed first, then those to download, with their size.
    const groups = [...select.querySelectorAll('optgroup')].map((g) => [g.label, [...g.children].map((o) => o.textContent)])
    expect(groups).toEqual([
      ['Installed', ['English', 'German']],
      ['Download on demand', ['French — 1.1 MB']],
    ])
    act(() => {
      select.value = 'eng'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(api.setSetting).toHaveBeenLastCalledWith('ocr.language', 'eng')
    expect(status()).toBe('Saved')
  })

  it('downloads a language chosen that is not installed, then makes it the default', async () => {
    await ocrTab()
    const select = labeled('Default language') as HTMLSelectElement
    api.downloadOcrLanguage.mockImplementationOnce(async () => {
      Object.assign(packs[2], { installed: true, source: 'downloaded', set: 'fast' })
      return { kind: 'ok', path: '' }
    })
    act(() => {
      select.value = 'fra'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    await flush()
    expect(api.downloadOcrLanguage).toHaveBeenCalledWith('fra', 'fast')
    expect(api.setSetting).toHaveBeenLastCalledWith('ocr.language', 'fra')
    // The installed list read the packs again.
    expect(items().map((i) => i.dataset.language)).toEqual(['eng', 'deu', 'fra'])
  })

  it('lists the installed languages with their size; English is included and has no Remove', async () => {
    await ocrTab()
    expect(items().map((i) => i.textContent)).toEqual(['EnglishIncluded', 'German1.5 MBRemove'])
    expect(items()[0].querySelector('button')).toBeNull()
    expect(items()[1].querySelector('button')?.getAttribute('aria-label')).toBe('Remove German')
    const group = panel().querySelector<HTMLElement>('[data-ocr-packs]')!
    const described = group.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent)
    expect(described.join(' ')).toMatch(/downloaded once and kept on this computer/)
    expect(described.join(' ')).toMatch(/English is used instead until you install it again/)
    expect(described.join(' ')).toMatch(/Affects: images and scanned PDFs with OCR on/)
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Installed languages')
  })

  it('shows a language with both models at their combined size, and Remove takes both', async () => {
    Object.assign(packs[1], { set: 'best', downloaded: ['fast', 'best'], onDisk: 9_520_000 })
    await ocrTab()
    expect(items()[1].textContent).toBe('German9.5 MBRemove')
    await removeGerman()
    // No model named: main removes every downloaded model of the language.
    expect(api.removeOcrLanguage).toHaveBeenCalledWith('deu')
    expect(items().map((i) => i.dataset.language)).toEqual(['eng'])
  })

  it('removes a language installed only as the best model', async () => {
    Object.assign(packs[1], { set: 'best', downloaded: ['best'], onDisk: 8_000_000 })
    await ocrTab()
    expect(items()[1].textContent).toBe('German8 MBRemove')
    await removeGerman()
    expect(api.removeOcrLanguage).toHaveBeenCalledWith('deu')
  })

  it('asks before removing a language, with what getting it back costs', async () => {
    await ocrTab()
    act(() => panel().querySelector<HTMLButtonElement>('button[aria-label="Remove German"]')!.click())
    expect(api.removeOcrLanguage).not.toHaveBeenCalled()
    expect(question()).toBe('Remove German? Getting it back needs a download (about 1.5 MB).RemoveCancel')
    // The question is in the row, in place of its Remove button, with the focus on the safe answer.
    expect(items()[1].querySelector('button[aria-label="Remove German"]')).toBeNull()
    expect(document.activeElement).toBe(button('Cancel'))

    // Escape backs out of the question, not the dialog.
    key(button('Cancel'), 'Escape')
    expect(question()).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()
    expect(dialog().open).toBe(true)
    expect(document.activeElement).toBe(panel().querySelector('button[aria-label="Remove German"]'))

    // Cancel keeps the pack too.
    act(() => panel().querySelector<HTMLButtonElement>('button[aria-label="Remove German"]')!.click())
    act(() => button('Cancel').click())
    await flush()
    expect(question()).toBeUndefined()
    expect(document.activeElement).toBe(panel().querySelector('button[aria-label="Remove German"]'))
    expect(api.removeOcrLanguage).not.toHaveBeenCalled()
    expect(items().map((i) => i.dataset.language)).toEqual(['eng', 'deu'])
  })

  it('lets Escape close the dialog again after leaving the section with the question up', async () => {
    await ocrTab()
    act(() => items()[1].querySelector('button')!.click())
    act(() => tab('Code').click())
    act(() => {
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('says in the question when the language is the default', async () => {
    saved = { ...saved, ocr: { language: 'deu' } }
    await ocrTab()
    act(() => items()[1].querySelector('button')!.click())
    expect(question()).toBe(
      'Remove German? Getting it back needs a download (about 1.5 MB). The default language will become English.RemoveCancel',
    )
  })

  it('leaves the size out of the question when the recorded size is not known', async () => {
    delete packs[1].downloadSize
    await ocrTab()
    act(() => items()[1].querySelector('button')!.click())
    expect(question()).toBe('Remove German? Getting it back needs a download.RemoveCancel')
  })

  it('removes a language, and says when that puts the default back to English', async () => {
    saved = { ...saved, ocr: { language: 'deu' } }
    await ocrTab()
    await removeGerman()
    expect(api.removeOcrLanguage).toHaveBeenCalledWith('deu')
    expect(items().map((i) => i.dataset.language)).toEqual(['eng'])
    expect(status()).toBe('German is removed. The default language is now English.')
    expect(onOcrPackRemoved).toHaveBeenCalledWith('deu')
    // The focus stays in the list, not lost with the button.
    expect(document.activeElement).toBe(panel().querySelector('[data-ocr-packs]'))
    // Main tells the windows the language in force is now English.
    act(() => changed!({ ...saved, ocr: { language: 'eng' } }))
    expect((labeled('Default language') as HTMLSelectElement).value).toBe('eng')
  })

  it('removes a language that is not the default without a word about English', async () => {
    await ocrTab()
    await removeGerman()
    expect(status()).toBe('German is removed.')
  })

  it('says when a pack could not be removed, and keeps it listed', async () => {
    api.removeOcrLanguage.mockImplementationOnce(async () => ({ ok: false, message: 'EACCES' }))
    await ocrTab()
    await removeGerman()
    expect(status()).toBe('Not removed: EACCES')
    expect(items().map((i) => i.dataset.language)).toEqual(['eng', 'deu'])
    expect(onOcrPackRemoved).not.toHaveBeenCalled()
  })

  it('resets its own section, which removes no pack', async () => {
    await ocrTab()
    act(() => button('Reset this section').click())
    await flush()
    expect(api.resetSettings).toHaveBeenLastCalledWith('ocr')
    expect(api.removeOcrLanguage).not.toHaveBeenCalled()
  })
})

describe('the Affects lines', () => {
  it('name the outputs each setting changes', () => {
    expect(targetList(PICTURE_TARGET_FORMATS)).toBe('PDF, HTML, slides, EPUB, Kindle (AZW3, AZW4), Word, Markdown')
    expect(targetList([...SVG_TARGETS])).toBe('PDF, HTML, slides, EPUB, Kindle (AZW4)')
    expect(targetList(CODE_COLOR_TARGETS)).toBe('PDF, HTML, slides, EPUB, Kindle (AZW3, AZW4), Word')
  })

  it('are the ones the conversions use', () => {
    const affects = Object.fromEntries(SETTINGS_PAGES.flatMap((p) => p.settings.map((s) => [s.key, s.affects])))
    expect(affects['pictures.format']).toBe(targetList(PICTURE_TARGET_FORMATS))
    expect(affects['rendered.format']).toBe(targetList([...SVG_TARGETS]))
    expect(affects['code.color']).toBe(targetList(CODE_COLOR_TARGETS))
  })
})
