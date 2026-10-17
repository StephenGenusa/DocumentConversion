import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readDocx } from '../../src/core/readers/docx'
import { createConverter } from '../../src/core/convert'

/*
 * mammoth reads a paragraph's text and none of its fonts, so a code block in
 * a Word file came back as ordinary paragraphs with its indentation gone. The
 * reader recognizes the code paragraphs — our own docx writer's (every run in
 * Courier, lines split by breaks), Word's "HTML Preformatted"-style ones, and
 * runs of paragraphs set wholly in a monospace font — and makes them a code block.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const STYLES =
  `<?xml version="1.0"?><w:styles ${W}>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="HTMLPreformatted"><w:name w:val="HTML Preformatted"/><w:basedOn w:val="Normal"/>` +
  `<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Listing"><w:name w:val="Listing"/><w:basedOn w:val="Normal"/>` +
  `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style>` +
  `<w:style w:type="character" w:styleId="Mono"><w:name w:val="Mono"/><w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/></w:rPr></w:style>` +
  `</w:styles>`

/** A bulleted list (numId 1) and a numbered one (numId 2), two levels each. */
const NUMBERING =
  `<?xml version="1.0"?><w:numbering ${W}>` +
  `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>` +
  `<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="◦"/></w:lvl></w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>` +
  `<w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:lvlText w:val="%2."/></w:lvl></w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`

async function docx(body: string, styles = STYLES): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
  )
  zip.file('word/styles.xml', styles)
  zip.file('word/numbering.xml', NUMBERING)
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

const para = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const styled = (style: string, runs: string): string => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs}</w:p>`
const run = (text: string, rPr = ''): string => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const font = (name: string): string => `<w:rFonts w:ascii="${name}" w:hAnsi="${name}"/>`
const item = (runs: string, numId = 1, ilvl = 0): string =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${runs}</w:p>`
const br = '<w:r><w:br/></w:r>'

const read = async (body: string, styles?: string): Promise<string> => (await readDocx({ bytes: await docx(body, styles), filename: 'a.docx' })).html

describe('docx: code blocks', () => {
  it('reads Word\'s "HTML Preformatted" paragraphs as one block, blank line, tab and indent kept', async () => {
    const html = await read(
      para('Before.') +
        styled('HTMLPreformatted', run('if (a &lt; b) {')) +
        styled('HTMLPreformatted', run('    run();')) +
        styled('HTMLPreformatted', '') +
        styled('HTMLPreformatted', `<w:r><w:tab/><w:t>done();</w:t></w:r>`) +
        styled('HTMLPreformatted', run('}')) +
        para('After.'),
    )
    expect(html).toBe('<p>Before.</p><pre><code>if (a &lt; b) {\n    run();\n\n\tdone();\n}</code></pre><p>After.</p>')
  })

  it('reads paragraphs set wholly in a monospace font, by run, by character style or by paragraph style', async () => {
    const html = await read(
      `<w:p>${run('SELECT id', font('Consolas'))}<w:r><w:rPr>${font('Consolas')}</w:rPr><w:br/></w:r>${run('  FROM t', font('Consolas'))}</w:p>` +
        `<w:p>${run('WHERE ', '<w:rStyle w:val="Mono"/>')}${run('n = 1', font('DejaVu Sans Mono'))}</w:p>` +
        para('Then.') +
        styled('Listing', run('x = 1')),
    )
    expect(html).toBe('<pre><code>SELECT id\n  FROM t\nWHERE n = 1</code></pre><p>Then.</p><pre><code>x = 1</code></pre>')
  })

  it('leaves prose with a word of code in it, a heading and a one-line monospace cell alone', async () => {
    const html = await read(
      `<w:p>${run('Call ')}${run('run()', font('Courier'))}${run(' twice.')}</w:p>` +
        `<w:tbl><w:tr><w:tc><w:p>${run('ID-42', font('Courier New'))}</w:p></w:tc></w:tr></w:tbl>`,
    )
    expect(html).not.toContain('<pre>')
    expect(html).toContain('<p>Call <code>run()</code> twice.</p>')
    expect(html).toContain('ID-42')
  })
})

