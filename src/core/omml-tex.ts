/**
 * Word equations (Office Math Markup Language, the `m:` namespace) as TeX
 * (spec B12, plan step 19).
 *
 * The hub has one math form, TeX (B1), and MathJax draws it in every target and
 * in the editor (step 18), so a Word equation is turned into TeX once, here,
 * and from then on it is a formula like any other. The TeX is written for
 * MathJax with the packages step 18 enables (ams, mathtools, cancel,
 * textmacros…); nothing here needs `\require`.
 *
 * What is mapped is the table in B12, element by element. An element this file
 * does not know is never dropped: it becomes its linear text (its `m:t` runs in
 * order) and is reported, so the reader can raise one notice per document.
 *
 * Elements are matched by their prefixed names (`m:f`, `w:rPr`), the prefixes
 * Word, LibreOffice and Google Docs all write.
 */
import { parseDocument } from 'htmlparser2'
import { Element, type AnyNode } from 'domhandler'

export interface OmmlTex {
  /** The equation as TeX ('' for an empty one). */
  tex: string
  /** Names of the elements that were not understood and became linear text. */
  unknown: string[]
}

interface Ctx {
  display: boolean
  unknown: string[]
  /** Inside an `m:eqArr` row: `&` is an alignment mark, not an ampersand. */
  align: boolean
  /** Inside `m:fName`: a run of letters is a function name (`\sin`, `\operatorname{…}`). */
  fname: boolean
}

/**
 * Convert one `m:oMathPara` or `m:oMath` (as XML). `display` says whether the
 * equation stands on a line of its own, which only changes where n-ary limits
 * go (Word's inline equations keep them at the side, as TeX's do).
 */
export function ommlToTex(xml: string, opts: { display?: boolean } = {}): OmmlTex {
  const root = parseDocument(xml, { xmlMode: true, decodeEntities: true })
  const ctx: Ctx = { display: opts.display ?? false, unknown: [], align: false, fname: false }
  const tex = seq(root.children, ctx).trim()
  return { tex, unknown: ctx.unknown }
}

/** All `m:t` (and `w:t`) text of an OMML fragment, in order: an equation's linear text. */
export function ommlLinearText(xml: string): string {
  const root = parseDocument(xml, { xmlMode: true, decodeEntities: true })
  return linearText(root.children)
}

/* -------------------------------------------------------------------------- */
/* Tree helpers                                                                */
/* -------------------------------------------------------------------------- */

const elements = (nodes: AnyNode[]): Element[] => nodes.filter((n): n is Element => n instanceof Element)

const child = (el: Element | undefined, name: string): Element | undefined =>
  el ? elements(el.children).find((c) => c.name === name) : undefined

const childrenNamed = (el: Element, name: string): Element[] => elements(el.children).filter((c) => c.name === name)

/** `m:val` of `<pr><name m:val="…"/></pr>`; undefined when the property is absent. */
function prop(el: Element, pr: string, name: string): string | undefined {
  const p = child(child(el, pr), name)
  if (!p) return undefined
  return p.attribs['m:val'] ?? p.attribs['w:val'] ?? p.attribs.val ?? ''
}

/** An OMML on/off property: present with no value, or with 1/on/true, is on. */
function flag(el: Element, pr: string, name: string): boolean {
  const v = prop(el, pr, name)
  return v !== undefined && !/^(0|off|false)$/i.test(v)
}

function linearText(nodes: AnyNode[]): string {
  let out = ''
  for (const n of elements(nodes)) {
    if (n.name === 'm:t' || n.name === 'w:t') out += textOf(n)
    else if (!PROPERTIES.test(n.name)) out += linearText(n.children)
  }
  return out
}

function textOf(el: Element): string {
  let s = ''
  for (const c of el.children) if (c.type === 'text') s += (c as unknown as { data: string }).data
  return s
}

/* -------------------------------------------------------------------------- */
/* Joining TeX                                                                 */
/* -------------------------------------------------------------------------- */

/** Concatenate TeX, with a space only where a control word would run into a letter. */
function join(parts: string[]): string {
  let out = ''
  for (const p of parts) {
    if (!p) continue
    if (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(p)) out += ' '
    out += p
  }
  return out
}

/** A single token needs no braces as a script base or accent argument. */
function isToken(tex: string): boolean {
  return /^(\\[A-Za-z]+|\\[^A-Za-z]|[A-Za-z0-9])$/.test(tex) || [...tex].length === 1
}

const base = (tex: string): string => (tex === '' ? '{}' : isToken(tex) ? tex : `{${tex}}`)

/* -------------------------------------------------------------------------- */
/* Elements                                                                    */
/* -------------------------------------------------------------------------- */

/** Property elements: they shape their parent and are read there. */
const PROPERTIES = /Pr$/

