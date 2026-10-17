import { describe, expect, it } from 'vitest'
import { ommlLinearText, ommlToTex } from '../../src/core/omml-tex'

/*
 * Word equations as TeX (spec B12, plan step 19): one block per row of the
 * B12 table, each on OMML as Word writes it. That the TeX draws in MathJax is
 * checked on the fixture with tests/tools/math-corpus.test.ts.
 */

const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** A math run; `pr` is the inside of its m:rPr. */
const r = (t: string, pr = ''): string =>
  `<m:r>${pr ? `<m:rPr>${pr}</m:rPr>` : ''}<w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr><m:t xml:space="preserve">${t}</m:t></m:r>`
const e = (...inner: string[]): string => `<m:e>${inner.join('')}</m:e>`
const tex = (body: string, display = false): string =>
  ommlToTex(`<m:oMath ${M} ${W}>${body}</m:oMath>`, { display }).tex
const sty = (v: string): string => `<m:sty m:val="${v}"/>`
const scr = (v: string): string => `<m:scr m:val="${v}"/>`

describe('omml-tex: runs (r/t) and styles', () => {
  it('letters and operators as they are; italic is TeX’s default', () => {
    expect(tex(r('x+y=2'))).toBe('x+y=2')
  })
  it('m:sty: plain, bold, bold italic, italic', () => {
    expect(tex(r('d', sty('p')))).toBe('\\mathrm{d}')
    expect(tex(r('v', sty('b')))).toBe('\\mathbf{v}')
    expect(tex(r('w', sty('bi')))).toBe('\\boldsymbol{w}')
    expect(tex(r('x', sty('i')))).toBe('x')
    // Digits and operators alone are not wrapped.
    expect(tex(r('2+', sty('p')))).toBe('2+')
  })
  it('m:scr: double-struck, script, fraktur, sans-serif, monospace', () => {
    expect(tex(r('R', scr('double-struck')))).toBe('\\mathbb{R}')
    expect(tex(r('L', scr('script')))).toBe('\\mathcal{L}')
    expect(tex(r('g', scr('fraktur')))).toBe('\\mathfrak{g}')
    expect(tex(r('A', scr('sans-serif')))).toBe('\\mathsf{A}')
    expect(tex(r('k', scr('monospace')))).toBe('\\mathtt{k}')
    expect(tex(r('F', scr('fraktur') + sty('b')))).toBe('\\boldsymbol{\\mathfrak{F}}')
  })
  it('normal text (m:nor) and plain words with spaces become \\text', () => {
    expect(tex(r('per day', '<m:nor/>'))).toBe('\\text{per day}')
    expect(tex(r(' if ', sty('p')))).toBe('\\text{ if }')
  })
  it('a space elsewhere is a control space', () => {
    expect(tex(r('a b'))).toBe('a\\ b')
  })
  it('escapes TeX specials typed as text', () => {
    expect(tex(r('{a}%#&amp;_$'))).toBe('\\{a\\}\\%\\#\\&\\_\\$')
    expect(tex(r('a\\b'))).toBe('a\\backslash b')
    expect(tex(r('50% off', '<m:nor/>'))).toBe('\\text{50\\% off}')
    // A backslash, caret or tilde has no text-mode form in MathJax: the text closes round it.
    expect(tex(r('a\\b^c~d', '<m:nor/>'))).toBe('\\text{a}\\backslash\\text{b}\\hat{}\\text{c}\\sim\\text{d}')
  })
  it('a tracked deletion is left out', () => {
    expect(tex(r('a') + `<m:r><w:rPr><w:del w:id="1" w:author="x"/></w:rPr><m:t>b</m:t></m:r>`)).toBe('a')
  })
})

