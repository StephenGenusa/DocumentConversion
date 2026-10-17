import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { parseDocument } from 'htmlparser2'
import { Element } from 'domhandler'
import { createConverter } from '../../src/core/convert'
import { detect } from '../../src/core/detect'
import { writeDocx } from '../../src/core/writers/docx'
import type { SourceFormat } from '../../src/core/types'

/*
 * The element order of the Word files we write, checked against the schema's
 * sequences: ISO/IEC 29500-4 wml.xsd (the transitional schema Word writes),
 * written out here for every element html-to-docx and our post-processing
 * put children in. html-to-docx wrote the body's w:sectPr first (the schema
 * has it last), a paragraph's w:jc before its w:spacing and w:ind, a table's
 * borders before its cell spacing and its w:jc last, border sides as the CSS
 * named them, and a w:tblGrid before the rows of each <thead> and <tbody>.
 * A strict reader rejects the part ("w:p is not expected"), and Word may
 * offer to repair the file.
 *
 * An element whose children the schema puts in a sequence must have only
 * children from its list, in its order; an element missing here holds
 * children the schema allows in any order (w:trPr, and w:rPr in the
 * transitional schema, which RPR still holds to the first edition's order).
 */

const SIDES = ['top', 'start', 'left', 'bottom', 'end', 'right', 'insideH', 'insideV']
const RPR = [
  'ins', 'del', 'moveFrom', 'moveTo', 'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike',
  'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w',
  'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em',
  'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange',
]
const PPR = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr',
  'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE',
  'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents',
  'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr',
  'sectPr', 'pPrChange',
]
/** Content that may come in any order and any number, as one step of a sequence. */
const BLOCKS = 'p|tbl|bookmarkStart|bookmarkEnd|sdt|customXml'
const RUNS = 'r|hyperlink|bookmarkStart|bookmarkEnd|fldSimple|proofErr|ins|del|smartTag|sdt|customXml'

const SEQUENCE: Record<string, string[]> = {
  document: ['background', 'body'],
  body: [BLOCKS, 'sectPr'],
  p: ['pPr', RUNS],
  hyperlink: [RUNS],
  r: ['rPr', 'br|t|tab|cr|drawing|pict|sym|footnoteReference|endnoteReference|fldChar|instrText|noBreakHyphen|softHyphen|lastRenderedPageBreak'],
  pPr: PPR,
  rPr: RPR,
  numPr: ['ilvl', 'numId', 'ins'],
  pBdr: ['top', 'left', 'bottom', 'right', 'between', 'bar'],
  tabs: ['tab'],
  sectPr: [
    'headerReference|footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders',
    'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter',
    'docGrid', 'printerSettings', 'sectPrChange',
  ],
  tbl: ['tblPr', 'tblGrid', 'tr'],
  tblPr: [
    'tblStyle', 'tblpPr', 'tblOverlap', 'bidiVisual', 'tblStyleRowBandSize', 'tblStyleColBandSize', 'tblW', 'jc',
    'tblCellSpacing', 'tblInd', 'tblBorders', 'shd', 'tblLayout', 'tblCellMar', 'tblLook', 'tblCaption', 'tblDescription',
    'tblPrChange',
  ],
  tblBorders: SIDES,
  tblCellMar: SIDES.slice(0, 6),
  tblGrid: ['gridCol'],
  tr: ['tblPrEx', 'trPr', 'tc'],
  tc: ['tcPr', BLOCKS],
  tcPr: [
    'cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar', 'textDirection', 'tcFitText',
    'vAlign', 'hideMark', 'headers', 'cellIns|cellDel|cellMerge', 'tcPrChange',
  ],
  tcBorders: [...SIDES, 'tl2br', 'tr2bl'],
  tcMar: SIDES.slice(0, 6),
  styles: ['docDefaults', 'latentStyles', 'style'],
  docDefaults: ['rPrDefault', 'pPrDefault'],
  rPrDefault: ['rPr'],
  pPrDefault: ['pPr'],
  style: [
    'name', 'aliases', 'basedOn', 'next', 'link', 'autoRedefine', 'hidden', 'uiPriority', 'semiHidden', 'unhideWhenUsed',
    'qFormat', 'locked', 'personal', 'personalCompose', 'personalReply', 'rsid', 'pPr', 'rPr', 'tblPr', 'trPr', 'tcPr',
    'tblStylePr',
  ],
  numbering: ['numPicBullet', 'abstractNum', 'num', 'numIdMacAtCleanup'],
  abstractNum: ['nsid', 'multiLevelType', 'tmpl', 'name', 'styleLink', 'numStyleLink', 'lvl'],
  lvl: ['start', 'numFmt', 'lvlRestart', 'pStyle', 'isLgl', 'suff', 'lvlText', 'lvlPicBulletId', 'legacy', 'lvlJc', 'pPr', 'rPr'],
  num: ['abstractNumId', 'lvlOverride'],
  fonts: ['font'],
  font: ['altName', 'panose1', 'charset', 'family', 'notTrueType', 'pitch', 'sig', 'embedRegular', 'embedBold', 'embedItalic', 'embedBoldItalic'],
}
/** Children the schema requires (minOccurs 1), each once. */
const ONCE: Record<string, string[]> = { tbl: ['tblPr', 'tblGrid'], document: ['body'] }
/** CT_Settings, as far as html-to-docx writes it. */
const SETTINGS = ['zoom', 'defaultTabStop', 'characterSpacingControl', 'compat', 'rsids', 'themeFontLang', 'decimalSymbol', 'listSeparator']

