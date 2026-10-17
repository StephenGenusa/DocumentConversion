import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { renderDocumentShell } from '../../src/core/shell'
import { writeEpub } from '../../src/core/writers/epub'
import { codeCss, writeRevealJs } from '../../src/core/writers/revealjs'
import { contrastRatio, relativeLuminance } from '../../src/core/css-color'

/**
 * Every color a code palette gives a token must read on the ground it is drawn
 * on: WCAG AA for body text, 4.5:1, worked out from relative luminance as
 * WCAG 2.x defines it (css-color.ts). The colors are read from what each
 * writer ships, not from the tables they come from, so a rule that moves or
 * an override that is added is checked too.
 */
const AA = 4.5

const CODE =
  '<pre><code class="language-python">import os\n@cache\nclass Box(Base):\n    """Holds things."""\n    def area(self, w: int) -&gt; float:\n        # width by height\n        return w * 2.5 + len("cm") if True else None</code></pre>' +
  '<pre><code class="language-diff">--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old line\n+new line</code></pre>' +
  '<pre><code class="language-xml">&lt;item id="a"&gt;&lt;!-- note --&gt;text&lt;/item&gt;</code></pre>' +
  '<pre><code class="language-markdown"># Title\n**bold**</code></pre>'

interface Rule {
  selector: string
  color?: string
  background?: string
}

/** The rules of a stylesheet, at top level and inside an at-rule alike. */
function rules(css: string): Rule[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    color: /(?:^|[;\s])color:\s*([^;]+)/.exec(body)?.[1].trim(),
    background: /background(?:-color)?:\s*([^;]+)/.exec(body)?.[1].trim(),
  }))
}

/** Each token color in these rules (not `inherit`: that is the reader's own text color). */
const tokenColors = (list: Rule[]): string[] =>
  list.filter((r) => r.selector.includes('.hljs-') && r.color && r.color !== 'inherit').map((r) => r.color as string)

