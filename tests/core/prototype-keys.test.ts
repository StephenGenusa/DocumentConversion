import { describe, it, expect } from 'vitest'
import { detect, detectByExtension } from '../../src/core/detect'
import { codeFormatFromFilename, languageForFilename } from '../../src/core/code-langs'
import { colorizeStatusEmoji } from '../../src/core/emoji'
import { readPptx } from '../../src/core/readers/pptx'
import JSZip from 'jszip'

/**
 * Lookup tables keyed by something the document or its name supplies.
 *
 * A plain object literal inherits `Object.prototype`, so `table['constructor']`
 * hands back a FUNCTION instead of undefined and every `?? null`, `if (x)` and
 * `x ? … : …` downstream reads it as a hit. `__proto__` is worse: it comes back
 * as the prototype object itself. Every table below takes its key from a
 * filename or from markup, so every one of them is reachable from a file
 * someone can hand the converter.
 */

const HOSTILE = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']

const text = (s: string) => Buffer.from(s, 'utf8')

describe('EXT_MAP: the key is a file extension', () => {
  it('returns null for a prototype member used as an extension', () => {
    for (const key of HOSTILE) expect(detectByExtension(`report.${key}`)).toBeNull()
  })

  it('reads a file with such an extension as what its content is', () => {
    expect(detect(text('just a plain sentence.'), 'report.constructor')).toEqual({
      kind: 'ok',
      format: 'txt',
    })
  })

  it('still maps a real extension on a prototype-named file', () => {
    expect(detect(text('# Heading\n\n- a\n'), 'toString.md')).toEqual({ kind: 'ok', format: 'md' })
    expect(detect(text('a,b\n1,2\n'), 'constructor.csv')).toEqual({ kind: 'ok', format: 'csv' })
  })
})

describe('EXT_TO_LANG and NAME_TO_LANG: the key is a filename', () => {
  it('claims no language for a file named after a prototype member', () => {
    for (const key of HOSTILE) {
      expect(languageForFilename(key)).toBeNull()
      expect(codeFormatFromFilename(key)).toBe(false)
      expect(languageForFilename(`src/${key}`)).toBeNull()
      expect(languageForFilename(`notes.${key}`)).toBeNull()
    }
  })

  it('does not route such a file to the code reader', () => {
    expect(detect(text('just a plain sentence.'), 'constructor')).toEqual({ kind: 'ok', format: 'txt' })
    expect(detect(text('just a plain sentence.'), '__proto__')).toEqual({ kind: 'ok', format: 'txt' })
  })

  it('still names the language of a real source file', () => {
    expect(languageForFilename('constructor.py')).toBe('python')
    expect(languageForFilename('Dockerfile')).toBe('dockerfile')
    expect(languageForFilename('toString.ts')).toBe('typescript')
  })
})

/**
 * `<a:buAutoNum type>` is an attribute value straight out of the slide XML.
 */
async function deckWithAutoNumType(type: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file(
    'ppt/slides/slide1.xml',
    `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>` +
      `<a:p><a:pPr lvl="0"><a:buAutoNum type="${type}"/></a:pPr><a:r><a:t>First step</a:t></a:r></a:p>` +
      `<a:p><a:pPr lvl="0"><a:buAutoNum type="${type}"/></a:pPr><a:r><a:t>Second step</a:t></a:r></a:p>` +
      `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  )
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
}

describe('OL_TYPE: the key is a slide attribute value', () => {
  it('writes no list type for a numbering scheme named after a prototype member', async () => {
    for (const key of ['constructor', 'toString']) {
      const { html } = await readPptx({ bytes: await deckWithAutoNumType(key), filename: 'deck.pptx' })
      expect(html).toContain('<ol>')
      expect(html).not.toContain('type=')
      expect(html).not.toContain('native code')
      expect(html).toContain('First step')
    }
  })

  it('still writes the type of a real numbering scheme', async () => {
    const { html } = await readPptx({ bytes: await deckWithAutoNumType('alphaLcPeriod'), filename: 'd.pptx' })
    expect(html).toContain('<ol type="a">')
  })
})

/**
 * The emoji table is the one lookup here whose key is NOT document-controlled:
 * the pattern is built from the table's own keys, so the captured group can
 * only ever be one of them. Pinned rather than changed.
 */
describe('RULES: the key can only come from the table itself', () => {
  it('leaves prose naming a prototype member alone', () => {
    const prose = 'Call constructor, then toString, then hasOwnProperty and finally __proto__.'
    expect(colorizeStatusEmoji(prose)).toBe(prose)
  })

  it('still colours a status emoji', () => {
    expect(colorizeStatusEmoji('done ✅')).toContain('#16a34a')
  })
})
