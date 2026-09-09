import { describe, it, expect } from 'vitest'
import { writeRevealJs } from '../../src/core/writers/revealjs'

const deck = async (html: string, opts?: Parameters<typeof writeRevealJs>[1]): Promise<string> =>
  (await writeRevealJs({ html, title: 'Deck' }, opts)).toString('utf8')

describe('the reveal.js writer', () => {
  it('produces one section per slide', async () => {
    const html = await deck('<h1>A</h1><p>1</p><hr><h1>B</h1><p>2</p>')
    expect(html.match(/<section>/g)).toHaveLength(2)
    expect(html).toContain('<h1>A</h1>')
    expect(html).toContain('<h1>B</h1>')
  })

  it('is self-contained: no network reference of any kind', async () => {
    const html = await deck('<p>a</p>')
    // Scan the MARKUP only. The inlined engine is minified JS full of its own
    // string literals, and matching those would fail on reveal's source rather
    // than on anything this writer emitted.
    const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '')
    // Any src/href that is not a data: URI is a file this deck cannot open
    // without the network - the one failure that shows up on stage.
    const refs = [...markup.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1])
    expect(refs.filter((r) => !r.startsWith('data:') && !r.startsWith('#'))).toEqual([])
    expect(markup).not.toMatch(/https?:\/\//)
  })

  it('inlines the engine rather than linking it', async () => {
    const html = await deck('<p>a</p>')
    expect(html).toContain('Reveal.initialize')
    expect(html.length).toBeGreaterThan(150_000)
  })

  it('puts speaker notes where reveal expects them', async () => {
    const html = await deck('<p>a</p><aside><p>say this</p></aside>')
    expect(html).toContain('<aside class="notes"><p>say this</p></aside>')
  })

  it('honours an explicit split rule', async () => {
    const html = await deck('<h2>A</h2><p>1</p><h2>B</h2><p>2</p>', { slides: { splitOn: 'h2' } })
    expect(html.match(/<section>/g)).toHaveLength(2)
  })

  it('emits a valid document rather than an empty one for empty input', async () => {
    const html = await deck('')
    expect(html).toContain('<section>')
    expect(html).toContain('no content')
  })

  it('escapes the title rather than trusting it', async () => {
    const out = (await writeRevealJs({ html: '<p>a</p>', title: '<script>x</script>' })).toString('utf8')
    expect(out).not.toContain('<title><script>')
    expect(out).toContain('&lt;script&gt;')
  })
})
