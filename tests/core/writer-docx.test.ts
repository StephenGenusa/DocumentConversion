import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { writeDocx } from '../../src/core/writers/docx'
import { readDocx } from '../../src/core/readers/docx'

describe('writeDocx', () => {
  it('produces a docx that reads back to equivalent content', async () => {
    const buf = await writeDocx({ html: '<h1>Rt</h1><p>Hello <strong>world</strong></p>', title: 'Rt' })
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(1000)
    const back = await readDocx({ bytes: buf })
    expect(back.html).toContain('Rt')
    expect(back.html.toLowerCase()).toContain('world')
  })
})

/**
 * The lines of each paragraph holding `marker`, as Word shows them: the runs'
 * text, with a <w:br/> starting a new line.
 */
async function linesOf(html: string, marker: string): Promise<string[]> {
  const xml = await (await JSZip.loadAsync(await writeDocx({ html }))).file('word/document.xml')!.async('string')
  const para = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map((m) => m[0]).find((p) => p.includes(marker))
  expect(para, `a paragraph holding ${marker}`).toBeDefined()
  const pieces = [...para!.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br\b[^>]*\/>/g)]
  return pieces
    .map((m) => (m[0].startsWith('<w:br') ? '\n' : m[1]))
    .join('')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split('\n')
}

describe('writeDocx keeps the lines of a code block apart', () => {
  it('writes each line of a plain block on its own line', async () => {
    const lines = await linesOf('<pre><code>const alpha = 1\nconst beta = 2\n</code></pre>', 'alpha')
    expect(lines).toEqual(['const alpha = 1', 'const beta = 2'])
  })

  it('breaks a line whose newline falls inside a highlighting span', async () => {
    const html =
      '<pre><code class="language-js"><span class="hljs-keyword">const</span> alpha = <span class="hljs-string">"one\ntwo"</span>\n<span class="hljs-title">run</span>()\n</code></pre>'
    expect(await linesOf(html, 'alpha')).toEqual(['const alpha = "one', 'two"', 'run()'])
  })

  it('keeps leading indentation and tabs', async () => {
    const lines = await linesOf('<pre><code>if (alpha) {\n    beta()\n\tgamma()\n}\n</code></pre>', 'alpha')
    expect(lines).toEqual(['if (alpha) {', '    beta()', '\tgamma()', '}'])
  })

  it('keeps a blank line inside the block', async () => {
    const lines = await linesOf('<pre><code>alpha()\n\nbeta()\n</code></pre>', 'alpha')
    expect(lines).toEqual(['alpha()', '', 'beta()'])
  })

  it('breaks the lines of a code block in a list item', async () => {
    const lines = await linesOf('<ul><li><p>Step</p><pre><code>alpha()\n  beta()\n</code></pre></li></ul>', 'alpha')
    expect(lines).toEqual(['Step', 'alpha()', '  beta()'])
  })

  it('breaks the lines of a code block in a table cell', async () => {
    const lines = await linesOf('<table><tr><td><pre><code>alpha()\nbeta()</code></pre></td></tr></table>', 'alpha')
    expect(lines).toEqual(['alpha()', 'beta()'])
  })

  it('keeps a <br> already inside a block as a line break', async () => {
    expect(await linesOf('<pre><code>alpha()<br>beta()</code></pre>', 'alpha')).toEqual(['alpha()', 'beta()'])
  })

  it('breaks the lines of a diagram source block', async () => {
    const lines = await linesOf('<pre><code class="language-mermaid">graph TD\n  Alpha --&gt; Beta\n</code></pre>', 'Alpha')
    expect(lines).toEqual(['graph TD', '  Alpha --> Beta'])
  })
})

/**
 * The font of every run whose text holds `marker`: the w:rFonts ascii font,
 * or '' for the body font. Word takes a run without rFonts in the body font.
 */
async function fontsOf(html: string, marker: string): Promise<string[]> {
  const xml = await (await JSZip.loadAsync(await writeDocx({ html }))).file('word/document.xml')!.async('string')
  const runs = [...xml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => m[1])
  const hits = runs.filter((r) => [...r.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].some((t) => t[1].includes(marker)))
  expect(hits.length, `a run holding ${marker}`).toBeGreaterThan(0)
  return hits.map((r) => /<w:rFonts\b[^>]*\bw:ascii="([^"]*)"/.exec(r)?.[1] ?? '')
}

describe('writeDocx sets code in a monospace font wherever it is', () => {
  it('sets a top-level code block in Courier (as html-to-docx already does)', async () => {
    expect(await fontsOf('<pre><code>alpha()\nbeta()</code></pre>', 'alpha')).toEqual(['Courier'])
  })

  it('sets a code block in a list item in Courier, lines still apart', async () => {
    const html = '<ul><li><p>Step</p><pre><code>alpha()\n  beta()\n</code></pre></li></ul>'
    expect(await fontsOf(html, 'alpha')).toEqual(['Courier'])
    expect(await fontsOf(html, 'beta')).toEqual(['Courier'])
    expect(await fontsOf(html, 'Step')).toEqual([''])
    expect(await linesOf(html, 'alpha')).toEqual(['Step', 'alpha()', '  beta()'])
  })

  it('sets a code block in a nested list item in Courier', async () => {
    const html = '<ol><li>Outer<ul><li>Inner<pre><code>alpha()\nbeta()</code></pre></li></ul></li></ol>'
    expect(await fontsOf(html, 'alpha')).toEqual(['Courier'])
    expect(await fontsOf(html, 'beta')).toEqual(['Courier'])
    expect(await fontsOf(html, 'Inner')).toEqual([''])
  })

  it('sets inline code in a list item, a paragraph and a table cell in Courier', async () => {
    expect(await fontsOf('<ul><li>use <code>alpha</code> now</li></ul>', 'alpha')).toEqual(['Courier'])
    expect(await fontsOf('<ul><li>use <code>alpha</code> now</li></ul>', 'now')).toEqual([''])
    expect(await fontsOf('<p>use <code>beta</code> now</p>', 'beta')).toEqual(['Courier'])
    expect(await fontsOf('<table><tr><td>use <code>gamma</code></td></tr></table>', 'gamma')).toEqual(['Courier'])
  })

  it('sets a highlighted code block in a list item in Courier', async () => {
    const html =
      '<ol><li>Item<pre><code class="hljs language-js"><span class="hljs-keyword">const</span> alpha = <span class="hljs-number">1</span>\nbeta()</code></pre></li></ol>'
    expect(await fontsOf(html, 'const')).toEqual(['Courier'])
    expect(await fontsOf(html, 'beta')).toEqual(['Courier'])
    expect(await linesOf(html, 'alpha')).toEqual(['Item', 'const alpha = 1', 'beta()'])
  })

  it('keeps the paragraph after a code block in a list item', async () => {
    // A loose Markdown list: html-to-docx wrote nothing for "Then this."
    const html = '<ol><li><p>Step one:</p><pre><code>alpha()</code></pre><p>Then this.</p></li></ol>'
    expect(await linesOf(html, 'alpha')).toEqual(['Step one:', 'alpha()', 'Then this.'])
    expect(await fontsOf(html, 'Then')).toEqual([''])
  })
})