describe('omml-tex: characters', () => {
  it('Greek letters to commands', () => {
    expect(tex(r('αβγΔΩ'))).toBe('\\alpha\\beta\\gamma\\Delta\\Omega')
    expect(tex(r('ε φ'))).toBe('\\varepsilon\\ \\varphi')
    expect(tex(r('Α'))).toBe('\\mathrm{A}')
  })
  it('operators, relations and arrows to commands', () => {
    expect(tex(r('a≤b≠c≈d±e×f'))).toBe('a\\le b\\ne c\\approx d\\pm e\\times f')
    expect(tex(r('x→∞'))).toBe('x\\rightarrow\\infty')
    expect(tex(r('A⊆B∪C'))).toBe('A\\subseteq B\\cup C')
    expect(tex(r('∀x∈ℝ'))).toBe('\\forall x\\in\\mathbb{R}')
    expect(tex(r('a−b'))).toBe('a-b')
  })
  it('mathematical italic letters to ASCII; other styles to commands', () => {
    expect(tex(r('𝑥𝑦ℎ'))).toBe('xyh')
    expect(tex(r('𝐯'))).toBe('\\mathbf{v}')
    expect(tex(r('𝔸'))).toBe('\\mathbb{A}')
    expect(tex(r('𝜃'))).toBe('\\theta')
  })
  it('Word’s spacing characters as TeX spaces', () => {
    expect(tex(r('a\u2003b\u2009c'))).toBe('a\\quad b\\,c')
  })
  it('invisible operators draw nothing; others pass through as Unicode', () => {
    expect(tex(r('f⁡x⁢y'))).toBe('fxy')
    expect(tex(r('☺'))).toBe('☺')
  })
})

describe('omml-tex: fractions (f)', () => {
  const f = (type: string | null, num: string, den: string): string =>
    `<m:f>${type ? `<m:fPr><m:type m:val="${type}"/></m:fPr>` : ''}<m:num>${r(num)}</m:num><m:den>${r(den)}</m:den></m:f>`
  it('bar (the default)', () => {
    expect(tex(f(null, 'a', 'b'))).toBe('\\frac{a}{b}')
    expect(tex(f('bar', '1', 'n+1'))).toBe('\\frac{1}{n+1}')
  })
  it('linear, skewed and no bar', () => {
    expect(tex(f('lin', 'a', 'b+c'))).toBe('a/{b+c}')
    expect(tex(f('skw', 'a', 'b'))).toBe('{}^{a}\\!/\\!{}_{b}')
    expect(tex(f('noBar', 'n', 'k'))).toBe('\\genfrac{}{}{0pt}{}{n}{k}')
  })
})

describe('omml-tex: scripts (sSup, sSub, sSubSup, sPre)', () => {
  it('superscript and subscript', () => {
    expect(tex(`<m:sSup>${e(r('x'))}<m:sup>${r('2')}</m:sup></m:sSup>`)).toBe('x^{2}')
    expect(tex(`<m:sSub>${e(r('a'))}<m:sub>${r('i')}</m:sub></m:sSub>`)).toBe('a_{i}')
    expect(tex(`<m:sSup>${e(r('x+1'))}<m:sup>${r('n')}</m:sup></m:sSup>`)).toBe('{x+1}^{n}')
  })
  it('both, and pre-scripts', () => {
    expect(tex(`<m:sSubSup>${e(r('x'))}<m:sub>${r('i')}</m:sub><m:sup>${r('2')}</m:sup></m:sSubSup>`)).toBe('x_{i}^{2}')
    expect(tex(`<m:sPre><m:sub>${r('1')}</m:sub><m:sup>${r('2')}</m:sup>${e(r('F'))}</m:sPre>`)).toBe('{}_{1}^{2}F')
  })
})

