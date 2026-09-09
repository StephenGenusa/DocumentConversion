// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateHTML, generateJSON } from '@tiptap/html'
import { sanitizeToHub } from '../../src/core/allowlist'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../fixtures/clipboard', name), 'utf8')

function roundTrip(html: string): string {
  return generateHTML(generateJSON(html, EDITOR_EXTENSIONS), EDITOR_EXTENSIONS)
}

/**
 * Invariant: any HTML the sanitizer passes must round-trip the editor schema
 * losslessly — otherwise the clipboard pane silently destroys content.
 */
describe('sanitize -> editor -> getHTML round-trip', () => {
  it('preserves tables from a Teams copy', () => {
    const out = roundTrip(sanitizeToHub(fixture('teams.html')))
    expect(out).toContain('<table')
    expect(out).toContain('gateway')
    expect(out).toContain('billing')
    expect(out).toContain('href="https://wiki.example.com/runbook"')
    expect(out).toContain('<strong>before Friday</strong>')
  })

  it('preserves tables with colspan from a Word copy', () => {
    const out = roundTrip(sanitizeToHub(fixture('word.html')))
    expect(out).toContain('<table')
    expect(out).toContain('colspan="2"')
    expect(out).toContain('Combined header')
    expect(out).toContain('<h1>Requirements Overview</h1>')
  })

  it('preserves lists, blockquote, and links from an Outlook copy', () => {
    const out = roundTrip(sanitizeToHub(fixture('outlook.html')))
    expect(out).toContain('<blockquote')
    expect(out).toContain('<ol')
    expect(out).toContain('href="https://vendor.example.com/spec"')
  })

  it('preserves data-URI images, code blocks, hr, strike and underline from a browser copy', () => {
    const out = roundTrip(sanitizeToHub(fixture('browser.html')))
    expect(out).toContain('data:image/png;base64,iVBOR')
    expect(out).toContain('<pre')
    expect(out).toContain("encode('HELLO')")
    expect(out).toContain('<hr')
    expect(out).toContain('href="https://spec.example.org/v2"')
  })
})