/** CT_RPr's child order, as far as html-to-docx and this writer use it. */
const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'color', 'position', 'sz', 'szCs', 'highlight', 'u', 'shd', 'vertAlign']

/**
 * The formatting of every run whose text holds `marker`, as sorted names:
 * b, i, u, strike, sup, sub, mark, plus `link` for a run in a hyperlink and
 * `mono` for one in Courier. Also checks each run's properties are in the
 * schema's order and no stand-in color is left behind.
 */
async function formatsOf(html: string, marker: string, xml?: string): Promise<string[]> {
  xml ??= await documentXml(html)
  expect(xml).not.toMatch(/w:color w:val="0D0[BC]/i)
  const hits: string[] = []
  for (const m of xml.matchAll(/<w:hyperlink\b[^>]*>[\s\S]*?<\/w:hyperlink>|<w:r>[\s\S]*?<\/w:r>/g)) {
    const inLink = m[0].startsWith('<w:hyperlink')
    for (const r of inLink ? [...m[0].matchAll(/<w:r>[\s\S]*?<\/w:r>/g)].map((x) => x[0]) : [m[0]]) {
      if (![...r.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].some((t) => t[1].includes(marker))) continue
      const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(r)?.[1] ?? ''
      const names = [...props.matchAll(/<w:(\w+)\b/g)].map((n) => n[1])
      const order = names.map((n) => RPR_ORDER.indexOf(n))
      expect(order.every((o) => o >= 0), `known run properties: ${names}`).toBe(true)
      expect(order, `run properties in schema order: ${names}`).toEqual([...order].sort((a, b) => a - b))
      const f: string[] = []
      if (names.includes('b')) f.push('b')
      if (names.includes('i')) f.push('i')
      if (names.includes('u')) f.push('u')
      if (names.includes('strike')) f.push('strike')
      if (/w:vertAlign w:val="superscript"/.test(props)) f.push('sup')
      if (/w:vertAlign w:val="subscript"/.test(props)) f.push('sub')
      if (names.includes('highlight')) f.push('mark')
      if (/w:rFonts\b[^>]*w:ascii="Courier"/.test(props)) f.push('mono')
      if (inLink) f.push('link')
      hits.push(f.sort().join('+'))
    }
  }
  expect(hits.length, `a run holding ${marker}`).toBeGreaterThan(0)
  return hits
}

async function documentXml(html: string): Promise<string> {
  return (await JSZip.loadAsync(await writeDocx({ html }))).file('word/document.xml')!.async('string')
}

/** The text of the paragraph holding `marker`, all runs joined. */
async function textOf(html: string, marker: string): Promise<string> {
  return (await linesOf(html, marker)).join('\n')
}

/**
 * html-to-docx 1.8.0 honors <i> but not <em>, ignores <s>/<del>/<strike>,
 * and keeps only the innermost of nested tags, so ***both*** came out bold
 * only and ~~struck~~ plain, whatever reader the document came from.
 */
describe('writeDocx keeps inline formatting', () => {
  const STYLES: Record<string, [string, string]> = {
    strong: ['<strong>', '</strong>'],
    em: ['<em>', '</em>'],
    u: ['<u>', '</u>'],
    s: ['<s>', '</s>'],
    sup: ['<sup>', '</sup>'],
    sub: ['<sub>', '</sub>'],
  }
  const NAME: Record<string, string> = { strong: 'b', em: 'i', u: 'u', s: 'strike', sup: 'sup', sub: 'sub' }

  it('writes the Markdown sample the way it reads', async () => {
    const html = '<p>Plain <em>italic</em> and <strong>bold</strong> and <s>struck</s> and <em><strong>both</strong></em> end.</p>'
    const xml = await documentXml(html)
    expect(await formatsOf(html, 'Plain', xml)).toEqual([''])
    expect(await formatsOf(html, 'italic', xml)).toEqual(['i'])
    expect(await formatsOf(html, 'bold', xml)).toEqual(['b'])
    expect(await formatsOf(html, 'struck', xml)).toEqual(['strike'])
    expect(await formatsOf(html, 'both', xml)).toEqual(['b+i'])
    expect(await textOf(html, 'Plain')).toBe('Plain italic and bold and struck and both end.')
  })

  it.each([
    ['strong', 'b'], ['b', 'b'], ['em', 'i'], ['i', 'i'], ['u', 'u'], ['ins', 'u'],
    ['s', 'strike'], ['del', 'strike'], ['strike', 'strike'], ['sup', 'sup'], ['sub', 'sub'], ['mark', 'mark'],
    ['cite', 'i'], ['var', 'i'], ['dfn', 'i'], ['kbd', 'mono'], ['samp', 'mono'],
  ])('writes <%s> as %s', async (tag, name) => {
    const html = `<p>before <${tag}>alpha</${tag}> after</p>`
    expect(await formatsOf(html, 'alpha')).toEqual([name])
    expect(await formatsOf(html, 'after')).toEqual([''])
    expect(await textOf(html, 'alpha')).toBe('before alpha after')
  })

  const pairs = Object.keys(STYLES).flatMap((a) => Object.keys(STYLES).filter((b) => a !== b).map((b) => [a, b]))
  it.each(pairs.filter(([a, b]) => !(['sup', 'sub'].includes(a) && ['sup', 'sub'].includes(b))))(
    'keeps both of <%s><%s>',
    async (outer, inner) => {
      const html = `<p>x ${STYLES[outer][0]}${STYLES[inner][0]}alpha${STYLES[inner][1]}${STYLES[outer][1]} y</p>`
      expect(await formatsOf(html, 'alpha')).toEqual([[NAME[outer], NAME[inner]].sort().join('+')])
    },
  )

  it('takes the inner of a superscript and a subscript', async () => {
    expect(await formatsOf('<p><sup>a <sub>alpha</sub></sup></p>', 'alpha')).toEqual(['sub'])
    expect(await formatsOf('<p><sub>a <sup>alpha</sup></sub></p>', 'alpha')).toEqual(['sup'])
  })

  it('keeps every style of a deep nest, and each level its own', async () => {
    const html = '<p><strong>one <em>two <u>three <s>four <sup>alpha</sup></s></u></em></strong> plain</p>'
    const xml = await documentXml(html)
    expect(await formatsOf(html, 'one', xml)).toEqual(['b'])
    expect(await formatsOf(html, 'two', xml)).toEqual(['b+i'])
    expect(await formatsOf(html, 'three', xml)).toEqual(['b+i+u'])
    expect(await formatsOf(html, 'four', xml)).toEqual(['b+i+strike+u'])
    expect(await formatsOf(html, 'alpha', xml)).toEqual(['b+i+strike+sup+u'])
    expect(await formatsOf(html, 'plain', xml)).toEqual([''])
    expect(await textOf(html, 'one')).toBe('one two three four alpha plain')
  })

  it('keeps the space between two formatted words', async () => {
    // html-to-docx drops a text node that is only whitespace: "alpha beta" became "alphabeta".
    expect(await textOf('<p><strong>alpha</strong> <em>beta</em></p>', 'alpha')).toBe('alpha beta')
    expect(await textOf('<p><a href="https://example.com/"><strong>alpha</strong> <em>beta</em></a></p>', 'alpha')).toBe('alpha beta')
  })

  it('does not strike or underline the space after struck or underlined text', async () => {
    const runText = async (html: string, marker: string): Promise<string> => {
      const xml = await documentXml(html)
      const run = [...xml.matchAll(/<w:r>[\s\S]*?<\/w:r>/g)].map((m) => m[0]).find((r) => r.includes(marker))!
      return /<w:t[^>]*>([^<]*)<\/w:t>/.exec(run)![1]
    }
    expect(await runText('<p><s>alpha</s> <code>beta</code></p>', 'alpha')).toBe('alpha')
    expect(await runText('<p><strong>beta</strong> <u>alpha</u></p>', 'alpha')).toBe('alpha')
    expect(await textOf('<p><s>alpha</s> <u>beta</u></p>', 'alpha')).toBe('alpha beta')
  })

  it('keeps formatting inside a link, and the whole link', async () => {
    const html = '<p>see <a href="https://example.com/">the <strong>alpha</strong> and <em><s>beta</s></em> page</a> now</p>'
    const xml = await documentXml(html)
    expect(await formatsOf(html, 'alpha', xml)).toEqual(['b+link'])
    expect(await formatsOf(html, 'beta', xml)).toEqual(['i+link+strike'])
    expect(await formatsOf(html, 'page', xml)).toEqual(['link'])
    expect(await formatsOf(html, 'now', xml)).toEqual([''])
    expect(xml.match(/<w:hyperlink\b/g)).toHaveLength(1)
    expect(await textOf(html, 'see')).toBe('see the alpha and beta page now')
  })

  it('keeps a link that is itself formatted', async () => {
    const html = '<p>go <strong><a href="https://example.com/">alpha</a></strong> <em>now</em></p>'
    expect(await formatsOf(html, 'alpha')).toEqual(['b+link'])
    expect(await formatsOf(html, 'now')).toEqual(['i'])
  })

  it('keeps formatting in a list item', async () => {
    const html = '<ul><li>item <em><strong>alpha</strong></em> and <s>beta</s></li></ul>'
    const xml = await documentXml(html)
    expect(await formatsOf(html, 'alpha', xml)).toEqual(['b+i'])
    expect(await formatsOf(html, 'beta', xml)).toEqual(['strike'])
    expect(await textOf(html, 'item')).toBe('item alpha and beta')
  })

  it('keeps formatting in a table cell', async () => {
    const html = '<table><tr><th>Head <em>alpha</em></th></tr><tr><td>cell <del><strong>beta</strong></del> end</td></tr></table>'
    const xml = await documentXml(html)
    expect((await formatsOf(html, 'alpha', xml)).map((f) => f.replace(/^b\+?/, ''))).toEqual(['i'])
    expect(await formatsOf(html, 'beta', xml)).toEqual(['b+strike'])
    expect(await textOf(html, 'cell')).toBe('cell beta end')
  })

  it('keeps formatting in a footnote and the reference raised', async () => {
    const html =
      '<p>A claim<sup data-fn="n1">1</sup> made.</p>' +
      '<ol><li data-fn="n1"><p>See <em>alpha</em> and <strong><s>beta</s></strong>.</p></li></ol>'
    const xml = await documentXml(html)
    expect(await formatsOf(html, 'alpha', xml)).toEqual(['i'])
    expect(await formatsOf(html, 'beta', xml)).toEqual(['b+strike'])
    const ref = [...xml.matchAll(/<w:r>[\s\S]*?<\/w:r>/g)].map((m) => m[0]).find((r) => /<w:t[^>]*>1<\/w:t>/.test(r))
    expect(ref).toMatch(/w:vertAlign w:val="superscript"/)
  })

  it('keeps bold on a superscript and a subscript', async () => {
    const html = '<p>x<strong><sup>alpha</sup></strong> y<sub><b>beta</b></sub></p>'
    expect(await formatsOf(html, 'alpha')).toEqual(['b+sup'])
    expect(await formatsOf(html, 'beta')).toEqual(['b+sub'])
  })

  it('keeps inline code in Courier inside other formatting', async () => {
    const html = '<p>run <strong>the <code>alpha</code> tool</strong></p>'
    expect(await formatsOf(html, 'alpha')).toEqual(['b+mono'])
    expect(await formatsOf(html, 'tool')).toEqual(['b'])
  })

  it('formats a heading run without doubling its style', async () => {
    const html = '<h2>Title <em>alpha</em> <strong>beta</strong></h2>'
    const xml = await documentXml(html)
    expect(await formatsOf(html, 'alpha', xml)).toEqual(['i'])
    expect(await formatsOf(html, 'beta', xml)).toEqual(['b'])
    expect(await formatsOf(html, 'Title', xml)).toEqual([''])
    expect(xml).toMatch(/w:pStyle w:val="Heading2"/)
  })

  it('keeps line breaks inside formatting', async () => {
    expect(await linesOf('<p><strong>alpha<br><em>beta</em></strong></p>', 'alpha')).toEqual(['alpha', 'beta'])
  })

  it('keeps a picture inside formatting', async () => {
    // html-to-docx wrote nothing for an <img> inside <strong>.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const html = `<p>a <strong>alpha <img src="${png}" alt="dot"> beta</strong></p>`
    const xml = await documentXml(html)
    expect(xml.match(/<w:drawing>/g)).toHaveLength(1)
    expect(await formatsOf(html, 'beta', xml)).toEqual(['b'])
  })

  it('keeps the text of other inline elements', async () => {
    // html-to-docx wrote an empty run for a tag it does not know.
    expect(await textOf('<p>a <small>alpha</small> <abbr title="x">beta</abbr> c</p>', 'alpha')).toBe('a alpha beta c')
  })
})

/**
 * html-to-docx writes w:gridSpan and w:vMerge after w:tcBorders; CT_TcPr puts
 * them before it; a strict reader may ignore the span, and Word may repair.
 */
describe('writeDocx writes merged cells in schema order', () => {
  const TCPR_ORDER = ['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark']
  const html =
    '<table><tr><th colspan="2">alpha</th><th>c</th></tr>' +
    '<tr><td rowspan="2">beta</td><td style="vertical-align: middle">x</td><td>y</td></tr>' +
    '<tr><td colspan="2">gamma</td></tr>' +
    '<tr><td rowspan="2" colspan="2">delta</td><td>z</td></tr><tr><td>w</td></tr></table>'

  it('puts every cell property in CT_TcPr order', async () => {
    const xml = await documentXml(html)
    const cells = [...xml.matchAll(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/g)].map((m) => m[1])
    expect(cells.length).toBeGreaterThan(0)
    for (const inner of cells) {
      const names = [...inner.matchAll(/<w:(\w+)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:\1>)/g)].map((m) => m[1])
      const order = names.map((n) => TCPR_ORDER.indexOf(n))
      expect(order.every((o) => o >= 0), `known cell properties: ${names}`).toBe(true)
      expect(order, `cell properties in order: ${names}`).toEqual([...order].sort((a, b) => a - b))
    }
    expect(xml).toMatch(/<w:gridSpan w:val="2"\/>/)
    expect(xml).toMatch(/<w:vMerge w:val="restart"\/>/)
    expect(xml).toMatch(/<w:vMerge w:val="continue"\/>/)
    expect(xml).toMatch(/<w:vAlign w:val="center"\/>/)
  })

  it('writes no zero span, and a continued cell under a wide one keeps its width', async () => {
    const xml = await documentXml(html)
    expect(xml).not.toMatch(/<w:gridSpan w:val="0"\/>/)
    const rows = [...xml.matchAll(/<w:tr>[\s\S]*?<\/w:tr>/g)].map((m) => m[0])
    const last = rows[rows.length - 1]
    expect(last).toMatch(/<w:tcPr><w:gridSpan w:val="2"\/><w:vMerge w:val="continue"\/>/)
  })
})

