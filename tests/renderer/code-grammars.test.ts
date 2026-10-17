// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { Editor } from '@tiptap/core'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'
import { GRAMMARS, grammarName, grammarReady, hljs as editorHljs, loadGrammar } from '../../src/renderer/src/lib/code-grammars'
import outputsHljs from '../../src/core/hljs'
import { installHighlights, painted } from './highlights'

/*
 * The editor's grammars are loaded when a block needs one, not carried in the
 * renderer bundle; the list must stay the outputs' list.
 */

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('the editor grammars', () => {
  it('are the languages the outputs register, with the same titles and aliases', () => {
    expect(GRAMMARS.map(([name]) => name).sort()).toEqual(outputsHljs.listLanguages().sort())
    for (const [name, title, aliases] of GRAMMARS) {
      const lang = outputsHljs.getLanguage(name)!
      expect(title).toBe(lang.name)
      expect([...aliases]).toEqual(lang.aliases ?? [])
    }
  })

  it('name a language as highlight.js does: by name or alias, any case', () => {
    for (const probe of ['js', 'JSX', 'py', 'Python', 'html', 'svg', 'h', 'hpp', 'yml', 'ps1', 'text', 'console', 'nosuchlang', '']) {
      const lang = outputsHljs.getLanguage(probe)
      const expected = lang ? outputsHljs.listLanguages().find((n) => outputsHljs.getLanguage(n) === lang)! : null
      expect(grammarName(probe)).toBe(expected)
    }
  })

  it('load a grammar with the ones it embeds, once, into the editor\'s own highlight.js', async () => {
    expect(await loadGrammar('xml')).toBe(true)
    expect(grammarReady('xml')).toBe(true)
    // HTML hands its <style> and <script> to CSS and JavaScript, which hands its templates back to HTML.
    for (const n of ['css', 'javascript']) expect(grammarReady(n) || editorHljs.getLanguage(n) !== undefined).toBe(true)
    const { value } = editorHljs.highlight('<style>a { color: red }</style><script>const n = 1</script>', { language: 'xml' })
    expect(value).toContain('hljs-selector-tag')
    expect(value).toContain('<span class="hljs-keyword">const</span>')
    expect(loadGrammar('xml')).toBe(loadGrammar('xml'))
    expect(await loadGrammar('nosuchlang')).toBe(false)
  })

  it('color a block once its grammar is in, without any edit', async () => {
    expect(grammarReady('go')).toBe(false)
    installHighlights()
    const host = document.createElement('div')
    document.body.append(host)
    editor = new Editor({ element: host, extensions: EDITOR_EXTENSIONS, content: '<pre><code class="language-golang">func main() { return }</code></pre>' })
    expect(await loadGrammar('go')).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(painted(host)).toContain('hljs-keyword:func')
    expect(editor.getHTML()).toMatch(/^<pre><code class="language-golang">func main\(\) { return }<\/code><\/pre>/)
    host.remove()
  })

  it('stay out of the renderer: nothing there imports core/hljs.ts or the whole highlight.js', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(f)) files.push(p)
      }
    }
    walk(join(__dirname, '../../src/renderer/src'))
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/^import (?!type ).*from '[./]*core\/hljs'/m)
      expect(src, f).not.toMatch(/^import (?!type ).*from 'highlight\.js(\/lib\/common)?'/m)
    }
  })
})
