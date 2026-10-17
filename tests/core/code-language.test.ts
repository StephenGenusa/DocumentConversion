import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { createConverter } from '../../src/core/convert'
import { detect } from '../../src/core/detect'
import { renderEditableText } from '../../src/core/text-intake'
import { pastedHtmlToHub } from '../../src/core/remote-images'
import { shouldUseHtmlFlavor } from '../../src/core/paste-flavors'
import { guessLanguage, languageFromClass, normalizeLanguage, guessCodeLanguages } from '../../src/core/code-language'
import { writeDocx } from '../../src/core/writers/docx'
import type { GuardedFetchDeps } from '../../src/core/net/guarded-fetch'

/*
 * The owner pasted Python into the main window: it showed as a code block, and
 * printed as plain monospace. Highlighting needs `language-X` on the block, and
 * a paste has no filename to take it from. These run each realistic clipboard
 * source through the functions the app uses — the flavour choice, then either
 * the pasted-HTML or the pasted-text intake — and check the hub, the printed
 * HTML and the other writers.
 */

const PY = [
  '# Totals for the invented ledger',
  'import math',
  '',
  'def total(items):',
  '    result = 0',
  '    for item in items:',
  '        if item.amount > 0:',
  '            result += item.amount',
  '    return math.floor(result)',
].join('\n')

const noFetch = {} as GuardedFetchDeps

/** The app's paste: the HTML flavour when it is formatted, else the text one (intake.ts onPaste). */
async function paste(html: string, plain: string): Promise<string> {
  if (shouldUseHtmlFlavor(html, plain)) return pastedHtmlToHub(html, noFetch)
  const d = detect(Buffer.from(plain, 'utf8'))
  if (d.kind !== 'ok') throw new Error('not text')
  return renderEditableText(plain, d.format)
}

const rendered: string[] = []
const conv = createConverter(async (html: string) => {
  rendered.push(html)
  return Buffer.from('%PDF fake')
})
const text = (res: { parts: { bytes: Buffer }[] }): string => res.parts[0].bytes.toString('utf8')

/** The pane's HTML converted as the app converts it: an html source. */
async function convertHub(hub: string, target: 'html' | 'md' | 'pdf'): Promise<string> {
  const out = await conv.convert({ bytes: Buffer.from(hub, 'utf8') }, 'html', target, target === 'pdf' ? { pdf: {} } : undefined)
  return target === 'pdf' ? rendered[rendered.length - 1] : text(out)
}

const escaped = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const spans = (lines: string, styleFor: (i: number) => string): string =>
  lines
    .split('\n')
    .map((l, i) => `<div><span style="${styleFor(i)}">${escaped(l) || '<br>'}</span></div>`)
    .join('')

const PYCHARM_LINES = [
  '# A small invented script for checking the clipboard path.',
  '',
  '# Run it with the green arrow, or press the run key while it has the focus.',
  '',
  'def total(items):',
  '    # Add up the amounts that are above zero, and ignore all of the rest.',
  '    result = 0',
  '    for item in items:',
  '        if item.amount > 0:',
  '            result += item.amount  # The running sum is kept in this variable.',
  '    return result',
  '',
  "if __name__ == '__main__':",
  "    print(f'Total: {total([])}')",
]
const sp = (s: string): string => s.replace(/ /g, '&#32;')