/** WordprocessingML bookkeeping that can sit in an equation and has no content. */
const IGNORED = /^w:(bookmarkStart|bookmarkEnd|proofErr|permStart|permEnd|commentRangeStart|commentRangeEnd|commentReference|moveFromRangeStart|moveFromRangeEnd|moveToRangeStart|moveToRangeEnd|del|moveFrom|lastRenderedPageBreak|noBreakHyphen)$/

/** Elements whose content is simply their children in order. */
const CONTAINERS = new Set([
  'm:oMath',
  'm:e',
  'm:num',
  'm:den',
  'm:sub',
  'm:sup',
  'm:deg',
  'm:lim',
  'm:fName',
  'm:box',
  'w:ins',
  'w:moveTo',
  'w:hyperlink',
  'w:smartTag',
  'w:sdt',
  'w:sdtContent',
  'w:customXml',
])

function seq(nodes: AnyNode[], ctx: Ctx): string {
  return join(elements(nodes).map((el) => conv(el, ctx)))
}

/** The content of a named argument (`m:e`, `m:num`…) of `el`. */
const arg = (el: Element, name: string, ctx: Ctx): string => {
  const a = child(el, name)
  return a ? seq(a.children, ctx) : ''
}

function conv(el: Element, ctx: Ctx): string {
  const name = el.name
  if (PROPERTIES.test(name) || IGNORED.test(name)) return ''
  if (CONTAINERS.has(name)) return seq(el.children, ctx)
  switch (name) {
    case 'm:oMathPara':
      return oMathPara(el, ctx)
    case 'm:r':
      return run(el, ctx)
    case 'w:r':
      return wordRun(el)
    case 'm:f':
      return fraction(el, ctx)
    case 'm:sSup':
      return `${base(arg(el, 'm:e', ctx))}^{${arg(el, 'm:sup', { ...ctx, fname: false })}}`
    case 'm:sSub':
      return `${base(arg(el, 'm:e', ctx))}_{${arg(el, 'm:sub', { ...ctx, fname: false })}}`
    case 'm:sSubSup': {
      const inner = { ...ctx, fname: false }
      return `${base(arg(el, 'm:e', ctx))}_{${arg(el, 'm:sub', inner)}}^{${arg(el, 'm:sup', inner)}}`
    }
    case 'm:sPre':
      return join([`{}_{${arg(el, 'm:sub', ctx)}}^{${arg(el, 'm:sup', ctx)}}`, base(arg(el, 'm:e', ctx))])
    case 'm:rad':
      return radical(el, ctx)
    case 'm:nary':
      return nary(el, ctx)
    case 'm:d':
      return delimiter(el, ctx)
    case 'm:m':
      return `\\begin{matrix}${matrixRows(el, ctx)}\\end{matrix}`
    case 'm:eqArr':
      return eqArr(el, ctx)
    case 'm:func':
      return join([arg(el, 'm:fName', { ...ctx, fname: true }), arg(el, 'm:e', { ...ctx, fname: false })])
    case 'm:limLow':
      return limit(el, ctx, 'low')
    case 'm:limUpp':
      return limit(el, ctx, 'upp')
    case 'm:acc':
      return accent(el, ctx)
    case 'm:bar':
      return `${prop(el, 'm:barPr', 'm:pos') === 'top' ? '\\overline' : '\\underline'}{${arg(el, 'm:e', ctx)}}`
    case 'm:groupChr':
      return groupChr(el, ctx)
    case 'm:borderBox':
      return borderBox(el, ctx)
    case 'm:phant':
      return phantom(el, ctx)
    default:
      // Not understood: its linear text, so nothing is lost, and reported.
      ctx.unknown.push(name)
      return mathText(linearText(el.children), ctx)
  }
}

function oMathPara(el: Element, ctx: Ctx): string {
  const lines = childrenNamed(el, 'm:oMath').map((m) => seq(m.children, ctx).trim()).filter(Boolean)
  // Anything else directly inside (rare) is kept rather than dropped.
  const rest = elements(el.children).filter((c) => c.name !== 'm:oMath')
  const extra = seq(rest, ctx)
  if (extra) lines.push(extra)
  if (lines.length <= 1) return lines[0] ?? ''
  // Word puts each m:oMath of a math paragraph on a line of its own.
  return `\\begin{gathered}${lines.join('\\\\')}\\end{gathered}`
}

/* -- runs ------------------------------------------------------------------- */

/** Function names TeX has a command for (amsmath's operator names). */
const KNOWN_FUNCTIONS = new Set(
  (
    'sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth sech csch ' +
    'log ln lg exp lim liminf limsup max min sup inf det dim ker deg gcd arg hom Pr'
  ).split(' '),
)

