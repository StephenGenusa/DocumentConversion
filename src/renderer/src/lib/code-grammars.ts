import core from 'highlight.js/lib/core'
import type { HLJSApi, LanguageFn, Mode } from 'highlight.js'

/*
 * The grammars the editor colors code with, loaded when a document or the
 * language picker needs one rather than all carried in the renderer bundle
 * (about 450 KB). The list is the one core/hljs.ts registers for the outputs,
 * so the pane and the printed page know the same languages; a test checks
 * the two agree (tests/renderer/code-grammars.test.ts).
 */

/** Every language core/hljs.ts registers: its name, highlight.js's title for it, and its aliases. */
export const GRAMMARS: ReadonlyArray<readonly [name: string, title: string, aliases: readonly string[]]> = [
  ['xml', 'HTML, XML', ['html', 'xhtml', 'rss', 'atom', 'xjb', 'xsd', 'xsl', 'plist', 'wsf', 'svg']],
  ['bash', 'Bash', ['sh', 'zsh']],
  ['c', 'C', ['h']],
  ['cpp', 'C++', ['cc', 'c++', 'h++', 'hpp', 'hh', 'hxx', 'cxx']],
  ['csharp', 'C#', ['cs', 'c#']],
  ['css', 'CSS', []],
  ['markdown', 'Markdown', ['md', 'mkdown', 'mkd']],
  ['diff', 'Diff', ['patch']],
  ['ruby', 'Ruby', ['rb', 'gemspec', 'podspec', 'thor', 'irb']],
  ['go', 'Go', ['golang']],
  ['graphql', 'GraphQL', ['gql']],
  ['ini', 'TOML, also INI', ['toml']],
  ['java', 'Java', ['jsp']],
  ['javascript', 'JavaScript', ['js', 'jsx', 'mjs', 'cjs']],
  ['json', 'JSON', ['jsonc', 'json5']],
  ['kotlin', 'Kotlin', ['kt', 'kts', 'ktm', 'ktx']],
  ['less', 'Less', []],
  ['lua', 'Lua', ['pluto']],
  ['makefile', 'Makefile', ['mk', 'mak', 'make']],
  ['perl', 'Perl', ['pl', 'pm']],
  ['objectivec', 'Objective-C', ['mm', 'objc', 'obj-c', 'obj-c++', 'objective-c++']],
  ['php', 'php', []],
  ['php-template', 'PHP template', []],
  ['plaintext', 'Plain text', ['text', 'txt']],
  ['python', 'Python', ['py', 'gyp', 'ipython']],
  ['python-repl', 'python-repl', ['pycon']],
  ['r', 'R', []],
  ['rust', 'Rust', ['rs']],
  ['scss', 'SCSS', []],
  ['shell', 'Shell Session', ['console', 'shellsession']],
  ['sql', 'SQL', []],
  ['swift', 'Swift', []],
  ['yaml', 'YAML', ['yml']],
  ['typescript', 'TypeScript', ['ts', 'tsx', 'mts', 'cts']],
  ['vbnet', 'Visual Basic .NET', ['vb']],
  ['wasm', 'WebAssembly', []],
  ['dockerfile', 'Dockerfile', ['docker']],
  ['powershell', 'PowerShell', ['pwsh', 'ps', 'ps1']],
  ['scala', 'Scala', []],
  ['groovy', 'Groovy', []],
  ['dart', 'Dart', []],
  ['haskell', 'Haskell', ['hs']],
  ['elixir', 'Elixir', ['ex', 'exs']],
  ['erlang', 'Erlang', ['erl']],
  ['clojure', 'Clojure', ['clj', 'edn']],
  ['fsharp', 'F#', ['fs', 'f#']],
  ['ocaml', 'OCaml', ['ml']],
  ['julia', 'Julia', []],
  ['vbscript', 'VBScript', ['vbs']],
  ['dos', 'Batch file (DOS)', ['bat', 'batch', 'cmd']],
  ['cmake', 'CMake', ['cmake.in']],
  ['protobuf', 'Protocol Buffers', ['proto']],
  ['x86asm', 'Intel x86 Assembly', []],
  ['nginx', 'Nginx config', ['nginxconf']],
]

