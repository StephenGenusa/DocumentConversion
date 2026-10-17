#!/usr/bin/env node
/**
 * Builds `tests/corpus/treasurer-equations.docx`: invented notes on loan and
 * shelving figures, typed as Word equations (OMML, spec B12, plan step 19).
 * There is one math paragraph per row of B12's table (runs and styles,
 * fractions, scripts, roots, n-ary operators, delimiters, matrices, equation
 * arrays and cases, functions, limits, accents and bars and braces, boxes and
 * phantoms, characters), plus TeX specials typed as text, a math paragraph of
 * two equations, inline equations in running text, an equation alone in its
 * paragraph, an equation in a footnote and in an endnote, and one element no
 * Word version writes (it comes through as its characters, with a notice).
 * Then manual line breaks, matrix column alignment, partly hidden border
 * boxes, double brackets, and an equation under another namespace prefix.
 *
 * The OMML is written the way Word 365 writes it (m:rPr before w:rPr in each
 * run, properties in m:*Pr, m:ctrlPr omitted). Every word comes from
 * vocabulary.mjs (OMML_NOTES), which the PII guard's vocabulary is derived from.
 *
 *   node scripts/fixtures/build-omml-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDocx, noteRef } from './lib-docx.mjs'
import { OMML_NOTES as N } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus/treasurer-equations.docx')

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/* -- OMML ----------------------------------------------------------------- */

const FONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>'
/** A math run; `pr` is the inside of its m:rPr. */
const r = (t, pr = '') => `<m:r>${pr ? `<m:rPr>${pr}</m:rPr>` : ''}${FONT}<m:t xml:space="preserve">${esc(t)}</m:t></m:r>`
const plain = (t) => r(t, '<m:sty m:val="p"/>')
const e = (...x) => `<m:e>${x.join('')}</m:e>`
const val = (name, v) => `<m:${name} m:val="${esc(v)}"/>`
const pr = (name, ...props) => (props.length ? `<m:${name}>${props.join('')}</m:${name}>` : '')

const frac = (num, den, type) => `<m:f>${type ? pr('fPr', val('type', type)) : ''}<m:num>${num}</m:num><m:den>${den}</m:den></m:f>`
const sup = (b, s) => `<m:sSup>${e(b)}<m:sup>${s}</m:sup></m:sSup>`
const sub = (b, s) => `<m:sSub>${e(b)}<m:sub>${s}</m:sub></m:sSub>`
const subsup = (b, s, p) => `<m:sSubSup>${e(b)}<m:sub>${s}</m:sub><m:sup>${p}</m:sup></m:sSubSup>`
const pre = (s, p, b) => `<m:sPre><m:sub>${s}</m:sub><m:sup>${p}</m:sup>${e(b)}</m:sPre>`
const sqrt = (x) => `<m:rad>${pr('radPr', val('degHide', '1'))}<m:deg/>${e(x)}</m:rad>`
const root = (d, x) => `<m:rad><m:deg>${d}</m:deg>${e(x)}</m:rad>`
const nary = (props, s, p, body) => `<m:nary>${pr('naryPr', ...props)}<m:sub>${s}</m:sub><m:sup>${p}</m:sup>${e(body)}</m:nary>`
const d = (props, ...args) => `<m:d>${pr('dPr', ...props)}${args.map((a) => e(a)).join('')}</m:d>`
const matrix = (rows, cols = []) =>
  `<m:m>${cols.length ? `<m:mPr><m:mcs>${cols.map(([count, jc]) => `<m:mc>${pr('mcPr', val('count', count), val('mcJc', jc))}</m:mc>`).join('')}</m:mcs></m:mPr>` : ''}${rows.map((row) => `<m:mr>${row.map((c) => e(c)).join('')}</m:mr>`).join('')}</m:m>`