function run(el: Element, ctx: Ctx): string {
  const wrPr = child(el, 'w:rPr')
  // A tracked deletion inside an equation is history, not content.
  if (wrPr && child(wrPr, 'w:del')) return ''
  let text = ''
  for (const c of elements(el.children)) {
    if (c.name === 'm:t' || c.name === 'w:t') text += textOf(c)
    else if (c.name === 'w:tab') text += ' '
  }
  const rPr = child(el, 'm:rPr')
  const normal = rPr ? flag(el, 'm:rPr', 'm:nor') : false
  const sty = rPr ? prop(el, 'm:rPr', 'm:sty') : undefined
  const scr = rPr ? prop(el, 'm:rPr', 'm:scr') : undefined
  const mark = ctx.align && rPr && child(rPr, 'm:aln') ? '&' : ''
  if (text === '') return mark

  if (ctx.fname && !normal) {
    const t = text.trim()
    if (KNOWN_FUNCTIONS.has(t)) return mark + `\\${t}`
    if (/^[A-Za-z]{2,}$/.test(t)) return mark + `\\operatorname{${t}}`
  }
  const bold = sty === 'b' || sty === 'bi'
  // "Normal text" (m:nor), and plain-style words with spaces ("if ", " otherwise"),
  // are prose inside the equation: text mode keeps their spaces and upright shape.
  if (normal || (sty === 'p' && /[A-Za-z]/.test(text) && / /.test(text))) {
    const cmd = bold ? '\\textbf' : '\\text'
    return mark + `${cmd}{${textModeText(text, ctx, cmd)}}`.replace(/\\text(bf)?\{\}/g, '')
  }
  return mark + styled(mathText(text, ctx), text, sty, scr)
}

/** A WordprocessingML run inside an equation: ordinary text. */
function wordRun(el: Element): string {
  if (child(el, 'w:rPr') && child(child(el, 'w:rPr')!, 'w:del')) return ''
  const text = elements(el.children)
    .filter((c) => c.name === 'w:t')
    .map(textOf)
    .join('')
  return text ? `\\text{${textModeText(text, { align: false })}}` : ''
}

const SCRIPTS: Record<string, string> = {
  'double-struck': '\\mathbb',
  script: '\\mathcal',
  fraktur: '\\mathfrak',
  'sans-serif': '\\mathsf',
  monospace: '\\mathtt',
}

/** Apply a run's style (m:sty) and script (m:scr) to its TeX, when it holds letters. */
function styled(tex: string, text: string, sty: string | undefined, scr: string | undefined): string {
  if (!/[A-Za-zͰ-Ͽ]/.test(text) || tex === '') return tex
  let out = tex
  const script = scr ? SCRIPTS[scr] : undefined
  if (script) out = `${script}{${out}}`
  if (script) {
    if (sty === 'b' || sty === 'bi') out = `\\boldsymbol{${out}}`
    return out
  }
  if (sty === 'p') return `\\mathrm{${out}}`
  if (sty === 'b') return `\\mathbf{${out}}`
  if (sty === 'bi') return `\\boldsymbol{${out}}`
  return out
}

/* -- characters ------------------------------------------------------------- */

const GREEK: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'varepsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta',
  θ: 'theta', ϑ: 'vartheta', ι: 'iota', κ: 'kappa', ϰ: 'varkappa', λ: 'lambda', μ: 'mu', ν: 'nu',
  ξ: 'xi', π: 'pi', ϖ: 'varpi', ρ: 'rho', ϱ: 'varrho', σ: 'sigma', ς: 'varsigma', τ: 'tau',
  υ: 'upsilon', φ: 'varphi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
  Γ: 'Gamma', Δ: 'Delta', Θ: 'Theta', Λ: 'Lambda', Ξ: 'Xi', Π: 'Pi', Σ: 'Sigma', Υ: 'Upsilon',
  Φ: 'Phi', Ψ: 'Psi', Ω: 'Omega', ϝ: 'digamma',
}

/** Capital Greek letters that look like Latin ones: TeX has no command, so upright Latin. */
const GREEK_LATIN: Record<string, string> = {
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X',
}

