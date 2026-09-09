import { describe, it, expect } from 'vitest'
import { detect, detectByExtension, looksLikeMarkdown } from '../../src/core/detect'

const buf = (s: string) => Buffer.from(s, 'utf8')
const zip = (parts: string) =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), buf(parts)])
const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00])

describe('detectByExtension', () => {
  it('maps known extensions', () => {
    expect(detectByExtension('a.PDF')).toBe('pdf')
    expect(detectByExtension('a.md')).toBe('md')
    expect(detectByExtension('a.markdown')).toBe('md')
    expect(detectByExtension('a.docx')).toBe('docx')
    expect(detectByExtension('a.htm')).toBe('html')
    expect(detectByExtension('a.txt')).toBe('txt')
    expect(detectByExtension('a.xyz')).toBeNull()
  })
})

describe('looksLikeMarkdown', () => {
  it('true for markdown signals', () => {
    expect(looksLikeMarkdown('# Heading\n\ntext')).toBe(true)
    expect(looksLikeMarkdown('- item one\n- item two')).toBe(true)
  })
  it('false for plain prose', () => {
    expect(looksLikeMarkdown('Just a normal sentence. Another one.')).toBe(false)
  })
})

describe('detect (DetectResult contract)', () => {
  it('prefers extension', () => {
    expect(detect(buf('# hi'), 'notes.txt')).toEqual({ kind: 'ok', format: 'txt' })
  })
  it('detects PDF by magic', () => {
    expect(detect(buf('%PDF-1.4'))).toEqual({ kind: 'ok', format: 'pdf' })
  })
  it('detects docx by word/document.xml part, not [Content_Types].xml', () => {
    expect(detect(zip('...word/document.xml...'))).toEqual({ kind: 'ok', format: 'docx' })
  })
  it('detects xlsx zips (not docx)', () => {
    expect(detect(zip('...[Content_Types].xml...xl/workbook.xml...'))).toEqual({ kind: 'ok', format: 'xlsx' })
  })

  it('maps csv/tsv/xlsx extensions', () => {
    expect(detectByExtension('a.csv')).toBe('csv')
    expect(detectByExtension('a.tsv')).toBe('csv')
    expect(detectByExtension('a.xlsx')).toBe('xlsx')
  })

  it('applies the csv heuristic only to files, never pasted text', () => {
    const table = 'alpha,beta,gamma\n1,2,3\n4,5,6'
    expect(detect(buf(table), 'export.dat')).toEqual({ kind: 'ok', format: 'csv' })
    expect(detect(buf(table))).toEqual({ kind: 'ok', format: 'txt' })
  })

  it('does not misroute prose with commas into csv', () => {
    const prose = 'First, we check the file.\nThen, we convert it, obviously.'
    expect(detect(buf(prose), 'notes.dat')).toEqual({ kind: 'ok', format: 'txt' })
  })
  it('detects pptx zips', () => {
    expect(detect(zip('...[Content_Types].xml...ppt/presentation.xml...'))).toEqual({
      kind: 'ok',
      format: 'pptx',
    })
  })
  it('reports CFB (legacy Office) as unsupported', () => {
    const r = detect(CFB)
    expect(r.kind).toBe('unsupported')
    if (r.kind === 'unsupported') expect(r.reason).toMatch(/legacy office/i)
  })
  it('detects html by sniff', () => {
    expect(detect(buf('<!DOCTYPE html><html></html>'))).toEqual({ kind: 'ok', format: 'html' })
  })
  it('falls back to md/txt heuristic', () => {
    expect(detect(buf('# Title\n- a'))).toEqual({ kind: 'ok', format: 'md' })
    expect(detect(buf('plain sentence here'))).toEqual({ kind: 'ok', format: 'txt' })
  })
})