const W = 'w:'

/** Every element out of its schema order in one part, as "parent: child after previous". */
function orderProblems(xml: string): string[] {
  const problems: string[] = []
  const visit = (el: Element): void => {
    const name = el.name.startsWith(W) ? el.name.slice(W.length) : null
    const kids = el.children.filter((c): c is Element => c instanceof Element)
    const sequence = name === 'settings' ? SETTINGS : name ? SEQUENCE[name] : undefined
    if (sequence) {
      let at = 0
      for (const kid of kids) {
        if (!kid.name.startsWith(W)) continue
        const child = kid.name.slice(W.length)
        const step = sequence.findIndex((s) => s.split('|').includes(child))
        if (step < 0) problems.push(`${name}: ${child} is not one of its children here`)
        else if (step < at) problems.push(`${name}: ${child} after ${sequence[at]}`)
        else at = step
      }
      for (const needed of ONCE[name!] ?? []) {
        const count = kids.filter((k) => k.name === W + needed).length
        if (count !== 1) problems.push(`${name}: ${count} ${needed}`)
      }
    }
    kids.forEach(visit)
  }
  for (const node of parseDocument(xml, { xmlMode: true }).children) if (node instanceof Element) visit(node)
  return problems
}

const PARTS = ['word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml', 'word/fontTable.xml']

async function problemsOf(docx: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(docx)
  const out: string[] = []
  for (const part of PARTS) {
    const file = zip.file(part)
    if (file) out.push(...orderProblems(await file.async('string')).map((p) => `${part} ${p}`))
  }
  // CT_Types is a choice of Default and Override: any order.
  expect(await zip.file('[Content_Types].xml')!.async('string')).toMatch(/^<\?xml[^>]*>\s*<Types\b/)
  return [...new Set(out)]
}

