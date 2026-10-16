import { describe, expect, it } from 'vitest'
import { carryDefinitions, texDefinitions } from '../../src/core/tex-definitions'

/*
 * A document's own TeX definitions carried into its later formulas, which
 * the render host draws one at a time (TODO, Formulas).
 */

describe('TeX definitions in a formula', () => {
  it('finds \\newcommand, \\renewcommand, \\providecommand, braced or not, with arguments and a default', () => {
    const defs = texDefinitions(
      '\\newcommand{\\vv}[1]{\\mathbf{#1}} \\renewcommand\\E{\\mathbb{E}} \\providecommand*{\\pa}[2][x]{\\partial_{#1}#2} a+b',
    )
    expect(defs.map((d) => [d.name, d.text])).toEqual([
      ['\\vv', '\\newcommand{\\vv}[1]{\\mathbf{#1}}'],
      ['\\E', '\\renewcommand\\E{\\mathbb{E}}'],
      ['\\pa', '\\providecommand*{\\pa}[2][x]{\\partial_{#1}#2}'],
    ])
  })

  it('finds \\def with parameters, \\let, \\DeclareMathOperator (starred too), environments and paired delimiters', () => {
    const defs = texDefinitions(
      '\\def\\ip#1#2{\\langle #1,#2\\rangle}\\let\\eps=\\varepsilon \\DeclareMathOperator*{\\argmax}{arg\\,max}' +
        '\\DeclareMathOperator\\Tr{Tr}\\newenvironment{sys}{\\left\\{\\begin{aligned}}{\\end{aligned}\\right.}' +
        '\\DeclarePairedDelimiter{\\abs}{\\lvert}{\\rvert}',
    )
    expect(defs.map((d) => d.name)).toEqual(['\\ip', '\\eps', '\\argmax', '\\Tr', 'env:sys', '\\abs'])
    expect(defs[1].text).toBe('\\let\\eps=\\varepsilon')
    expect(defs[4].text).toBe('\\newenvironment{sys}{\\left\\{\\begin{aligned}}{\\end{aligned}\\right.}')
  })

  it('skips a definition it cannot read whole: no name, an unclosed body, a commented-out one', () => {
    expect(texDefinitions('\\newcommand{x}{y}')).toEqual([])
    expect(texDefinitions('\\newcommand{\\a}{\\frac{1}{2}')).toEqual([])
    expect(texDefinitions('x % \\newcommand{\\a}{b}\n+ y')).toEqual([])
    expect(texDefinitions('100\\% \\newcommand{\\a}{b}').map((d) => d.name)).toEqual(['\\a'])
  })
})

describe('carrying definitions forward', () => {
  it('gives a later formula the definitions it uses from earlier ones, in document order', () => {
    const out = carryDefinitions(['\\newcommand{\\vv}[1]{\\mathbf{#1}} \\vv{a}', 'x', '\\vv{b} + \\vv{c}'])
    expect(out).toEqual(['\\newcommand{\\vv}[1]{\\mathbf{#1}} \\vv{a}', 'x', '\\newcommand{\\vv}[1]{\\mathbf{#1}}\\vv{b} + \\vv{c}'])
  })

  it('never carries backwards: a formula before the definition is drawn as it is', () => {
    expect(carryDefinitions(['\\vv{a}', '\\newcommand{\\vv}{v}'])).toEqual(['\\vv{a}', '\\newcommand{\\vv}{v}'])
  })

  it('carries only what is used, with what those definitions use in turn, and a redefinition after the first', () => {
    const out = carryDefinitions([
      '\\newcommand{\\R}{\\mathbb{R}}\\newcommand{\\Rn}{\\R^n}\\newcommand{\\unused}{u}',
      '\\renewcommand{\\R}{\\mathbf{R}}',
      'x \\in \\Rn',
    ])
    expect(out[2]).toBe('\\newcommand{\\R}{\\mathbb{R}}\\newcommand{\\Rn}{\\R^n}\\renewcommand{\\R}{\\mathbf{R}}x \\in \\Rn')
  })

  it('carries an environment to a formula that begins it', () => {
    const def = '\\newenvironment{sys}{\\left\\{\\begin{aligned}}{\\end{aligned}\\right.}'
    expect(carryDefinitions([def, '\\begin{sys} x&=1 \\end{sys}'])[1]).toBe(def + '\\begin{sys} x&=1 \\end{sys}')
  })

  it('does not take \\Rn for \\R: names are whole control words', () => {
    expect(carryDefinitions(['\\def\\R{r}', '\\Rn'])[1]).toBe('\\Rn')
  })
})