/** Operators, relations, arrows and other symbols with a TeX command. */
const SYMBOLS: Record<string, string> = {
  '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '⋅': '\\cdot', '·': '\\cdot', '∘': '\\circ',
  '∗': '\\ast', '⋆': '\\star', '•': '\\bullet', '∙': '\\bullet', '⊕': '\\oplus', '⊖': '\\ominus',
  '⊗': '\\otimes', '⊘': '\\oslash', '⊙': '\\odot', '∖': '\\setminus', '≀': '\\wr', '⊎': '\\uplus',
  '⊓': '\\sqcap', '⊔': '\\sqcup', '△': '\\triangle', '▽': '\\triangledown',
  '∞': '\\infty', '∂': '\\partial', '∇': '\\nabla', '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists',
  '∄': '\\nexists', '¬': '\\neg', '∧': '\\wedge', '∨': '\\vee', '∠': '\\angle', '∡': '\\measuredangle',
  '⊥': '\\perp', '∥': '\\parallel', '∦': '\\nparallel', '∣': '\\mid', '∤': '\\nmid', 'ℏ': '\\hbar',
  'ℓ': '\\ell', '℘': '\\wp', 'ℵ': '\\aleph', 'ℶ': '\\beth', 'ℑ': '\\Im', 'ℜ': '\\Re', '′': "'",
  '″': "''", '‴': "'''", '°': '^{\\circ}', '∴': '\\therefore', '∵': '\\because', '…': '\\ldots',
  '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots', '√': '\\surd', '†': '\\dagger', '‡': '\\ddagger',
  '♠': '\\spadesuit', '♣': '\\clubsuit', '♡': '\\heartsuit', '♢': '\\diamondsuit', '◊': '\\lozenge',
  '⊤': '\\top', '⊢': '\\vdash', '⊣': '\\dashv', '⊨': '\\models', '⟂': '\\perp',
  '≤': '\\le', '≥': '\\ge', '≦': '\\leqq', '≧': '\\geqq', '≠': '\\ne', '≈': '\\approx', '≡': '\\equiv',
  '≢': '\\not\\equiv', '∼': '\\sim', '≃': '\\simeq', '≅': '\\cong', '≆': '\\ncong', '≉': '\\not\\approx',
  '∝': '\\propto', '≪': '\\ll', '≫': '\\gg', '≺': '\\prec', '≻': '\\succ', '≼': '\\preceq',
  '≽': '\\succeq', '≐': '\\doteq', '≜': '\\triangleq', '≝': '\\stackrel{\\text{def}}{=}', '≔': '\\coloneqq',
  '≮': '\\nless', '≯': '\\ngtr', '≰': '\\nleq', '≱': '\\ngeq', '≍': '\\asymp', '≲': '\\lesssim',
  '≳': '\\gtrsim', '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '∌': '\\not\\ni', '⊂': '\\subset',
  '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq', '⊄': '\\not\\subset', '⊈': '\\nsubseteq',
  '⊉': '\\nsupseteq', '⊊': '\\subsetneq', '⊋': '\\supsetneq', '⊏': '\\sqsubset', '⊐': '\\sqsupset',
  '⊑': '\\sqsubseteq', '⊒': '\\sqsupseteq', '∪': '\\cup', '∩': '\\cap',
  '→': '\\rightarrow', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↦': '\\mapsto', '↑': '\\uparrow', '↓': '\\downarrow',
  '↕': '\\updownarrow', '⇑': '\\Uparrow', '⇓': '\\Downarrow', '⇕': '\\Updownarrow', '⟶': '\\longrightarrow',
  '⟵': '\\longleftarrow', '⟷': '\\longleftrightarrow', '⟹': '\\Longrightarrow', '⟸': '\\Longleftarrow',
  '⟺': '\\Longleftrightarrow', '⟼': '\\longmapsto', '↗': '\\nearrow', '↘': '\\searrow', '↙': '\\swarrow',
  '↖': '\\nwarrow', '↪': '\\hookrightarrow', '↩': '\\hookleftarrow', '⇀': '\\rightharpoonup',
  '↼': '\\leftharpoonup', '⇌': '\\rightleftharpoons', '↠': '\\twoheadrightarrow', '⇝': '\\leadsto',
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint',
  '∮': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge',
  '⟨': '\\langle', '⟩': '\\rangle', '〈': '\\langle', '〉': '\\rangle', '⌈': '\\lceil', '⌉': '\\rceil',
  '⌊': '\\lfloor', '⌋': '\\rfloor', '‖': '\\|',
  'ℂ': '\\mathbb{C}', 'ℍ': '\\mathbb{H}', 'ℕ': '\\mathbb{N}', 'ℙ': '\\mathbb{P}', 'ℚ': '\\mathbb{Q}',
  'ℝ': '\\mathbb{R}', 'ℤ': '\\mathbb{Z}', 'ℎ': 'h', 'ℬ': '\\mathcal{B}', 'ℰ': '\\mathcal{E}',
  'ℱ': '\\mathcal{F}', 'ℋ': '\\mathcal{H}', 'ℐ': '\\mathcal{I}', 'ℒ': '\\mathcal{L}', 'ℳ': '\\mathcal{M}',
  'ℛ': '\\mathcal{R}', 'ℭ': '\\mathfrak{C}', 'ℌ': '\\mathfrak{H}', 'ℨ': '\\mathfrak{Z}',
  '−': '-', '∶': ':', '∕': '/',
  // TeX specials typed as text.
  '{': '\\{', '}': '\\}', '%': '\\%', '#': '\\#', $: '\\$', _: '\\_', '\\': '\\backslash',
  '^': '\\hat{}', '~': '\\sim', ' ': '~',
  // Word's spacing characters, as TeX's spaces.
  ' ': '\\quad', ' ': '\\qquad', ' ': '\\enspace', ' ': '\\;', ' ': '\\:',
  ' ': '\\:', ' ': '\\,', ' ': '\\,', ' ': '\\,',
}

