// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DropZone } from '../../src/renderer/src/components/DropZone'
import { SAMPLES } from '../../src/core/samples'
import { inputFormatHint } from '../../src/core/input-formats'
import type { Intake } from '../../src/renderer/src/lib/intake-types'

/** The start screen's Sample documents link: a menu button offering the Help menu's samples. */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const api = { openAbout: vi.fn(), openSample: vi.fn(async () => {}) }

beforeEach(() => {
  ;(window as unknown as { api: typeof api }).api = api
  api.openSample.mockClear()
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() => root.render(createElement(DropZone, { intake: {} as Intake, notice: null, onOpenSettings: () => {} })))
})
afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

const button = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
const items = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
const key = (el: Element, k: string): void =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })

describe('start screen', () => {
  it('lists what the app reads from the detector\'s own table', () => {
    expect([...host.querySelectorAll('.dropzone__hint')].map((p) => p.textContent)).toContain(inputFormatHint())
  })
})

describe('start screen: Sample documents', () => {
  it('sits beside Settings and About, closed', () => {
    const links = [...host.querySelectorAll('.dropzone__about button')].map((b) => b.textContent)
    expect(links).toEqual(['Settings', 'Sample documents', 'About and licenses'])
    expect(button().getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })

  it('opens on Down with the first sample focused, offering the same samples as the Help menu', () => {
    button().focus()
    key(button(), 'ArrowDown')
    expect(button().getAttribute('aria-expanded')).toBe('true')
    expect(items().map((i) => i.textContent)).toEqual(SAMPLES.map((s) => s.menu))
    expect(document.activeElement).toBe(items()[0])
  })

  it('opens on a click (Enter and Space press a button), arrows move, and choosing one opens it', () => {
    act(() => button().click())
    expect(document.activeElement).toBe(items()[0])
    key(items()[0], 'ArrowDown')
    key(items()[1], 'ArrowDown')
    expect(document.activeElement).toBe(items()[2])
    key(items()[2], 'ArrowUp')
    expect(document.activeElement).toBe(items()[1])
    key(items()[1], 'End')
    expect(document.activeElement).toBe(items().at(-1))
    key(items().at(-1)!, 'ArrowDown')
    expect(document.activeElement).toBe(items()[0])
    key(items()[0], 'ArrowUp')
    expect(document.activeElement).toBe(items().at(-1))
    act(() => items()[1].click())
    expect(api.openSample).toHaveBeenCalledWith('software')
    expect(host.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(button())
  })

  it('closes on Escape and gives the focus back to the link', () => {
    act(() => button().click())
    key(items()[0], 'Escape')
    expect(host.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(button())
    expect(api.openSample).not.toHaveBeenCalled()
  })

  it('closes on a click elsewhere', () => {
    act(() => button().click())
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })
})