describe('omml-tex: radicals (rad)', () => {
  it('square root, with the degree hidden or empty', () => {
    expect(tex(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>${e(r('x'))}</m:rad>`)).toBe('\\sqrt{x}')
    expect(tex(`<m:rad><m:deg/>${e(r('x'))}</m:rad>`)).toBe('\\sqrt{x}')
  })
  it('nth root', () => {
    expect(tex(`<m:rad><m:deg>${r('3')}</m:deg>${e(r('y'))}</m:rad>`)).toBe('\\sqrt[3]{y}')
  })
})

describe('omml-tex: n-ary operators (nary)', () => {
  const nary = (pr: string, sub: string, sup: string, body: string): string =>
    `<m:nary><m:naryPr>${pr}</m:naryPr><m:sub>${sub}</m:sub><m:sup>${sup}</m:sup>${e(body)}</m:nary>`
  it('sum, product and union with limits', () => {
    expect(tex(nary('<m:chr m:val="∑"/><m:limLoc m:val="undOvr"/>', r('i=1'), r('n'), r('x')))).toBe('\\sum_{i=1}^{n}x')
    expect(tex(nary('<m:chr m:val="∏"/>', r('k'), '', r('a')))).toBe('\\prod_{k}a')
    expect(tex(nary('<m:chr m:val="⋃"/>', r('i'), '', r('A')))).toBe('\\bigcup_{i}A')
  })
  it('the integral is the default operator; double, triple and contour integrals', () => {
    expect(tex(nary('', r('0'), r('1'), r('f'))).startsWith('\\int_{0}^{1}')).toBe(true)
    expect(tex(nary('<m:chr m:val="∬"/>', r('D'), '', r('g')))).toBe('\\iint_{D}g')
    expect(tex(nary('<m:chr m:val="∭"/>', r('V'), '', r('h')))).toBe('\\iiint_{V}h')
    expect(tex(nary('<m:chr m:val="∮"/>', r('C'), '', r('F')))).toBe('\\oint_{C}F')
  })
  it('an operator TeX has no command for is \\mathop of its character', () => {
    expect(tex(nary('<m:chr m:val="∯"/>', r('S'), '', r('F')))).toBe('\\mathop{∯}_{S}F')
  })
  it('subHide and supHide drop a limit', () => {
    expect(tex(nary('<m:chr m:val="∑"/><m:subHide m:val="1"/><m:supHide m:val="1"/>', '', '', r('a')))).toBe('\\sum a')
  })
  it('limLoc moves limits in a display equation where TeX’s default differs', () => {
    expect(tex(nary('<m:limLoc m:val="undOvr"/>', r('a'), r('b'), r('f')), true)).toBe('\\int\\limits_{a}^{b}f')
    expect(tex(nary('<m:chr m:val="∑"/><m:limLoc m:val="subSup"/>', r('i'), '', r('x')), true)).toBe('\\sum\\nolimits_{i}x')
    // When inline, Word keeps limits at the side, as TeX does.
    expect(tex(nary('<m:limLoc m:val="undOvr"/>', r('a'), r('b'), r('f')))).toBe('\\int_{a}^{b}f')
  })
})

describe('omml-tex: delimiters (d)', () => {
  const d = (pr: string, ...args: string[]): string => `<m:d><m:dPr>${pr}</m:dPr>${args.map((a) => e(a)).join('')}</m:d>`
  it('parentheses by default, growing', () => {
    expect(tex(d('', r('x+1')))).toBe('\\left(x+1\\right)')
  })
  it('begChr/endChr: brackets, braces, angle brackets, bars', () => {
    expect(tex(d('<m:begChr m:val="["/><m:endChr m:val="]"/>', r('a')))).toBe('\\left[a\\right]')
    expect(tex(d('<m:begChr m:val="{"/><m:endChr m:val="}"/>', r('a')))).toBe('\\left\\{a\\right\\}')
    expect(tex(d('<m:begChr m:val="⟨"/><m:endChr m:val="⟩"/>', r('v')))).toBe('\\left\\langle v\\right\\rangle')
    expect(tex(d('<m:begChr m:val="|"/><m:endChr m:val="|"/>', r('z')))).toBe('\\left|z\\right|')
    expect(tex(d('<m:begChr m:val="‖"/><m:endChr m:val="‖"/>', r('v')))).toBe('\\left\\|v\\right\\|')
  })
  it('empty or invisible delimiters become \\left. / \\right.', () => {
    expect(tex(d('<m:begChr m:val=""/><m:endChr m:val="|"/>', r('f')))).toBe('\\left.f\\right|')
    expect(tex(d('<m:begChr m:val="("/><m:endChr m:val=""/>', r('a')))).toBe('\\left(a\\right.')
  })
  it('sepChr between arguments', () => {
    expect(tex(d('', r('a'), r('b')))).toBe('\\left(a\\middle|b\\right)')
    expect(tex(d('<m:begChr m:val="⟨"/><m:sepChr m:val="|"/><m:endChr m:val="⟩"/>', r('ψ'), r('φ')))).toBe('\\left\\langle\\psi\\middle|\\varphi\\right\\rangle')
  })
})

describe('omml-tex: matrices (m)', () => {
  const m = `<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="2"/></m:mcPr></m:mc></m:mcs></m:mPr><m:mr>${e(r('a'))}${e(r('b'))}</m:mr><m:mr>${e(r('c'))}${e(r('d'))}</m:mr></m:m>`
  it('a bare matrix', () => {
    expect(tex(m)).toBe('\\begin{matrix}a&b\\\\c&d\\end{matrix}')
  })
  it('inside parentheses, brackets, bars: pmatrix, bmatrix, vmatrix', () => {
    expect(tex(`<m:d>${e(m)}</m:d>`)).toBe('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}')
    expect(tex(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr>${e(m)}</m:d>`)).toBe('\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}')
    expect(tex(`<m:d><m:dPr><m:begChr m:val="|"/><m:endChr m:val="|"/></m:dPr>${e(m)}</m:d>`)).toBe('\\begin{vmatrix}a&b\\\\c&d\\end{vmatrix}')
  })
  it('an ampersand typed in a cell stays an ampersand', () => {
    expect(tex(`<m:m><m:mr>${e(r('&amp;'))}</m:mr></m:m>`)).toBe('\\begin{matrix}\\&\\end{matrix}')
  })
})

