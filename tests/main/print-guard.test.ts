import { describe, it, expect, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 60_000 })

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({ webRequest: { onBeforeRequest: () => {} } }) },
  app: { getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => { throw new Error('not under test') } },
}))

const { printMayLoad } = await import('../../src/main/conversion')

describe('printMayLoad', () => {
  const dir = join(tmpdir(), 'docconv-test')
  const dirs = [dir]

  it('loads the page and anything inline', () => {
    expect(printMayLoad(pathToFileURL(join(dir, 'doc.html')).href, dirs)).toBe(true)
    expect(printMayLoad('data:image/png;base64,AAAA', dirs)).toBe(true)
    expect(printMayLoad('about:blank', dirs)).toBe(true)
  })

  it('refuses the network', () => {
    expect(printMayLoad('https://example.com/a.png', dirs)).toBe(false)
    expect(printMayLoad('http://127.0.0.1/a.png', dirs)).toBe(false)
  })

  it('refuses a file: URL with a host, which on Windows is UNC and leaks NTLM', () => {
    expect(printMayLoad('file://attacker.example/share/x.png', dirs)).toBe(false)
  })

  it('refuses local files outside the render folder', () => {
    expect(printMayLoad(pathToFileURL('/etc/passwd').href, dirs)).toBe(false)
    expect(printMayLoad(pathToFileURL(`${dir}-sibling/x.png`).href, dirs)).toBe(false)
  })
})
