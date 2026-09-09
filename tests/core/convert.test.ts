import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createConverter } from '../../src/core/convert'
import { ConversionError } from '../../src/core/errors'

const fakeRender = vi.fn(async (html: string) => Buffer.from('%PDF fake ' + html.length))
const text = (res: { parts: { bytes: Buffer }[] }): string => res.parts[0].bytes.toString('utf8')

describe('createConverter', () => {
  const conv = createConverter(fakeRender)

  it('md -> html', async () => {
    const out = await conv.convert({ bytes: Buffer.from('# Hi', 'utf8') }, 'md', 'html')
    expect(text(out)).toContain('<h1>Hi</h1>')
  })

  it('txt -> md', async () => {
    const out = await conv.convert({ bytes: Buffer.from('# not a heading, plain', 'utf8') }, 'txt', 'md')
    // txt reader escapes '#', so it should NOT become an atx heading
    expect(text(out)).toContain('\\#')
  })

  it('docx -> txt', async () => {
    const bytes = await readFile(join(__dirname, '../fixtures/sample.docx'))
    const out = await conv.convert({ bytes }, 'docx', 'txt')
    // html-to-text upper-cases headings, so compare case-insensitively
    expect(text(out).toLowerCase()).toContain('fixture title')
  })

  it('anything -> pdf uses the injected renderer', async () => {
    const out = await conv.convert({ bytes: Buffer.from('# Hi', 'utf8') }, 'md', 'pdf')
    expect(text(out)).toContain('%PDF fake')
  })

  it('forwards pdf render options to the injected renderer', async () => {
    fakeRender.mockClear()
    const opts = { pdf: { scale: 1.5, pageSize: 'A4' as const, landscape: true, headerFooter: false } }
    await conv.convert({ bytes: Buffer.from('# Hi', 'utf8') }, 'md', 'pdf', opts)
    expect(fakeRender).toHaveBeenCalledWith(expect.any(String), opts.pdf)
  })

  it('derives an HTML-escaped headerText from the document title when headerFooter is on', async () => {
    fakeRender.mockClear()
    const opts = { pdf: { scale: 1, pageSize: 'Letter' as const, landscape: false, headerFooter: true } }
    // md reader produces title-less hub; use html with <title> path? txt/md set no title,
    // so derive from filename via sourceName instead.
    await conv.convert({ bytes: Buffer.from('# Hi', 'utf8'), filename: 'spec <1>.md' }, 'md', 'pdf', opts)
    const forwarded = fakeRender.mock.calls[0][1] as { headerText?: string }
    expect(forwarded.headerText).toBe('spec &lt;1&gt;.md')
  })

  it('leaves headerText empty when headerFooter is off', async () => {
    fakeRender.mockClear()
    const opts = { pdf: { scale: 1, pageSize: 'Letter' as const, landscape: false, headerFooter: false } }
    await conv.convert({ bytes: Buffer.from('# Hi', 'utf8') }, 'md', 'pdf', opts)
    const forwarded = fakeRender.mock.calls[0][1] as { headerText?: string }
    expect(forwarded.headerText).toBeUndefined()
  })

  it('ignores pdf render options for non-pdf targets', async () => {
    const opts = { pdf: { scale: 2, pageSize: 'Legal' as const, landscape: false, headerFooter: false } }
    const out = await conv.convert({ bytes: Buffer.from('# Hi', 'utf8') }, 'md', 'html', opts)
    expect(text(out)).toContain('<h1>Hi</h1>')
  })

  it('propagates scanned-pdf as a ConversionError', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const pdf = await PDFDocument.create()
    pdf.addPage([100, 100])
    const bytes = Buffer.from(await pdf.save())
    await expect(conv.convert({ bytes }, 'pdf', 'txt')).rejects.toMatchObject({ code: 'scanned-pdf' })
  })

  it('rejects with read-failed for an unknown source format', async () => {
    const bogus = 'nope' as Parameters<typeof conv.convert>[1]
    await expect(conv.convert({ bytes: Buffer.from('x') }, bogus, 'txt')).rejects.toMatchObject({
      code: 'read-failed',
    })
  })

  /**
   * `sanitizeToHub` strips the characters XML forbids, but only readers that
   * call it were covered — txt, csv, code, rst, pdf and the ODF readers never
   * did, and a `.txt` holding a U+0008 out of a legacy export produced a docx
   * that Word refused to open. The strip has to sit where every reader's output
   * passes, which is here, not in each reader.
   */
  describe('XML-illegal characters are stripped whatever the reader', () => {
    // Backspace and SUB. A lone surrogate cannot ride in on bytes — UTF-8
    // encoding turns it into U+FFFD — so the byte-level sources cannot test it.
    const ILLEGAL = String.fromCharCode(0x08, 0x1a)
    // Built from codes, not literals: a literal control character in a test file is the bug under test.
    const CLEAN_RE = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(8) + String.fromCharCode(11, 12) + String.fromCharCode(14) + '-' + String.fromCharCode(31) + ']|[\uD800-\uDBFF](?![\uDC00-\uDFFF])')

    it.each(['txt', 'csv', 'rst', 'code'] as const)('%s reader', async (source) => {
      const body = source === 'csv' ? `a,b\nleft${ILLEGAL}right,2` : `left${ILLEGAL}right`
      const hub = await conv.read({ bytes: Buffer.from(body, 'utf8'), filename: `x.${source === 'code' ? 'py' : source}` }, source)
      expect(hub.html).not.toMatch(CLEAN_RE)
      // Stripping, not replacing: the surrounding text is intact and adjacent.
      expect(hub.html).toContain('leftright')
    })

    it('strips them from the title too', async () => {
      const hub = await conv.read(
        { bytes: Buffer.from(`<html><head><title>T${ILLEGAL}itle</title></head><body><p>x</p></body></html>`) },
        'html',
      )
      expect(hub.title ?? '').not.toMatch(CLEAN_RE)
    })

    it('reaches the docx writer clean', async () => {
      const out = await conv.convert({ bytes: Buffer.from(`left${ILLEGAL}right`, 'utf8'), filename: 'x.txt' }, 'txt', 'docx')
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(out.parts[0].bytes)
      const xml = await zip.file('word/document.xml')!.async('string')
      expect(xml).not.toMatch(CLEAN_RE)
      expect(xml).toContain('leftright')
    })
  })

  it('wraps unexpected reader failure as read-failed', async () => {
    await expect(
      conv.convert({ bytes: Buffer.from('not a docx') }, 'docx', 'txt'),
    ).rejects.toBeInstanceOf(ConversionError)
    await expect(
      conv.convert({ bytes: Buffer.from('not a docx') }, 'docx', 'txt'),
    ).rejects.toMatchObject({ code: 'read-failed' })
  })
})