const SOURCES: Record<string, { html: string; plain: string }> = {
  'plain text (terminal, Notepad, a .py in a plain editor)': { html: '', plain: PY },
  'VS Code: a div per line, colored spans': {
    html: `<meta charset='utf-8'><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Consolas, 'Courier New', monospace;white-space: pre;">${spans(PY, (i) => (i % 2 ? 'color: #569cd6;' : 'color: #d4d4d4;'))}</div>`,
    plain: PY,
  },
  'Colab: the same Monaco HTML': {
    html: `<div style="color: #000000;background-color: #fffffe;font-family: monospace;white-space: pre;">${spans(PY, () => 'color: #0000ff;')}</div>`,
    plain: PY,
  },
  'JetBrains: one <pre> with colored spans and no language': {
    html: `<html><head><meta charset="utf-8"></head><body><pre style="background-color:#2b2b2b;color:#a9b7c6;font-family:'JetBrains Mono',monospace;">${escaped(PY)
      .split('\n')
      .map((l) => l.replace(/\b(def|import|for|in|if|return)\b/g, '<span style="color:#cc7832;">$1</span>'))
      .join('<br>')}</pre></body></html>`,
    plain: PY,
  },
  // The owner's source. PyCharm's "Copy as rich text" (on by default): one
  // <pre> styled inline, newlines in the text, keywords in spans that carry
  // their trailing space, and no language named anywhere.
  'PyCharm: rich-text copy, Darcula colors as inline styles': {
    html: `<html><head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body><pre style="background-color:#2b2b2b;color:#a9b7c6;font-family:'JetBrains Mono',monospace;font-size:9.8pt;">${escaped(PY)
      .replace(/^# .*$/m, (c) => `<span style="color:#7a7e85;">${c}</span>`)
      .replace(/\b(def|import|for|in|if|return) /g, '<span style="color:#cc7832;">$1 </span>')
      .replace(/\btotal\b(?=\()/, '<span style="color:#ffc66d;">total</span>')
      .replace(/\b0\b/g, '<span style="color:#6897bb;">0</span>')}</pre></body></html>`,
    plain: PY,
  },
  // The same copy as X11 hands it over on Linux: a <meta charset> before the
  // document, and CRLF line ends in both flavours.
  'PyCharm on Linux: meta-prefixed HTML, CRLF line ends': {
    html: `<meta charset='utf-8'><html><body><!--StartFragment--><pre style="background-color:#1e1f22;color:#bcbec4;font-family:'JetBrains Mono',monospace;font-size:9.8pt;">${escaped(PY)
      .replace(/\b(def|import|for|in|if|return) /g, '<span style="color:#cf8e6d;">$1 </span>')
      .replace(/\n/g, '\r\n')}</pre><!--EndFragment--></body></html>`,
    plain: PY.replace(/\n/g, '\r\n'),
  },
  // Byte for byte the shape PyCharm put on an X11 clipboard (invented code):
  // a styled <div> round the <pre>, `<br>` for each line end, usually inside
  // the span that ends the line, every space as `&#32;`, and comments written
  // as sentences, the way its own sample script is.
  'PyCharm on Linux, as read off the X clipboard': {
    html:
      '<html><head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body>' +
      '<div style="background-color:#191a1c;color:#bcbec4"><pre style="font-family:\'JetBrains Mono\',monospace;font-size:9.8pt;">' +
      PYCHARM_LINES.map((l) =>
        l.startsWith('#') || l === ''
          ? `<span style="color:#7a7e85;">${sp(escaped(l))}<br></span>`
          : sp(escaped(l)).replace(/^((?:&#32;)*)(def|for|if|return)&#32;/, '$1<span style="color:#cf8e6d;">$2&#32;</span>') + '<br>',
      ).join('') +
      '</pre></div></body></html>',
    plain: PYCHARM_LINES.join('\n') + '\n',
  },
  'PyCharm with rich-text copy turned off: text only': { html: '', plain: PY },
  'GitHub: highlight-source-python on the wrapper': {
    html: `<div class="highlight highlight-source-python notranslate position-relative overflow-auto" dir="auto"><pre>${escaped(PY).replace(/\b(def|import|return)\b/g, '<span class="pl-k">$1</span>')}</pre></div>`,
    plain: PY,
  },
  'Stack Overflow: lang-py on the <pre>, hljs spans, no language class': {
    html: `<pre class="lang-py s-code-block"><code class="hljs">${escaped(PY).replace(/\b(def|return)\b/g, '<span class="hljs-keyword">$1</span>')}</code></pre>`,
    plain: PY,
  },
  'Sphinx docs: highlight-python3 two wrappers up': {
    html: `<div class="highlight-python3 notranslate"><div class="highlight"><pre><span></span>${escaped(PY)}</pre></div></div>`,
    plain: PY,
  },
  'a docs page with a bare <pre> and no name for the language': { html: `<p>Example:</p><pre>${escaped(PY)}</pre>`, plain: PY },
  'JupyterLab: text only': { html: '', plain: PY },
}

describe('a pasted Python snippet is highlighted, from wherever it was copied', () => {
  it.each(Object.entries(SOURCES))('%s', async (_name, { html, plain }) => {
    const hub = await paste(html, plain)
    expect(hub).toContain('<code class="language-python">')
    // The text survives whole, indentation included.
    expect(hub).toContain('            result += item.amount')
    expect(hub).not.toMatch(/<span/)
    expect(hub).not.toContain('\r')
    for (const target of ['html', 'pdf'] as const) {
      const out = await convertHub(hub, target)
      expect(out).toContain('<code class="language-python hljs">')
      expect(out).toContain('<span class="hljs-keyword">def</span>')
      expect(out).not.toContain('&lt;span')
    }
    expect(await convertHub(hub, 'md')).toContain('```python\n')
  })

  it('the path that showed a code block before: a <pre> in the HTML flavour, which lost its language', async () => {
    // What the pane used to receive for the GitHub, JetBrains and docs pastes:
    // a code block with no class, which shell.ts never highlights.
    const { html } = SOURCES['GitHub: highlight-source-python on the wrapper']
    expect(shouldUseHtmlFlavor(html, PY)).toBe(true)
    expect(await pastedHtmlToHub(html, noFetch)).toMatch(/<pre><code class="language-python">/)
  })

  it('plain text is one code block, not a heading and paragraphs', async () => {
    // A `# comment` made it markdown, whose reader made a heading of it.
    expect(detect(Buffer.from(PY)).kind === 'ok' && detect(Buffer.from(PY))).toMatchObject({ format: 'md' })
    const hub = await paste('', PY)
    expect(hub).not.toContain('<h1>')
    expect(hub.match(/<pre>/g)).toHaveLength(1)
    expect(hub).toContain('# Totals for the invented ledger\nimport math\n\ndef total')
  })
})

describe('guessing a language', () => {
  const JS = 'const total = (items) => {\n  let sum = 0\n  for (const item of items) sum += item.amount\n  return sum\n}\nconsole.log(total([]))'
  const TS = 'interface Item {\n  amount: number\n}\nexport const total = (items: Item[]): number =>\n  items.reduce((s, i) => s + i.amount, 0)'
  const BASH = 'cd ~/projects/widget\nnpm install\nexport NODE_ENV=production\nif [ -f .env ]; then\n  source .env\nfi'
  const SCRIPT = '#!/usr/bin/env bash\nset -euo pipefail\nfor f in *.txt; do echo "$f"; done'
  const PROSE =
    'The quarterly review went well. The team shipped three features and fixed a number of defects that customers had reported.\n\n' +
    'Next quarter the plan is to focus on performance (mostly start-up time), and on making the onboarding flow easier.'
  const LOG = [
    '2024-03-01 12:00:01 INFO  Starting service on port 8080',
    '2024-03-01 12:00:02 WARN  Cache directory missing, creating /var/cache/app',
    '2024-03-01 12:00:05 ERROR Connection refused: db.internal:5432 (attempt 1 of 5)',
    '2024-03-01 12:00:10 INFO  Connected to database',
  ].join('\n')
  const TRACE = 'Traceback (most recent call last):\n  File "app.py", line 3, in <module>\n    main()\nZeroDivisionError: division by zero'
  const MARKDOWN = '# Project title\n\nSome intro text with **bold**.\n\n- item one\n- item two\n\n[link](https://example.com)'
  const AGENDA = 'Agenda (it may change):\n1. Budget review - 10 minutes\n2. Hiring plan for Q3\n3. Any other business'

  it.each([
    ['Python', PY, 'python'],
    ['JavaScript', JS, 'javascript'],
    ['TypeScript', TS, 'typescript'],
    ['Bash commands', BASH, 'bash'],
    ['a shell script by its shebang', SCRIPT, 'bash'],
    ['SQL', 'SELECT name, COUNT(*) AS n\nFROM orders\nWHERE total > 10\nGROUP BY name;', 'sql'],
    ['JSON', '{\n  "name": "widget",\n  "version": "1.0.0"\n}', 'json'],
    ['Java', 'public class Hello {\n    public static void main(String[] args) {\n        System.out.println("Hi");\n    }\n}', 'java'],
    ['Go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}', 'go'],
  ])('%s', (_name, code, language) => {
    expect(guessLanguage(code)).toBe(language)
  })

  it.each([
    ['prose', PROSE],
    ['a log excerpt', LOG],
    ['a stack trace', TRACE],
    ['markdown', MARKDOWN],
    ['an agenda', AGENDA],
    ['a CSV excerpt', 'name,amount\nwidget,10\ngadget,20'],
  ])('leaves %s without a language', (_name, body) => {
    expect(guessLanguage(body)).toBeUndefined()
  })

  it('pasted JavaScript and Bash are code blocks in their language', async () => {
    expect(await paste('', JS)).toContain('<code class="language-javascript">')
    expect(await paste('', BASH)).toContain('<code class="language-bash">')
  })

  it('pasted prose, a log and markdown open as they did', async () => {
    expect(await paste('', PROSE)).toMatch(/^<p>The quarterly/)
    expect(await paste('', LOG)).not.toContain('<pre>')
    expect(await paste('', MARKDOWN)).toContain('<h1>Project title</h1>')
  })

  it('a code block of log lines or prose stays unclassed', async () => {
    const hub = `<pre><code>${escaped(LOG)}</code></pre><pre><code>${escaped(PROSE)}</code></pre>`
    expect(guessCodeLanguages(hub)).toBe(hub)
    expect(await convertHub(hub, 'html')).not.toContain('hljs')
  })

  it('a markdown fence without a language is given one, and written back with it', async () => {
    const out = await conv.convert({ bytes: Buffer.from('Run this:\n\n```\n' + PY + '\n```\n') }, 'md', 'md')
    expect(text(out)).toContain('```python\n# Totals')
  })

  it('never overrides a language a reader chose, plaintext included, nor a diagram or formula', () => {
    const decided = [
      '<pre><code class="language-plaintext">def f():\n    return 1\nfor x in y:\n    pass</code></pre>',
      '<pre><code class="language-ruby">def f():\n    return 1\nfor x in y:\n    pass</code></pre>',
      '<pre><code class="language-mermaid">graph TD\n  A --&gt; B</code></pre>',
      '<pre><code class="language-math">x^2</code></pre>',
      '<p>Inline <code>def f(): return 1</code></p>',
      '<pre class="nb-output nb-stream">def f():\n    return 1</pre>',
    ].join('')
    expect(guessCodeLanguages(decided)).toBe(decided)
  })

  it('a .txt file stays a listing without color', async () => {
    const out = await conv.convert({ bytes: Buffer.from(PY), filename: 'notes.txt' }, 'txt', 'html')
    expect(text(out)).not.toContain('hljs')
  })
})

describe('the names pages give a language', () => {
  it.each([
    ['language-python', 'python'],
    ['language-py', 'python'],
    ['lang-py s-code-block', 'python'],
    ['highlight highlight-source-python notranslate', 'python'],
    ['highlight-source-js', 'javascript'],
    ['highlight-source-shell', 'bash'],
    ['highlight-source-c++', 'cpp'],
    ['highlight-text-html-basic', 'xml'],
    ['highlight-python3 notranslate', 'python'],
    ['sourceCode python', 'python'],
    ['hljs python', 'python'],
    ['brush: python; gutter: false', 'python'],
    ['brush: js notranslate', 'javascript'],
    ['prism language-ts', 'typescript'],
    ['language-sh', 'bash'],
    ['language-text', 'plaintext'],
  ])('%s', (cls, language) => {
    expect(languageFromClass(cls)).toBe(language)
  })

  it.each(['highlight notranslate', 'go', 'position-relative c', 'language-mermaid', 'language-math', 'lang-en'])(
    'not from %s',
    (cls) => {
      expect(languageFromClass(cls)).toBeUndefined()
    },
  )

  it('keeps only the normalised class, from data-lang too', async () => {
    const hub = await pastedHtmlToHub('<pre data-lang="py"><code class="hljs prism">x = 1\nprint(x)</code></pre>', noFetch)
    expect(hub).toBe('<pre><code class="language-python">x = 1\nprint(x)</code></pre>')
    expect(normalizeLanguage('graphviz')).toBeUndefined()
    // A name highlight.js lacks is kept as the author wrote it, and not guessed over.
    expect(await pastedHtmlToHub('<pre><code class="language-zig">const x = 1;\nconst y = 2;</code></pre>', noFetch)).toBe(
      '<pre><code class="language-zig">const x = 1;\nconst y = 2;</code></pre>',
    )
  })

  it('a saved web page gets the same mapping', async () => {
    const page = `<!doctype html><html><body><div class="highlight-source-python"><pre>${escaped(PY)}</pre></div></body></html>`
    const out = await conv.convert({ bytes: Buffer.from(page), filename: 'page.html' }, 'html', 'html')
    expect(text(out)).toContain('<span class="hljs-keyword">def</span>')
  })
})

describe('Word', () => {
  const docXml = async (html: string): Promise<string> =>
    (await JSZip.loadAsync(await writeDocx({ html }))).file('word/document.xml')!.async('string')

  it('colors highlighted code by run, line by line, without touching the formatting stand-in', async () => {
    const xml = await docXml(`<pre><code class="language-python">${escaped(PY)}</code></pre>`)
    expect(xml).toMatch(/<w:color w:val="cf222e"\/>/i) // keywords
    expect(xml).toMatch(/<w:color w:val="59636e"\/>/i) // the comment
    expect(xml).not.toMatch(/w:val="0D0C/i)
    // One paragraph, its lines split by breaks, every character kept.
    const para = xml.split('</w:p>').find((p) => p.includes('total'))!
    const read = [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br\b[^>]*\/>/g)].map((m) => (m[0].startsWith('<w:br') ? '\n' : m[1])).join('')
    expect(read).toBe(PY.replace(/>/g, '&gt;'))
  })

  it('keeps Courier on a colored block inside a list item', async () => {
    const xml = await docXml(`<ul><li><p>Step:</p><pre><code class="language-python">def f():\n    return 1</code></pre></li></ul>`)
    const run = /<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*cf222e(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>/i.exec(xml)?.[0]
    expect(run).toContain('w:ascii="Courier"')
  })

  it('leaves an unknown or plaintext block uncolored', async () => {
    const xml = await docXml('<pre><code class="language-plaintext">def f():\n    return 1</code></pre>')
    expect(xml).not.toMatch(/cf222e/i)
  })
})