describe('omml-tex: equation arrays (eqArr)', () => {
  it('rows with alignment marks: aligned', () => {
    expect(tex(`<m:eqArr>${e(r('x&amp;=1'))}${e(r('y&amp;=2'))}</m:eqArr>`)).toBe('\\begin{aligned}x&=1\\\\y&=2\\end{aligned}')
  })
  it('an m:aln alignment point', () => {
    expect(tex(`<m:eqArr>${e(r('a'), r('=b', '<m:aln/>'))}</m:eqArr>`)).toBe('\\begin{aligned}a&=b\\end{aligned}')
  })
  it('rows without: gathered', () => {
    expect(tex(`<m:eqArr>${e(r('a'))}${e(r('b'))}</m:eqArr>`)).toBe('\\begin{gathered}a\\\\b\\end{gathered}')
  })
  it('a left brace round an equation array is cases', () => {
    const arr = `<m:eqArr>${e(r('0&amp;d≤7'))}${e(r('1&amp;d&gt;7'))}</m:eqArr>`
    expect(tex(`<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/></m:dPr>${e(arr)}</m:d>`)).toBe('\\begin{cases}0&d\\le7\\\\1&d>7\\end{cases}')
  })
})

describe('omml-tex: functions (func)', () => {
  const func = (name: string, arg: string, pr = sty('p')): string => `<m:func><m:fName>${r(name, pr)}</m:fName>${e(arg)}</m:func>`
  it('known names to commands', () => {
    expect(tex(func('sin', r('x')))).toBe('\\sin x')
    expect(tex(func('log', r('n')))).toBe('\\log n')
    expect(tex(func('ln', `<m:d>${e(r('x'))}</m:d>`))).toBe('\\ln\\left(x\\right)')
  })
  it('other names as \\operatorname', () => {
    expect(tex(func('sgn', r('x')))).toBe('\\operatorname{sgn}x')
  })
  it('a function with a power (sin² x)', () => {
    const fname = `<m:fName><m:sSup>${e(r('sin', sty('p')))}<m:sup>${r('2')}</m:sup></m:sSup></m:fName>`
    expect(tex(`<m:func>${fname}${e(r('θ'))}</m:func>`)).toBe('\\sin^{2}\\theta')
  })
})

