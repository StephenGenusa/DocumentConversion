import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { detect } from '../../src/core/detect'

const CFB = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(64),
])
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

describe('mislabeled binary files fall back to their magic bytes', () => {
  it('reads a Word 97 file that was saved with a .docx name', () => {
    // Previously refused with a raw jszip "end of central directory" error.
    expect(detect(CFB, 'mislabeled.docx')).toEqual({ kind: 'ok', format: 'doc' })
  })

  it('reads a PNG that was named .pdf', () => {
    expect(detect(PNG, 'screenshot.pdf')).toEqual({ kind: 'ok', format: 'image' })
  })

  it('reads a real docx that was named .doc', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', '<w:document/>')
    const bytes = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
    expect(detect(bytes, 'mislabeled.doc')).toEqual({ kind: 'ok', format: 'docx' })
  })

  it('leaves text formats to their extension, since they legitimately overlap', () => {
    // Markdown IS valid plain text; the extension must stay authoritative.
    const md = Buffer.from('# Heading\n\n- a\n- b\n', 'utf8')
    expect(detect(md, 'notes.txt')).toEqual({ kind: 'ok', format: 'txt' })
    expect(detect(md, 'notes.md')).toEqual({ kind: 'ok', format: 'md' })
  })

  it('still trusts the extension when the bytes agree', () => {
    expect(detect(PNG, 'logo.png')).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(CFB, 'mail.msg')).toEqual({ kind: 'ok', format: 'msg' })
  })
})
