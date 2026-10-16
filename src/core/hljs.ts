/**
 * The one configured highlight.js: lib/common plus the languages the code
 * reader can name (see EXT_TO_LANG in code-langs.ts). Shared so the writers'
 * highlighting and the language guess (code-language.ts) agree on what exists.
 */
import hljs from 'highlight.js/lib/common'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import powershell from 'highlight.js/lib/languages/powershell'
// Beyond lib/common, each a few KB; see EXT_TO_LANG in code-langs.ts.
import scala from 'highlight.js/lib/languages/scala'
import groovy from 'highlight.js/lib/languages/groovy'
import dart from 'highlight.js/lib/languages/dart'
import haskell from 'highlight.js/lib/languages/haskell'
import elixir from 'highlight.js/lib/languages/elixir'
import erlang from 'highlight.js/lib/languages/erlang'
import clojure from 'highlight.js/lib/languages/clojure'
import fsharp from 'highlight.js/lib/languages/fsharp'
import ocaml from 'highlight.js/lib/languages/ocaml'
import julia from 'highlight.js/lib/languages/julia'
import vbscript from 'highlight.js/lib/languages/vbscript'
import dos from 'highlight.js/lib/languages/dos'
import cmake from 'highlight.js/lib/languages/cmake'
import protobuf from 'highlight.js/lib/languages/protobuf'
import x86asm from 'highlight.js/lib/languages/x86asm'
import nginx from 'highlight.js/lib/languages/nginx'

hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('powershell', powershell)
hljs.registerLanguage('scala', scala)
hljs.registerLanguage('groovy', groovy)
hljs.registerLanguage('dart', dart)
hljs.registerLanguage('haskell', haskell)
hljs.registerLanguage('elixir', elixir)
hljs.registerLanguage('erlang', erlang)
hljs.registerLanguage('clojure', clojure)
hljs.registerLanguage('fsharp', fsharp)
hljs.registerLanguage('ocaml', ocaml)
hljs.registerLanguage('julia', julia)
hljs.registerLanguage('vbscript', vbscript)
hljs.registerLanguage('dos', dos)
hljs.registerLanguage('cmake', cmake)
hljs.registerLanguage('protobuf', protobuf)
hljs.registerLanguage('x86asm', x86asm)
hljs.registerLanguage('nginx', nginx)

/**
 * The colour of each highlight.js scope, GitHub-light. The pdf and html shell
 * turns this into CSS; the docx writer gives a run the colour of its token.
 * None of these may begin `0D0C`: that is the docx writer's stand-in marker
 * for run formatting (writers/docx.ts), and a run coloured like it would be
 * rewritten as bold or italic.
 */
export const TOKEN_COLOURS: ReadonlyArray<readonly [scopes: readonly string[], colour: string]> = [
  [['keyword', 'selector-tag', 'meta'], '#cf222e'],
  [['title'], '#8250df'],
  [['string', 'regexp', 'attr'], '#0a3069'],
  [['number', 'literal'], '#0550ae'],
  [['comment', 'quote'], '#59636e'],
  [['built_in', 'type'], '#953800'],
  [['variable', 'template-variable', 'property'], '#24292f'],
  [['section', 'name'], '#0550ae'],
]

// Compact GitHub-light palette for hljs spans. The pdf and html shell prints it
// inline (the shell must stay self-contained) and the editor colours code with it
// (renderer/src/lib/code-colour.ts), so the pane looks like the printed page.
export const HLJS_CSS = `
${TOKEN_COLOURS.map(([scopes, colour]) => `  ${scopes.map((s) => `.hljs-${s}`).join(', ')} { color: ${colour}; }`).join('\n')}
  .hljs-comment, .hljs-quote { font-style: italic; }
  .hljs-section, .hljs-name { font-weight: 600; }
  .hljs-addition { background: #dafbe1; }
  .hljs-deletion { background: #ffebe9; }
  /* A printed review reads by whole lines: colour the line, not just its text. */
  .language-diff .hljs-addition, .language-diff .hljs-deletion { display: inline-block; width: 100%; }
`

/**
 * The same scopes for an e-reader (epub, the AZW3 made from it, and the
 * printed page of an AZW4, which a reader such as Calibre's may reflow into
 * text that keeps bold and italic but not colour). Darker than the screen palette, so every colour still reads at better than
 * 5:1 on a sepia page as well as white; and not by colour alone, since a
 * black-and-white Kindle turns these into much the same grey: keywords are
 * bold and comments italic. No backgrounds (a diff's lines included): the
 * reader's night and sepia themes own the page, and a forced light block
 * would clash with them.
 */
const EREADER_TOKEN_COLOURS: ReadonlyArray<readonly [scopes: readonly string[], colour: string]> = [
  [['keyword', 'selector-tag', 'meta'], '#a40e26'],
  [['title'], '#6639ba'],
  [['string', 'regexp', 'attr'], '#0a3069'],
  [['number', 'literal'], '#0550ae'],
  [['comment', 'quote'], '#57606a'],
  [['built_in', 'type'], '#953800'],
  [['variable', 'template-variable', 'property'], '#24292f'],
  [['section', 'name'], '#0550ae'],
  [['addition'], '#0f5c26'],
  [['deletion'], '#82071e'],
]

export const EREADER_HLJS_CSS = `${EREADER_TOKEN_COLOURS.map(
  ([scopes, colour]) => `${scopes.map((s) => `.hljs-${s}`).join(', ')} { color: ${colour}; }`,
).join('\n')}
.hljs-keyword, .hljs-selector-tag, .hljs-section, .hljs-name { font-weight: bold; }
.hljs-comment, .hljs-quote { font-style: italic; }
`

const COLOUR_OF = new Map(TOKEN_COLOURS.flatMap(([scopes, colour]) => scopes.map((s) => [s, colour] as const)))

/**
 * Code highlighted as flat runs: each piece of text in a span with an inline
 * `color`, the colour of the innermost token that has one, and uncoloured text
 * bare. For a writer that can colour a run but not apply a stylesheet.
 *
 * Lines are separated by a bare newline, and no piece is only white space:
 * html-to-docx drops a whitespace-only run, which printed `def total` as
 * `deftotal` and took every indent in front of a keyword. Such a piece joins
 * the one after it on its line (white space shows no colour), and white space
 * that ends a line is dropped.
 */
export function highlightedRuns(code: string, language: string): string {
  const { value } = hljs.highlight(code, { language })
  const stack: (string | undefined)[] = []
  const lines: { colour?: string; text: string }[][] = [[]]
  for (const m of value.matchAll(/<span class="([^"]*)">|<\/span>|[^<]+/g)) {
    if (m[1] !== undefined) {
      const scope = /(?:^|\s)hljs-([\w-]+)/.exec(m[1])?.[1]
      stack.push((scope && COLOUR_OF.get(scope)) ?? stack[stack.length - 1])
    } else if (m[0] === '</span>') {
      stack.pop()
    } else {
      m[0].split('\n').forEach((text, i) => {
        if (i) lines.push([])
        if (text) lines[lines.length - 1].push({ colour: stack[stack.length - 1], text })
      })
    }
  }
  const run = ({ colour, text }: { colour?: string; text: string }): string =>
    colour ? `<span style="color: ${colour}">${text}</span>` : text
  return lines
    .map((pieces) => {
      let out = ''
      let pending = ''
      for (const piece of pieces) {
        // hljs escapes &, < and >, so an entity is never white space.
        if (piece.text.trim() === '') pending += piece.text
        else {
          out += run({ colour: piece.colour, text: pending + piece.text })
          pending = ''
        }
      }
      return out
    })
    .join('\n')
}

export default hljs