describe('omml-tex: limits (limLow, limUpp)', () => {
  it('lim with its limit below', () => {
    const fname = `<m:fName><m:limLow>${e(r('lim', sty('p')))}<m:lim>${r('n→∞')}</m:lim></m:limLow></m:fName>`
    expect(tex(`<m:func>${fname}${e(r('a'))}</m:func>`)).toBe('\\lim_{n\\rightarrow\\infty}a')
  })
  it('max and an unknown name take their limit as a script', () => {
    const low = (name: string): string => `<m:func><m:fName><m:limLow>${e(r(name, sty('p')))}<m:lim>${r('x')}</m:lim></m:limLow></m:fName>${e(r('f'))}</m:func>`
    expect(tex(low('max'))).toBe('\\max_{x}f')
    expect(tex(low('argmax'))).toBe('\\operatorname*{argmax}_{x}f')
  })
  it('anything else: \\underset and \\overset', () => {
    expect(tex(`<m:limLow>${e(r('X'))}<m:lim>${r('k')}</m:lim></m:limLow>`)).toBe('\\underset{k}{X}')
    expect(tex(`<m:limUpp>${e(r('='))}<m:lim>${r('def', sty('p'))}</m:lim></m:limUpp>`)).toBe('\\overset{\\mathrm{def}}{=}')
  })
})

describe('omml-tex: accents (acc), bars (bar), group characters (groupChr)', () => {
  const acc = (chr: string | null, body: string): string =>
    `<m:acc>${chr ? `<m:accPr><m:chr m:val="${chr}"/></m:accPr>` : ''}${e(body)}</m:acc>`
  it('hat (the default), tilde, dot, double dot, vector, bar', () => {
    expect(tex(acc(null, r('x')))).toBe('\\hat{x}')
    expect(tex(acc('̃', r('n')))).toBe('\\tilde{n}')
    expect(tex(acc('̇', r('x')))).toBe('\\dot{x}')
    expect(tex(acc('̈', r('y')))).toBe('\\ddot{y}')
    expect(tex(acc('⃗', r('v')))).toBe('\\vec{v}')
    expect(tex(acc('̅', r('z')))).toBe('\\overline{z}')
    expect(tex(acc('̄', r('x')))).toBe('\\bar{x}')
  })
  it('wide accents over more than one token', () => {
    expect(tex(acc(null, r('xy')))).toBe('\\widehat{xy}')
    expect(tex(acc('⃗', r('AB')))).toBe('\\overrightarrow{AB}')
  })
  it('bar: underline by default, overline on top', () => {
    expect(tex(`<m:bar>${e(r('a'))}</m:bar>`)).toBe('\\underline{a}')
    expect(tex(`<m:bar><m:barPr><m:pos m:val="top"/></m:barPr>${e(r('a+b'))}</m:bar>`)).toBe('\\overline{a+b}')
  })
  it('groupChr: underbrace by default, overbrace, and with a label', () => {
    expect(tex(`<m:groupChr>${e(r('a+b'))}</m:groupChr>`)).toBe('\\underbrace{a+b}')
    expect(tex(`<m:groupChr><m:groupChrPr><m:chr m:val="⏞"/><m:pos m:val="top"/></m:groupChrPr>${e(r('c'))}</m:groupChr>`)).toBe('\\overbrace{c}')
    const under = `<m:limLow>${e(`<m:groupChr>${e(r('x+y'))}</m:groupChr>`)}<m:lim>${r('n')}</m:lim></m:limLow>`
    expect(tex(under)).toBe('\\underbrace{x+y}_{n}')
  })
})

