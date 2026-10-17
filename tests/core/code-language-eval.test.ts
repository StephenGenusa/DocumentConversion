import { describe, it, expect } from 'vitest'
import { guessLanguage, pastedCodeLanguage, guessCodeLanguages } from '../../src/core/code-language'
import { renderEditableText } from '../../src/core/text-intake'
import { SAMPLES, HELD_OUT, NOT_CODE } from './code-language-samples'

/*
 * The guess against its evaluation set (code-language-samples.ts). A miss is
 * allowed to be "no language" — the block is then shown plain, as before —
 * but never another language: a wrong coloring is worse than none.
 */

type Set = Record<string, { lines: string[]; one: string[] }>

function score(set: Set, pick: 'lines' | 'one') {
  let n = 0
  let right = 0
  const wrong: string[] = []
  for (const [language, samples] of Object.entries(set)) {
    for (const sample of samples[pick]) {
      n++
      const guess = pick === 'one' ? pastedCodeLanguage(sample) : guessLanguage(sample)
      if (guess === language) right++
      else if (guess) wrong.push(`${language} as ${guess}: ${sample.slice(0, 60)}`)
    }
  }
  return { n, right, wrong }
}

describe('the code-language guess, measured', () => {
  it('names nearly every block in the set, and never the wrong language', () => {
    const { n, right, wrong } = score(SAMPLES, 'lines')
    expect(wrong).toEqual([])
    expect(right / n).toBeGreaterThanOrEqual(0.95)
  })

  it('names a single line that says what it is', () => {
    const { n, right, wrong } = score(SAMPLES, 'one')
    expect(wrong).toEqual([])
    expect(right / n).toBeGreaterThanOrEqual(0.95)
  })

  it('does about as well on snippets it was not tuned on', () => {
    const blocks = score(HELD_OUT, 'lines')
    const ones = score(HELD_OUT, 'one')
    expect([...blocks.wrong, ...ones.wrong].length).toBeLessThanOrEqual(1)
    expect((blocks.right + ones.right) / (blocks.n + ones.n)).toBeGreaterThanOrEqual(0.75)
  })

  it.each(NOT_CODE.map((s) => [s.slice(0, 40), s]))('leaves alone: %s', (_name, text) => {
    expect(guessLanguage(text)).toBeUndefined()
    expect(pastedCodeLanguage(text)).toBeUndefined()
  })
})

describe('C, not C++', () => {
  it('a C program is c; with one C++ line it is cpp', () => {
    const c = '#include <stdio.h>\n\nint main(void) {\n    printf("hi\\n");\n    return 0;\n}'
    expect(guessLanguage(c)).toBe('c')
    expect(guessLanguage(c.replace('printf("hi\\n");', 'std::cout << "hi";'))).toBe('cpp')
  })

  it('a Rust `use std::` is not C++', () => {
    expect(guessLanguage('use std::collections::HashMap;')).toBe('rust')
  })
})

describe('one line', () => {
  it('a pasted query, command or include opens as code in its language', async () => {
    expect(await renderEditableText('SELECT name FROM users WHERE id = 7;', 'txt')).toBe(
      '<pre><code class="language-sql">SELECT name FROM users WHERE id = 7;</code></pre>',
    )
    expect(await renderEditableText('$ npm install --save-dev vitest', 'txt')).toContain('<code class="language-bash">')
    expect(await renderEditableText('#include <stdio.h>', 'md')).toContain('<code class="language-c">')
  })

  it('a pasted sentence, heading or link opens as it did', async () => {
    expect(await renderEditableText('Select a file from the list and press Open.', 'txt')).not.toContain('<pre>')
    expect(await renderEditableText('# Release notes', 'md')).toContain('<h1>')
    expect(await renderEditableText('[the docs](https://example.com/docs)', 'md')).not.toContain('<pre>')
  })

  it('a one-line code block is guessed by the same rule', () => {
    expect(guessCodeLanguages('<pre><code>fmt.Println("hi")</code></pre>')).toBe('<pre><code class="language-go">fmt.Println("hi")</code></pre>')
    const plain = '<pre><code>see page 12</code></pre>'
    expect(guessCodeLanguages(plain)).toBe(plain)
  })
})

describe('markdown stays markdown', () => {
  it('a block of badges, a link list or a changelog is not code', () => {
    const badges = '[![build][ci-image]][ci-url]\n[![coverage][cov-image]][cov-url]\n[![license][lic-image]][lic-url]'
    const links = '- [copy](docs/copy.md)\n- [move](docs/move.md)\n- [remove](docs/remove.md)'
    const changes = 'API\n---\n- feat: add the export button\n- fix: keep the margins\n- docs: explain the setting'
    for (const text of [badges, links, changes]) expect(guessLanguage(text)).toBeUndefined()
  })
})
