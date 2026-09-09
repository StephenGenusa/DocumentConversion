import { describe, it, expect } from 'vitest'
import { readCode } from '../../src/core/readers/code'
import { codeFormatFromFilename, languageForFilename } from '../../src/core/code-langs'

const src = (text: string, filename: string) => ({ bytes: Buffer.from(text, 'utf8'), filename })

describe('codeFormatFromFilename', () => {
  it('recognizes allowlisted extensions', () => {
    expect(codeFormatFromFilename('app.ts')).toBe(true)
    expect(codeFormatFromFilename('script.PY')).toBe(true)
    expect(codeFormatFromFilename('query.sql')).toBe(true)
    expect(codeFormatFromFilename('notes.txt')).toBe(false)
    expect(codeFormatFromFilename('page.html')).toBe(false)
  })
  it('recognizes Dockerfile and Makefile by name', () => {
    expect(codeFormatFromFilename('Dockerfile')).toBe(true)
    expect(codeFormatFromFilename('Makefile')).toBe(true)
  })
  it('maps filenames to highlight languages', () => {
    expect(languageForFilename('a.ts')).toBe('typescript')
    expect(languageForFilename('a.ps1')).toBe('powershell')
    expect(languageForFilename('Dockerfile')).toBe('dockerfile')
  })
})

describe('readCode', () => {
  it('wraps the file as a fenced block with the language class and filename heading', async () => {
    const hub = await readCode(src('const x: number = 1\n', 'util.ts'))
    expect(hub.html).toContain('<h1>util.ts</h1>')
    expect(hub.html).toContain('<pre><code class="language-typescript">')
    expect(hub.html).toContain('const x: number = 1')
    expect(hub.title).toBe('util.ts')
    expect(hub.language).toBe('typescript')
  })
  it('escapes html and preserves tabs', async () => {
    const hub = await readCode(src('if (a < b) {\n\treturn "<div>"\n}', 'x.js'))
    expect(hub.html).toContain('a &lt; b')
    expect(hub.html).toContain('\treturn')
    expect(hub.html).not.toContain('<div>')
  })
})
