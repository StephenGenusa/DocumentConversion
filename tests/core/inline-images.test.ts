import { describe, it, expect, vi } from 'vitest'
import { inlineImages, type ImageFetcher } from '../../src/core/inline-images'

const PNG = Buffer.from('89504e47', 'hex')

function fetcher(sizes: Record<string, number>): ImageFetcher {
  return vi.fn(async (url: string) => {
    const size = sizes[url]
    if (size == null) throw new Error('404')
    return { bytes: Buffer.alloc(size, 1), contentType: 'image/png' }
  })
}

describe('inlineImages', () => {
  it('inlines images as data URIs, resolving relative URLs', async () => {
    const html = '<p>x</p><img src="/img/a.png" alt="a">'
    const out = await inlineImages(html, 'https://example.com/docs/page', fetcher({ 'https://example.com/img/a.png': 10 }))
    expect(out).toContain('src="data:image/png;base64,')
    expect(out).not.toContain('/img/a.png')
  })

  it('leaves data: images untouched', async () => {
    const html = `<img src="data:image/png;base64,${PNG.toString('base64')}">`
    const f = fetcher({})
    const out = await inlineImages(html, 'https://example.com/', f)
    expect(out).toBe(html)
    expect(f).not.toHaveBeenCalled()
  })

  it('replaces failed fetches with an alt placeholder', async () => {
    const html = '<img src="https://example.com/missing.png" alt="lost diagram">'
    const out = await inlineImages(html, 'https://example.com/', fetcher({}))
    expect(out).not.toContain('<img')
    expect(out).toContain('[image: lost diagram]')
  })

  it('evicts the largest images to placeholders when over the total budget', async () => {
    const html =
      '<img src="https://e.com/small.png" alt="small"><img src="https://e.com/big.png" alt="big">'
    const out = await inlineImages(html, 'https://e.com/', fetcher({ 'https://e.com/small.png': 100, 'https://e.com/big.png': 900 }), {
      maxImages: 20,
      maxPerImage: 2000,
      maxTotal: 500,
    })
    expect(out).toContain('data:image/png;base64,') // small survives
    expect(out).toContain('[image: big]') // big evicted
  })

  it('fetches at most maxImages', async () => {
    const html = '<img src="https://e.com/1.png"><img src="https://e.com/2.png"><img src="https://e.com/3.png">'
    const f = fetcher({ 'https://e.com/1.png': 5, 'https://e.com/2.png': 5, 'https://e.com/3.png': 5 })
    await inlineImages(html, 'https://e.com/', f, { maxImages: 2, maxPerImage: 100, maxTotal: 100 })
    expect(f).toHaveBeenCalledTimes(2)
  })

  /* ---- the data URI must land in src and nowhere else ------------------- */

  it('writes the data URI into src, not into an earlier attribute that shares its value', async () => {
    const html = '<img alt="logo.png" src="logo.png">'
    const out = await inlineImages(html, 'https://e.com/', fetcher({ 'https://e.com/logo.png': 10 }))
    expect(out).toContain('alt="logo.png"')
    expect(out).toMatch(/src="data:image\/png;base64,/)
    // The remote reference must be gone: a page the app called self-contained
    // may not still be fetching from the network.
    expect(out).not.toContain('src="logo.png"')
  })

  it('reads src, not data-src, when deciding what to fetch', async () => {
    const html = '<img data-src="https://e.com/tracker.gif" src="https://e.com/real.png">'
    const f = fetcher({ 'https://e.com/real.png': 10, 'https://e.com/tracker.gif': 10 })
    const out = await inlineImages(html, 'https://e.com/', f)
    expect(f).toHaveBeenCalledTimes(1)
    expect(f).toHaveBeenCalledWith('https://e.com/real.png')
    expect(out).toMatch(/\ssrc="data:image\/png;base64,/)
  })

  it('replaces the src of a tag whose src value is a prefix of the tag itself', async () => {
    // "a.png" also occurs inside the title attribute, before src.
    const html = '<img title="see a.png" src="a.png">'
    const out = await inlineImages(html, 'https://e.com/', fetcher({ 'https://e.com/a.png': 10 }))
    expect(out).toContain('title="see a.png"')
    expect(out).toMatch(/src="data:image\/png;base64,/)
  })

  it('handles a single-quoted src', async () => {
    const html = "<img src='https://e.com/a.png' alt='a'>"
    const out = await inlineImages(html, 'https://e.com/', fetcher({ 'https://e.com/a.png': 10 }))
    expect(out).toMatch(/src="data:image\/png;base64,/)
    expect(out).not.toContain('https://e.com/a.png')
  })

  it('handles an unquoted src', async () => {
    const html = '<img src=https://e.com/a.png>'
    const out = await inlineImages(html, 'https://e.com/', fetcher({ 'https://e.com/a.png': 10 }))
    expect(out).toMatch(/src="data:image\/png;base64,/)
  })

  /* ---- the tag scan has to be quote-aware ------------------------------- */

  it('does not end the tag at a ">" inside an attribute value', async () => {
    const html = '<p>before</p><img alt="a > b" src="https://e.com/a.png"><p>after</p>'
    const out = await inlineImages(html, 'https://e.com/', fetcher({ 'https://e.com/a.png': 10 }))
    expect(out).toMatch(/src="data:image\/png;base64,/)
    expect(out).toContain('alt="a > b"')
    expect(out).not.toContain('https://e.com/a.png')
    expect(out.startsWith('<p>before</p><img ')).toBe(true)
    expect(out.endsWith('><p>after</p>')).toBe(true)
  })

  it('replaces the whole tag with the placeholder when the alt contains ">"', async () => {
    const html = '<img alt="a > b" src="https://e.com/missing.png">'
    const out = await inlineImages(html, 'https://e.com/', fetcher({}))
    expect(out).not.toContain('<img')
    expect(out).not.toContain('src=')
    expect(out).toContain('[image: a > b]')
  })
})

/* ---- follow-ups from the diff review ---------------------------------- */

describe('inlineImages: attribute parsing edge cases', () => {
  it('reads src as an attribute, not as text inside another attribute value', async () => {
    // The lookbehind fixed `data-src`; a `src=` INSIDE an alt still matched,
    // fetched the wrong file, and wrote the data URI into the alt.
    const html = '<img alt="see src=evil.png here" src="real.png">'
    const f = fetcher({ 'https://e.com/real.png': 10, 'https://e.com/evil.png': 10 })
    const out = await inlineImages(html, 'https://e.com/', f)
    expect(f).toHaveBeenCalledTimes(1)
    expect(f).toHaveBeenCalledWith('https://e.com/real.png')
    expect(out).toContain('alt="see src=evil.png here"')
    expect(out).toMatch(/ src="data:image\/png;base64,/)
  })

  it('does not let an unbalanced quote in one tag swallow the paragraphs after it', async () => {
    const html = '<img alt="unterminated src="real.png"><p>para one</p><p>quote " here</p>'
    const out = await inlineImages(html, 'https://e.com/', fetcher({}))
    expect(out).toContain('<p>para one</p>')
    expect(out).toContain('<p>quote " here</p>')
  })

  it('does not write an unvalidated Content-Type into the attribute', async () => {
    const f: ImageFetcher = vi.fn(async () => ({
      bytes: PNG,
      contentType: 'image/png"onerror="alert(1)',
    }))
    const out = await inlineImages('<img src="a.png">', 'https://e.com/', f)
    expect(out).not.toContain('onerror')
    expect(out).toContain('src="data:image/png;base64,')
  })

  it('escapes alt text before it becomes placeholder markup', async () => {
    const html = '<img src="https://e.com/missing.png" alt="&lt;b&gt;bold&lt;/b&gt; &amp; co">'
    const out = await inlineImages(html, 'https://e.com/', fetcher({}))
    expect(out).not.toContain('<b>')
    expect(out).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; co')
  })
})