/**
 * Inside a <pre>, html-to-docx keeps only the innermost tag, and the bold of
 * a <strong> ran on through the rest of the block, its link and its later
 * lines included.
 */
describe('writeDocx keeps formatting inside a code block', () => {
  it('keeps nested formatting and a link, in Courier, line by line', async () => {
    const html = '<pre><code>run <strong>bold <em>both</em></strong> and <a href="https://example.com/">link</a>\nnext</code></pre>'
    const xml = await documentXml(html)
    expect(await formatsOf(html, 'run', xml)).toEqual(['mono'])
    expect(await formatsOf(html, 'bold', xml)).toEqual(['b+mono'])
    expect(await formatsOf(html, 'both', xml)).toEqual(['b+i+mono'])
    expect(await formatsOf(html, 'and', xml)).toEqual(['mono'])
    expect(await formatsOf(html, 'link', xml)).toEqual(['link+mono'])
    expect(await formatsOf(html, 'next', xml)).toEqual(['mono'])
    expect(await linesOf(html, 'run')).toEqual(['run bold both and link', 'next'])
  })

  it('neither strikes nor underlines the indent or the space beside such text', async () => {
    const html = '<pre><code>if alpha:\n    <s>beta</s> <u>gamma</u>()</code></pre>'
    expect(await linesOf(html, 'alpha')).toEqual(['if alpha:', '    beta gamma()'])
    const xml = await documentXml(html)
    const runs = [...xml.matchAll(/<w:r>[\s\S]*?<\/w:r>/g)].map((m) => m[0])
    const drawn = runs.filter((r) => /<w:strike\/>|<w:u /.test(r)).map((r) => /<w:t[^>]*>([^<]*)<\/w:t>/.exec(r)?.[1])
    expect(drawn).toEqual(['beta', 'gamma'])
    const spaces = runs.filter((r) => /<w:t[^>]*>\s+<\/w:t>/.test(r))
    expect(spaces.length).toBe(2)
    for (const r of spaces) expect(r).toMatch(/w:ascii="Courier"/)
  })

  it('keeps the indent in front of formatted text', async () => {
    const html = '<pre><code>if alpha:\n    <strong>beta</strong>()\n\t<em>gamma</em></code></pre>'
    expect(await linesOf(html, 'alpha')).toEqual(['if alpha:', '    beta()', '\tgamma'])
    expect(await formatsOf(html, 'beta')).toEqual(['b+mono'])
  })

  it('does the same in a list item and a table cell', async () => {
    const item = '<ul><li><p>Step</p><pre><code>alpha <strong>beta</strong>\n  <s>gamma</s> <a href="https://example.com/">delta</a></code></pre><p>After</p></li></ul>'
    expect(await formatsOf(item, 'beta')).toEqual(['b+mono'])
    expect(await formatsOf(item, 'gamma')).toEqual(['mono+strike'])
    expect(await formatsOf(item, 'delta')).toEqual(['link+mono'])
    expect(await formatsOf(item, 'Step')).toEqual([''])
    expect(await formatsOf(item, 'After')).toEqual([''])
    expect(await linesOf(item, 'alpha')).toEqual(['Step', 'alpha beta', '  gamma delta', 'After'])
    const cell = '<table><tr><td><pre><code>alpha <em>beta</em>\ngamma</code></pre></td></tr></table>'
    expect(await formatsOf(cell, 'beta')).toEqual(['i+mono'])
    expect(await linesOf(cell, 'alpha')).toEqual(['alpha beta', 'gamma'])
  })

  it('still colors a highlighted block run by run, in Courier', async () => {
    const html = '<pre><code class="language-python">def alpha():\n    return 1</code></pre>'
    const xml = await documentXml(html)
    expect(await formatsOf(html, 'def', xml)).toEqual(['mono'])
    const colors = new Set([...xml.matchAll(/<w:color w:val="([0-9A-Fa-f]{6})"\/>/g)].map((m) => m[1]))
    expect(colors.size).toBeGreaterThan(1)
    expect(await linesOf(html, 'alpha')).toEqual(['def alpha():', '    return 1'])
  })
})

