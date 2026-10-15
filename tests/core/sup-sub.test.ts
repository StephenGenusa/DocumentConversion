import { describe, it, expect } from 'vitest'
import HTMLtoDOCX from 'html-to-docx'
import { sanitizeToHub } from '../../src/core/allowlist'
import { readRtf } from '../../src/core/readers/rtf'
import { readDocx } from '../../src/core/readers/docx'
import { readAsciidoc } from '../../src/core/readers/asciidoc'
import { readHtml } from '../../src/core/readers/html'
import { readMarkdown } from '../../src/core/readers/md'
import { writeMarkdown } from '../../src/core/writers/md'

const bytes = (s: string) => ({ bytes: Buffer.from(s, 'utf8') })

/**
 * Superscript and subscript are content: x² is not x2 and H₂O is not H2O, and
 * a footnote reference run into its word ("claim1") reads as a typo. The hub
 * did not allow either tag, so every sanitising reader kept the text and
 * dropped the meaning.
 */
describe('superscript and subscript', () => {
  it('pass the hub sanitizer, without attributes', () => {
    expect(sanitizeToHub('<p>x<sup>2</sup> H<sub>2</sub>O</p>')).toBe('<p>x<sup>2</sup> H<sub>2</sub>O</p>')
    expect(sanitizeToHub('<p>x<sup onclick="evil()" style="color:red" class="c">2</sup></p>')).toBe('<p>x<sup>2</sup></p>')
  })

  it('survive a Word document', async () => {
    const docx = Buffer.from(await HTMLtoDOCX('<p>x<sup>2</sup> H<sub>2</sub>O</p>'))
    const html = (await readDocx({ bytes: docx, filename: 'f.docx' })).html
    expect(html).toContain('x<sup>2</sup>')
    expect(html).toContain('H<sub>2</sub>O')
  })

  it('survive AsciiDoc ^sup^ and ~sub~', async () => {
    const html = (await readAsciidoc({ ...bytes('E = mc^2^ and H~2~O\n'), filename: 'a.adoc' })).html
    expect(html).toContain('mc<sup>2</sup>')
    expect(html).toContain('H<sub>2</sub>O')
  })

  it('survive HTML and inline HTML in Markdown', async () => {
    expect((await readHtml({ ...bytes('<p>x<sup>2</sup> H<sub>2</sub>O</p>'), filename: 'a.html' })).html).toContain('H<sub>2</sub>O')
    expect((await readMarkdown(bytes('x<sup>2</sup> H<sub>2</sub>O\n'))).html).toContain('x<sup>2</sup> H<sub>2</sub>O')
  })

  it('are written to Markdown as inline HTML, which GitHub renders', async () => {
    const md = (await writeMarkdown({ html: '<p>x<sup>2</sup> H<sub>2</sub>O</p>' })).toString('utf8')
    expect(md.trim()).toBe('x<sup>2</sup> H<sub>2</sub>O')
  })

  describe('in RTF', () => {
    it('reads \\super and \\sub in body text, and does not turn \\sub into superscript', async () => {
      const html = (await readRtf(bytes('{\\rtf1\\ansi x{\\super 2} and H{\\sub 2}O\\par}'))).html
      expect(html).toContain('x<sup>2</sup>')
      expect(html).toContain('H<sub>2</sub>O')
      expect(html).not.toContain('H<sup>2</sup>')
    })

    it('reads a paragraph that is subscript throughout', async () => {
      const html = (await readRtf(bytes('{\\rtf1\\ansi {\\sub low}\\par}'))).html
      expect(html).toContain('<sub>low</sub>')
      expect(html).not.toContain('<sup>')
    })

    it('ends superscript at \\nosupersub and \\plain', async () => {
      const html = (await readRtf(bytes('{\\rtf1\\ansi a{\\super b\\nosupersub c}d\\par}'))).html
      expect(html).toContain('a<sup>b</sup>cd')
    })

    it('reads \\super and \\sub inside a table cell', async () => {
      const rtf =
        '{\\rtf1\\ansi\\trowd\\cellx2000\\cellx4000 x{\\super 2}\\cell H{\\sub 2}O\\cell\\row}'
      const html = (await readRtf(bytes(rtf))).html
      expect(html).toContain('x<sup>2</sup>')
      expect(html).toContain('H<sub>2</sub>O')
    })

    // \upN / \dnN raise or lower by N half-points: the older, positional way
    // of writing the same thing, still produced by some exporters.
    it('reads \\up and \\dn as superscript and subscript', async () => {
      const html = (await readRtf(bytes('{\\rtf1 E = mc{\\up6 2}, H{\\dn4 2}O}'))).html
      expect(html).toContain('mc<sup>2</sup>')
      expect(html).toContain('H<sub>2</sub>O')
      expect(html).not.toContain('H<sup>2</sup>')
    })

    it('ends them at \\up0 and \\dn0', async () => {
      const html = (await readRtf(bytes('{\\rtf1\\ansi a{\\up6 b\\up0 c}d e{\\dn6 f\\dn0 g}h\\par}'))).html
      expect(html).toContain('a<sup>b</sup>cd')
      expect(html).toContain('e<sub>f</sub>gh')
    })

    it('reads \\up and \\dn inside a table cell', async () => {
      const rtf = '{\\rtf1\\ansi\\trowd\\cellx2000\\cellx4000 x{\\up6 2}y\\up0\\cell H{\\dn4 2}O\\cell\\row}'
      const html = (await readRtf(bytes(rtf))).html
      expect(html).toContain('x<sup>2</sup>y')
      expect(html).toContain('H<sub>2</sub>O')
    })
  })
})