/** A run that starts a new line of a display equation (m:brk), lined up on operator `at` when given. */
const brk = (t, at) => r(t, at ? `<m:brk m:alnAt="${at}"/>` : '<m:brk/>')
const box = (hide, x) => `<m:borderBox>${pr('borderBoxPr', ...hide.map((h) => val(h, '1')))}${e(x)}</m:borderBox>`
const eqArr = (...rows) => `<m:eqArr>${rows.map((x) => e(x)).join('')}</m:eqArr>`
const func = (name, arg) => `<m:func><m:fName>${name}</m:fName>${e(arg)}</m:func>`
const limLow = (b, l) => `<m:limLow>${e(b)}<m:lim>${l}</m:lim></m:limLow>`
const limUpp = (b, l) => `<m:limUpp>${e(b)}<m:lim>${l}</m:lim></m:limUpp>`
const acc = (chr, x) => `<m:acc>${chr ? pr('accPr', val('chr', chr)) : ''}${e(x)}</m:acc>`
const bar = (pos, x) => `<m:bar>${pr('barPr', val('pos', pos))}${e(x)}</m:bar>`
const group = (chr, pos, x) => `<m:groupChr>${pr('groupChrPr', val('chr', chr), val('pos', pos))}${e(x)}</m:groupChr>`

const oMath = (...x) => `<m:oMath>${x.join('')}</m:oMath>`
/** A math paragraph: a display equation on a line of its own. */
const display = (...x) => `<w:p><m:oMathPara>${pr('oMathParaPr', val('jc', 'center'))}${oMath(...x)}</m:oMathPara></w:p>`

/* -- prose ---------------------------------------------------------------- */

const t = (s) => `<w:r><w:t xml:space="preserve">${esc(s)}</w:t></w:r>`
const p = (...runs) => `<w:p>${runs.join('')}</w:p>`
const lead = (s) => p(t(s))

/* -- the equations, one per B12 row --------------------------------------- */

const comma = r(', ')

