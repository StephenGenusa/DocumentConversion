import { describe, it, expect } from 'vitest'
import { parseArgs, checkFlagScope, FLAG_SCOPES, USAGE } from '../../src/cli/args'
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

/**
 * Spec 2a: a command-line flag scoped to some targets or inputs. A STRICT
 * flag that cannot apply exits 2; the flags that predate the rule are not
 * strict and are still ignored, as they always were, so no script breaks.
 */
describe('flag scope', () => {
  const scopes = [
    { flag: '--strict-thing', targets: ['pdf' as const], strict: true },
    { flag: '--input-thing', inputs: ['json' as const], strict: true },
    { flag: '--legacy-thing', targets: ['pdf' as const], strict: false },
  ]

  it('rejects a strict flag the target cannot use', () => {
    expect(checkFlagScope(['--strict-thing'], 'docx', ['md'], scopes)).toMatch(/--strict-thing.*pdf/)
    expect(checkFlagScope(['--strict-thing'], 'pdf', ['md'], scopes)).toBeNull()
  })

  it('rejects a strict flag no input can use', () => {
    expect(checkFlagScope(['--input-thing'], 'csv', ['md', 'docx'], scopes)).toMatch(/--input-thing/)
    expect(checkFlagScope(['--input-thing'], 'csv', ['md', 'json'], scopes)).toBeNull()
  })

  it('still ignores a legacy flag the target cannot use', () => {
    expect(checkFlagScope(['--legacy-thing'], 'docx', ['md'], scopes)).toBeNull()
  })

  it('keeps today\'s flags non-strict: --table, --split, --scale, --page, --landscape, --header-footer', () => {
    for (const flag of ['--table', '--split', '--scale', '--page', '--landscape', '--header-footer']) {
      const scope = FLAG_SCOPES.find((s) => s.flag === flag)
      expect(scope, flag).toBeDefined()
      expect(scope!.strict, flag).toBe(false)
    }
  })
})

/** Spec B4: --diagrams <svg|png>, strict, for the outputs that take SVG. */
describe('--diagrams', () => {
  it('takes svg or png', () => {
    for (const v of ['svg', 'png'] as const) {
      const r = parseArgs(['a.md', '--to', 'html', '--diagrams', v])
      expect(r.kind).toBe('ok')
      if (r.kind === 'ok') expect(r.req.diagrams).toBe(v)
    }
    const none = parseArgs(['a.md', '--to', 'html'])
    if (none.kind === 'ok') expect(none.req.diagrams).toBeUndefined()
  })

  it('refuses anything else, and a missing value', () => {
    expect(parseArgs(['a.md', '--to', 'html', '--diagrams', 'jpeg']).kind).toBe('usage')
    expect(parseArgs(['a.md', '--to', 'html', '--diagrams']).kind).toBe('usage')
  })

  it('exits 2 for an output that cannot take it (Word is always PNG)', () => {
    for (const t of ['pdf', 'html', 'revealjs', 'epub', 'azw4'] as const) expect(checkFlagScope(['--diagrams'], t, ['md']), t).toBeNull()
    for (const t of ['docx', 'azw3', 'md', 'txt', 'csv', 'json', 'xlsx'] as const) {
      expect(checkFlagScope(['--diagrams'], t, ['md']), t).toMatch(/^--diagrams applies only to pdf, html, revealjs, epub, azw4 output/)
    }
  })

  it('is listed in the usage', () => {
    expect(USAGE).toContain('--diagrams <svg|png>')
  })
})

