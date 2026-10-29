import { describe, it, expect } from 'vitest'
import { detect } from '../../src/core/detect'
import { renderEditableText } from '../../src/core/text-intake'
import { pastedHtmlToHub } from '../../src/core/remote-images'
import { clearlyMarkdown, shouldUseHtmlFlavor } from '../../src/core/paste-flavors'
import { guessLanguage } from '../../src/core/code-language'
import type { GuardedFetchDeps } from '../../src/core/net/guarded-fetch'

/*
 * The owner pasted an answer an AI had written: a couple of lines of prose,
 * then markdown with fenced code blocks. It opened as ONE code block, colored
 * as Python, `##` and the fences shown as text. The whole paste had gone to
 * the code guesser before the markdown reader, and the code inside the fences
 * outvoted the prose round it.
 *
 * The same document copied from where markdown is shown as source (a raw .md
 * page in a browser, an IDE) carries an HTML flavor that is one <pre>, and
 * that flavor won, with the same result. These run each shape through the
 * functions the app uses, as tests/core/code-language.test.ts does.
 */

const noFetch: GuardedFetchDeps = {
  lookup: async () => [{ address: '203.0.113.1', family: 4 }],
  fetchImpl: async () => {
    throw new Error('no network in this test')
  },
}

async function paste(html: string, plain: string): Promise<string> {
  if (shouldUseHtmlFlavor(html, plain)) return pastedHtmlToHub(html, noFetch)
  const d = detect(Buffer.from(plain, 'utf8'))
  if (d.kind !== 'ok') throw new Error('not text')
  return renderEditableText(plain, d.format)
}

const escaped = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** An answer with headings: prose, a Python script, the command to run it. */
const ANSWER = `Here's a script that does what you asked.
It reads the file and prints each line.

## The script

\`\`\`python
import sys

def main(path):
    with open(path) as f:
        for line in f:
            print(line.rstrip())

if __name__ == "__main__":
    main(sys.argv[1])
\`\`\`

## Running it

\`\`\`bash
python3 read.py notes.txt
\`\`\`
`

/** A short answer: one line before, one JavaScript block, one line after. */
const FIX = `Sure — here is the fix.

\`\`\`javascript
function add(a, b) {
  const sum = a + b;
  if (sum > 10) {
    console.log("big");
  }
  return sum;
}
module.exports = { add };
\`\`\`

That should work.
`

/** A README with no code: headings, a list, a link, bold. */
const README = `# Widget

A small library for **widgets**.

## Install

- Download the [latest release](https://example.com/releases).
- Unpack it anywhere.
`

const PY = 'import math\n\n# Totals\ndef total(items):\n    result = 0\n    for item in items:\n        result += item.amount\n    return math.floor(result)\n'

describe('a pasted AI answer opens as markdown, its code blocks colored', () => {
  it.each([
    ['with headings and two blocks', ANSWER, ['<h2>The script</h2>', '<code class="language-python">', '<code class="language-bash">']],
    ['with one block between two lines', FIX, ['<p>Sure — here is the fix.</p>', '<code class="language-javascript">', '<p>That should work.</p>']],
  ])('%s', async (_name, md, expected) => {
    const html = await paste('', md)
    for (const part of expected) expect(html).toContain(part)
    expect(html).not.toContain('```')
    expect(html).not.toMatch(/^<pre>/)
  })

  it('cut off before its closing fence, still opens as markdown', async () => {
    const html = await paste('', FIX.slice(0, FIX.indexOf('module.exports')))
    expect(html).toContain('<p>Sure — here is the fix.</p>')
    expect(html).toContain('<code class="language-javascript">')
  })

  it('is never guessed as code as a whole', () => {
    expect(guessLanguage(ANSWER)).toBeUndefined()
    expect(guessLanguage(FIX)).toBeUndefined()
  })
})

describe('markdown copied where it is shown as source', () => {
  const raw = (md: string): string => `<meta charset='utf-8'><pre style="word-wrap: break-word; white-space: pre-wrap;">${escaped(md)}</pre>`
  // An IDE's rich copy: a styled <div> round a <pre>, colored spans, `<br>` line ends.
  const ide = (md: string): string =>
    `<html><body><div style="background-color:#191a1c"><pre style="font-family:monospace;">` +
    md.split('\n').map((l) => `<span style="color:#cf8e6d;">${escaped(l)}</span><br>`).join('') +
    '</pre></div></body></html>'

  it.each([
    ['a raw .md page in a browser', raw],
    ['an IDE', ide],
  ])('from %s, opens as markdown', async (_name, wrap) => {
    for (const md of [ANSWER, README]) {
      expect(shouldUseHtmlFlavor(wrap(md), md)).toBe(false)
      const html = await paste(wrap(md), md)
      expect(html).toMatch(/<h[12]>/)
      expect(html).not.toMatch(/^<pre>/)
    }
  })

  it('code copied the same way stays one code block', async () => {
    expect(shouldUseHtmlFlavor(ide(PY), PY)).toBe(true)
    expect(await paste(ide(PY), PY)).toContain('<pre><code class="language-python">import math')
  })

  it('a code block copied from a page stays one code block, whatever it holds', () => {
    const block = `<pre><code class="language-markdown">${escaped(README)}</code></pre>`
    expect(shouldUseHtmlFlavor(block, README)).toBe(true)
  })

  it('a rendered page, which has more than a <pre>, keeps its formatting', () => {
    const page = `<h2>Install</h2><p>Run this:</p><pre>${escaped(ANSWER)}</pre>`
    expect(shouldUseHtmlFlavor(page, ANSWER)).toBe(true)
  })
})

describe('clearlyMarkdown', () => {
  it.each([
    ['an answer with fences', ANSWER],
    ['a fence left open, naming its language', 'Try this:\n\n```python\nprint(1)\n'],
    ['a README with no code', README],
    ['a table and a heading', '## Totals\n\n| a | b |\n|---|---|\n| 1 | 2 |'],
  ])('accepts %s', (_name, text) => {
    expect(clearlyMarkdown(text)).toBe(true)
  })

  it.each([
    ['Python with a comment', PY],
    ['one heading-like line', '# Notes'],
    ['shell with comments', '# install\nnpm install\n# run\nnpm start'],
    ['prose', 'The quarterly review went well.\n\nNext quarter we focus on speed.'],
    ['a single bullet', '- just one thing'],
  ])('rejects %s', (_name, text) => {
    expect(clearlyMarkdown(text)).toBe(false)
  })
})