describe('docx: a code block inside a list item', () => {
  it('reads the monospace lines after a break as a block in the item, text either side kept', async () => {
    // Word's own shape: the break inside a run of the text.
    const html = await read(
      item(
        `<w:r><w:t>Run:</w:t><w:br/></w:r>${run('npm  install', font('Consolas'))}${br}${br}` +
          `<w:r><w:rPr>${font('Consolas')}</w:rPr><w:tab/><w:t>npm test</w:t><w:br/></w:r>${run('Then this.')}`,
        2,
      ) + item(run('Two'), 2),
    )
    expect(html).toBe('<ol><li>Run:<pre><code>npm  install\n\n\tnpm test</code></pre>Then this.</li><li>Two</li></ol>')
  })

  it('leaves a list item set wholly in a monospace font, or with a word of code in it, alone', async () => {
    const html = await read(
      item(run('ls -la', font('Courier New'))) +
        item(`${run('first', font('Courier New'))}${br}${run('second', font('Courier New'))}`) +
        item(`${run('Call ')}${run('run()', font('Courier New'))}`) +
        item(`${run('Note')}${br}${run('Then ')}${run('x', font('Courier New'))}${run(' again.')}`),
    )
    expect(html).not.toContain('<pre>')
    expect(html).toContain('<li><code>ls -la</code></li>')
    expect(html).toContain('<li>Call <code>run()</code></li>')
    expect(html).toContain('Then <code>x</code> again.')
  })
})

describe('docx: inline code', () => {
  const STYLES_CODE =
    `<?xml version="1.0"?><w:styles ${W}>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr>${font('Calibri')}</w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="HTMLCode"><w:name w:val="HTML Code"/></w:style>` +
    `<w:style w:type="character" w:styleId="ApiName"><w:name w:val="Api Name"/><w:basedOn w:val="HTMLCode"/></w:style>` +
    `<w:style w:type="character" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/></w:style>` +
    `<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/></w:style>` +
    `</w:styles>`
  const readCode = (body: string): Promise<string> => read(body, STYLES_CODE)

  it('reads a Consolas run in a Calibri paragraph as code', async () => {
    const html = await readCode(`<w:p>${run('Call ')}${run('run()', font('Consolas'))}${run(' twice.')}</w:p>`)
    expect(html).toBe('<p>Call <code>run()</code> twice.</p>')
  })

  it('reads Word\'s "HTML Code", pandoc\'s "Verbatim Char" and a style based on them as code', async () => {
    const html = await readCode(
      `<w:p>${run('Use ')}${run('fetch()', '<w:rStyle w:val="HTMLCode"/>')}${run(', ')}` +
        `${run('Array.from', '<w:rStyle w:val="ApiName"/>')}${run(' or ')}${run('x', '<w:rStyle w:val="VerbatimChar"/>')}${run('.')}</w:p>`,
    )
    expect(html).toBe('<p>Use <code>fetch()</code>, <code>Array.from</code> or <code>x</code>.</p>')
  })

  it('keeps neighboring monospace runs one piece of code, a space between them included', async () => {
    const html = await readCode(
      `<w:p>${run('Run ')}${run('npm', font('Consolas'))}${run(' ', font('Consolas'))}${run('test', font('Courier New'))}${run(' now.')}</w:p>`,
    )
    expect(html).toBe('<p>Run <code>npm test</code> now.</p>')
  })

  it('leaves a monospace space alone between ordinary words', async () => {
    const html = await readCode(`<w:p>${run('One')}${run(' ', font('Consolas'))}${run('two.')}</w:p>`)
    expect(html).toBe('<p>One two.</p>')
  })

  it('keeps bold and links around code', async () => {
    const html = await readCode(
      `<w:p>${run('A ')}${run('bold', font('Consolas') + '<w:b/>')}${run(' and ')}${run('strong', '<w:rStyle w:val="Strong"/>' + font('Consolas'))}` +
        `${run(' word.')}</w:p>`,
    )
    expect(html).toBe('<p>A <strong><code>bold</code></strong> and <strong><code>strong</code></strong> word.</p>')
  })

  it('still reads a code style in a document set in a monospace face, but no font', async () => {
    const styles =
      `<?xml version="1.0"?><w:styles ${W}>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr>${font('Courier New')}</w:rPr></w:style>` +
      `<w:style w:type="character" w:styleId="HTMLCode"><w:name w:val="HTML Code"/></w:style></w:styles>`
    const html = await read(
      `<w:p>${run('INT. KITCHEN. ')}${run('NIGHT', font('Consolas'))}</w:p><w:p>${run('Type ')}${run('ls', '<w:rStyle w:val="HTMLCode"/>')}</w:p>`,
      styles,
    )
    expect(html).toBe('<p>INT. KITCHEN. NIGHT</p><p>Type <code>ls</code></p>')
  })

  it('reads no font as code where nearly every paragraph is set in it', async () => {
    const lines = Array.from({ length: 24 }, (_, i) => `<w:p>${run(`Line ${i} of the letter.`, font('Courier New'))}</w:p>`)
    const html = await read(`<w:p>${run('Dear ')}${run('reader', font('Courier New'))}</w:p>` + lines.join(''))
    expect(html).not.toContain('<code>')
  })
})

