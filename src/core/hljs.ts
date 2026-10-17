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
import { TOKEN_COLORS } from './hljs-palette'

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

// The screen palette lives on its own, so the editor can color code without
// carrying every grammar (renderer/src/lib/code-grammars.ts loads them lazily).
export { TOKEN_COLORS, HLJS_CSS } from './hljs-palette'

/**
 * The same scopes for an e-reader (epub, the AZW3 made from it, and the
 * printed page of an AZW4, which a reader such as Calibre's may reflow into
 * text that keeps bold and italic but not color). Darker than the screen palette, so every color still reads at better than
 * 5:1 on a sepia page as well as white; and not by color alone, since a
 * black-and-white Kindle turns these into much the same gray: keywords are
 * bold and comments italic. No backgrounds (a diff's lines included): the
 * reader's night and sepia themes own the page, and a forced light block
 * would clash with them.
 */
const EREADER_TOKEN_COLORS: ReadonlyArray<readonly [scopes: readonly string[], color: string]> = [
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

export const EREADER_HLJS_CSS = `${EREADER_TOKEN_COLORS.map(
  ([scopes, color]) => `${scopes.map((s) => `.hljs-${s}`).join(', ')} { color: ${color}; }`,
).join('\n')}
.hljs-keyword, .hljs-selector-tag, .hljs-section, .hljs-name { font-weight: bold; }
.hljs-comment, .hljs-quote { font-style: italic; }
`

const COLOR_OF = new Map(TOKEN_COLORS.flatMap(([scopes, color]) => scopes.map((s) => [s, color] as const)))

/**
 * Highlighted code (highlight.js's HTML, perhaps with the author's markup
 * around its spans: code-markup.ts) as flat runs: each piece of text in a
 * span with an inline `color`, the color of the innermost token that has one,
 * and uncolored text bare. For a writer that can color a run but not apply a
 * stylesheet. The author's tags are left where they stand, between the runs.
 *
 * Lines are separated by a bare newline, and no piece is only white space:
 * html-to-docx drops a whitespace-only run, which printed `def total` as
 * `deftotal` and took every indent in front of a keyword. Such a piece joins
 * the one after it on its line (white space shows no color), and white space
 * that ends a line is dropped.
 */
export function highlightedRuns(value: string): string {
  const stack: (string | undefined)[] = []
  const lines: { color?: string; text: string; tag?: boolean }[][] = [[]]
  for (const m of value.matchAll(/<span class="([^"]*)">|<\/span>|<[^>]*>|[^<]+/g)) {
    if (m[1] !== undefined) {
      const scope = /(?:^|\s)hljs-([\w-]+)/.exec(m[1])?.[1]
      stack.push((scope && COLOR_OF.get(scope)) ?? stack[stack.length - 1])
    } else if (m[0] === '</span>') {
      stack.pop()
    } else if (m[0].startsWith('<')) {
      lines[lines.length - 1].push({ text: m[0], tag: true })
    } else {
      m[0].split('\n').forEach((text, i) => {
        if (i) lines.push([])
        if (text) lines[lines.length - 1].push({ color: stack[stack.length - 1], text })
      })
    }
  }
  const run = ({ color, text }: { color?: string; text: string }): string =>
    color ? `<span style="color: ${color}">${text}</span>` : text
  return lines
    .map((pieces) => {
      let out = ''
      let pending = ''
      for (const piece of pieces) {
        // White space before an author's tag stays outside it, bare.
        if (piece.tag) {
          out += pending + piece.text
          pending = ''
        }
        // hljs escapes &, < and >, so an entity is never white space.
        else if (piece.text.trim() === '') pending += piece.text
        else {
          out += run({ color: piece.color, text: pending + piece.text })
          pending = ''
        }
      }
      return out
    })
    .join('\n')
}

export default hljs
