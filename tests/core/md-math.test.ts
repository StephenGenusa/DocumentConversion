import { describe, it, expect } from 'vitest'
import { readMarkdown } from '../../src/core/readers/md'

const render = async (text: string): Promise<string> =>
  (await readMarkdown({ bytes: Buffer.from(text, 'utf8') })).html

/** Backslash-f, as two characters — NOT the form feed an escape would give. */
const FRAC = '\\' + 'frac'

/**
 * The hub carries TeX as source, byte for byte, in its own tagged form
 * (`<code class="language-math">`, spec B1 and B10 in
 * docs/superpowers/specs/2026-10-14-rendered-blocks-and-markdown-fidelity-design.md).
 * Before that, markdown-it applied its own inline rules to the TeX first, so
 * the source arrived silently altered. Measured across the
 * corpus notebooks, 29 of 387 math spans (7.5%) were damaged:
 *
 *   \left\{  ->  \left{         backslash escaping ate the escape
 *   \\       ->  \              a display-math line break vanished
 *   $e_{i} = y_{i} - \hat{y}_{i}$ ... $p_{i}$
 *                               two _ paired as <em> ACROSS a formula boundary
 *
 * That is corruption of content, not a rendering choice, so the spans are
 * read by an inline rule of their own and kept verbatim. Written back out to
 * Markdown or plain text, they keep their `$` delimiters.
 */
describe('markdown math is passed through unaltered', () => {
  it('keeps its dollar delimiters in Markdown and text output', async () => {
    const { writeMarkdown } = await import('../../src/core/writers/md')
    const { writeTxt } = await import('../../src/core/writers/txt')
    const src = String.raw`Let $\left\{x\right\}$ be the set.` + '\n\n' + String.raw`$$a_{1} \\ b$$`
    const html = await render(src)
    expect((await writeMarkdown({ html })).toString('utf8')).toBe(src)
    const txt = (await writeTxt({ html })).toString('utf8')
    expect(txt).toContain(String.raw`$\left\{x\right\}$`)
    expect(txt).toContain(String.raw`$$a_{1} \\ b$$`)
  })

  it('keeps a backslash escape inside inline math', async () => {
    expect(await render(String.raw`Let $\left\{x\right\}$ be the set.`)).toContain(String.raw`\left\{x\right\}`)
  })

  it('keeps a display-math line break', async () => {
    // Two literal backslashes: TeX's line break, which markdown-it ate.
    const tex = 'a = b ' + '\\\\' + ' c = d'
    expect(await render(`$$${tex}$$`)).toBe(`<pre><code class="language-math">${tex}</code></pre>\n`)
  })

  /** The exact sentence from a time-series forecasting notebook. */
  it('does not pair underscores as emphasis across two formulas', async () => {
    const tex = `p_{i} =${FRAC}{\\displaystyle e_{i}}{\\displaystyle y_{i}}`
    const formula = `$${tex}$`
    const html = await render(
      String.raw`Then $e_{i} = y_{i} - \hat{y}_{i}$ is the *forecast error* and ` +
        formula +
        ' is the *relative forecast error*.',
    )
    // Was: \hat{y}<em>{i}$ is the <em>forecast error</em> and $p</em>{i}
    expect(html).toContain(String.raw`<code class="language-math">e_{i} = y_{i} - \hat{y}_{i}</code>`)
    expect(html).toContain(`<code class="language-math">${tex}</code>`)
    // The prose emphasis between the formulas is real and must survive.
    expect(html).toContain('<em>forecast error</em>')
    expect(html).toContain('<em>relative forecast error</em>')
  })

  it('keeps a subscript that markdown-it would read as emphasis', async () => {
    expect(await render(String.raw`$\theta_{t} + \theta_{s}$`)).toContain(String.raw`\theta_{t} + \theta_{s}`)
  })

  it('escapes html metacharacters inside math rather than emitting them raw', async () => {
    const html = await render(String.raw`$a < b$ and $c & d$`)
    expect(html).toContain('&lt;')
    expect(html).toContain('&amp;')
    expect(html).not.toMatch(/<(?!\/?(p|em|strong|code|a|h[1-6]|ul|ol|li|br)\b)/)
  })

  // ---- the false-positive cases: prose that merely contains dollar signs ----

  it('still renders markdown between two plain dollar amounts', async () => {
    const html = await render('It costs $5 for the **bold** plan and $10 otherwise.')
    expect(html).not.toContain('language-math')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('$5')
    expect(html).toContain('$10')
  })

  it('leaves a lone dollar sign alone', async () => {
    expect(await render('Priced at $42 flat.')).toContain('$42')
  })

  it('does not treat a shell prompt in a code fence as math', async () => {
    const html = await render('```\n$ pip install fbprophet\n```\n')
    expect(html).toContain('$ pip install fbprophet')
  })

  it('still emphasises normal prose', async () => {
    expect(await render('a _b_ c and **d**')).toContain('<em>b</em>')
  })

  /**
   * The reason this file states its backslashes the long way. An earlier
   * revision was written through a tool that interpreted `\f`, so the fixture
   * held a real U+000C form feed and the test asserted a control character
   * survived to the output — which it did, until the hub started stripping
   * XML-illegal characters. The assertion was wrong, not the strip.
   */
  it('contains no control characters in its own fixtures', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL(import.meta.url), 'utf8')
    // Written as escapes on purpose: a literal class here would be the very
    // bug it guards against. Tab, LF and CR are legitimate source characters.
    const forbidden = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F]')
    expect(forbidden.test(source)).toBe(false)
  })
})
