import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { extractArticle, loadUrl } from '../../src/core/readers/url'
import type { GuardedFetchDeps } from '../../src/core/net/guarded-fetch'

const fixture = (name: string): string => readFileSync(join(__dirname, '../fixtures', name), 'utf8')

const article = fixture('article.html')
const specTable = fixture('spec-table.html')
const layoutTable = fixture('layout-table.html')

/** What Readability alone produces — the baseline our non-table pages must still match byte for byte. */
function rawReadability(html: string): string {
  const { document } = parseHTML(html)
  return new Readability(document as unknown as Document, { charThreshold: 250 }).parse()?.content ?? ''
}

describe('extractArticle', () => {
  it('extracts the article body and drops nav/sidebar/footer', () => {
    const res = extractArticle(article, 'https://vendor.example.com/docs/framing')
    expect(res.html).toContain('self-describing frame header')
    expect(res.html).toContain('credit scheme')
    expect(res.html).not.toContain('Pricing')
    expect(res.html).not.toContain('© 2026 Vendor Inc.')
  })

  it('uses the page title', () => {
    const res = extractArticle(article, 'https://vendor.example.com/docs/framing')
    expect(res.title).toContain('Framing Protocol v2')
  })

  it('falls back to the raw body when extraction finds nothing', () => {
    const tiny = '<html><head><title>t</title></head><body><p>just one line</p></body></html>'
    const res = extractArticle(tiny, 'https://example.com/')
    expect(res.html).toContain('just one line')
  })
})

describe('extractArticle table rescue', () => {
  // The defect: a spec page whose payload is a low-density reference table (short
  // cells, no prose) scores badly, so Readability keeps the surrounding prose and
  // silently drops the table. See tests/fixtures/spec-table.html.
  it('keeps a low-density reference table Readability drops', () => {
    const res = extractArticle(specTable, 'https://vendor.example.com/docs/mx7')
    expect(res.html).toContain('<table')
    expect(res.html).toContain('IRQ_FLAGS')
    expect(res.html).toContain('CHIP_ID')
    // Every data row, not just the head.
    expect((res.html.match(/<tr/gi) ?? []).length).toBe(25)
  })

  it('re-attaches the table in document order, not at the end', () => {
    const res = extractArticle(specTable, 'https://vendor.example.com/docs/mx7')
    const afterProse = res.html.indexOf('Access modes are given as RW')
    const table = res.html.indexOf('<table')
    const nextSection = res.html.indexOf('Reserved ranges')
    expect(afterProse).toBeGreaterThan(-1)
    expect(nextSection).toBeGreaterThan(-1)
    expect(table).toBeGreaterThan(afterProse)
    expect(table).toBeLessThan(nextSection)
  })

  it('keeps several dropped tables in source order', () => {
    const grid = (tag: string): string =>
      `<table><thead><tr><th>Field</th><th>Bits</th><th>Meaning</th></tr></thead><tbody>${Array.from(
        { length: 8 },
        (_, i) => `<tr><td>${tag}_${i}</td><td>${i}:${i}</td><td>flag</td></tr>`,
      ).join('')}</tbody></table>`
    const prose = (word: string): string =>
      `<p>${`The ${word} register controls one half of the link and is described by the grid that follows it here. `.repeat(3)}</p>`
    const page = `<html><head><title>t</title></head><body><main>
      <div class="content"><h1>Link registers</h1>${prose('first')}${prose('second')}</div>
      <div class="grid">${grid('ALPHA')}</div>
      <div class="content">${prose('third')}${prose('fourth')}</div>
      <div class="grid">${grid('OMEGA')}</div>
      </main></body></html>`
    const res = extractArticle(page, 'https://example.com/link')
    expect(res.html).toContain('ALPHA_3')
    expect(res.html).toContain('OMEGA_3')
    expect(res.html.indexOf('ALPHA_3')).toBeLessThan(res.html.indexOf('OMEGA_3'))
    expect(res.html.indexOf('ALPHA_3')).toBeLessThan(res.html.indexOf('The third register'))
  })

  it('tolerates a full-width spanning row inside a data table', () => {
    const rows = Array.from(
      { length: 10 },
      (_, i) => `<tr><td>0x${i}0</td><td>FLD_${i}</td><td>RW</td></tr>`,
    ).join('')
    const page = `<html><head><title>t</title></head><body><main><div class="content"><h1>Fields</h1>
      <p>${'Each field below occupies one word of the configuration block and resets to zero. '.repeat(4)}</p>
      <p>${'The reserved band at the end of the table must be written as zero by every driver. '.repeat(4)}</p>
      </div><div class="grid"><table><thead><tr><th>Offset</th><th>Name</th><th>Access</th></tr></thead>
      <tbody>${rows}<tr><td colspan="3">Reserved — do not probe</td></tr></tbody></table></div></main></body></html>`
    const res = extractArticle(page, 'https://example.com/fields')
    expect(res.html).toContain('FLD_9')
    expect(res.html).toContain('Reserved — do not probe')
  })

  it('appends a dropped table when no anchoring prose precedes it', () => {
    const rows = Array.from(
      { length: 10 },
      (_, i) => `<tr><td>${i}</td><td>CODE_${i}</td><td>retry</td></tr>`,
    ).join('')
    const page = `<html><head><title>t</title></head><body>
      <nav><ul><li><a href="/">Home</a></li></ul></nav>
      <main><div class="grid"><table><thead><tr><th>Id</th><th>Code</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="content"><h1>Status codes</h1>
      <p>${'The table above lists every status code the daemon can return to a client. '.repeat(4)}</p>
      <p>${'Codes marked retry are safe to repeat once the caller has backed off a little. '.repeat(4)}</p>
      </div></main></body></html>`
    const res = extractArticle(page, 'https://example.com/codes')
    expect(res.html).toContain('CODE_7')
  })

  it('does not duplicate a table Readability already kept', () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `<tr><td>0x${(i * 4).toString(16)}</td><td>REG_${i}</td><td>RW</td></tr>`,
    ).join('')
    const page = `<html><head><title>t</title></head><body><main><article><h1>Regs</h1>
      <p>${'The controller exposes a bank of memory mapped registers documented below. '.repeat(4)}</p>
      <p>${'Reserved bits read as zero and must be written as zero on every access. '.repeat(4)}</p>
      <table><thead><tr><th>Offset</th><th>Name</th><th>Access</th></tr></thead><tbody>${rows}</tbody></table>
      </article></main></body></html>`
    const res = extractArticle(page, 'https://example.com/regs')
    expect((res.html.match(/<table/gi) ?? []).length).toBe(1)
    expect((res.html.match(/REG_7/g) ?? []).length).toBe(1)
  })
})

