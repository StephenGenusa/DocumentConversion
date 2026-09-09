import { describe, it, expect } from 'vitest'
import * as iconv from 'iconv-lite'
import { readTxt } from '../../src/core/readers/txt'
import { readHtml } from '../../src/core/readers/html'

/**
 * D1. Both text readers used to call `bytes.toString('utf8')`, which is only
 * correct for one of the encodings a real .txt or a saved web page arrives in.
 * A Windows-1252 memo came through with a replacement character where every
 * curly quote and em dash had been, and a UTF-16 file came through as a column
 * of NUL-separated letters.
 */

const cp1252 = (s: string): Buffer => iconv.encode(s, 'win1252')
const utf16le = (s: string): Buffer => iconv.encode(s, 'utf16le', { addBOM: true })
const utf16be = (s: string): Buffer => iconv.encode(s, 'utf16be', { addBOM: true })
const utf8bom = (s: string): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')])

const SMART = 'He said “hello” — it’s fine.'

describe('readTxt charset detection', () => {
  it('reads plain ASCII unchanged', async () => {
    const doc = await readTxt({ bytes: Buffer.from('plain ascii text', 'ascii') })
    expect(doc.html).toContain('plain ascii text')
  })

  it('reads UTF-8 unchanged, multi-byte characters included', async () => {
    const doc = await readTxt({ bytes: Buffer.from('Café 你好 \u{1f600} — ok', 'utf8') })
    expect(doc.html).toContain('Café 你好 \u{1f600} — ok')
  })

  it('honours a UTF-8 BOM without leaving it in the text', async () => {
    const doc = await readTxt({ bytes: utf8bom('Café') })
    expect(doc.html).toContain('Café')
    expect(doc.html).not.toContain('\uFEFF')
  })

  it('decodes UTF-16LE with a BOM', async () => {
    const doc = await readTxt({ bytes: utf16le(SMART) })
    expect(doc.html).toContain(SMART)
    expect(doc.html).not.toContain('\u0000')
  })

  it('decodes UTF-16BE with a BOM', async () => {
    const doc = await readTxt({ bytes: utf16be(SMART) })
    expect(doc.html).toContain(SMART)
    expect(doc.html).not.toContain('\u0000')
  })

  it('decodes Windows-1252 curly quotes and an em dash', async () => {
    const doc = await readTxt({ bytes: cp1252(SMART) })
    expect(doc.html).toContain(SMART)
    expect(doc.html).not.toContain('�')
  })

  it('keeps a tab-delimited table detectable through a UTF-16 decode', async () => {
    const doc = await readTxt({ bytes: utf16le('Item\tQty\nBolt\t10\n') })
    expect(doc.html).toContain('<th>Item</th>')
    expect(doc.html).toContain('<td>Bolt</td>')
  })
})

describe('readHtml charset detection', () => {
  it('reads UTF-8 unchanged', async () => {
    const doc = await readHtml({ bytes: Buffer.from('<p>Café — 你好</p>', 'utf8') })
    expect(doc.html).toContain('Café — 你好')
  })

  it('honours <meta charset="windows-1252">', async () => {
    const bytes = cp1252(`<html><head><meta charset="windows-1252"><title>T</title></head><body><p>${SMART}</p></body></html>`)
    const doc = await readHtml({ bytes })
    expect(doc.html).toContain(SMART)
    expect(doc.html).not.toContain('�')
  })

  it('honours a legacy http-equiv Content-Type declaration', async () => {
    const bytes = cp1252(
      `<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"></head><body><p>café</p></body></html>`,
    )
    const doc = await readHtml({ bytes })
    expect(doc.html).toContain('café')
  })

  it('decodes a UTF-16LE page and still finds its title', async () => {
    const doc = await readHtml({ bytes: utf16le('<html><head><title>Titel</title></head><body><p>Grüße</p></body></html>') })
    expect(doc.title).toBe('Titel')
    expect(doc.html).toContain('Grüße')
    expect(doc.html).not.toContain('\u0000')
  })

  it('ignores a declared charset that contradicts a BOM', async () => {
    // The BOM wins over any in-document declaration (HTML spec, and the only
    // sane reading: the bytes cannot be what the meta says they are).
    const doc = await readHtml({
      bytes: utf8bom('<html><head><meta charset="windows-1252"></head><body><p>Café</p></body></html>'),
    })
    expect(doc.html).toContain('Café')
  })
})

/**
 * Two follow-ups from the diff review.
 *
 * 1. A declared single-byte charset used to outrank bytes that are valid
 *    UTF-8. A UTF-8 page whose `<meta charset="windows-1252">` lies — routine
 *    on legacy sites — came out as `CafÃ© â€” â€œqâ€`, and the baseline
 *    `toString('utf8')` had it right, so that was a regression. Multi-byte
 *    UTF-8 sequences are almost never valid by accident in single-byte text,
 *    so strict UTF-8 is the better witness when the two disagree.
 * 2. `bomlessUtf16` had no test at all; deleting it passed the suite.
 */
describe('charset: declaration versus evidence', () => {
  const NUL = String.fromCharCode(0)

  it('trusts valid UTF-8 bytes over a single-byte declaration that contradicts them', async () => {
    const page = '<html><head><meta charset="windows-1252"></head><body><p>Café — “quoted”</p></body></html>'
    const doc = await readHtml({ bytes: Buffer.from(page, 'utf8') })
    expect(doc.html).toContain('Café — “quoted”')
    expect(doc.html).not.toContain('Ã')
  })

  it('still honours the declaration when the bytes are not valid UTF-8', async () => {
    // Real Windows-1252: 0x93/0x94 are not a UTF-8 sequence, so the
    // declaration is the only witness and it is right.
    const bytes = cp1252('<html><head><meta charset="windows-1252"></head><body><p>“q”</p></body></html>')
    const doc = await readHtml({ bytes })
    expect(doc.html).toContain('“q”')
  })

  it('honours a declared non-Latin single-byte charset when the bytes fit it', async () => {
    const bytes = iconv.encode('<html><head><meta charset="windows-1251"></head><body><p>Привет</p></body></html>', 'win1251')
    const doc = await readHtml({ bytes })
    expect(doc.html).toContain('Привет')
  })

  it('decodes BOM-less UTF-16LE', async () => {
    const doc = await readTxt({ bytes: iconv.encode(SMART, 'utf16le') })
    expect(doc.html).toContain(SMART)
    expect(doc.html).not.toContain(NUL)
  })

  it('decodes BOM-less UTF-16BE', async () => {
    const doc = await readTxt({ bytes: iconv.encode(SMART, 'utf16be') })
    expect(doc.html).toContain(SMART)
    expect(doc.html).not.toContain(NUL)
  })

  it('decodes BOM-less UTF-16LE that opens with CJK text', async () => {
    // Every code unit here has a non-zero high byte, so a "zero high bytes"
    // heuristic sees nothing; the Latin punctuation later in the line is what
    // has to carry the detection.
    const text = '一二三四五六七八九十 — the report, 2024.'
    const doc = await readTxt({ bytes: iconv.encode(text, 'utf16le') })
    expect(doc.html).toContain(text)
    expect(doc.html).not.toContain(NUL)
  })
})