/** The w:color of every run whose text holds `marker`, or '' for none. */
async function colorsOf(html: string, marker: string): Promise<string[]> {
  const xml = await documentXml(html)
  expect(xml).not.toMatch(/w:color w:val="0D0[BC]/i)
  return [...xml.matchAll(/<w:r>[\s\S]*?<\/w:r>/g)]
    .map((m) => m[0])
    .filter((r) => [...r.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].some((t) => t[1].includes(marker)))
    .map((r) => /<w:color w:val="([^"]*)"\/>/.exec(r)?.[1]?.toUpperCase() ?? '')
}

/**
 * html-to-docx gives every run of a <p>, heading or cell that paragraph's
 * `color`, but a formatted run carries its stand-in color instead, so the
 * bold words of a red paragraph came out black.
 */
describe('writeDocx keeps a paragraph color on formatted text', () => {
  it('colors plain and formatted runs alike', async () => {
    const html = '<p style="color: #C00000">plain <strong>alpha</strong> <em><s>beta</s></em> <code>gamma</code> end</p>'
    expect(await colorsOf(html, 'plain')).toEqual(['C00000'])
    expect(await colorsOf(html, 'gamma')).toEqual(['C00000'])
    expect(await colorsOf(html, 'alpha')).toEqual(['C00000'])
    expect(await colorsOf(html, 'beta')).toEqual(['C00000'])
    expect(await formatsOf(html, 'alpha')).toEqual(['b'])
    expect(await formatsOf(html, 'beta')).toEqual(['i+strike'])
  })

  it('does so in headings and cells, for short and rgb() colors', async () => {
    expect(await colorsOf('<h2 style="color: #0a0">head <em>alpha</em></h2>', 'alpha')).toEqual(['00AA00'])
    expect(await colorsOf('<table><tr><td style="color: rgb(0, 0, 192)">cell <strong>alpha</strong></td></tr></table>', 'alpha')).toEqual(['0000C0'])
  })

  it('lets a run keep its own color', async () => {
    const html = '<p style="color: #C00000">plain <strong style="color: #0000C0">alpha</strong> <em>beta</em></p>'
    expect(await colorsOf(html, 'alpha')).toEqual(['0000C0'])
    expect(await colorsOf(html, 'beta')).toEqual(['C00000'])
    expect(await formatsOf(html, 'alpha')).toEqual(['b'])
  })

  it('leaves formatted text in an uncolored paragraph uncolored', async () => {
    expect(await colorsOf('<p>plain <strong>alpha</strong></p>', 'alpha')).toEqual([''])
  })
})

