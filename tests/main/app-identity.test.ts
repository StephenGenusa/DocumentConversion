import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('electron', () => ({ app: { getVersion: () => '9.8.7' } }))

const { PRODUCT_NAME, appTitle } = await import('../../src/main/app-identity')

describe('app identity', () => {
  it('names the product exactly as the installer does', () => {
    const productName = /^productName:\s*(.+)$/m.exec(readFileSync('electron-builder.yml', 'utf8'))?.[1].trim()
    expect(PRODUCT_NAME).toBe(productName)
  })

  it('puts the version in the window title', () => {
    expect(appTitle()).toBe('Document Converter 9.8.7')
  })
})
