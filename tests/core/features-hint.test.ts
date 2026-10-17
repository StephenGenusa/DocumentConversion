import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { featuresHint, FEATURES_HINT_MAX_BYTES } from '../../src/core/features-hint'

const b = (s: string): Buffer => Buffer.from(s, 'utf8')

describe('featuresHint (spec 2a: the Diagrams choice knows about a file never opened)', () => {
  it('finds the diagrams and formulas in the corpus fixture', async () => {
    const bytes = readFileSync(join(__dirname, '..', 'corpus', 'diagram-notes.md'))
    expect(await featuresHint(bytes, 'md', 'diagram-notes.md')).toEqual({ diagrams: true, math: true })
  })

  it('reads each text format with its own reader', async () => {
    expect(await featuresHint(b('[mermaid]\n----\ngraph LR\nA-->B\n----\n'), 'asciidoc')).toEqual({ diagrams: true, math: false })
    expect(await featuresHint(b('.. mermaid::\n\n   graph LR\n   A-->B\n'), 'rst')).toEqual({ diagrams: true, math: false })
    expect(await featuresHint(b('<pre><code class="language-mermaid">graph LR</code></pre>'), 'html')).toEqual({ diagrams: true, math: false })
    // Graphviz alone counts: it is drawn too (step 17), so the Diagrams choice applies.
    expect(await featuresHint(b('.. digraph:: deps\n\n   a -> b\n'), 'rst')).toEqual({ diagrams: true, math: false })
    expect(await featuresHint(b('# Plain\n\nNothing to draw, and $5 is not math.\n'), 'md')).toEqual({ diagrams: false, math: false })
  })

  it('a Word file: formulas when it holds equations (spec B12), found without converting it', async () => {
    const equations = readFileSync(join(__dirname, '..', 'corpus', 'treasurer-equations.docx'))
    expect(await featuresHint(equations, 'docx')).toEqual({ diagrams: false, math: true })
    const plain = readFileSync(join(__dirname, '..', 'corpus', 'supply-request-header.docx'))
    expect(await featuresHint(plain, 'docx')).toEqual({ diagrams: false, math: false })
  })

  it('says nothing for formats with no such blocks, for large inputs, or for an input it cannot read', async () => {
    expect(await featuresHint(b('```mermaid\nA\n```'), 'txt')).toBeUndefined()
    expect(await featuresHint(b('anything'), 'docx')).toBeUndefined()
    expect(await featuresHint(Buffer.alloc(FEATURES_HINT_MAX_BYTES + 1, 0x61), 'md')).toBeUndefined()
    expect(await featuresHint(b('{ not json'), 'ipynb')).toBeUndefined()
  })
})