/** Characters that draw nothing: function application, invisible times/separator/plus, zero width. */
const INVISIBLE = /[⁡-⁤​‌‍﻿]/

/**
 * The mathematical alphanumeric symbols (U+1D400…U+1D7FF): each style block
 * of 52 Latin letters, A–Z then a–z, with the command it maps back to.
 * Italic is TeX's own default for letters, so it maps to the plain letter.
 */
const LATIN_BLOCKS: Array<[number, string]> = [
  [0x1d400, '\\mathbf'],
  [0x1d434, ''],
  [0x1d468, '\\boldsymbol'],
  [0x1d49c, '\\mathcal'],
  [0x1d4d0, '\\mathcal'],
  [0x1d504, '\\mathfrak'],
  [0x1d538, '\\mathbb'],
  [0x1d56c, '\\mathfrak'],
  [0x1d5a0, '\\mathsf'],
  [0x1d5d4, '\\mathsf'],
  [0x1d608, '\\mathsf'],
  [0x1d63c, '\\mathsf'],
  [0x1d670, '\\mathtt'],
]
/** Bold variants of the blocks above, wrapped in \boldsymbol as well. */
const BOLD_BLOCKS = new Set([0x1d4d0, 0x1d56c, 0x1d5d4, 0x1d63c])
/** The Greek order of each mathematical Greek block (58 code points). */
const GREEK_ORDER = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡϴΣΤΥΦΧΨΩ∇αβγδεζηθικλμνξοπρςστυφχψω∂ϵϑϰϕϱϖ'
const GREEK_BLOCKS: Array<[number, string]> = [
  [0x1d6a8, '\\boldsymbol'],
  [0x1d6e2, ''],
  [0x1d71c, '\\boldsymbol'],
  [0x1d756, '\\boldsymbol'],
  [0x1d790, '\\boldsymbol'],
]
const DIGIT_BLOCKS: Array<[number, string]> = [
  [0x1d7ce, '\\mathbf'],
  [0x1d7d8, '\\mathbb'],
  [0x1d7e2, '\\mathsf'],
  [0x1d7ec, '\\mathsf'],
  [0x1d7f6, '\\mathtt'],
]

function alphanumeric(cp: number): string | undefined {
  if (cp < 0x1d400 || cp > 0x1d7ff) return undefined
  for (const [start, cmd] of LATIN_BLOCKS) {
    if (cp >= start && cp < start + 52) {
      const i = cp - start
      const letter = String.fromCharCode(i < 26 ? 65 + i : 97 + i - 26)
      let out = cmd ? `${cmd}{${letter}}` : letter
      if (BOLD_BLOCKS.has(start)) out = `\\boldsymbol{${out}}`
      return out
    }
  }
  for (const [start, cmd] of GREEK_BLOCKS) {
    if (cp >= start && cp < start + 58) {
      const ch = [...GREEK_ORDER][cp - start]
      const tex = char(ch)
      return cmd ? `${cmd}{${tex}}` : tex
    }
  }
  for (const [start, cmd] of DIGIT_BLOCKS) {
    if (cp >= start && cp < start + 10) return `${cmd}{${cp - start}}`
  }
  if (cp === 0x1d6a4) return '\\imath'
  if (cp === 0x1d6a5) return '\\jmath'
  return undefined
}

/** One character as math-mode TeX. */
function char(ch: string): string {
  const g = GREEK[ch]
  if (g) return `\\${g}`
  const l = GREEK_LATIN[ch]
  if (l) return `\\mathrm{${l}}`
  const s = SYMBOLS[ch]
  if (s !== undefined) return s
  if (INVISIBLE.test(ch)) return ''
  const a = alphanumeric(ch.codePointAt(0)!)
  if (a !== undefined) return a
  // Everything else as Unicode: MathJax reads it.
  return ch
}

/** Text from an `m:t` as math-mode TeX. */
function mathText(text: string, ctx: Pick<Ctx, 'align'>): string {
  const parts: string[] = []
  for (const ch of text) {
    if (ch === '&') parts.push(ctx.align ? '&' : '\\&')
    else if (ch === ' ') parts.push('\\ ')
    else parts.push(char(ch))
  }
  return join(parts)
}