describe('omml-tex: box, borderBox, phant', () => {
  it('box keeps its content; borderBox draws a box', () => {
    expect(tex(`<m:box>${e(r('dx'))}</m:box>`)).toBe('dx')
    expect(tex(`<m:borderBox>${e(r('E=m'))}</m:borderBox>`)).toBe('\\boxed{E=m}')
  })
  it('a borderBox with every side hidden and a strike is a cancel', () => {
    const pr = '<m:borderBoxPr><m:hideTop/><m:hideBot/><m:hideLeft/><m:hideRight/><m:strikeBLTR/></m:borderBoxPr>'
    expect(tex(`<m:borderBox>${pr}${e(r('x'))}</m:borderBox>`)).toBe('\\cancel{x}')
  })
  it('phantom: hidden, or shown with a size change', () => {
    expect(tex(`<m:phant><m:phantPr><m:show m:val="0"/></m:phantPr>${e(r('x'))}</m:phant>`)).toBe('\\phantom{x}')
    expect(tex(`<m:phant><m:phantPr><m:show m:val="0"/><m:zeroWid/></m:phantPr>${e(r('x'))}</m:phant>`)).toBe('\\vphantom{x}')
    expect(tex(`<m:phant>${e(r('x'))}</m:phant>`)).toBe('x')
  })
})

describe('omml-tex: line breaks (m:brk)', () => {
  const brk = (t: string, at?: number): string => r(t, at === undefined ? '<m:brk/>' : `<m:brk m:alnAt="${at}"/>`)
  it('display: each break starts a new line, the lines set as multlined', () => {
    expect(tex(r('a=b+c') + brk('+d') + brk('+e'), true)).toBe('\\begin{multlined}a=b+c\\\\{}+d\\\\{}+e\\end{multlined}')
  })
  it('display with m:alnAt: the lines line up on that operator of the first line', () => {
    expect(tex(r('a+b=c') + brk('+d', 2), true)).toBe('\\begin{aligned}a+b&=c\\\\&{}+d\\end{aligned}')
    expect(tex(r('y=') + `<m:f><m:num>${r('1')}</m:num><m:den>${r('2')}</m:den></m:f>` + brk('−x', 1), true)).toBe('\\begin{aligned}y&=\\frac{1}{2}\\\\&{}-x\\end{aligned}')
  })
  it('an operator alnAt does not find: multlined after all', () => {
    expect(tex(r('ab') + brk('+c', 1), true)).toBe('\\begin{multlined}ab\\\\{}+c\\end{multlined}')
  })
  it('inline, Word does not break: one line', () => {
    expect(tex(r('a=b') + brk('+c'))).toBe('a=b+c')
  })
  it('a break inside a structure is not a line break', () => {
    expect(tex(`<m:f><m:num>${r('a')}${brk('+b')}</m:num><m:den>${r('2')}</m:den></m:f>`, true)).toBe('\\frac{a+b}{2}')
  })
  it('a math paragraph of a broken equation and another: gathered round both', () => {
    const out = ommlToTex(`<m:oMathPara ${M} ${W}><m:oMath>${r('a=b')}${brk('+c')}</m:oMath><m:oMath>${r('d=e')}</m:oMath></m:oMathPara>`, { display: true }).tex
    expect(out).toBe('\\begin{gathered}\\begin{multlined}a=b\\\\{}+c\\end{multlined}\\\\d=e\\end{gathered}')
  })
})