describe('extractArticle layout-table negatives', () => {
  // Pre-CSS pages use <table> for the page frame. Those must never be rescued:
  // a single-row nav strip, a two-column page shell, a nested sidebar table.
  it('does not drag in nav or layout tables', () => {
    const res = extractArticle(layoutTable, 'https://old.example.com/notes/shelf-runs')
    expect(res.html).toContain('turning circle the trolley needs')
    expect(res.html).not.toContain('<table')
    expect(res.html).not.toContain('Guestbook')
    expect(res.html).not.toContain('Last updated 2003')
  })

  it('ignores a ragged single-column list-of-links table', () => {
    const links = Array.from(
      { length: 14 },
      (_, i) => `<tr><td><a href="/p/${i}">Product page number ${i}</a></td></tr>`,
    ).join('')
    const page = `<html><head><title>t</title></head><body><main><div class="content"><h1>Guide</h1>
      <p>${'This guide explains how the shipping tiers are calculated for each destination. '.repeat(5)}</p>
      <p>${'Rates change quarterly and the table of destinations lives on a separate page. '.repeat(5)}</p>
      </div><div class="rail"><table>${links}</table></div></main></body></html>`
    const res = extractArticle(page, 'https://example.com/guide')
    expect(res.html).not.toContain('<table')
    expect(res.html).not.toContain('Product page number 3')
  })

  it('leaves an ordinary article page byte-identical to plain Readability', () => {
    expect(extractArticle(article, 'https://vendor.example.com/docs/framing').html).toBe(rawReadability(article))
    expect(extractArticle(layoutTable, 'https://old.example.com/notes').html).toBe(rawReadability(layoutTable))
  })
})

describe('loadUrl with a rescued table', () => {
  function deps(body: string): GuardedFetchDeps {
    return {
      fetch: vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })),
      lookup: vi.fn(async () => ['93.184.216.34']),
    }
  }

  it('sanitizes the rescued table like everything else', async () => {
    const hostile = specTable.replace(
      '<tr><td>0x0000</td><td>CTRL</td>',
      '<tr><td onclick="steal()">0x0000<script>steal()</script></td><td>CTRL</td>',
    )
    const res = await loadUrl('https://vendor.example.com/docs/mx7', deps(hostile))
    expect(res.kind).toBe('html')
    if (res.kind !== 'html') return
    expect(res.html).toContain('CHIP_ID')
    expect(res.html).not.toContain('<script')
    expect(res.html).not.toContain('onclick')
    expect(res.html).not.toContain('steal()')
  })
})

/**
 * Readability leaves an href exactly as the page wrote it, so a root-relative
 * or dot-relative link arrived in the hub still relative. Rendered, it resolves
 * against wherever the OUTPUT sits — the converter's own temporary directory —
 * which is the same defect that made an epub's cross-references point into temp
 * files. Here, unlike the epub case, the base URL is known, so the links can be
 * repaired rather than dropped.
 */
describe('extractArticle link resolution', () => {
  const page = (links: string): string =>
    `<html><head><title>Spec</title></head><body><article><h1>Framing</h1>` +
    `<p>${'Body prose long enough to clear the character threshold. '.repeat(12)}</p>` +
    `<p>${links}</p></article></body></html>`

  const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])

  it('resolves root-relative and dot-relative links against the page URL', () => {
    const res = extractArticle(
      page('<a href="/spec/part2">two</a> <a href="../rel/x">rel</a> <a href="plain">plain</a>'),
      'https://vendor.example.com/docs/framing',
    )
    expect(hrefs(res.html)).toEqual([
      'https://vendor.example.com/spec/part2',
      'https://vendor.example.com/rel/x',
      'https://vendor.example.com/docs/plain',
    ])
  })

  it('leaves absolute, mailto and in-page links alone', () => {
    const res = extractArticle(
      page('<a href="https://other.example.org/a">abs</a> <a href="mailto:x@y.z">mail</a> <a href="#top">top</a>'),
      'https://vendor.example.com/docs/framing',
    )
    expect(hrefs(res.html)).toEqual(['https://other.example.org/a', 'mailto:x@y.z', '#top'])
  })

  it('drops a relative link when the page URL is unusable rather than inventing one', () => {
    const res = extractArticle(page('<a href="/spec/part2">two</a>'), 'not a url')
    expect(hrefs(res.html)).toEqual([])
    expect(res.html).toContain('two')
  })
})
