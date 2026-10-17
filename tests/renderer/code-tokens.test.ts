import { describe, it, expect, beforeAll } from 'vitest'
import { hljs, loadGrammar } from '../../src/renderer/src/lib/code-grammars'
import { colorTo, recolorText, restartRule, tokensIn, uncolored, type Colors } from '../../src/renderer/src/lib/code-tokens'

/*
 * Colors kept up to date edit by edit must be the colors of the text as it
 * stands: coloring again from a restart point, and keeping the old colors
 * past where the two meet, has to give what coloring the whole text does.
 * All code here is invented for the test.
 */

beforeAll(async () => {
  for (const name of ['python', 'javascript', 'css', 'sql']) expect(await loadGrammar(name)).toBe(true)
})

/** highlight.js on the whole text, as [from, to, classes], the way the outputs color it. */
function whole(text: string, language: string): string[] {
  const { value } = hljs.highlight(text, { language, ignoreIllegals: true })
  const out: [number, number, string][] = []
  const stack: string[] = []
  let at = 0
  for (const m of value.matchAll(/<span class="([^"]*)">|<\/span>|[^<]+/g)) {
    if (m[1] !== undefined) stack.push(m[1])
    else if (m[0] === '</span>') stack.pop()
    else {
      const len = m[0].replace(/&(?:amp|lt|gt|quot|#x27);/g, '.').length
      if (stack.length) {
        const cls = stack.join(' ')
        const last = out[out.length - 1]
        if (last && last[1] === at && last[2] === cls) last[1] = at + len
        else out.push([at, at + len, cls])
      }
      at += len
    }
  }
  return out.map((t) => t.join(','))
}
const tokens = (c: Colors): string[] => tokensIn(c, 0, c.text.length).map((t) => t.join(','))

/** A small seeded random, so a failure can be run again. */
function random(seed: number): () => number {
  return () => {
    // Park and Miller's minimal standard generator.
    seed = (seed * 0xbc8f) % 0x7fffffff
    return seed / 0x7fffffff
  }
}

/*
 * Python and JavaScript hold even under any edit, half-typed code included.
 * CSS and SQL hide state between tokens across lines in a few half-typed
 * places (an at-rule or `url(` not yet closed, a quoted SQL name), where the
 * pane colors the next line afresh and the outputs carry on as before; their
 * edits here keep the code whole.
 */
const SAMPLES: Record<string, { text: string; pieces: string[]; whole?: boolean }> = {
  python: {
    text: [
      'import math',
      '',
      'def total(items, rate=0.2):',
      '    """Sum the invented prices.',
      '    Over two lines."""',
      '    out = 0  # running',
      '    for item in items:',
      "        out += item.price * (1 + rate)  # tax",
      "    note = f'{out:.2f} in all'",
      '    return math.floor(out)',
      '',
      'class Ledger:',
      '    pass',
    ].join('\n'),
    pieces: ['"""', "'", '#', '\n', 'def ', 'return 1', '\n    x = "a"\n', 'f"{x}"', '  # note', '(', ')', ':', '1.5'],
  },
  javascript: {
    text: [
      '// Totals for an invented ledger',
      'const rate = 0.2',
      '/* a block',
      '   comment */',
      'function total(items) {',
      '  const out = items.reduce((sum, item) => sum + item.price * (1 + rate), 0)',
      '  return `total: ${out}`',
      '}',
      'class Ledger extends Base {',
      '  static limit = 42',
      '}',
    ].join('\n'),
    pieces: ['/*', '*/', '`', '${', '}', "'", '"', '//', '\n', 'function f() {', 'return 1', '/re+/g', '{', '\n  a: 1,\n'],
  },
  css: {
    text: ['/* invented */', '.ledger {', '  color: #333;', '  margin: 0 auto;', '}', '@media (max-width: 40rem) {', '  .ledger { display: none }', '}'].join('\n'),
    pieces: ['/* note */', '\n', '\n.x { color: red; }\n', '"x"', '\n@media print {\n  a { color: #000 }\n}\n'],
    whole: true,
  },
  sql: {
    text: ['-- invented', 'SELECT name,', "       'a string'", 'FROM parts', 'WHERE weight > 3', '/* block', '   comment */', 'ORDER BY name;'].join('\n'),
    pieces: ["'it''s'", '\n-- note\n', '/* note */', '\n', ' SELECT ', ';', '\nUPDATE parts SET weight = 2;\n'],
    whole: true,
  },
}

describe('colors kept up to date edit by edit', () => {
  for (const [language, { text: start, pieces, whole: keepWhole }] of Object.entries(SAMPLES)) {
    it(`match coloring the whole ${language} text, after each of 300 random edits`, () => {
      expect(restartRule(language)).toBe('line')
      const next = random(language.length * 7919)
      // Many lines, so restart points and old colors past an edit matter.
      let text = Array.from({ length: 12 }, () => start).join('\n')
      let c = colorTo(uncolored(language, text), text.length)
      expect(tokens(c)).toEqual(whole(text, language))
      for (let k = 0; k < 300; k++) {
        let at = Math.floor(next() * (text.length + 1))
        // Whole code: pieces go in at line starts, outside any string or comment.
        if (keepWhole) at = text.lastIndexOf('\n', at) + 1
        if (!keepWhole && next() < 0.35 && text.length > 10) {
          const len = 1 + Math.floor(next() * 12)
          text = text.slice(0, at) + text.slice(at + len)
        } else text = text.slice(0, at) + pieces[Math.floor(next() * pieces.length)] + text.slice(at)
        c = recolorText(c, text, text.length)
        expect(c.upTo).toBe(text.length)
        expect(tokens(c), `edit ${k}`).toEqual(whole(text, language))
      }
    })
  }

  it('color only as far as needed, and the rest when it is needed', () => {
    const text = Array.from({ length: 400 }, (_, i) => `value_${i} = ${i}  # invented`).join('\n')
    const c = colorTo(uncolored('python', text), 600)
    expect(c.upTo).toBeGreaterThanOrEqual(600)
    expect(c.upTo).toBeLessThan(2000)
    // An edit before where it reaches, then the rest.
    const edited = text.slice(0, 100) + '"""' + text.slice(100)
    const d = recolorText(c, edited, 600)
    expect(d.upTo).toBeLessThan(2000)
    expect(tokens(colorTo(d, edited.length))).toEqual(whole(edited, 'python'))
    // An edit past where it reaches leaves the colors alone.
    const far = edited.slice(0, 5000) + 'x' + edited.slice(5000)
    const e = recolorText(d, far, 600)
    expect(e.tokens).toBe(d.tokens)
    expect(tokens(colorTo(e, far.length))).toEqual(whole(far, 'python'))
  })

  it('color again only from the line before an edit to where the old colors hold', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `value_${i} = ${i}  # invented`).join('\n')
    const c = colorTo(uncolored('python', text), text.length)
    const calls: number[] = []
    const real = hljs.highlight.bind(hljs)
    hljs.highlight = ((code: string, options: { language: string; ignoreIllegals?: boolean }) => {
      calls.push(code.length)
      return real(code, options)
    }) as typeof hljs.highlight
    const at = text.indexOf('value_1000')
    const edited = text.slice(0, at) + 'if ' + text.slice(at)
    let d: Colors
    try {
      d = recolorText(c, edited, edited.length)
    } finally {
      hljs.highlight = real
    }
    expect(calls.reduce((a, b) => a + b, 0)).toBeLessThan(1000)
    expect(tokens(d)).toEqual(whole(edited, 'python'))
  })
})
