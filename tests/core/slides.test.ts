import { describe, it, expect } from 'vitest'
import { splitSlides } from '../../src/core/slides'

const bodies = (html: string, opts?: Parameters<typeof splitSlides>[1]): string[] =>
  splitSlides(html, opts).map((s) => s.html)

/**
 * The split rule is the whole feature; the writer is a shell around it. The
 * assertion that matters most is content preservation - every element of the
 * input appears in exactly one slide - because silently dropping a section is
 * the failure mode section 0 of remaining_work.md treats as worst.
 */
describe('splitSlides', () => {
  it('splits on an explicit rule', () => {
    expect(bodies('<p>a</p><hr><p>b</p>')).toEqual(['<p>a</p>', '<p>b</p>'])
  })

  it('prefers a rule over headings when both are present', () => {
    expect(bodies('<h1>A</h1><p>1</p><hr><h1>B</h1><p>2</p>')).toEqual([
      '<h1>A</h1><p>1</p>',
      '<h1>B</h1><p>2</p>',
    ])
  })

  it('falls back to h1 when there is no rule', () => {
    expect(bodies('<h1>A</h1><p>1</p><h1>B</h1><p>2</p>')).toEqual([
      '<h1>A</h1><p>1</p>',
      '<h1>B</h1><p>2</p>',
    ])
  })

  it('splits on h2 when asked', () => {
    expect(bodies('<h2>A</h2><p>1</p><h2>B</h2><p>2</p>', { splitOn: 'h2' })).toEqual([
      '<h2>A</h2><p>1</p>',
      '<h2>B</h2><p>2</p>',
    ])
  })

  it('keeps a document with no separator as one slide', () => {
    expect(bodies('<p>only</p>')).toEqual(['<p>only</p>'])
  })

  it('is empty for an empty document rather than emitting a blank slide', () => {
    expect(splitSlides('')).toEqual([])
    expect(splitSlides('   \n  ')).toEqual([])
  })

  it('does not emit an empty slide for a leading rule', () => {
    expect(bodies('<hr><p>a</p>')).toEqual(['<p>a</p>'])
  })

  it('does not emit an empty slide for consecutive rules', () => {
    expect(bodies('<p>a</p><hr><hr><p>b</p>')).toEqual(['<p>a</p>', '<p>b</p>'])
  })

  it('does not emit an empty slide for a trailing rule', () => {
    expect(bodies('<p>a</p><hr>')).toEqual(['<p>a</p>'])
  })

  it('keeps content that precedes the first heading', () => {
    // A preamble before <h1> must not vanish - it is the title slide.
    expect(bodies('<p>intro</p><h1>A</h1><p>1</p>')).toEqual(['<p>intro</p>', '<h1>A</h1><p>1</p>'])
  })

  it('loses nothing: every element lands in exactly one slide', () => {
    const html = '<h1>A</h1><p>1</p><table><tbody><tr><td>c</td></tr></tbody></table><hr><h1>B</h1><ul><li>i</li></ul>'
    const joined = bodies(html).join('')
    for (const fragment of ['<h1>A</h1>', '<p>1</p>', '<table>', '<td>c</td>', '<h1>B</h1>', '<li>i</li>']) {
      expect(joined).toContain(fragment)
    }
    expect(joined.match(/<td>c<\/td>/g)).toHaveLength(1)
  })

  it('carries speaker notes onto their slide, and out of the body', () => {
    const slides = splitSlides('<p>a</p><aside><p>note one</p></aside><hr><p>b</p>')
    expect(slides).toHaveLength(2)
    expect(slides[0].notes).toEqual(['<p>note one</p>'])
    expect(slides[0].html).toBe('<p>a</p>')
    expect(slides[1].notes).toEqual([])
  })

  it('keeps several notes on one slide separate', () => {
    const [slide] = splitSlides('<p>a</p><aside><p>one</p></aside><aside><p>two</p></aside>')
    expect(slide.notes).toEqual(['<p>one</p>', '<p>two</p>'])
  })

  it('does not treat a note as content when deciding a slide is empty', () => {
    // A slide that is nothing but a note has no body worth showing.
    expect(splitSlides('<aside><p>orphan</p></aside>')).toEqual([])
  })
})
