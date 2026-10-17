import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { createConverter } from '../../src/core/convert'
import type { ConvertOptions, TargetFormat } from '../../src/core/types'

/**
 * Settings → Code: "Colour code by language" (settings spec 4.4, 8.1). Off,
 * every output that colours code (html, pdf, Word, EPUB, the Kindle books,
 * slides) writes it plain: no highlight.js spans, no token colours. On (the
 * default, and what a conversion with no option gets), it is coloured as
 * before. The editor's colouring is a display layer and is not touched here.
 */
const hub = { html: '<pre><code class="language-js">const answer = 42 // the answer\n</code></pre>', title: 'Code' }
/** Keyword red from TOKEN_COLOURS (hljs.ts), as Word writes it. */
const KEYWORD_RED = /cf222e/i

/** The pdf and azw4 writers hand their page to this; it is what Chromium would print. */
const printed: string[] = []
const converter = createConverter(async (html) => {
  printed.push(html)
  return Buffer.from('%PDF-1.4\n%%EOF')
})

/** The text of an output as far as colour goes: the page, or every part of a zip. */
async function textOf(target: TargetFormat, opts?: ConvertOptions): Promise<string> {
  printed.length = 0
  const out = (await converter.write(structuredClone(hub), target, opts)).parts[0].bytes
  if (target === 'pdf' || target === 'azw4') return printed.join('\n')
  if (target === 'docx' || target === 'epub') {
    const zip = await JSZip.loadAsync(out)
    const files = Object.values(zip.files).filter((f) => !f.dir && /\.(xml|xhtml|css)$/.test(f.name))
    return (await Promise.all(files.map((f) => f.async('string')))).join('\n')
  }
  return out.toString('latin1')
}

describe('code colour on and off', () => {
  for (const target of ['html', 'pdf', 'revealjs', 'epub', 'azw4'] as const) {
    it(`${target}: coloured by default, plain with codeColour off`, async () => {
      expect(await textOf(target)).toMatch(/class="hljs-keyword"/)
      const plain = await textOf(target, { codeColour: false })
      // No coloured span and no palette. (A deck's inlined reveal.js names hljs in its own source.)
      expect(plain).not.toMatch(/class="[^"]*hljs|\.hljs-keyword/)
      expect(plain).toContain('const answer = 42')
    })
  }

  it('docx: token colours by default, none with codeColour off', async () => {
    expect(await textOf('docx')).toMatch(KEYWORD_RED)
    const plain = await textOf('docx', { codeColour: false })
    expect(plain).not.toMatch(KEYWORD_RED)
    expect(plain).toContain('const answer = 42')
  })

  it('azw3: the book it is made from is written plain too', async () => {
    const coloured = (await converter.write(structuredClone(hub), 'azw3')).parts[0].bytes
    const plain = (await converter.write(structuredClone(hub), 'azw3', { codeColour: false })).parts[0].bytes
    // The book's stylesheet carries the code palette only when code was coloured.
    expect(coloured.includes('hljs-keyword')).toBe(true)
    expect(plain.includes('hljs')).toBe(false)
  })
})