/**
 * The TeX specials in text mode. MathJax's textmacros escapes most of them;
 * a backslash, caret and tilde have no text-mode form there, so the text is
 * closed around their math-mode symbols (`close` is the text command's end
 * and restart).
 */
const TEXT_MODE: Record<string, string> = {
  '{': '\\{', '}': '\\}', $: '\\$', '%': '\\%', '#': '\\#', _: '\\_',
}
const TEXT_AS_MATH: Record<string, string> = { '\\': '\\backslash', '^': '\\hat{}', '~': '\\sim' }

/** Text for `\text{…}` (or `cmd{…}`): the text-mode specials escaped. */
function textModeText(text: string, ctx: Pick<Ctx, 'align'>, cmd = '\\text'): string {
  let out = ''
  for (const ch of text) {
    if (ch === '&') out += ctx.align ? `}&${cmd}{` : '\\&'
    else if (INVISIBLE.test(ch)) continue
    else if (TEXT_AS_MATH[ch]) out += `}${TEXT_AS_MATH[ch]}${cmd}{`
    else out += TEXT_MODE[ch] ?? ch
  }
  return out
}

/* -- structures ------------------------------------------------------------- */

function fraction(el: Element, ctx: Ctx): string {
  const num = arg(el, 'm:num', ctx)
  const den = arg(el, 'm:den', ctx)
  switch (prop(el, 'm:fPr', 'm:type')) {
    case 'lin':
      return `${base(num)}/${base(den)}`
    case 'skw':
      return `{}^{${num}}\\!/\\!{}_{${den}}`
    case 'noBar':
      return `\\genfrac{}{}{0pt}{}{${num}}{${den}}`
    default:
      return `\\frac{${num}}{${den}}`
  }
}

function radical(el: Element, ctx: Ctx): string {
  const body = arg(el, 'm:e', ctx)
  const deg = flag(el, 'm:radPr', 'm:degHide') ? '' : arg(el, 'm:deg', ctx)
  return deg ? `\\sqrt[${deg}]{${body}}` : `\\sqrt{${body}}`
}

const NARY: Record<string, string> = {
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint',
  '⨌': '\\iiiint', '∮': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap',
  '⋁': '\\bigvee', '⋀': '\\bigwedge', '⨁': '\\bigoplus', '⨂': '\\bigotimes', '⨀': '\\bigodot',
  '⨄': '\\biguplus', '⨆': '\\bigsqcup',
}
/** Integrals: TeX puts their limits at the side even in display. */
const INTEGRALS = new Set(['∫', '∬', '∭', '⨌', '∮', '∯', '∰', '∱', '∲', '∳'])

function nary(el: Element, ctx: Ctx): string {
  // OMML's default operator, when m:chr is absent, is the integral.
  const chr = prop(el, 'm:naryPr', 'm:chr') || '∫'
  const op = NARY[chr] ?? `\\mathop{${char(chr)}}`
  const loc = prop(el, 'm:naryPr', 'm:limLoc')
  let limits = ''
  // Only a display equation moves limits: inline, Word keeps them at the side
  // as TeX does. In display, say so only where TeX's own default differs.
  if (ctx.display && loc === 'undOvr' && (INTEGRALS.has(chr) || !NARY[chr])) limits = '\\limits'
  if (ctx.display && loc === 'subSup' && !INTEGRALS.has(chr)) limits = '\\nolimits'
  const inner = { ...ctx, fname: false }
  const sub = flag(el, 'm:naryPr', 'm:subHide') ? '' : arg(el, 'm:sub', inner)
  const sup = flag(el, 'm:naryPr', 'm:supHide') ? '' : arg(el, 'm:sup', inner)
  const head = `${op}${limits}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''}`
  return join([head, arg(el, 'm:e', inner)])
}

/** A delimiter character as the argument of `\left`/`\right`/`\middle`. */
const DELIMS: Record<string, string> = {
  '': '.', '(': '(', ')': ')', '[': '[', ']': ']', '{': '\\{', '}': '\\}', '|': '|', '/': '/',
  '\\': '\\backslash', '⟨': '\\langle', '⟩': '\\rangle', '〈': '\\langle', '〉': '\\rangle',
  '<': '\\langle', '>': '\\rangle', '‖': '\\|', '∥': '\\|', '⌈': '\\lceil', '⌉': '\\rceil',
  '⌊': '\\lfloor', '⌋': '\\rfloor', '↑': '\\uparrow', '↓': '\\downarrow', '↕': '\\updownarrow',
  '⇑': '\\Uparrow', '⇓': '\\Downarrow', '⇕': '\\Updownarrow', '⟦': '[', '⟧': ']', '│': '|',
  '∣': '|',
}
const delim = (ch: string): string => DELIMS[ch] ?? '.'

