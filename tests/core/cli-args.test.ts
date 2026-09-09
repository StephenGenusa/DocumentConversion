import { describe, it, expect } from 'vitest'
import { parseArgs, USAGE } from '../../src/cli/args'
import { TARGET_FORMATS } from '../../src/core/types'

const ok = (argv: string[]) => {
  const r = parseArgs(argv)
  if (r.kind !== 'ok') throw new Error(`expected ok, got usage: ${r.message}`)
  return r.req
}

describe('parseArgs', () => {
  it('parses the minimal form', () => {
    const req = ok(['spec.md', '--to', 'pdf'])
    expect(req.inputs).toEqual(['spec.md'])
    expect(req.to).toBe('pdf')
    expect(req.merge).toBe(false)
    expect(req.landscape).toBe(false)
    expect(req.headerFooter).toBe(false)
    expect(req.ocr).toBe(false)
    expect(req.noClobber).toBe(false)
    expect(req.headings).toBe(true)
  })

  it('parses every flag', () => {
    const req = ok([
      'a.md',
      'b.docx',
      '--to',
      'pdf',
      '--out',
      'out',
      '--from',
      'md',
      '--merge',
      '--table',
      '2',
      '--scale',
      '1.25',
      '--page',
      'A4',
      '--landscape',
      '--header-footer',
      '--ocr',
      '--no-clobber',
      '--no-headings',
    ])
    expect(req.inputs).toEqual(['a.md', 'b.docx'])
    expect(req.out).toBe('out')
    expect(req.from).toBe('md')
    expect(req.merge).toBe(true)
    expect(req.table).toBe(2)
    expect(req.scale).toBeCloseTo(1.25)
    expect(req.page).toBe('A4')
    expect(req.landscape).toBe(true)
    expect(req.headerFooter).toBe(true)
    expect(req.ocr).toBe(true)
    expect(req.noClobber).toBe(true)
    expect(req.headings).toBe(false)
  })

  it('usage when --to is missing or invalid', () => {
    expect(parseArgs(['a.md']).kind).toBe('usage')
    expect(parseArgs(['a.md', '--to', 'xyz']).kind).toBe('usage')
  })

  it('usage when no inputs given', () => {
    expect(parseArgs(['--to', 'pdf']).kind).toBe('usage')
  })

  it('usage for an unknown flag', () => {
    expect(parseArgs(['a.md', '--to', 'pdf', '--wat']).kind).toBe('usage')
  })

  it('usage when multiple inputs lack --out', () => {
    expect(parseArgs(['a.md', 'b.md', '--to', 'pdf']).kind).toBe('usage')
    expect(parseArgs(['a.md', 'b.md', '--to', 'pdf', '--merge']).kind).toBe('usage')
  })

  it('usage for non-numeric table/scale', () => {
    expect(parseArgs(['a.md', '--to', 'csv', '--table', 'x']).kind).toBe('usage')
    expect(parseArgs(['a.md', '--to', 'pdf', '--scale', 'big']).kind).toBe('usage')
  })

  it('usage for an invalid --from', () => {
    expect(parseArgs(['a.md', '--to', 'pdf', '--from', 'nope']).kind).toBe('usage')
  })

  it('usage for merge to csv', () => {
    expect(parseArgs(['a.md', 'b.md', '--to', 'csv', '--out', 'x.csv', '--merge']).kind).toBe('usage')
  })
})

/**
 * The help text listed the target formats by hand, so adding `epub` left the
 * CLI advertising eight of nine targets while happily accepting the ninth.
 * Nothing asserted the string, so the drift was invisible. Derive the check
 * from the registry instead of restating the list here — a hand-written
 * expectation would drift in exactly the same way.
 */
describe('USAGE text', () => {
  it('offers every writable target format', () => {
    for (const format of TARGET_FORMATS) {
      expect(USAGE, `--to list is missing ${format}`).toContain(format)
    }
  })

  it('names every flag parseArgs accepts', () => {
    for (const flag of ['--out', '--from', '--merge', '--table', '--scale', '--page', '--landscape', '--ocr']) {
      expect(USAGE, `usage text is missing ${flag}`).toContain(flag)
    }
  })
})

describe('--split', () => {
  it('accepts each documented rule', () => {
    for (const rule of ['auto', 'hr', 'h1', 'h2'] as const) {
      const r = parseArgs(['a.md', '--to', 'revealjs', '--split', rule])
      expect(r.kind, `--split ${rule}`).toBe('ok')
      if (r.kind === 'ok') expect(r.req.split).toBe(rule)
    }
  })

  it('refuses a rule it does not know rather than silently defaulting', () => {
    const r = parseArgs(['a.md', '--to', 'revealjs', '--split', 'h7'])
    expect(r.kind).toBe('usage')
  })

  it('needs a value', () => {
    expect(parseArgs(['a.md', '--to', 'revealjs', '--split']).kind).toBe('usage')
  })

  it('is optional', () => {
    const r = parseArgs(['a.md', '--to', 'revealjs'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.req.split).toBeUndefined()
  })
})