const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  xml: () => import('highlight.js/lib/languages/xml'),
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  diff: () => import('highlight.js/lib/languages/diff'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  perl: () => import('highlight.js/lib/languages/perl'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  php: () => import('highlight.js/lib/languages/php'),
  'php-template': () => import('highlight.js/lib/languages/php-template'),
  plaintext: () => import('highlight.js/lib/languages/plaintext'),
  python: () => import('highlight.js/lib/languages/python'),
  'python-repl': () => import('highlight.js/lib/languages/python-repl'),
  r: () => import('highlight.js/lib/languages/r'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scss: () => import('highlight.js/lib/languages/scss'),
  shell: () => import('highlight.js/lib/languages/shell'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  vbnet: () => import('highlight.js/lib/languages/vbnet'),
  wasm: () => import('highlight.js/lib/languages/wasm'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  scala: () => import('highlight.js/lib/languages/scala'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  dart: () => import('highlight.js/lib/languages/dart'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  fsharp: () => import('highlight.js/lib/languages/fsharp'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  julia: () => import('highlight.js/lib/languages/julia'),
  vbscript: () => import('highlight.js/lib/languages/vbscript'),
  dos: () => import('highlight.js/lib/languages/dos'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  x86asm: () => import('highlight.js/lib/languages/x86asm'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
}

/**
 * The editor's own highlight.js, with nothing registered until it is loaded.
 * A separate instance, so the outputs' one (core/hljs.ts, which a test may
 * import beside this) is never shared with it.
 */
export const hljs: HLJSApi = core.newInstance()

// By name or alias, in lower case, as highlight.js looks them up: a later
// language's alias wins over an earlier one's, and a name over any alias.
const BY_NAME = new Map<string, string>()
for (const [name, , aliases] of GRAMMARS) for (const alias of aliases) BY_NAME.set(alias.toLowerCase(), name)
for (const [name] of GRAMMARS) BY_NAME.set(name, name)

/** The language a block's `language` attr names (by name or alias, any case), or null. */
export function grammarName(language: unknown): string | null {
  if (typeof language !== 'string' || !language) return null
  return BY_NAME.get(language.toLowerCase()) ?? null
}

const fetched = new Map<string, Promise<void>>()
const loads = new Map<string, Promise<boolean>>()
const ready = new Set<string>()

/** Whether a language can be colored now: its grammar and the ones it embeds are loaded. */
export function grammarReady(name: string): boolean {
  return ready.has(name)
}

function fetchOne(name: string): Promise<void> {
  let p = fetched.get(name)
  if (!p) {
    p = LOADERS[name]().then((m) => hljs.registerLanguage(name, m.default))
    fetched.set(name, p)
  }
  return p
}

/** The languages a grammar hands parts of its text to (HTML its CSS and JavaScript, and so on). */
function embedded(name: string): string[] {
  const out = new Set<string>()
  const seen = new Set<object>()
  const walk = (mode: Mode | 'self' | undefined): void => {
    if (!mode || mode === 'self' || seen.has(mode)) return
    seen.add(mode)
    for (const sub of [mode.subLanguage ?? []].flat()) {
      const known = grammarName(sub)
      if (known) out.add(known)
    }
    for (const m of [...(mode.contains ?? []), ...(mode.variants ?? []), mode.starts]) walk(m as Mode | 'self' | undefined)
  }
  walk(hljs.getLanguage(name) as Mode | undefined)
  return [...out]
}

/**
 * Load a language's grammar and every grammar it embeds, once. Resolves to
 * whether it can now be colored (false only if a grammar failed to load).
 * Embedding may go round (JavaScript embeds HTML, which embeds JavaScript):
 * the grammars are fetched wave by wave, each once, never waiting on itself.
 */
export function loadGrammar(name: string): Promise<boolean> {
  let p = loads.get(name)
  if (!p) {
    p = (async () => {
      if (!(name in LOADERS)) return false
      const seen = new Set<string>()
      let wave = [name]
      try {
        while (wave.length) {
          await Promise.all(wave.map(fetchOne))
          for (const n of wave) seen.add(n)
          wave = [...new Set(wave.flatMap(embedded))].filter((n) => !seen.has(n))
        }
      } catch (err) {
        console.error(`Could not load the ${name} grammar`, err)
        loads.delete(name)
        return false
      }
      ready.add(name)
      return true
    })()
    loads.set(name, p)
  }
  return p
}
