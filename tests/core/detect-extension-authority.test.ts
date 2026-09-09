import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { detect } from '../../src/core/detect'

/**
 * Which of the extension and the bytes wins, and in which direction.
 *
 * The sniff is allowed to correct an extension that LIES — a Word 97 file
 * saved as .docx is a CFB file and no reader of .docx will ever open it. It is
 * not allowed to correct one that tells the truth, and for the zip formats it
 * cannot tell the two apart on its own: the sniff is a substring scan for a
 * part name over the whole file, and one OOXML container legitimately carries
 * another's parts. A Word document with a chart in it stores the chart's
 * workbook whole, `xl/workbook.xml` and all — and that name is looked for
 * BEFORE `word/document.xml`, so the file sniffed as a spreadsheet and a
 * correctly named .docx went to the spreadsheet reader.
 */

const CFB = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(64),
])
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

async function zipOf(names: string[]): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  for (const name of names) zip.file(name, '<x/>')
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
}

function format(bytes: Buffer, filename: string): string {
  const r = detect(bytes, filename)
  return r.kind === 'ok' ? r.format : r.kind
}

describe('the bytes may correct a lying extension', () => {
  it('reads a Word 97 file named .docx as doc', () => {
    expect(format(CFB, 'mislabeled.docx')).toBe('doc')
  })

  it('reads a PNG named .pdf as an image', () => {
    expect(format(PNG, 'screenshot.pdf')).toBe('image')
  })

  it('reads an OOXML zip named .doc as docx', async () => {
    expect(format(await zipOf(['word/document.xml']), 'mislabeled.doc')).toBe('docx')
  })

  it('reads a workbook named .docx as xlsx, since no word part is there', async () => {
    // Still within the zip family: the extension named a part the zip does not
    // hold, so it is ruled out and the bytes decide.
    expect(format(await zipOf(['xl/workbook.xml']), 'mislabeled.docx')).toBe('xlsx')
  })

  it('reads a deck named .xlsx as pptx, since no workbook part is there', async () => {
    expect(format(await zipOf(['ppt/presentation.xml']), 'mislabeled.xlsx')).toBe('pptx')
  })

  it('reads an RTF named .doc as rtf', () => {
    expect(format(Buffer.from('{\\rtf1\\ansi hello}', 'utf8'), 'letter.doc')).toBe('rtf')
  })
})

describe('a sniff may not correct a truthful extension', () => {
  it('keeps a .docx that also carries an embedded workbook', async () => {
    const bytes = await zipOf([
      'word/document.xml',
      'word/embeddings/Microsoft_Excel_Worksheet.xlsx',
      'xl/workbook.xml',
    ])
    expect(format(bytes, 'quarterly-report.docx')).toBe('docx')
  })

  it('keeps a .pptx that also carries an embedded workbook', async () => {
    const bytes = await zipOf(['ppt/presentation.xml', 'ppt/embeddings/chart.xlsx', 'xl/workbook.xml'])
    expect(format(bytes, 'deck.pptx')).toBe('pptx')
  })

  it('keeps a .docm, which is a .docx by another name', async () => {
    const bytes = await zipOf(['word/document.xml', 'xl/workbook.xml'])
    expect(format(bytes, 'macro.docm')).toBe('docx')
  })

  it('keeps an .epub whose container also names a word part', async () => {
    const bytes = await zipOf(['META-INF/container.xml', 'OEBPS/word/document.xml'])
    expect(format(bytes, 'book.epub')).toBe('epub')
  })

  it('leaves text formats to their extension, since they legitimately overlap', () => {
    const md = Buffer.from('# Heading\n\n- a\n- b\n', 'utf8')
    expect(format(md, 'notes.txt')).toBe('txt')
    expect(format(md, 'notes.md')).toBe('md')
  })

  it('does not let an html sniff outrank an extension', () => {
    const html = Buffer.from('<!DOCTYPE html><html><body><p>hi</p></body></html>', 'utf8')
    expect(format(html, 'page.txt')).toBe('txt')
  })

  it('still trusts the extension when the bytes agree', () => {
    expect(format(PNG, 'logo.png')).toBe('image')
    expect(format(CFB, 'mail.msg')).toBe('msg')
    expect(format(CFB, 'book.xls')).toBe('xlsx')
  })
})