/**
 * Word keeps no code language, so each block's language goes in a hidden
 * bookmark around it (code-bookmark.ts): a bookmarkStart before the block's
 * first run and a bookmarkEnd after its last, inside its paragraph (CT_P
 * allows both among the runs), in a list item after the break that starts it.
 */
describe('writeDocx records each code block language in a hidden bookmark', () => {
  /** Every element balanced, as an XML parser would require. */
  const expectWellFormed = (xml: string): void => {
    const stack: string[] = []
    for (const m of xml.replace(/<\?[\s\S]*?\?>/g, '').matchAll(/<(\/?)([\w:.-]+)\b[^>]*?(\/?)>/g)) {
      if (m[3]) continue
      if (!m[1]) stack.push(m[2])
      else expect(stack.pop(), `closing ${m[2]}`).toBe(m[2])
    }
    expect(stack).toEqual([])
  }

  const html =
    '<p>Intro</p><pre><code class="language-c++">int alpha;\nint beta;</code></pre>' +
    '<ul><li>Item<pre><code class="language-objective-c">gamma = 1;</code></pre>After</li></ul>' +
    '<pre><code>plain delta</code></pre><pre><code class="language-ini">a=1</code></pre>'

  it('puts a bookmark naming the language around each named block, in its paragraph', async () => {
    const xml = await documentXml(html)
    expectWellFormed(xml)
    expect(xml).not.toMatch(/[-]/)
    const starts = [...xml.matchAll(/<w:bookmarkStart w:id="(\d+)" w:name="([^"]*)"\/>/g)]
    expect(starts.map((s) => s[2])).toEqual(['_DocConvCode_0_c_2b_2b', '_DocConvCode_1_objective_2dc', '_DocConvCode_2_ini'])
    const ids = starts.map((s) => s[1])
    expect(new Set(ids).size).toBe(3)
    for (const [i, s] of starts.entries()) {
      expect(s[2].length).toBeLessThanOrEqual(40)
      expect(s[2]).toMatch(/^[A-Za-z_][\w]*$/)
      const ends = [...xml.matchAll(new RegExp(`<w:bookmarkEnd w:id="${ids[i]}"/>`, 'g'))]
      expect(ends.length).toBe(1)
      // Start and end in the same paragraph, start first.
      const para = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map((m) => m[0]).find((p) => p.includes(s[0]))!
      expect(para.indexOf(s[0])).toBeLessThan(para.indexOf(ends[0][0]))
      // Children of the paragraph, never inside a run or its properties.
      const before = para.slice(0, para.indexOf(s[0]))
      expect(before.split('<w:r>').length).toBe(before.split('</w:r>').length)
      expect(before).not.toMatch(/<w:pPr>(?![\s\S]*<\/w:pPr>)/)
    }
    // A top-level block: the start straight after the paragraph's properties, the end its last child.
    expect(xml).toMatch(/<\/w:pPr>\s*<w:bookmarkStart w:id="\d+" w:name="_DocConvCode_0_c_2b_2b"\/>\s*<w:r>/)
    expect(xml).toMatch(new RegExp(`</w:r>\\s*<w:bookmarkEnd w:id="${ids[0]}"/>\\s*</w:p>`))
    // In a list item: after the break that ends the item's text.
    expect(xml).toMatch(/<w:br\b[^>]*\/>\s*<\/w:r>\s*<w:bookmarkStart w:id="\d+" w:name="_DocConvCode_1_objective_2dc"\/>\s*<w:r>/)
  })

  it('leaves the text and lines as they were', async () => {
    expect(await linesOf(html, 'alpha')).toEqual(['int alpha;', 'int beta;'])
    expect(await linesOf(html, 'gamma')).toEqual(['Item', 'gamma = 1;', 'After'])
    expect(await fontsOf(html, 'gamma')).toEqual(['Courier'])
    expect(await textOf(html, 'delta')).toBe('plain delta')
  })

  it('writes the bookmark with code color off too', async () => {
    const buf = await writeDocx({ html }, { codeColor: false })
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string')
    expect(xml).toContain('w:name="_DocConvCode_0_c_2b_2b"')
  })
})