describe('docx: a document set in a monospace face is not code', () => {
  it('when its Normal style is monospace, as a screenplay is', async () => {
    const styles =
      `<?xml version="1.0"?><w:styles ${W}>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr>${font('Courier New')}</w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="Dialogue"><w:name w:val="Dialogue"/><w:basedOn w:val="Normal"/></w:style></w:styles>`
    const html = await read(styled('Dialogue', run('We should go.')) + styled('Dialogue', run('Not yet.')) + para('The door opens.'), styles)
    expect(html).toBe('<p>We should go.</p><p>Not yet.</p><p>The door opens.</p>')
  })

  it('when nearly every paragraph is set in it directly', async () => {
    const lines = Array.from({ length: 24 }, (_, i) => `<w:p>${run(`Line ${i} of the letter.`, font('Courier New'))}</w:p>`)
    const html = await read(para('Dear reader,') + lines.join(''))
    expect(html).not.toContain('<pre>')
  })
})

/*
 * Our docx writer names each code block's language in a hidden bookmark
 * around it (code-bookmark.ts), which Word and LibreOffice keep; the reader
 * gives the block that language rather than a guess.
 */
describe('docx: a code block language kept in a hidden bookmark', () => {
  const mark = (id: number, name: string): string => `<w:bookmarkStart w:id="${id}" w:name="${name}"/>`
  const end = (id: number): string => `<w:bookmarkEnd w:id="${id}"/>`
  const code = (text: string): string => run(text, font('Courier'))

  it('names the block by the bookmark inside its paragraph, and leaves no anchor', async () => {
    const html = await read(para('Intro') + `<w:p>${mark(5, '_DocConvCode_0_ini')}${code('[core]')}${br}${code('name = x')}${end(5)}</w:p>`)
    expect(html).toContain('<pre><code class="language-ini">[core]\nname = x</code></pre>')
    expect(html).not.toContain('DocConvCode')
  })

  it('reads a bookmark around the paragraph too, as another editor may save it', async () => {
    const html = await read(`${mark(1, '_DocConvCode_0_c_2b_2b')}<w:p>${code('int main() {}')}</w:p>${end(1)}` + para('After'))
    expect(html).toContain('<pre><code class="language-c++">int main() {}</code></pre>')
    expect(html).not.toContain('DocConvCode')
  })

  it('names a block inside a list item', async () => {
    const html = await read(item(run('Step one:') + br + mark(2, '_DocConvCode_0_objective_2dc') + code('[obj go];') + end(2) + br + run('Then this.')))
    expect(html).toMatch(/<li>Step one:<pre><code class="language-objective-c">\[obj go\];<\/code><\/pre>Then this\.<\/li>/)
    expect(html).not.toContain('DocConvCode')
  })

  it('keeps two neighboring blocks apart, each with its language', async () => {
    const html = await read(`<w:p>${mark(1, '_DocConvCode_0_ini')}${code('a = 1')}${end(1)}</w:p><w:p>${mark(2, '_DocConvCode_1_text')}${code('b c')}${end(2)}</w:p>`)
    expect(html).toContain('<pre><code class="language-ini">a = 1</code></pre><pre><code class="language-text">b c</code></pre>')
  })

  it('ignores a bookmark on text that is no longer code, or one that is garbled', async () => {
    const html = await read(`<w:p>${mark(1, '_DocConvCode_0_python')}${run('Now prose.')}${end(1)}</w:p><w:p>${mark(2, '_DocConvCode_1_py_zz')}${code('x  = 1')}${end(2)}</w:p>`)
    expect(html).toContain('<p>Now prose.</p>')
    expect(html).toContain('<pre><code>x  = 1</code></pre>')
    expect(html).not.toContain('DocConvCode')
  })

  it('leaves no anchor when the document has no code at all', async () => {
    const html = await read(`<w:p>${mark(1, '_DocConvCode_0_python')}${run('Just prose.')}${end(1)}</w:p>`)
    expect(html).toBe('<p>Just prose.</p>')
  })

  it('keeps other bookmarks as they were', async () => {
    const html = await read(`<w:p>${mark(1, 'Chapter1')}${run('Title text')}${end(1)}</w:p><w:p>${mark(2, '_DocConvCode_0_ini')}${code('a = 1')}${end(2)}</w:p>`)
    expect(html).toContain('<a id="Chapter1"></a>')
    expect(html).toContain('language-ini')
  })
})