/** The lowest ratio of these colors on these grounds, with every failing pair named. */
function check(colors: string[], grounds: string[]): { min: number; failing: string[] } {
  let min = Infinity
  const failing: string[] = []
  for (const fg of colors)
    for (const bg of grounds) {
      const ratio = contrastRatio(fg, bg) as number
      expect(ratio, `${fg} on ${bg}`).toBeTypeOf('number')
      min = Math.min(min, ratio)
      if (ratio < AA) failing.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`)
    }
  return { min, failing }
}

const DARK_MEDIA = '@media (prefers-color-scheme: dark)'

/** The part of a stylesheet under the dark media query, and the rest. */
function splitDark(css: string): { light: string; dark: string } {
  const at = css.indexOf(DARK_MEDIA)
  if (at < 0) return { light: css, dark: '' }
  // The block runs to the brace that closes it.
  let depth = 0
  let end = css.indexOf('{', at)
  for (let i = end; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  return { light: css.slice(0, at) + css.slice(end + 1), dark: css.slice(at, end + 1) }
}

const styleOf = (html: string): string => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')

describe('code palettes meet WCAG AA contrast', () => {
  it('the pdf and html page: light tokens on its code block and on white (Word, the editor)', () => {
    const page = renderDocumentShell({ html: CODE, title: 'Code' }, { target: 'html' })
    const list = rules(styleOf(page))
    const colors = tokenColors(list)
    expect(colors.length).toBeGreaterThanOrEqual(8)
    const pre = list.find((r) => r.selector === 'pre' && r.background)?.background as string
    expect(pre).toBe('#f4f4f5')
    expect(check(colors, ['#ffffff', pre]).failing).toEqual([])
    // A diff's lines are the page's text color on a tinted line.
    const text = list.find((r) => r.selector === 'body' && r.color)?.color as string
    const tints = list.filter((r) => /\.hljs-(addition|deletion)$/.test(r.selector) && r.background).map((r) => r.background as string)
    expect(tints).toHaveLength(2)
    expect(check([text], tints).failing).toEqual([])
  })

  it('the html page stays a light page in a dark browser, so it keeps the light palette', () => {
    // Its colors (and an author's inline ones) are set for a white page; see renderDocumentShell.
    const page = renderDocumentShell({ html: CODE, title: 'Code' }, { target: 'html' })
    expect(styleOf(page)).toContain('color-scheme: light')
    expect(page).not.toContain('prefers-color-scheme')
  })

  describe('epub (and the AZW3 made from it)', () => {
    const stylesheet = async (): Promise<string> => {
      const zip = await JSZip.loadAsync(await writeEpub({ html: `<h1>Code</h1>${CODE}`, title: 'Code' }))
      return (await zip.file('OEBPS/style.css')?.async('string')) ?? ''
    }
    // A reader's day pages: white, and Calibre's sepia (#F6F3E9).
    const DAY = ['#ffffff', '#f6f3e9']
    // Its night pages: black, Calibre's dark (#111) and its sepia dark (#39322B), the lightest.
    const NIGHT = ['#000000', '#111111', '#39322b']

    it('light tokens on a white or sepia page', async () => {
      const { light } = splitDark(await stylesheet())
      const colors = tokenColors(rules(light))
      expect(colors.length).toBeGreaterThanOrEqual(10)
      expect(check(colors, DAY).failing).toEqual([])
    })

    it('dark tokens on a reader night page, with plain names in its own text color', async () => {
      const { dark } = splitDark(await stylesheet())
      expect(dark).not.toBe('')
      const list = rules(dark)
      const colors = tokenColors(list)
      expect(colors.length).toBeGreaterThanOrEqual(9)
      expect(check(colors, NIGHT).failing).toEqual([])
      // Variables go to the reader's own foreground: it chose that for its page.
      expect(list.find((r) => r.selector.includes('.hljs-variable'))?.color).toBe('inherit')
    })
  })

  describe('revealjs', () => {
    /** The ground of the code block and its plain text, and the token colors on it. */
    function block(css: string): { ground: string; text: string; colors: string[]; tints: string[] } {
      const list = rules(css)
      const pre = list.find((r) => r.selector === '.reveal pre code.hljs') as Rule
      return {
        ground: pre.background as string,
        text: pre.color as string,
        colors: tokenColors(list),
        tints: list.filter((r) => /\.hljs-(addition|deletion)$/.test(r.selector) && r.background).map((r) => r.background as string),
      }
    }

    it('the shipped deck (the white `simple` theme) uses the light palette', async () => {
      const deck = (await writeRevealJs({ html: CODE, title: 'Deck' })).toString('utf8')
      const b = block(styleOf(deck).slice(styleOf(deck).indexOf('.reveal pre code.hljs')))
      expect(relativeLuminance(b.ground)).toBeGreaterThan(0.5)
      expect(check([...b.colors, b.text], [b.ground]).failing).toEqual([])
      expect(check([b.text], b.tints).failing).toEqual([])
    })

    // Every reveal.js theme, light and dark: the palette follows its slide.
    const pkg = dirname(dirname(createRequire(import.meta.url).resolve('reveal.js')))
    const themes = join(pkg, 'dist', 'theme')
    for (const file of readdirSync(themes).filter((f) => f.endsWith('.css'))) {
      it(`the ${file.replace('.css', '')} theme gets a palette that reads on its slide`, () => {
        const theme = readFileSync(join(themes, file), 'utf8')
        const slide = /--r-background-color:\s*([^;}]+)/.exec(theme)?.[1].trim() as string
        const b = block(codeCss(theme))
        const darkSlide = (relativeLuminance(slide) as number) < 0.18
        // A dark slide gets a dark block, a light slide a light one.
        expect((relativeLuminance(b.ground) as number) < 0.18, `${slide} -> ${b.ground}`).toBe(darkSlide)
        expect(check([...b.colors, b.text], [b.ground]).failing).toEqual([])
        expect(check([b.text], b.tints).failing).toEqual([])
      })
    }

    it('reads a dark slide from the theme even when its color is short or rgb()', () => {
      expect(relativeLuminance(block(codeCss(':root{--r-background-color:#111}')).ground)).toBeLessThan(0.18)
      expect(relativeLuminance(block(codeCss(':root{--r-background-color: rgb(25, 25, 25)}')).ground)).toBeLessThan(0.18)
      // No color it can read: the light palette, as the white default.
      expect(relativeLuminance(block(codeCss('')).ground)).toBeGreaterThan(0.5)
    })
  })
})