/** The w:shd fill of every run (or, with `cell`, every cell) whose text holds `marker`, or '' for none. */
async function fillsOf(html: string, marker: string, cell = false): Promise<string[]> {
  const xml = await documentXml(html)
  return [...xml.matchAll(cell ? /<w:tc>[\s\S]*?<\/w:tc>/g : /<w:r>[\s\S]*?<\/w:r>/g)]
    .map((m) => m[0])
    .filter((r) => [...r.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].some((t) => t[1].includes(marker)))
    .map((r) => /<w:shd\b[^>]*w:fill="([^"]*)"/.exec(r)?.[1]?.toUpperCase() ?? '')
}

/**
 * Only hex and rgb() were read for a paragraph's color on formatted text, so
 * a named or hsl() one was lost there; and html-to-docx itself reads names,
 * #rrggbb/#rgb and comma rgb()/hsl() only, writing black for anything else
 * (rgba(), space syntax, hwb(), currentColor, inherit), for a run's color,
 * a cell's shading and its borders alike. Every color, background-color and
 * border color is written as hex before it sees them.
 */
describe('writeDocx reads every CSS color form', () => {
  const RED = ['red', 'RED', '#f00', '#f00f', '#FF0000', '#ff0000ff', 'rgb(255, 0, 0)', 'rgba(255,0,0,1)', 'rgb(255 0 0)', 'rgb(100% 0% 0%)', 'rgb(255 0 0 / 100%)', 'hsl(0, 100%, 50%)', 'hsla(0,100%,50%,1)', 'hsl(0deg 100% 50%)', 'hsl(1turn 100% 50%)', 'hsl(0rad 100% 50%)', 'hsl(400grad 100% 50%)', 'hwb(0 0% 0%)']

  it('colors formatted text in a colored paragraph, heading or cell', async () => {
    for (const css of RED) {
      const html = `<p style="color: ${css}">plain <strong>alpha</strong> <em>beta</em></p><h3 style="color: ${css}">head <em>gamma</em></h3><table><tr><td style="color: ${css}">cell <strong>delta</strong></td></tr></table>`
      for (const marker of ['plain', 'alpha', 'beta', 'head', 'gamma', 'cell', 'delta']) expect(await colorsOf(html, marker), `${css} ${marker}`).toEqual(['FF0000'])
    }
  })

  it('colors a run by its own color', async () => {
    for (const css of RED) {
      const html = `<p>plain <strong style="color: ${css}">alpha</strong> <small style="color: ${css}">beta</small> <code style="color: ${css}">gamma</code></p>`
      expect(await colorsOf(html, 'alpha'), css).toEqual(['FF0000'])
      expect(await colorsOf(html, 'beta'), css).toEqual(['FF0000'])
      expect(await colorsOf(html, 'gamma'), css).toEqual(['FF0000'])
      expect(await colorsOf(html, 'plain'), css).toEqual([''])
    }
    expect(await colorsOf('<p><small style="color: rebeccapurple">alpha</small></p>', 'alpha')).toEqual(['663399'])
  })

  it('blends a semi-transparent color with the white page', async () => {
    expect(await colorsOf('<p style="color: rgba(255, 0, 0, 0.5)">plain <strong>alpha</strong></p>', 'alpha')).toEqual(['FF8080'])
    expect(await colorsOf('<p><small style="color: hsl(0 100% 50% / 50%)">alpha</small></p>', 'alpha')).toEqual(['FF8080'])
  })

  it('leaves a transparent color off', async () => {
    expect(await colorsOf('<p style="color: transparent">plain <strong>alpha</strong></p>', 'alpha')).toEqual([''])
    expect(await colorsOf('<p style="color: transparent">plain <strong>alpha</strong></p>', 'plain')).toEqual([''])
    expect(await colorsOf('<p><small style="color: rgba(0, 0, 255, 0)">alpha</small></p>', 'alpha')).toEqual([''])
    expect(await colorsOf('<p style="color: #00f">plain <strong style="color: transparent">alpha</strong></p>', 'alpha')).toEqual(['0000FF'])
  })

  it('reads currentColor as the color around it', async () => {
    expect(await colorsOf('<p style="color: #00f">plain <strong style="color: currentColor">alpha</strong></p>', 'alpha')).toEqual(['0000FF'])
    expect(await colorsOf('<p style="color: #00f">plain <small style="color: currentColor">alpha</small></p>', 'alpha')).toEqual(['0000FF'])
    expect(await fillsOf('<table><tr style="color: blue"><td style="background-color: currentcolor">alpha</td></tr></table>', 'alpha', true)).toEqual(['0000FF'])
    expect(await fillsOf('<table><tr><td style="color: lime; background-color: currentColor">alpha</td></tr></table>', 'alpha', true)).toEqual(['00FF00'])
    expect(await fillsOf('<table><tr><td style="background-color: currentColor">alpha</td></tr></table>', 'alpha', true)).toEqual([''])
  })

  it('takes inherit, initial and unset as no color of its own', async () => {
    for (const css of ['inherit', 'initial', 'unset']) {
      expect(await colorsOf(`<p style="color: #00f">plain <strong style="color: ${css}">alpha</strong></p>`, 'alpha'), css).toEqual(['0000FF'])
      expect(await colorsOf(`<p style="color: #00f">plain <small style="color: ${css}">beta</small></p>`, 'beta'), css).toEqual(['0000FF'])
      expect(await colorsOf(`<p style="color: ${css}">plain <strong>alpha</strong></p>`, 'plain'), css).toEqual([''])
    }
  })

  it('ignores a color that is not one, keeping the rest of the style', async () => {
    const html = '<p style="color: reddish">plain <strong style="color: rgb(1, 2)">alpha</strong> <code style="color: hsl(red, 1%, 2%)">beta</code></p>'
    expect(await colorsOf(html, 'plain')).toEqual([''])
    expect(await colorsOf(html, 'alpha')).toEqual([''])
    expect(await colorsOf(html, 'beta')).toEqual([''])
    expect(await formatsOf(html, 'beta')).toEqual(['mono'])
    expect(await colorsOf('<p style="color: #00f">plain <strong style="color: nope">alpha</strong></p>', 'alpha')).toEqual(['0000FF'])
  })

  it('reads a background color on a run or cell in every form', async () => {
    expect(await fillsOf('<table><tr><td style="background-color: hsl(60, 100%, 50%)">alpha</td></tr></table>', 'alpha', true)).toEqual(['FFFF00'])
    expect(await fillsOf('<table><tr><td style="background-color: Yellow">alpha</td></tr></table>', 'alpha', true)).toEqual(['FFFF00'])
    expect(await fillsOf('<table><tr><td style="background-color: rgba(0, 0, 0, 0)">alpha</td></tr></table>', 'alpha', true)).toEqual([''])
    expect(await fillsOf('<table><tr><td style="background-color: nope">alpha</td></tr></table>', 'alpha', true)).toEqual([''])
    expect(await fillsOf('<table><tr><td style="background-color: rgb(255 255 0 / 50%)">alpha</td></tr></table>', 'alpha', true)).toEqual(['FFFF80'])
    expect(await fillsOf('<table><tr><td style="background-color: hwb(60 0% 0%)">alpha</td></tr></table>', 'alpha', true)).toEqual(['FFFF00'])
  })

  it('reads a cell border color in every form', async () => {
    const bordersOf = async (border: string): Promise<string[]> => {
      const xml = await documentXml(`<table><tr><td style="border: ${border}">alpha</td><td style="border-top: ${border}">beta</td></tr></table>`)
      return [...xml.matchAll(/<w:tcBorders>([\s\S]*?)<\/w:tcBorders>/g)].map((m) => [...m[1].matchAll(/<w:(\w+)\b[^>]*w:color="([^"]*)"/g)].map((b) => `${b[1]}:${b[2]}`).sort().join(' '))
    }
    for (const css of ['lime', 'hsl(120, 100%, 50%)', 'rgb(0, 255, 0)', 'rgb(0 255 0)', 'hwb(120 0% 0%)']) {
      expect(await bordersOf(`1px solid ${css}`), css).toEqual(['bottom:00FF00 left:00FF00 right:00FF00 top:00FF00', 'bottom:00FF00 left:00FF00 right:00FF00 top:00FF00'])
    }
    // Not drawn black: a transparent border is none (html-to-docx still gives a lone border-top's cell its other sides).
    expect((await bordersOf('1px solid transparent')).join(' ')).not.toContain('top:')
  })
})

/** The w:highlight of every run whose text holds `marker`, or '' for none. */
async function highlightsOf(html: string, marker: string): Promise<string[]> {
  const xml = await documentXml(html)
  return [...xml.matchAll(/<w:r>[\s\S]*?<\/w:r>/g)]
    .map((m) => m[0])
    .filter((r) => [...r.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].some((t) => t[1].includes(marker)))
    .map((r) => /<w:highlight w:val="([^"]*)"\/>/.exec(r)?.[1] ?? '')
}