describe('md → docx → md', () => {
  const conv = createConverter(async () => Buffer.from(''))
  const roundTrip = async (md: string): Promise<string> => {
    const docxOut = await conv.convert({ bytes: Buffer.from(md), filename: 'a.md' }, 'md', 'docx')
    const back = await conv.convert({ bytes: docxOut.parts[0].bytes, filename: 'a.docx' }, 'docx', 'md')
    return back.parts[0].bytes.toString('utf8')
  }

  it('gives back a fenced code block, indentation, blank lines and language', async () => {
    const code = 'def total(items):\n    result = 0\n    for item in items:\n        result += item\n\n    return result'
    const md = await roundTrip(`Intro.\n\n\`\`\`python\n${code}\n\`\`\`\n\nMiddle.\n\n\`\`\`\nplain  two  spaces\n  indented <tag> & more\n\`\`\`\n\nEnd with \`inline\` code.\n`)
    expect(md).toContain(`\`\`\`python\n${code}\n\`\`\``)
    expect(md).toContain('```\nplain  two  spaces\n  indented <tag> & more\n```')
    expect(md).toContain('Middle.')
    expect(md).toContain('End with `inline` code.')
  })

  it('gives back a fenced block inside list items, under the item, text after it and nesting kept', async () => {
    const md = await roundTrip(
      '- Step one:\n\n  ```\n  npm  install\n\n  \tnpm test\n  ```\n\n  Then this.\n- Two\n' +
        '  1. Nested:\n\n     ```python\n     def total(items):\n         return sum(items)\n     ```\n  2. After\n\n' +
        'Between.\n\n1. Numbered\n\n   ```\n   a = 1\n   ```\n2. B\n',
    )
    expect(md).toMatch(/^\*\s+Step one:\n\s*\n {4}```\w*\n {4}npm {2}install\n\s*\n {4}\tnpm test\n {4}```\n\s*\n {4}Then this\.$/m)
    expect(md).toMatch(/^ {4}1\.\s+Nested:\n\s*\n {8}```python\n {8}def total\(items\):\n {12}return sum\(items\)\n {8}```$/m)
    expect(md).toMatch(/^ {4}2\.\s+After$/m)
    expect(md).toMatch(/^1\.\s+Numbered\n\s*\n {4}```\w*\n {4}a = 1\n {4}```$/m)
    expect(md).toMatch(/^2\.\s+B$/m)
  })

  it('gives back the language of each block, where the guess would get it wrong or not know it', async () => {
    const blocks: [string, string][] = [
      ['ini', '[core]\nname = x'],
      ['text', 'def f():\n    return 1'],
      ['c++', 'int main() {\n  return 0;\n}'],
      ['cpp', 'int x = 0;'],
      ['csharp', 'public class A {\n  public int B { get; set; }\n}'],
      ['objective-c', '@interface Foo : NSObject\n@end'],
      ['javascript', 'class A {\n  #x = 1;\n  get x() { return this.#x }\n}'],
    ]
    const md = await roundTrip(blocks.map(([lang, code]) => `\`\`\`${lang}\n${code}\n\`\`\``).join('\n\nNext.\n\n') + '\n')
    for (const [lang, code] of blocks) expect(md).toContain(`\`\`\`${lang}\n${code}\n\`\`\``)
    expect(md).not.toContain('DocConvCode')
  })

  it('gives back the language of a block inside a list item', async () => {
    const md = await roundTrip('- Step one:\n\n  ```ini\n  [core]\n  name = x\n  ```\n\n  Then this.\n- Two\n')
    expect(md).toMatch(/^\*\s+Step one:\n\s*\n {4}```ini\n {4}\[core\]\n {4}name = x\n {4}```\n\s*\n {4}Then this\.$/m)
  })

  it('still guesses the language of a block in a docx without our bookmark', async () => {
    const bytes = await docx(`<w:p>${run('def total(items):', font('Courier'))}${br}${run('    return sum(items)', font('Courier'))}</w:p>`)
    const back = await conv.convert({ bytes, filename: 'a.docx' }, 'docx', 'md')
    expect(back.parts[0].bytes.toString('utf8')).toContain('```python\ndef total(items):\n    return sum(items)\n```')
  })

  it('gives back inline code in a sentence, bold and linked too', async () => {
    const md = await roundTrip('Set `x = 1` first, then **`go()`** and [`docs`](https://example.com/a).\n')
    expect(md).toContain('Set `x = 1` first')
    expect(md).toMatch(/\*\*`go\(\)`\*\*|`\*\*go\(\)\*\*`/)
    expect(md).toContain('[`docs`](https://example.com/a)')
  })
})
