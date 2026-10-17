import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  session: { fromPartition: () => ({ webRequest: { onBeforeRequest: () => {} } }) },
}))

const { buildAboutHtml, chromiumBody } = await import('../../src/main/about-window')

const base = {
  name: 'Document Converter',
  version: '1.3.0',
  appLicense: 'MIT License\n\nCopyright (c) 2026 Stephen Genusa',
  components: [
    { name: 'left-pad', version: '1.0.0', license: 'MIT', texts: [{ file: 'LICENSE', text: 'Copyright <evil>&co' }] },
    { name: 'x', version: '2.0.0', license: 'ISC', note: 'standard text', texts: [{ file: 'ISC (standard text)', text: 'ISC' }] },
  ],
  electronVersion: '43.4.1',
  electronLicense: 'Copyright (c) Electron contributors',
  chromiumHtml: '<html><head><link rel="stylesheet" href="chrome://credits/credits.css"></head><body><div class="product" onclick="x()"><span class="title">zlib</span><script>alert(1)</script></div></body></html>',
}

describe('About page', () => {
  it('shows name, version, the app license and every component', () => {
    const html = buildAboutHtml(base)
    expect(html).toContain('<title>About Document Converter 1.3.0</title>')
    expect(html).toContain('Copyright (c) 2026 Stephen Genusa')
    expect(html).toContain('Third-party software (2)')
    expect(html).toContain('left-pad 1.0.0')
    expect(html).toContain('standard text')
    expect(html).toContain('Electron 43.4.1')
  })

  it('escapes third-party text', () => {
    const html = buildAboutHtml(base)
    expect(html).toContain('Copyright &lt;evil&gt;&amp;co')
    expect(html).not.toContain('<evil>')
  })

  it('puts the Chromium notices last, collapsed', () => {
    const html = buildAboutHtml(base)
    expect(html).toMatch(/<details class="chromium"><summary>Chromium open-source notices<\/summary>/)
    expect(html).not.toMatch(/<details class="chromium"[^>]*\bopen\b/)
    expect(html.indexOf('class="chromium"')).toBeGreaterThan(html.indexOf('id="electron"'))
  })

  it('makes the Chromium file inert', () => {
    const body = chromiumBody(base.chromiumHtml)
    expect(body).toContain('<span class="title">zlib</span>')
    expect(body).not.toMatch(/<script|<link|onclick/i)
  })

  it('says so when a file is missing instead of failing', () => {
    const html = buildAboutHtml({ ...base, appLicense: null, components: [], electronLicense: null, chromiumHtml: null })
    expect(html).toContain('were not generated for this build')
    expect(html).toContain("Electron's license file was not found")
    expect(html).toContain('LICENSES.chromium.html) was not found')
  })
})