/**
 * flattenFormatting's spans carried a formatted run's color and font only, so
 * `<strong style="background-color: …">` or a `<mark>` in a color of its own
 * came out with no background, or yellow. A background that is exactly one
 * of Word's 16 highlight colors is a highlight; any other is shading.
 */
describe('writeDocx keeps a background color on formatted text', () => {
  it('shades a formatted run by its own background, in every CSS form', async () => {
    for (const css of ['#ABCDEF', '#abcdef', '#abcdefff', 'rgb(171, 205, 239)', 'rgba(171,205,239,1)', 'rgb(171 205 239 / 100%)', 'hwb(210 67.06% 6.27%)']) {
      const html = `<p>plain <strong style="background-color: ${css}">alpha</strong> <em style="background: no-repeat ${css}">beta</em></p>`
      expect(await fillsOf(html, 'alpha'), css).toEqual(['ABCDEF'])
      expect(await fillsOf(html, 'beta'), css).toEqual(['ABCDEF'])
      expect(await fillsOf(html, 'plain'), css).toEqual([''])
      expect(await formatsOf(html, 'alpha'), css).toEqual(['b'])
      expect(await formatsOf(html, 'beta'), css).toEqual(['i'])
    }
    expect(await fillsOf('<p><small style="background-color: wheat">alpha</small> <code style="background-color: #eee">beta</code></p>', 'alpha')).toEqual(['F5DEB3'])
    expect(await fillsOf('<p><small style="background-color: wheat">alpha</small> <code style="background-color: #eee">beta</code></p>', 'beta')).toEqual(['EEEEEE'])
  })

  it('makes a background that is one of Word\'s highlight colors a highlight', async () => {
    const WORD = { yellow: 'yellow', lime: 'green', aqua: 'cyan', fuchsia: 'magenta', blue: 'blue', red: 'red', black: 'black', white: 'white', navy: 'darkBlue', teal: 'darkCyan', green: 'darkGreen', purple: 'darkMagenta', maroon: 'darkRed', olive: 'darkYellow', gray: 'darkGray', silver: 'lightGray' }
    for (const [css, word] of Object.entries(WORD)) {
      const html = `<p>plain <strong style="background-color: ${css}">alpha</strong></p>`
      expect(await highlightsOf(html, 'alpha'), css).toEqual([word])
      expect(await fillsOf(html, 'alpha'), css).toEqual([''])
    }
    expect(await highlightsOf('<p><em style="background-color: hsl(60 100% 50%)">alpha</em></p>', 'alpha')).toEqual(['yellow'])
    // Near is not exact: shading keeps the color.
    expect(await highlightsOf('<p><em style="background-color: #FFFF01">alpha</em></p>', 'alpha')).toEqual([''])
    expect(await fillsOf('<p><em style="background-color: #FFFF01">alpha</em></p>', 'alpha')).toEqual(['FFFF01'])
  })

  it('gives a <mark> its own color in place of yellow', async () => {
    expect(await highlightsOf('<p><mark>alpha</mark></p>', 'alpha')).toEqual(['yellow'])
    expect(await highlightsOf('<p><mark style="background-color: aqua">alpha</mark></p>', 'alpha')).toEqual(['cyan'])
    expect(await highlightsOf('<p><mark style="background-color: #FFE0A0">alpha</mark></p>', 'alpha')).toEqual([''])
    expect(await fillsOf('<p><mark style="background-color: #FFE0A0">alpha</mark></p>', 'alpha')).toEqual(['FFE0A0'])
    expect(await highlightsOf('<p><mark style="background-color: transparent">alpha</mark></p>', 'alpha')).toEqual(['yellow'])
  })

  it('carries the background into nested formatting, with the color and a paragraph background beside it', async () => {
    const html = '<p style="color: #C00000; background-color: #E0E0FF">plain <mark style="background-color: #FFE0A0">alpha <strong>beta</strong> <s style="background-color: lime">gamma</s></mark> delta</p>'
    expect(await fillsOf(html, 'plain')).toEqual(['E0E0FF'])
    expect(await fillsOf(html, 'alpha')).toEqual(['FFE0A0'])
    expect(await fillsOf(html, 'beta')).toEqual(['FFE0A0'])
    expect(await fillsOf(html, 'delta')).toEqual(['E0E0FF'])
    expect(await highlightsOf(html, 'gamma')).toEqual(['green'])
    expect(await colorsOf(html, 'beta')).toEqual(['C00000'])
    expect(await formatsOf(html, 'beta')).toEqual(['b'])
    expect(await formatsOf(html, 'gamma')).toEqual(['mark+strike'])
  })

  it('leaves a semi-transparent background blended and a transparent one off', async () => {
    expect(await fillsOf('<p><strong style="background-color: rgba(0, 0, 255, 0.25)">alpha</strong></p>', 'alpha')).toEqual(['BFBFFF'])
    expect(await fillsOf('<p><strong style="background-color: transparent">alpha</strong></p>', 'alpha')).toEqual([''])
    expect(await highlightsOf('<p><strong style="background-color: rgba(255, 255, 0, 0)">alpha</strong></p>', 'alpha')).toEqual([''])
  })

  it('shades the space between two shaded words, in a code block too', async () => {
    const html = '<p><strong style="background-color: #ABCDEF">alpha</strong> <em style="background-color: #ABCDEF">beta</em></p>'
    expect((await linesOf(html, 'alpha')).join('')).toBe('alpha beta')
    const pre = '<pre><code>  <strong style="background-color: #ABCDEF">alpha</strong></code></pre>'
    expect(await fillsOf(pre, 'alpha')).toEqual(['ABCDEF'])
    expect(await fontsOf(pre, 'alpha')).toEqual(['Courier'])
  })
})
