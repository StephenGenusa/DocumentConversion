import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('electron', () => ({ app: { getVersion: () => '9.8.7' } }))

const { PACKAGE_NAME, PRODUCT_NAME, appTitle } = await import('../../src/main/app-identity')

describe('app identity', () => {
  it('names the product exactly as the installer does', () => {
    const productName = /^productName:\s*(.+)$/m.exec(readFileSync('electron-builder.yml', 'utf8'))?.[1].trim()
    expect(PRODUCT_NAME).toBe(productName)
  })

  it("names the userData folder as Electron does: package.json's name, the packaged app having no productName", () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; productName?: string }
    expect(pkg.productName).toBeUndefined()
    expect(PACKAGE_NAME).toBe(pkg.name)
  })

  it('puts the version in the window title', () => {
    expect(appTitle()).toBe('Document Converter 9.8.7')
  })
})
