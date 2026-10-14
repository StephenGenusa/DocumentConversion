import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectNotices, declaredLicense, isAllowed, holderOf } from '../../scripts/notices/lib.mjs'

describe('licence expressions', () => {
  it('allows what the allowlist names, and nothing else', () => {
    expect(isAllowed('MIT')).toBe(true)
    expect(isAllowed('GPL-3.0-only')).toBe(false)
    expect(isAllowed('UNKNOWN')).toBe(false)
    expect(isAllowed(null)).toBe(false)
    expect(isAllowed('')).toBe(false)
  })

  it('takes the permitted side of OR and needs both sides of AND', () => {
    expect(isAllowed('(MIT OR GPL-3.0-or-later)')).toBe(true)
    expect(isAllowed('(MIT AND Zlib)')).toBe(true)
    expect(isAllowed('MIT AND GPL-2.0-only')).toBe(false)
    expect(isAllowed('(GPL-2.0-only OR LGPL-2.1-only)')).toBe(false)
    expect(isAllowed('Apache-2.0 WITH LLVM-exception')).toBe(true)
  })

  it('treats malformed expressions as not allowed', () => {
    expect(isAllowed('(MIT')).toBe(false)
    expect(isAllowed('MIT OR')).toBe(false)
    expect(isAllowed('MIT MIT')).toBe(false)
  })

  it('reads the old object and array forms', () => {
    expect(declaredLicense({ license: 'ISC' })).toBe('ISC')
    expect(declaredLicense({ license: { type: 'MIT', url: 'x' } })).toBe('MIT')
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
    expect(declaredLicense({})).toBe(null)
  })

  it('names the holder without contact details', () => {
    expect(holderOf({ name: 'p', author: 'Jane Doe <jane@example.com> (https://example.com)' })).toBe('Jane Doe')
    expect(holderOf({ name: 'p', author: { name: 'Jane Doe' } })).toBe('Jane Doe')
    expect(holderOf({ name: 'p' })).toBe('the p authors')
  })
})

describe('collecting notices', () => {
  let root: string
  const pkg = (name: string, json: object, files: Record<string, string> = {}): void => {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...json }))
    for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t)
  }
  const lockOf = (...names: string[]) => ({
    packages: Object.fromEntries([['', {}], ...names.map((n) => [`node_modules/${n}`, n.startsWith('dev-') ? { dev: true } : {}])]),
  })
  const templates = { MIT: 'MIT License\n\nCopyright (c) {{holder}}\n' }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'notices-'))
    pkg('good', { license: 'MIT' }, { LICENSE: 'Copyright good' })
    pkg('textless', { license: 'MIT', author: 'Ann Author' })
    pkg('gpl', { license: 'GPL-3.0-only' }, { LICENSE: 'GPL text' })
    pkg('weird', { license: 'BSD' }, { LICENSE: 'BSD 2-clause text' })
    pkg('isc-textless', { license: 'Apache-2.0' })
    pkg('dev-only', { license: 'GPL-3.0-only' })
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('keeps shipped packages, skips dev ones and missing optional ones', () => {
    const { entries } = collectNotices({ root, lock: lockOf('good', 'dev-only', 'not-installed'), templates })
    expect(entries.map((e) => e.name)).toEqual(['good'])
    expect(entries[0].texts[0].text).toBe('Copyright good')
  })

  it('fills in the standard text, with the author, for a package that ships none', () => {
    const { entries, errors } = collectNotices({ root, lock: lockOf('textless'), templates })
    expect(errors).toEqual([])
    expect(entries[0].texts[0].text).toContain('Copyright (c) Ann Author')
    expect(entries[0].note).toMatch(/standard text/)
  })

  it('fails on a licence off the allowlist', () => {
    const { errors } = collectNotices({ root, lock: lockOf('gpl'), templates })
    expect(errors.join('\n')).toMatch(/gpl@1.0.0: licence "GPL-3.0-only" is not on the allowlist/)
  })

  it('fails when there is no text and no standard text for the licence', () => {
    const { errors } = collectNotices({ root, lock: lockOf('isc-textless'), templates })
    expect(errors.join('\n')).toMatch(/ships no licence text/)
  })

  it('applies an override, and fails on one that matches nothing', () => {
    const fixed = collectNotices({ root, lock: lockOf('weird'), templates, overrides: { weird: { license: 'BSD-2-Clause', note: 'read the file' } } })
    expect(fixed.errors).toEqual([])
    expect(fixed.entries[0].license).toBe('BSD-2-Clause')
    const stale = collectNotices({ root, lock: lockOf('good'), templates, overrides: { gone: { license: 'MIT' } } })
    expect(stale.errors.join('\n')).toMatch(/override for gone matches no shipped package/)
  })

  it('merges a package that is both installed and bundled, and reports a stale bundle record', () => {
    const both = collectNotices({ root, lock: lockOf('good'), templates, bundled: [{ id: 'good@1.0.0', dir: join(root, 'node_modules/good') }] })
    expect(both.entries).toHaveLength(1)
    expect(both.entries[0].from).toEqual(['node_modules', 'bundled'])
    const stale = collectNotices({ root, lock: lockOf(), templates, bundled: [{ id: 'gone@1.0.0', dir: join(root, 'node_modules/gone') }] })
    expect(stale.errors.join('\n')).toMatch(/recorded as bundled/)
  })
})

/**
 * The real tree: every package this checkout would ship passes the policy.
 * A new dependency with an unlisted licence fails here, in `npm test`, and not
 * first at release time.
 */
describe('this project', () => {
  it('ships nothing the notices policy rejects', () => {
    const templates: Record<string, string> = {}
    for (const f of readdirSync('scripts/notices/templates')) {
      templates[f.replace(/\.txt$/, '')] = readFileSync(join('scripts/notices/templates', f), 'utf8')
    }
    const { errors, entries } = collectNotices({
      root: process.cwd(),
      lock: JSON.parse(readFileSync('package-lock.json', 'utf8')),
      vendored: JSON.parse(readFileSync('scripts/notices/vendored.json', 'utf8')).components,
      overrides: JSON.parse(readFileSync('scripts/notices/overrides.json', 'utf8')).packages,
      templates,
    })
    expect(errors).toEqual([])
    expect(entries.length).toBeGreaterThan(300)
  })
})