/** begChr+endChr pairs that have their own matrix environment. */
const MATRIX_ENV: Record<string, string> = {
  '()': 'pmatrix', '[]': 'bmatrix', '{}': 'Bmatrix', '||': 'vmatrix', '‖‖': 'Vmatrix', '∥∥': 'Vmatrix',
}

/** The single structure an `m:e` holds, if it holds exactly one element of that name. */
function only(e: Element | undefined, name: string): Element | undefined {
  if (!e) return undefined
  const kids = elements(e.children).filter((c) => !PROPERTIES.test(c.name) && !IGNORED.test(c.name))
  return kids.length === 1 && kids[0].name === name ? kids[0] : undefined
}

function delimiter(el: Element, ctx: Ctx): string {
  // Absent: OMML's defaults, parentheses and a bar. Present but empty: none.
  const beg = prop(el, 'm:dPr', 'm:begChr') ?? '('
  const end = prop(el, 'm:dPr', 'm:endChr') ?? ')'
  const sep = prop(el, 'm:dPr', 'm:sepChr') ?? '|'
  const args = childrenNamed(el, 'm:e')
  if (args.length === 1) {
    const matrix = only(args[0], 'm:m')
    const env = matrix ? MATRIX_ENV[beg + end] : undefined
    if (matrix && env) return `\\begin{${env}}${matrixRows(matrix, ctx)}\\end{${env}}`
    // A brace on the left alone round an equation array is a case split.
    const arr = only(args[0], 'm:eqArr')
    if (arr && beg === '{' && end === '') {
      const rows = eqArrRows(arr, ctx)
      if (rows.every((r) => alignMarks(r) <= 1)) return `\\begin{cases}${rows.join('\\\\')}\\end{cases}`
    }
  }
  const middle = sep === '' ? '' : `\\middle${delim(sep)}`
  const inner = args.map((a) => seq(a.children, ctx)).join(middle)
  return join([`\\left${delim(beg)}`, inner, `\\right${delim(end)}`])
}

function matrixRows(el: Element, ctx: Ctx): string {
  const inner = { ...ctx, align: false }
  return childrenNamed(el, 'm:mr')
    .map((row) => childrenNamed(row, 'm:e').map((cell) => seq(cell.children, inner)).join('&'))
    .join('\\\\')
}

/** Alignment marks (unescaped `&`) in a row of TeX. */
const alignMarks = (tex: string): number => (tex.match(/(?<!\\)&/g) ?? []).length

function eqArrRows(el: Element, ctx: Ctx): string[] {
  const inner = { ...ctx, align: true }
  return childrenNamed(el, 'm:e').map((row) => seq(row.children, inner))
}

function eqArr(el: Element, ctx: Ctx): string {
  const rows = eqArrRows(el, ctx)
  // Rows with alignment marks line up on them; rows without are centered.
  const env = rows.some((r) => alignMarks(r) > 0) ? 'aligned' : 'gathered'
  return `\\begin{${env}}${rows.join('\\\\')}\\end{${env}}`
}

/** Bases that take their limits as scripts: function names and big operators. */
const TAKES_LIMITS = /^\\(lim|liminf|limsup|max|min|sup|inf|det|gcd|Pr|sum|prod|coprod|bigcup|bigcap|bigvee|bigwedge|bigoplus|bigotimes|bigodot|biguplus|bigsqcup)$/