describe('omml-tex: matrix column alignment (m:mcJc)', () => {
  const mc = (count: number, jc?: string): string =>
    `<m:mc><m:mcPr><m:count m:val="${count}"/>${jc ? `<m:mcJc m:val="${jc}"/>` : ''}</m:mcPr></m:mc>`
  const m = (...cols: string[]): string =>
    `<m:m><m:mPr><m:mcs>${cols.join('')}</m:mcs></m:mPr><m:mr>${e(r('1'))}${e(r('22'))}</m:mr><m:mr>${e(r('333'))}${e(r('4'))}</m:mr></m:m>`
  it('every column centered (the default): matrix', () => {
    expect(tex(m(mc(2)))).toBe('\\begin{matrix}1&22\\\\333&4\\end{matrix}')
    expect(tex(m(mc(2, 'center')))).toBe('\\begin{matrix}1&22\\\\333&4\\end{matrix}')
  })
  it('every column aligned one way: matrix* with that alignment', () => {
    expect(tex(m(mc(2, 'right')))).toBe('\\begin{matrix*}[r]1&22\\\\333&4\\end{matrix*}')
    expect(tex(`<m:d>${e(m(mc(2, 'left')))}</m:d>`)).toBe('\\begin{pmatrix*}[l]1&22\\\\333&4\\end{pmatrix*}')
  })
  it('columns aligned differently: an array with a column spec, inside its delimiters', () => {
    expect(tex(m(mc(1, 'left'), mc(1, 'right')))).toBe('\\begin{array}{lr}1&22\\\\333&4\\end{array}')
    expect(tex(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr>${e(m(mc(1, 'left'), mc(1)))}</m:d>`)).toBe(
      '\\left[\\begin{array}{lc}1&22\\\\333&4\\end{array}\\right]',
    )
  })
  it('more cells than the columns described: the rest centered', () => {
    expect(tex(m(mc(1, 'left')))).toBe('\\begin{array}{lc}1&22\\\\333&4\\end{array}')
  })
})

describe('omml-tex: double brackets (⟦⟧)', () => {
  const d = (beg: string, end: string, ...args: string[]): string =>
    `<m:d><m:dPr><m:begChr m:val="${beg}"/><m:endChr m:val="${end}"/></m:dPr>${args.map((a) => e(a)).join('')}</m:d>`
  it('two brackets drawn close together, growing with the content', () => {
    expect(tex(d('⟦', '⟧', r('x')))).toBe('\\left[\\!\\left[x\\right]\\!\\right]')
  })
  it('one side double: the other side single, still balanced', () => {
    expect(tex(d('⟦', ')', r('x')))).toBe('\\left[\\!\\left[x\\right.\\right)')
    expect(tex(d('', '⟧', r('x')))).toBe('\\left.\\left.x\\right]\\!\\right]')
  })
})

describe('omml-tex: borderBox sides and strikes', () => {
  const box = (...props: string[]): string => `<m:borderBox><m:borderBoxPr>${props.map((p) => `<m:${p}/>`).join('')}</m:borderBoxPr>${e(r('x'))}</m:borderBox>`
  it('hidden sides: only the sides shown are drawn', () => {
    expect(tex(box('hideTop', 'hideBot'))).toBe('\\enclose{left right}{x}')
    expect(tex(box('hideLeft', 'hideRight', 'hideTop'))).toBe('\\enclose{bottom}{x}')
    expect(tex(box('hideBot'))).toBe('\\enclose{top left right}{x}')
  })
  it('strikes on a box, and horizontal and vertical strikes', () => {
    expect(tex(box('strikeBLTR'))).toBe('\\enclose{box updiagonalstrike}{x}')
    expect(tex(box('hideTop', 'hideBot', 'hideLeft', 'hideRight', 'strikeH'))).toBe('\\enclose{horizontalstrike}{x}')
    expect(tex(box('hideTop', 'hideBot', 'hideLeft', 'hideRight', 'strikeV', 'strikeTLBR'))).toBe('\\enclose{verticalstrike downdiagonalstrike}{x}')
  })
  it('diagonal strikes alone stay cancels; both diagonals an \\xcancel', () => {
    expect(tex(box('hideTop', 'hideBot', 'hideLeft', 'hideRight', 'strikeBLTR', 'strikeTLBR'))).toBe('\\xcancel{x}')
    expect(tex(box('hideTop', 'hideBot', 'hideLeft', 'hideRight', 'strikeTLBR'))).toBe('\\bcancel{x}')
  })
})

describe('omml-tex: namespaces', () => {
  const MML = 'xmlns:mml="http://schemas.openxmlformats.org/officeDocument/2006/math"'
  it('the math namespace under another prefix', () => {
    const xml = `<mml:oMath ${MML} ${W}><mml:sSup><mml:e><mml:r><mml:t>x</mml:t></mml:r></mml:e><mml:sup><mml:r><mml:rPr><mml:sty mml:val="p"/></mml:rPr><mml:t>T</mml:t></mml:r></mml:sup></mml:sSup></mml:oMath>`
    expect(ommlToTex(xml)).toEqual({ tex: 'x^{\\mathrm{T}}', unknown: [] })
    expect(ommlLinearText(xml)).toBe('xT')
  })
  it('as the default namespace', () => {
    const xml = `<oMath xmlns="http://schemas.openxmlformats.org/officeDocument/2006/math"><f><num><r><t>1</t></r></num><den><r><t>2</t></r></den></f></oMath>`
    expect(ommlToTex(xml).tex).toBe('\\frac{1}{2}')
  })
  it('declared on the part’s root, outside the fragment', () => {
    const xml = `<q:oMath><q:r><q:t>a</q:t></q:r></q:oMath>`
    expect(ommlToTex(xml, { namespaces: { q: 'http://schemas.openxmlformats.org/officeDocument/2006/math' } }).tex).toBe('a')
  })
  it('the m: prefix bound to something else is not math', () => {
    const xml = `<x:oMath xmlns:x="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:m="urn:other"><x:r><x:t>a</x:t></x:r><m:f><m:num><x:r><x:t>b</x:t></x:r></m:num></m:f></x:oMath>`
    expect(ommlToTex(xml).unknown).toHaveLength(1)
  })
  it('strict Office Open XML’s math namespace', () => {
    const xml = `<s:oMath xmlns:s="http://purl.oclc.org/ooxml/officeDocument/math"><s:r><s:t>z</s:t></s:r></s:oMath>`
    expect(ommlToTex(xml).tex).toBe('z')
  })
})

describe('omml-tex: math paragraphs and unknown elements', () => {
  it('an m:oMathPara of one equation is that equation; of two, gathered lines', () => {
    const para = (n: number): string =>
      ommlToTex(`<m:oMathPara ${M} ${W}><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>${Array.from({ length: n }, (_, i) => `<m:oMath>${r(`x=${i}`)}</m:oMath>`).join('')}</m:oMathPara>`, { display: true }).tex
    expect(para(1)).toBe('x=0')
    expect(para(2)).toBe('\\begin{gathered}x=0\\\\x=1\\end{gathered}')
  })
  it('an unknown element becomes its linear text, and is reported', () => {
    const out = ommlToTex(`<m:oMath ${M} ${W}>${r('a+')}<m:future><m:e>${r('b')}${r('c')}</m:e></m:future></m:oMath>`)
    expect(out.tex).toBe('a+bc')
    expect(out.unknown).toEqual(['m:future'])
  })
  it('every known element reports nothing', () => {
    expect(ommlToTex(`<m:oMath ${M} ${W}><m:f><m:num>${r('1')}</m:num><m:den>${r('2')}</m:den></m:f></m:oMath>`).unknown).toEqual([])
  })
  it('linear text of a whole equation', () => {
    expect(ommlLinearText(`<m:oMath ${M}><m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f></m:oMath>`)).toBe('ab')
  })
})