describe('our Word files keep the schema order', () => {
  it('the checker catches what html-to-docx wrote out of order', () => {
    expect(orderProblems('<w:body><w:sectPr><w:pgSz/></w:sectPr><w:p/></w:body>')).toEqual(['body: p after sectPr'])
    expect(orderProblems('<w:pPr><w:jc/><w:spacing/></w:pPr>')).toEqual(['pPr: spacing after jc'])
    expect(orderProblems('<w:tbl><w:tblPr/><w:tblGrid/><w:tr/><w:tblGrid/></w:tbl>')).toEqual(['tbl: tblGrid after tr', 'tbl: 2 tblGrid'])
    expect(orderProblems('<w:tcBorders><w:top/><w:bottom/><w:left/></w:tcBorders>')).toEqual(['tcBorders: left after bottom'])
  })

  it('a document using every kind of formatting the writer carries', async () => {
    const png = readFileSync(join(__dirname, '../fixtures/sample.png')).toString('base64')
    const html =
      '<h1 style="color: red; text-align: center">Title <em>it</em></h1>' +
      '<p style="text-align: right; line-height: 1.5; margin-left: 20px; background-color: #eef">para <strong style="background-color: #abcdef">b</strong> <mark>m</mark> <u>u</u> <s>s</s> <sup>1</sup><sub>2</sub> <code>c</code> <a href="https://example.com/">link <b>bold</b></a></p>' +
      '<p style="display: block; background-color: yellow; font-size: 14pt; font-family: Arial">block shaded</p>' +
      '<blockquote>quote <i>x</i></blockquote>' +
      '<ul><li>one<ul><li>two <strong>bold</strong></li></ul></li><li><p>a</p><p>b</p></li></ul>' +
      '<ol><li>first</li><li>second<pre><code class="language-python">def f():\n    return 1</code></pre></li></ol>' +
      '<pre><code class="language-js">const x = 1 // hi</code></pre>' +
      '<table style="border-collapse: collapse; width: 80%; border: 2px solid blue"><colgroup><col style="width: 100px"><col></colgroup>' +
      '<thead><tr><th colspan="2" style="background-color: #ddd; vertical-align: bottom; border-top: 1px solid red; border-left: 2px dashed green">h</th><th>h3</th></tr></thead>' +
      '<tbody><tr><td rowspan="2" style="vertical-align: middle; width: 50px">r</td><td style="border-bottom: 1px solid red; border-right: 1px solid red; text-align: center">x</td><td>y</td></tr><tr><td colspan="2">z</td></tr></tbody></table>' +
      `<p>pic <img src="data:image/png;base64,${png}" alt="sample" width="60" height="12"> after</p>` +
      `<img src="data:image/png;base64,${png}" alt="sample2"><hr>` +
      '<h2>Footnote<sup><a href="#fn1" id="r1">1</a></sup></h2><ol class="footnotes"><li id="fn1">note <a href="#r1">back</a></li></ol>' +
      `<p><img src="data:image/png;base64,${png}" data-docx-lower="5" alt="f"> formula</p>`
    const docx = await writeDocx({ html, title: 'Order' })
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')
    // What the sample is there for: each of these was out of order before.
    for (const seen of ['<w:jc ', '<w:spacing ', '<w:ind ', '<w:pBdr>', '<w:tblCellSpacing ', '<w:position ', '<w:shd ', '<w:vAlign ']) expect(xml).toContain(seen)
    expect(xml).toMatch(/<\/w:p>\s*<w:sectPr>[\s\S]*<\/w:sectPr>\s*<\/w:body>/)
    expect(await problemsOf(docx)).toEqual([])
  })

  const dirs = [join(__dirname, '../fixtures'), join(__dirname, '../../tests/corpus')]
  const files = dirs.flatMap((dir) => readdirSync(dir).map((f) => join(dir, f))).filter((f) => statSync(f).isFile() && !f.endsWith('.mjs'))
  const converter = createConverter(async () => Buffer.from('%PDF-1.4'))
  // No text to write: a .doc of pictures only is refused (as the e2e matrix expects).
  const REFUSED = new Set(['picture-only-figure.doc'])

  it('every fixture converted to Word', async () => {
    const problems: string[] = []
    let written = 0
    for (const file of files) {
      const name = file.split('/').pop()!
      if (REFUSED.has(name)) continue
      const bytes = readFileSync(file)
      const found = detect(bytes, name)
      if (found.kind !== 'ok') continue
      const out = await converter.convert({ bytes, filename: name }, found.format as SourceFormat, 'docx')
      written++
      problems.push(...(await problemsOf(out.parts[0].bytes)).map((p) => `${name}: ${p}`))
    }
    expect(written).toBeGreaterThan(60)
    expect(problems).toEqual([])
  }, 120_000)
})
