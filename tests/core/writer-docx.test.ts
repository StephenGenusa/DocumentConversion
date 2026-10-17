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
