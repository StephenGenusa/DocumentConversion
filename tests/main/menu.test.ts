import { describe, it, expect, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

vi.mock('electron', () => ({ Menu: {}, app: { getVersion: () => '1.0.0' } }))

const { menuTemplate } = await import('../../src/main/menu')

const flatten = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu) : [])])

describe('application menu', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    it(`has About and the Edit roles on ${platform}`, () => {
      const openAbout = vi.fn()
      const items = flatten(menuTemplate(platform, openAbout))
      const about = items.find((i) => i.label === 'About Document Converter')
      expect(about).toBeDefined()
      ;(about!.click as () => void)()
      expect(openAbout).toHaveBeenCalledOnce()
      // Without an Edit menu, Cmd-C/V/Z stop working on macOS once the default menu is replaced.
      expect(items.some((i) => i.role === 'editMenu')).toBe(true)
      expect(items.some((i) => i.role === 'quit')).toBe(true)
    })
  }

  it('puts About in the app menu on macOS and under Help elsewhere', () => {
    const mac = menuTemplate('darwin', () => {})
    expect(mac[0].label).toBe('Document Converter')
    expect((mac[0].submenu as MenuItemConstructorOptions[])[0].label).toBe('About Document Converter')
    const win = menuTemplate('win32', () => {})
    const help = win.find((i) => i.label === '&Help')
    expect((help?.submenu as MenuItemConstructorOptions[])[0].label).toBe('About Document Converter')
  })
})