/** Settings spec 5.7: a flag for each setting, all strict. */
describe('settings flags', () => {
  it('--pictures takes auto, jpg or png (jpeg too), as the picture format', () => {
    expect(ok(['a.md', '--to', 'pdf', '--pictures', 'auto']).pictures).toBe('auto')
    expect(ok(['a.md', '--to', 'pdf', '--pictures', 'Auto']).pictures).toBe('auto')
    expect(ok(['a.md', '--to', 'pdf', '--pictures', 'jpg']).pictures).toBe('jpeg')
    expect(ok(['a.md', '--to', 'pdf', '--pictures', 'jpeg']).pictures).toBe('jpeg')
    expect(ok(['a.md', '--to', 'pdf', '--pictures', 'png']).pictures).toBe('png')
    expect(ok(['a.md', '--to', 'pdf']).pictures).toBeUndefined()
    expect(parseArgs(['a.md', '--to', 'pdf', '--pictures', 'gif']).kind).toBe('usage')
    expect(parseArgs(['a.md', '--to', 'pdf', '--pictures']).kind).toBe('usage')
  })

  it('--pictures exits 2 for an output that holds no pictures', () => {
    for (const t of ['pdf', 'html', 'revealjs', 'epub', 'azw3', 'azw4', 'md', 'docx'] as const) {
      expect(checkFlagScope(['--pictures'], t, ['md']), t).toBeNull()
    }
    for (const t of ['txt', 'csv', 'json', 'xlsx'] as const) {
      expect(checkFlagScope(['--pictures'], t, ['md']), t).toMatch(/^--pictures applies only to .* output, not /)
    }
  })

  it('--no-fetch and --no-local-network', () => {
    const req = ok(['a.md', '--to', 'pdf', '--no-fetch'])
    expect(req.noFetch).toBe(true)
    expect(req.noLocalNetwork).toBeUndefined()
    expect(ok(['a.md', '--to', 'pdf', '--no-local-network']).noLocalNetwork).toBe(true)
  })

  it('--no-local-network with --no-fetch is a usage error: nothing is fetched to limit', () => {
    const r = parseArgs(['a.md', '--to', 'pdf', '--no-fetch', '--no-local-network'])
    expect(r.kind).toBe('usage')
    if (r.kind === 'usage') expect(r.message).toMatch(/^--no-local-network does nothing with --no-fetch/)
  })

  it('the web flags exit 2 when every input is mail or a calendar, which never fetch', () => {
    for (const flag of ['--no-fetch', '--no-local-network']) {
      expect(checkFlagScope([flag], 'pdf', ['eml', 'ics']), flag).toMatch(new RegExp(`^${flag} does not apply to eml, msg, mbox, ics input`))
      expect(checkFlagScope([flag], 'pdf', ['eml', 'md']), flag).toBeNull()
      expect(checkFlagScope([flag], 'txt', ['docx']), flag).toBeNull()
    }
  })

  it('--no-code-color, strict to the outputs that color code', () => {
    expect(ok(['a.md', '--to', 'html', '--no-code-color']).noCodeColor).toBe(true)
    for (const t of ['pdf', 'html', 'revealjs', 'epub', 'azw3', 'azw4', 'docx'] as const) {
      expect(checkFlagScope(['--no-code-color'], t, ['md']), t).toBeNull()
    }
    for (const t of ['md', 'txt', 'csv', 'json', 'xlsx'] as const) {
      expect(checkFlagScope(['--no-code-color'], t, ['md']), t).toMatch(/^--no-code-color applies only to/)
    }
  })

  it('--fetch and --code-color turn back on what a settings file turned off', () => {
    const req = ok(['a.md', '--to', 'html', '--fetch', '--code-color'])
    expect(req.fetch).toBe(true)
    expect(req.codeColor).toBe(true)
    expect(req.noFetch).toBeUndefined()
    expect(req.noCodeColor).toBeUndefined()
    const none = ok(['a.md', '--to', 'html'])
    expect(none.fetch).toBeUndefined()
    expect(none.codeColor).toBeUndefined()
  })

  it('--fetch and --code-color are accepted without --settings, where they are the default already', () => {
    expect(ok(['a.md', '--to', 'pdf', '--fetch']).settings).toBeUndefined()
    expect(ok(['a.md', '--to', 'pdf', '--code-color']).settings).toBeUndefined()
  })

  it('a flag and its --no- opposite together are a usage error, either order', () => {
    for (const [on, off] of [
      ['--fetch', '--no-fetch'],
      ['--local-network', '--no-local-network'],
      ['--code-color', '--no-code-color'],
      ['--header-footer', '--no-header-footer'],
    ]) {
      for (const argv of [[on, off], [off, on]]) {
        const r = parseArgs(['a.md', '--to', 'pdf', ...argv])
        expect(r.kind, argv.join(' ')).toBe('usage')
        if (r.kind === 'usage') expect(r.message).toMatch(new RegExp(`^${on} and ${off} are opposites: give one`))
      }
    }
  })

  it('--fetch with --no-local-network is fine: fetch, but not from the intranet', () => {
    const req = ok(['a.md', '--to', 'pdf', '--fetch', '--no-local-network'])
    expect(req.fetch).toBe(true)
    expect(req.noLocalNetwork).toBe(true)
    expect(checkFlagScope(['--fetch', '--no-local-network'], 'pdf', ['md'])).toBeNull()
  })

  it("--fetch has --no-fetch's scope: exit 2 when every input is mail or a calendar", () => {
    expect(checkFlagScope(['--fetch'], 'pdf', ['eml', 'msg', 'mbox', 'ics'])).toMatch(/^--fetch does not apply to eml, msg, mbox, ics input/)
    expect(checkFlagScope(['--fetch'], 'pdf', ['eml', 'md'])).toBeNull()
    expect(checkFlagScope(['--fetch'], 'txt', ['docx'])).toBeNull()
    // Each is matched whole: --no-fetch's scope is not --fetch's, nor the other way round.
    expect(checkFlagScope(['--no-fetch'], 'pdf', ['md'])).toBeNull()
    expect(checkFlagScope(['--no-fetch'], 'pdf', ['eml'])).toMatch(/^--no-fetch does not apply/)
  })

  it("--code-color has --no-code-color's scope: the outputs that color code", () => {
    for (const t of ['pdf', 'html', 'revealjs', 'epub', 'azw3', 'azw4', 'docx'] as const) {
      expect(checkFlagScope(['--code-color'], t, ['md']), t).toBeNull()
    }
    for (const t of ['md', 'txt', 'csv', 'json', 'xlsx'] as const) {
      expect(checkFlagScope(['--code-color'], t, ['md']), t).toMatch(
        /^--code-color applies only to pdf, html, revealjs, epub, azw3, azw4, docx output, not /,
      )
    }
  })

  it('--local-network turns back on the intranet a settings file refused', () => {
    const req = ok(['a.md', '--to', 'pdf', '--local-network'])
    expect(req.localNetwork).toBe(true)
    expect(req.noLocalNetwork).toBeUndefined()
    expect(ok(['a.md', '--to', 'pdf']).localNetwork).toBeUndefined()
    expect(ok(['a.md', '--to', 'pdf', '--fetch', '--local-network']).localNetwork).toBe(true)
  })

  it('--local-network with --no-fetch is a usage error, like --no-local-network', () => {
    const r = parseArgs(['a.md', '--to', 'pdf', '--no-fetch', '--local-network'])
    expect(r.kind).toBe('usage')
    if (r.kind === 'usage') expect(r.message).toMatch(/^--local-network does nothing with --no-fetch/)
  })

  it("--local-network has --no-local-network's scope", () => {
    expect(checkFlagScope(['--local-network'], 'pdf', ['eml', 'ics'])).toMatch(/^--local-network does not apply to eml, msg, mbox, ics input/)
    expect(checkFlagScope(['--local-network'], 'pdf', ['eml', 'md'])).toBeNull()
    expect(checkFlagScope(['--no-local-network'], 'pdf', ['md'])).toBeNull()
  })

  it('--no-header-footer: pdf only, and strict, unlike the legacy --header-footer', () => {
    const req = ok(['a.md', '--to', 'pdf', '--no-header-footer'])
    expect(req.noHeaderFooter).toBe(true)
    expect(req.headerFooter).toBe(false)
    expect(ok(['a.md', '--to', 'pdf']).noHeaderFooter).toBeUndefined()
    expect(checkFlagScope(['--no-header-footer'], 'pdf', ['md'])).toBeNull()
    for (const t of ['azw4', 'html', 'docx', 'txt'] as const) {
      expect(checkFlagScope(['--no-header-footer'], t, ['md']), t).toMatch(/^--no-header-footer applies only to pdf output, not /)
      expect(checkFlagScope(['--header-footer'], t, ['md']), t).toBeNull()
    }
  })

  it('--ocr-lang needs --ocr and a language the app knows', () => {
    expect(ok(['a.png', '--to', 'txt', '--ocr', '--ocr-lang', 'deu']).ocrLang).toBe('deu')
    const without = parseArgs(['a.png', '--to', 'txt', '--ocr-lang', 'deu'])
    expect(without.kind).toBe('usage')
    if (without.kind === 'usage') expect(without.message).toMatch(/^--ocr-lang needs --ocr/)
    const unknown = parseArgs(['a.png', '--to', 'txt', '--ocr', '--ocr-lang', 'klingon'])
    expect(unknown.kind).toBe('usage')
    if (unknown.kind === 'usage') expect(unknown.message).toMatch(/^--ocr-lang: klingon is not an OCR language/)
    expect(parseArgs(['a.png', '--to', 'txt', '--ocr', '--ocr-lang']).kind).toBe('usage')
  })

  it('--ocr-lang exits 2 when no input is an image or a PDF', () => {
    expect(checkFlagScope(['--ocr-lang'], 'txt', ['image'])).toBeNull()
    expect(checkFlagScope(['--ocr-lang'], 'txt', ['pdf'])).toBeNull()
    expect(checkFlagScope(['--ocr-lang'], 'txt', ['md'])).toMatch(/^--ocr-lang applies only to image, pdf input/)
  })

  it('--settings takes a path or app', () => {
    expect(ok(['a.md', '--to', 'pdf', '--settings', 'app']).settings).toBe('app')
    expect(ok(['a.md', '--to', 'pdf', '--settings', 'my.json']).settings).toBe('my.json')
    expect(ok(['a.md', '--to', 'pdf']).settings).toBeUndefined()
    expect(parseArgs(['a.md', '--to', 'pdf', '--settings']).kind).toBe('usage')
  })

  it("lets Chromium's --user-data-dir=<dir> through, the profile --settings app reads from", () => {
    const req = ok(['a.md', '--to', 'pdf', '--user-data-dir=/tmp/profile'])
    expect(req.inputs).toEqual(['a.md'])
  })

  it('are all strict, and listed in the usage', () => {
    for (const flag of [
      '--pictures', '--fetch', '--no-fetch', '--local-network', '--no-local-network', '--code-color', '--no-code-color',
      '--no-header-footer', '--ocr-lang',
    ]) {
      expect(FLAG_SCOPES.find((s) => s.flag === flag)?.strict, flag).toBe(true)
    }
    for (const text of [
      '--pictures <auto|jpg|png>', '[--fetch]', '[--no-fetch]', '[--local-network]', '[--no-local-network]', '[--code-color]',
      '[--no-code-color]', '[--no-header-footer]', '--ocr-lang <code>', '--settings <file|app>',
    ]) {
      expect(USAGE, text).toContain(text)
    }
    for (const old of ['colour', 'coloured']) {
      expect(USAGE, old).not.toContain(old)
    }
  })
})