const body = [
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${t(N.title)}</w:p>`,
  lead(N.intro),

  // r/t with m:sty and m:scr, and normal text.
  lead(N.styles),
  display(
    r('v', '<m:sty m:val="b"/>'), r('∈'), sup(r('R', '<m:scr m:val="double-struck"/>'), r('n')), comma,
    r('L', '<m:scr m:val="script"/>'), r('≠'), r('g', '<m:scr m:val="fraktur"/>'), comma,
    r('d', '<m:sty m:val="p"/>'), r('x'), comma,
    r('w', '<m:sty m:val="bi"/>'), comma,
    r('A', '<m:scr m:val="sans-serif"/>'), r('=12'), r(` ${N.styleText}`, '<m:nor/>'),
  ),

  // f: bar, lin, skw, noBar.
  lead(N.fractions),
  display(
    frac(r('a'), r('b+1')), comma, frac(r('a'), r('b'), 'lin'), comma, frac(r('1'), r('2'), 'skw'), comma,
    d([], frac(r('n'), r('k'), 'noBar')),
  ),

  // sSup, sSub, sSubSup, sPre.
  lead(N.scripts),
  display(sup(r('x'), r('2')), comma, sub(r('a'), r('i')), comma, subsup(r('x'), r('i'), r('2')), comma, pre(r('1'), r('2'), r('F'))),

  // rad.
  lead(N.roots),
  display(sqrt(sup(r('a'), r('2')) + r('+') + sup(r('b'), r('2'))), comma, root(r('3'), r('V'))),

  // nary: sum, product with subHide, union, integrals.
  lead(N.sums),
  display(
    nary([val('chr', '∑'), val('limLoc', 'undOvr')], r('i=1'), r('n'), sub(r('f'), r('i'))), comma,
    nary([val('chr', '∏'), val('limLoc', 'undOvr'), val('supHide', '1')], r('k'), '', sub(r('p'), r('k'))), comma,
    nary([val('chr', '⋃'), val('limLoc', 'undOvr')], r('j'), '', sub(r('A'), r('j'))), comma,
    nary([val('limLoc', 'subSup')], r('0'), r('1'), sup(r('x'), r('2')) + plain('d') + r('x')), comma,
    nary([val('chr', '∬'), val('limLoc', 'subSup'), val('supHide', '1')], r('D'), '', r('g') + plain('d') + r('A')), comma,
    nary([val('chr', '∮'), val('limLoc', 'subSup'), val('supHide', '1')], r('C'), '', r('F⋅') + plain('d') + r('s')),
  ),

  // d: begChr/endChr/sepChr, and an invisible left delimiter.
  lead(N.delimiters),
  display(
    d([], r('x+1')), comma,
    d([val('begChr', '['), val('endChr', ']')], r('a,b')), comma,
    d([val('begChr', '{'), val('endChr', '}')], r('1,2,3')), comma,
    d([val('begChr', '|'), val('endChr', '|')], r('z')), comma,
    d([val('begChr', '⟨'), val('sepChr', '|'), val('endChr', '⟩')], r('u'), r('v')), comma,
    subsup(d([val('begChr', ''), val('endChr', '|')], r('F')), r('a'), r('b')),
  ),

  // m: inside parentheses, brackets, and bare.
  lead(N.matrices),
  display(
    r('C='), d([], matrix([[r('120'), r('80')], [r('95'), r('60')]])), comma,
    d([val('begChr', '['), val('endChr', ']')], matrix([[r('1'), r('0')], [r('0'), r('1')]])), comma,
    matrix([[r('a'), r('b')], [r('c'), r('d')]]),
  ),

  // eqArr: aligned on & marks.
  lead(N.aligned),
  display(eqArr(r('T&=') + sub(r('f'), r('1')) + r('+') + sub(r('f'), r('2')), r('&=') + r('15'))),

  // A brace round an equation array: cases.
  lead(N.cases),
  display(
    r('f') + d([], r('d')) + r('='),
    d([val('begChr', '{'), val('endChr', '')], eqArr(r('0&d≤7'), r('r') + d([], r('d−7')) + r('&') + plain(N.casesText))),
  ),

  // func: known names, an unknown name, and sin² θ.
  lead(N.functions),
  display(
    func(plain('sin'), r('x')), comma, func(plain('log'), r('n')), comma, func(plain('sgn'), r('x')), comma,
    func(sup(plain('sin'), r('2')), r('θ')) + r('+') + func(sup(plain('cos'), r('2')), r('θ')) + r('=1'),
  ),

  // limLow, limUpp.
  lead(N.limits),
  display(
    func(limLow(plain('lim'), r('n→∞')), sup(d([], r('1+') + frac(r('1'), r('n'))), r('n'))), comma,
    func(limLow(plain('max'), r('i')), sub(r('d'), r('i'))), comma,
    r('r') + limUpp(r('='), plain('def')) + frac(r('f'), r('d')),
  ),

  // acc, bar, groupChr.
  lead(N.accents),
  display(
    acc('', r('x')), comma, acc('̃', r('n')), comma, acc('̇', r('x')), comma, acc('̈', r('y')), comma,
    acc('⃗', r('v')), comma, acc('̄', r('x')), comma, acc('', r('xy')), comma,
    bar('top', r('a+b')), comma, bar('bot', r('c')), comma,
    limLow(group('⏟', 'bot', r('1+1+⋯+1')), r('n ') + plain(N.braceLabel)), comma,
    group('⏞', 'top', r('a+b')),
  ),

  // box, borderBox, phant.
  lead(N.boxes),
  display(
    `<m:borderBox>${e(r('T=15'))}</m:borderBox>`, comma,
    `<m:borderBox>${pr('borderBoxPr', val('hideTop', '1'), val('hideBot', '1'), val('hideLeft', '1'), val('hideRight', '1'), val('strikeBLTR', '1'))}${e(r('x'))}</m:borderBox>`,
    r('+y'), comma,
    r('a') + `<m:phant>${pr('phantPr', val('show', '0'))}${e(r('bbb'))}</m:phant>` + r('c'), comma,
    `<m:box>${e(plain('d') + r('x'))}</m:box>`,
  ),

  // Characters: Greek, operators, relations, arrows.
  lead(N.symbols),
  display(r('∀ε>0 ∃δ>0:|x−a|<δ⇒|f(x)−L|<ε'), comma, r('Δ≤Σ±Ω×α⋅β≈γ'), comma, r('A⊆B∪C'), comma, r('∂f/∂x≠∇λ')),

  // TeX specials typed as text, in math and as normal text.
  lead(N.specials),
  display(r('{a}%#&_$'), comma, r(N.specialText, '<m:nor/>')),

  // An oMathPara holding two equations: two lines.
  lead(N.twoLines),
  `<w:p><m:oMathPara>${oMath(r('a+b=c'))}${oMath(r('c−b=a'))}</m:oMathPara></w:p>`,

  // Inline math in running text.
  p(t(`${N.inlineLead} `), oMath(frac(r('a'), r('b'))), t(` ${N.inlineMid} `), oMath(sub(r('r'), plain('day')), r('=0.25')), t(` ${N.inlineEnd}`)),

  // An oMath alone in its paragraph, without an oMathPara: inline per B12.
  lead(N.aloneLead),
  p(oMath(sup(r('e'), r('−λt')))),

  // Math in a footnote and an endnote.
  p(t(N.footnoteLead), noteRef('footnote', 1), t('.')),
  p(t(N.endnoteLead), noteRef('endnote', 1), t('.')),

  // An element no Word version writes.
  lead(N.unknownLead),
  display(r('S='), '<m:futureScript><m:e>' + r('a') + r('+') + r('b') + '</m:e></m:futureScript>'),

  // m:brk: manual line breaks, unaligned and lined up on the equals sign.
  lead(N.broken),
  display(r('T=') + sub(r('f'), r('1')) + r('+') + sub(r('f'), r('2')), brk('+'), sub(r('f'), r('3')) + r('+') + sub(r('f'), r('4')), brk('+'), sub(r('f'), r('5'))),
  display(r('S=') + frac(r('a'), r('2')), brk('+b', 1), brk('+c', 1)),

  // m:mcJc: column alignment, mixed and all one way.
  lead(N.columns),
  display(
    d([val('begChr', '['), val('endChr', ']')], matrix([[r('1'), r('120')], [r('15'), r('8')]], [['1', 'left'], ['1', 'right']])), comma,
    d([], matrix([[r('7'), r('30')], [r('120'), r('4')]], [['2', 'right']])),
  ),

  // borderBox with some sides hidden and a horizontal strike; ⟦⟧.
  lead(N.sides),
  display(
    box(['hideTop', 'hideBot'], r('a+b')), comma,
    box(['hideTop', 'hideLeft', 'hideRight'], r('c')), comma,
    box(['hideTop', 'hideBot', 'hideLeft', 'hideRight', 'strikeH'], r('d')), comma,
    d([val('begChr', '⟦'), val('endChr', '⟧')], r('x+1')),
  ),

  // The math namespace bound to another prefix (declared on the equation).
  lead(N.otherPrefix),
  `<w:p><q:oMathPara xmlns:q="http://schemas.openxmlformats.org/officeDocument/2006/math"><q:oMath><q:sSup><q:e><q:r><q:t>r</q:t></q:r></q:e><q:sup><q:r><q:t>2</q:t></q:r></q:sup></q:sSup><q:r><q:t>=4</q:t></q:r></q:oMath></q:oMathPara></w:p>`,

  lead(N.closing),
].join('')

const footnotes = [p(t(`${N.footnote} `), oMath(r('12×'), sub(r('m'), r('i'))), t(` ${N.footnoteEnd}`))]
const endnotes = [p(t(N.endnote)) + display(nary([val('chr', '∑'), val('limLoc', 'undOvr')], r('i=1'), r('30'), sub(r('d'), r('i'))))]

const bytes = await buildDocx({ body, footnotes, endnotes })
writeFileSync(OUT, bytes)
console.log(`wrote ${OUT}`)