function limit(el: Element, ctx: Ctx, side: 'low' | 'upp'): string {
  let body = arg(el, 'm:e', ctx)
  const lim = arg(el, 'm:lim', { ...ctx, fname: false })
  const script = side === 'low' ? '_' : '^'
  const group = only(child(el, 'm:e'), 'm:groupChr')
  const braced = group && /^\\(underbrace|overbrace)\{/.test(body)
  const op = /^\\operatorname\{([^{}]*)\}$/.exec(body)
  if (op) body = `\\operatorname*{${op[1]}}`
  if (TAKES_LIMITS.test(body) || op || braced) return `${body}${script}{${lim}}`
  return side === 'low' ? `\\underset{${lim}}{${body}}` : `\\overset{${lim}}{${body}}`
}

/** Accent characters (combining and spacing forms): [one-letter command, wide command]. */
const ACCENTS: Record<string, [string, string]> = {
  '̂': ['\\hat', '\\widehat'], '^': ['\\hat', '\\widehat'], 'ˆ': ['\\hat', '\\widehat'],
  '̃': ['\\tilde', '\\widetilde'], '~': ['\\tilde', '\\widetilde'], '˜': ['\\tilde', '\\widetilde'],
  '̇': ['\\dot', '\\dot'], '˙': ['\\dot', '\\dot'],
  '̈': ['\\ddot', '\\ddot'], '¨': ['\\ddot', '\\ddot'],
  '⃛': ['\\dddot', '\\dddot'], '⃜': ['\\ddddot', '\\ddddot'],
  '⃗': ['\\vec', '\\overrightarrow'], '→': ['\\vec', '\\overrightarrow'],
  '⃖': ['\\overleftarrow', '\\overleftarrow'], '←': ['\\overleftarrow', '\\overleftarrow'],
  '⃡': ['\\overleftrightarrow', '\\overleftrightarrow'], '↔': ['\\overleftrightarrow', '\\overleftrightarrow'],
  '̄': ['\\bar', '\\overline'], '¯': ['\\bar', '\\overline'], '̅': ['\\overline', '\\overline'],
  '̆': ['\\breve', '\\breve'], '˘': ['\\breve', '\\breve'],
  '̌': ['\\check', '\\check'], 'ˇ': ['\\check', '\\check'],
  '́': ['\\acute', '\\acute'], '´': ['\\acute', '\\acute'],
  '̀': ['\\grave', '\\grave'], '`': ['\\grave', '\\grave'],
  '̊': ['\\mathring', '\\mathring'], '˚': ['\\mathring', '\\mathring'],
  '\u20d1': ['\\overset{\\rightharpoonup}', '\\overset{\\rightharpoonup}'],
  '\u20d0': ['\\overset{\\leftharpoonup}', '\\overset{\\leftharpoonup}'],
}

function accent(el: Element, ctx: Ctx): string {
  // OMML's default accent, when m:chr is absent, is the circumflex.
  const chr = prop(el, 'm:accPr', 'm:chr') || '̂'
  const body = arg(el, 'm:e', ctx)
  const pair = ACCENTS[chr]
  if (!pair) return `\\overset{${char(chr)}}{${body}}`
  return `${isToken(body) ? pair[0] : pair[1]}{${body}}`
}

function groupChr(el: Element, ctx: Ctx): string {
  // OMML's defaults: a bottom curly bracket, below.
  const chr = prop(el, 'm:groupChrPr', 'm:chr') || '⏟'
  const top = (prop(el, 'm:groupChrPr', 'm:pos') ?? 'bot') === 'top'
  const body = arg(el, 'm:e', ctx)
  switch (chr) {
    case '⏟':
    case '︸':
      return `\\underbrace{${body}}`
    case '⏞':
    case '︷':
      return `\\overbrace{${body}}`
    case '→':
      return `${top ? '\\overrightarrow' : '\\underrightarrow'}{${body}}`
    case '←':
      return `${top ? '\\overleftarrow' : '\\underleftarrow'}{${body}}`
    case '↔':
      return `${top ? '\\overleftrightarrow' : '\\underleftrightarrow'}{${body}}`
    case '¯':
      return `\\overline{${body}}`
    case '_':
      return `\\underline{${body}}`
    default:
      return top ? `\\overset{${char(chr)}}{${body}}` : `\\underset{${char(chr)}}{${body}}`
  }
}

function borderBox(el: Element, ctx: Ctx): string {
  const body = arg(el, 'm:e', ctx)
  const on = (name: string): boolean => flag(el, 'm:borderBoxPr', name)
  const up = on('m:strikeBLTR')
  const down = on('m:strikeTLBR')
  const hidden = on('m:hideTop') && on('m:hideBot') && on('m:hideLeft') && on('m:hideRight')
  // A box with every side hidden is how Word draws a struck-out term alone.
  if (hidden) {
    if (up && down) return `\\xcancel{${body}}`
    if (up) return `\\cancel{${body}}`
    if (down) return `\\bcancel{${body}}`
    return body
  }
  return `\\boxed{${body}}`
}

function phantom(el: Element, ctx: Ctx): string {
  const body = arg(el, 'm:e', ctx)
  // m:show is on unless switched off: a phantom that shows is only a size change.
  const show = prop(el, 'm:phantPr', 'm:show')
  const shown = show === undefined || !/^(0|off|false)$/i.test(show)
  const zeroWid = flag(el, 'm:phantPr', 'm:zeroWid')
  const zeroHeight = flag(el, 'm:phantPr', 'm:zeroAsc') || flag(el, 'm:phantPr', 'm:zeroDesc')
  if (!shown) {
    if (zeroWid) return `\\vphantom{${body}}`
    if (zeroHeight) return `\\hphantom{${body}}`
    return `\\phantom{${body}}`
  }
  if (zeroHeight) return `\\smash{${body}}`
  if (zeroWid) return `\\mathrlap{${body}}`
  return body
}
