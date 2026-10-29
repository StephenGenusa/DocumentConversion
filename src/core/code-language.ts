/**
 * A code block's language, for one that arrives without a usable one.
 *
 * Highlighting happens at write time and only for `<code class="language-X">`
 * where highlight.js knows X (shell.ts). A file read by the code reader is
 * named by its extension, but a paste has no filename, and a copied code block
 * comes in one of two shapes that both lost it:
 *
 *   - a web page's or an IDE's HTML, which names the language in its own way —
 *     `lang-py` on the <pre>, `highlight-source-python` on a wrapping <div>,
 *     `sourceCode python`, `brush: python` — or in a `data-lang` attribute,
 *     none of which the hub sanitizer keeps; or, for PyCharm and many docs
 *     sites, not at all;
 *   - plain text, from a terminal, an editor or a notebook cell, which never
 *     names it.
 *
 * So two steps, in this order. `tagForeignCodeBlocks` runs on the source DOM
 * before sanitizing and turns whatever the page called the language into the
 * hub's `language-X`. `guessCodeLanguages` runs on hub HTML and asks
 * highlight.js for a block that still has no class at all — never one a
 * reader deliberately marked `language-plaintext`, and never a diagram or
 * formula, which carry a class of their own.
 *
 * The guess is kept to common languages and has to clear a bar, because a
 * wrong coloring is worse than none: highlight.js will name SOME language for
 * anything, including a paragraph of prose or a server log.
 */
import hljs from './hljs'
import { DRAWN_KINDS } from './rendered-blocks'
import { hasFencedCodeBlock } from './paste-flavors'

/** Names pages use that highlight.js either lacks or reads as something else. */
const EXTRA_ALIASES = new Map<string, string>([
  ['python3', 'python'],
  ['python2', 'python'],
  ['py3', 'python'],
  ['ipython3', 'python'],
  // highlight.js `shell` is a prompt-and-output session; GitHub's and most
  // pages' "shell" is a script.
  ['shell', 'bash'],
  ['shellscript', 'bash'],
  ['node', 'javascript'],
  ['nodejs', 'javascript'],
  ['plain', 'plaintext'],
  ['none', 'plaintext'],
  ['nohighlight', 'plaintext'],
  ['no-highlight', 'plaintext'],
])

let aliasTable: Map<string, string> | undefined

/** Every name highlight.js answers to, mapped to the key `highlight()` takes. */
function aliases(): Map<string, string> {
  if (aliasTable) return aliasTable
  aliasTable = new Map()
  for (const key of hljs.listLanguages()) {
    aliasTable.set(key, key)
    for (const alias of hljs.getLanguage(key)?.aliases ?? []) aliasTable.set(alias.toLowerCase(), key)
  }
  for (const [alias, key] of EXTRA_ALIASES) aliasTable.set(alias, key)
  return aliasTable
}

/**
 * The hub's name for a language a page or an author called `name`, or
 * undefined when highlight.js has no such language. Diagram and formula names
 * are never answered: those blocks are not code (spec B1).
 */
export function normalizeLanguage(name: string | undefined | null): string | undefined {
  const key = name?.trim().toLowerCase()
  if (!key || (DRAWN_KINDS as ReadonlySet<string>).has(key)) return undefined
  return aliases().get(key)
}

/**
 * Class prefixes that name a language outright: hljs and Prism (`language-`),
 * Stack Overflow and Prettify (`lang-`), GitHub (`highlight-source-python`,
 * `highlight-text-html-basic`), Sphinx/Pygments and Rouge (`highlight-python`).
 */
const PREFIXED = /^(?:language-|lang-|highlight-source-|highlight-text-|highlight-)(.+)$/i

/**
 * Markers after which a bare class token is the language: Pandoc's
 * `sourceCode python`, highlight.js's older `hljs python`, Prettify's
 * `prettyprint python`. A bare token without one is not trusted — `go`, `c`
 * or `r` mean nothing on their own.
 */
const MARKERS = new Set(['sourcecode', 'hljs', 'prettyprint', 'highlight', 'code', 'codehilite', 'syntax'])

function fromToken(token: string): string | undefined {
  const m = PREFIXED.exec(token)
  if (!m) return undefined
  const named = m[1].toLowerCase()
  // GitHub's scope names: `text-html-basic` is html, `source-c++` is c++.
  return normalizeLanguage(named) ?? normalizeLanguage(named.split('-')[0])
}

/** The language a `class` attribute names, if it names one. */
export function languageFromClass(cls: string | null | undefined): string | undefined {
  if (!cls) return undefined
  // SyntaxHighlighter and MDN: `brush: python; gutter: false`.
  const brush = /\bbrush:\s*([\w+#-]+)/i.exec(cls)
  if (brush) return normalizeLanguage(brush[1])
  const tokens = cls.split(/\s+/).filter(Boolean)
  for (const token of tokens) {
    const lang = fromToken(token)
    if (lang) return lang
  }
  if (tokens.some((t) => MARKERS.has(t.toLowerCase()))) {
    for (const token of tokens) {
      if (MARKERS.has(token.toLowerCase())) continue
      const lang = normalizeLanguage(token)
      if (lang) return lang
    }
  }
  return undefined
}

const LANG_ATTRIBUTES = ['data-lang', 'data-language', 'lang', 'data-code-language']

/** What one element says about its language, by class or attribute. */
function languageOfElement(el: Element): string | undefined {
  const byClass = languageFromClass(el.getAttribute('class'))
  if (byClass) return byClass
  for (const attr of LANG_ATTRIBUTES) {
    // `lang` on an ordinary element is a human language; `en` and `fr` are not
    // highlight.js names, and the few that collide (`r`) are not worth trusting.
    const value = el.getAttribute(attr)
    if (attr === 'lang' && el.tagName.toLowerCase() !== 'pre' && el.tagName.toLowerCase() !== 'code') continue
    const lang = normalizeLanguage(value)
    if (lang) return lang
  }
  return undefined
}

/** Ancestors above the <pre> a highlighter's wrapper may sit on (GitHub and Sphinx both use one). */
const WRAPPER_DEPTH = 2

/** The code's text, with `<br>` read as the line break it draws. */
function codeText(el: Element): string {
  for (const br of Array.from(el.querySelectorAll('br'))) br.replaceWith(el.ownerDocument.createTextNode('\n'))
  return (el.textContent ?? '').replace(/\r\n?/g, '\n')
}

/** The author's inline markup a code block keeps when a file is read (see keepMarkup). */
export const KEPT_IN_CODE: ReadonlySet<string> = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'a', 'sup', 'sub', 'mark'])

/**
 * The code's content with only the author's inline markup left in it: bold,
 * italic, links and the like stay (the sanitizer then trims their attributes),
 * `<br>` becomes the line break it draws, and any other element — a
 * highlighter's span, a `<font>`, a stray `<code>` — gives up its text.
 */
function codeWithMarkup(from: Element, into: Element): void {
  const doc = from.ownerDocument
  for (const node of Array.from(from.childNodes)) {
    if (node.nodeType === 3) into.appendChild(doc.createTextNode((node.textContent ?? '').replace(/\r\n?/g, '\n')))
    if (node.nodeType !== 1) continue
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    if (tag === 'br') into.appendChild(doc.createTextNode('\n'))
    else if (KEPT_IN_CODE.has(tag)) {
      const kept = doc.createElement(tag)
      for (const attr of Array.from(el.attributes)) kept.setAttribute(attr.name, attr.value)
      codeWithMarkup(el, kept)
      into.appendChild(kept)
    } else codeWithMarkup(el, into)
  }
}

/**
 * Give every `<pre>` in `root` exactly one `<code>` holding its text, classed
 * `language-X` when the page named a language anywhere it is conventionally
 * named. Runs before sanitizing, while the classes and attributes are there.
 *
 * A highlighter's spans go: they are color the writers will redraw, and left
 * in, they made the write-time highlighter print `<span>` literally. With
 * `keepMarkup` (a file being read) the author's bold, italic and links stay,
 * as the page showed them; without it (a paste into the editor, whose code
 * block holds text only) the block is text.
 *
 * A diagram or formula block keeps its class and its text untouched.
 */
export function tagForeignCodeBlocks(root: Element, opts?: { keepMarkup?: boolean }): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const children = Array.from(pre.childNodes).filter((n) => !(n.nodeType === 3 && !(n.textContent ?? '').trim()))
    const only = children.length === 1 && children[0].nodeType === 1 ? (children[0] as Element) : null
    const code = only && only.tagName.toLowerCase() === 'code' ? only : null
    const ownClass = code?.getAttribute('class') ?? ''
    if (/(?:^|\s)language-(?:math|mermaid|dot)(?:\s|$)/.test(ownClass)) continue
    // A notebook's outputs are program output, not code (readers/ipynb.ts).
    if (/\bnb-/.test(pre.getAttribute('class') ?? '')) continue
    let lang = (code && languageOfElement(code)) ?? languageOfElement(pre)
    for (let p = pre.parentElement, depth = 0; !lang && p && depth < WRAPPER_DEPTH; p = p.parentElement, depth++) {
      lang = languageOfElement(p)
    }
    // A `language-X` highlight.js does not know is still the author's word for it.
    const kept = lang ? `language-${lang}` : /(?:^|\s)(language-[\w+-]+)(?:\s|$)/.exec(ownClass)?.[1]
    const fresh = pre.ownerDocument.createElement('code')
    if (kept) fresh.setAttribute('class', kept)
    if (opts?.keepMarkup) codeWithMarkup(code ?? pre, fresh)
    else fresh.textContent = codeText(code ?? pre)
    pre.replaceChildren(fresh)
  }
}

/* ------------------------------------------------------------------ *
 * Guessing
 * ------------------------------------------------------------------ */

/**
 * Lines that mark a language in the snippets people actually paste. Each line
 * that matches one of a language's patterns is a vote for it.
 *
 * highlight.js's own detection is not enough on its own here: its relevance
 * counts only the distinctive matches, and `def`, `for … in` and `return` are
 * not — a plain eight-line Python function scored 3 and lost to SQL — and it
 * calls C `cpp`, Swift Python and a Makefile Bash. So the languages people
 * paste are recognized by their shape first, and highlight.js decides only
 * what these do not.
 *
 * A pattern belongs here only when it is rare in every other language: a
 * closing brace or a trailing semicolon would vote JavaScript for any C-family
 * snippet. Where two languages share a line (`end` in Ruby and Lua, `FROM x`
 * in SQL and a Dockerfile) both get the vote, and the rest decides.
 *
 * `requires`, when given, must match somewhere in the block before the
 * language gets any votes: a Makefile has a tab-indented recipe or a `$(…)`,
 * YAML nests, a Dockerfile has more than a `FROM`. `excludes`, when it
 * matches, rules the language out: Python never opens a block with `{` nor
 * closes one with `end`, though Swift and Lua share its `print(`.
 */
interface Tells {
  language: string
  patterns: readonly RegExp[]
  requires?: RegExp
  excludes?: RegExp
}

/** C++ is C plus these: they vote for the C family, and a block with one is C++. */
const CPP = [
  /^(?!\s*use\s).*\bstd::\w/,
  /^\s*#\s*include\s*<(?:iostream|iomanip|fstream|sstream|string|string_view|vector|map|unordered_map|set|unordered_set|memory|algorithm|functional|utility|optional|variant|array|deque|list|queue|stack|thread|mutex|chrono|cstdio|cstdlib|cstring|cmath|cstdint)>/,
  /\b(?:cout|cerr|cin)\s*(?:<<|>>)/,
  /^\s*template\s*</,
  /^\s*using\s+namespace\s+\w+\s*;/,
  /^\s*(?:public|private|protected)\s*:\s*$/,
  /\b(?:nullptr|static_cast|dynamic_cast|reinterpret_cast|const_cast)\b/,
  /\bvirtual\s+[\w:<>~]+[\s*&]*\w*\s*\(|\bvirtual\s+~\w+\(/,
  /^\s*(?:const\s+)?auto\s*[&*]*\s+\w+\s*[=:({]/,
  /\bconst\s+[\w:<>]+\s*&\s*\w+/,
  /\b(?:new|delete)\s+\w+(?:\[\])?\s*[(;[]/,
]

/** TypeScript is JavaScript plus these: they vote for JavaScript, and a block with one is TypeScript. */
const TYPESCRIPT = [
  /^\s*(?:export\s+)?(?:interface|type)\s+\w+(?:<[^>]*>)?\s*(?:=|\{|extends\b)/,
  /\w\??:\s*(?:string|number|boolean|void|unknown|any|never)\b/,
  /\bas\s+const\b/,
  /^\s*(?:private|public|protected|readonly)\s+(?:readonly\s+)?\w+\s*[:=?]/,
]

const CSS_PROPERTY =
  /(?:--[\w-]+|(?:-(?:webkit|moz|ms)-)?(?:color|background(?:-[a-z]+)?|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|border(?:-[a-z]+)*|font(?:-[a-z]+)?|display|position|(?:max-|min-)?(?:width|height)|top|left|right|bottom|z-index|flex(?:-[a-z]+)?|grid(?:-[a-z]+)*|align-(?:items|self|content)|justify-(?:content|items|self)|text-(?:align|decoration|transform|overflow|indent|shadow)|line-height|opacity|transition(?:-[a-z]+)?|transform(?:-[a-z]+)?|overflow(?:-[xy])?|cursor|box-(?:shadow|sizing)|content|gap|row-gap|column-gap|outline(?:-[a-z]+)?|visibility|white-space|letter-spacing|word-(?:break|wrap|spacing)|animation(?:-[a-z]+)?|list-style(?:-[a-z]+)?|vertical-align|float|clear|filter|fill|stroke(?:-[a-z]+)?|object-fit|aspect-ratio|inset|place-(?:items|content)))\s*:\s*[^;{}]+;/

/**
 * A selector that starts a rule: a class, id, `:root` or a common element,
 * then its own classes and pseudo-classes. Written so that no word can be
 * matched more than one way (a backtracking blow-up on a line of prose).
 */
const CSS_PARTS = String.raw`(?:[.#:]{1,2}[\w-]+(?:\([^)]*\))?|\[[^\]]+\])*`
const CSS_SELECTOR = String.raw`(?:[.#][\w-]+|:root|\*|(?:html|body|a|p|h[1-6]|ul|ol|li|div|span|img|table|td|th|tr|input|button|form|nav|header|footer|main|section|article|label|pre|code|blockquote)\b)${CSS_PARTS}`
const CSS_COMPOUND = String.raw`(?:[.#][\w-]+|\*|[a-z][\w-]*)${CSS_PARTS}`

/**
 * A Makefile rule: a target line at the margin, then a recipe line that
 * starts with a tab. Nothing else puts `word:` at the margin over a tab
 * (YAML forbids tabs; Go's `case x:` is indented), so its recipe's shell
 * commands are the Makefile's, not Bash's.
 */
const MAKE_RULE =
  /^(?!(?:else|try|finally|except|default|case|public|private|protected|return)\b)(?:[\w.%/-]|\$\([^)\n]*\))+(?:[ \t]+(?:[\w.%/-]|\$\([^)\n]*\))+)*[ \t]*::?(?!=)[^\n]*\n\t/m

const TELLS: readonly Tells[] = [
  {
    language: 'python',
    excludes: /^\s*(?:\}\s*)?(?:if|else|for|while|switch|func|fn|fun|function|guard)\b.*\{\s*$|^\s*end\s*$|^\s*local\s/m,
    patterns: [
      /^\s*(?:async\s+)?def\s+\w+\s*\(.*\)\s*(?:->.*)?:\s*(?:#.*)?$/,
      /^\s*class\s+\w+\s*(?:\(.*\))?\s*:\s*$/,
      /^\s*(?:from\s+[\w.]+\s+import\s+[\w*, ()]+|import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+)*)\s*$/,
      /^\s*(?:if|elif|while|with|for)\s.*:\s*(?:#.*)?$/,
      /^\s*(?:else|try|finally|except(?:\s.*)?)\s*:\s*$/,
      /^\s*print\(/,
      /\bself\.\w/,
      /^\s*@\w[\w.]*(?:\(.*\))?\s*$/,
      /"""|'''/,
      /\bf"[^"]*\{|\bf'[^']*\{/,
      /^\s*(?:return|raise|yield)\b[^;{]*$/,
      /\blambda\s+\w*\s*:|\b(?:True|False)\b|\belif\b/,
      /\[[^\]]+\bfor\s+\w+\s+in\s+[^\]]+\]/,
    ],
  },
  {
    language: 'javascript',
    patterns: [
      /^\s*(?:export\s+)?(?:const|var)\s+[\w${}[\], ]+\s*=/,
      /^\s*let\s+(?!mut\b)[\w${}[\], ]+\s*=(?!.*(?:::|\?;\s*$)).*(?:;|[{([]|=>.*)\s*$/,
      /(?:[=(,:]\s*|\breturn\s+)(?:async\s+)?(?:\([^()]*\)|[\w$]+)\s*=>/,
      /\bfunction\b\s*\*?\s*\w*\s*\(.*\)\s*\{/,
      /\bconsole\.\w+\(/,
      /^\s*import\s.+\sfrom\s+['"]|\brequire\(['"]/,
      /^\s*export\s+(?:default|function|class|const|async)\b/,
      /\s(?:===|!==)\s/,
      /\b(?:document|window)\.\w+/,
      /\bawait\s+\w|\basync\s+(?:function\b|\()/,
      /\.(?:then|catch|addEventListener|querySelector|forEach)\(/,
      ...TYPESCRIPT,
    ],
  },
  {
    language: 'bash',
    excludes: MAKE_RULE,
    patterns: [
      /^\s*(?:sudo\s+)?(?:echo|cd|apt(?:-get)?|npm|npx|pip3?|git|ls|mkdir|rm|cp|mv|chmod|chown|grep|curl|wget|source|cat|docker|brew|yarn|tar|ssh|scp|sed|awk|systemctl|unset|alias|cmake|gzip|kubectl|exit)\s/,
      /^\s*(?:if\s+\[\[?\s|elif\s+\[|fi\b|then\b|do\b|done\b|esac\b|case\s.+\sin\s*$)/,
      /"\$\{?[A-Za-z_]\w*\}?"|\$\((?!(?:wildcard|patsubst|shell|addprefix|addsuffix|subst|foreach|notdir|basename|dir|filter|call|eval|if|info|warning|error)\s)[a-z]|\$\{\w+\}/,
      /^\s*(?:export\s+)?[A-Z_][A-Z0-9_]*=\S*\s*$|^\s*export\s+[A-Za-z_]\w*=/,
      /\s(?:&&|\|\|)\s|\s\|\s*(?:grep|sort|head|tail|wc|xargs|awk|sed)\b/,
      /;\s*(?:then|do)\s*$/,
    ],
  },
  {
    language: 'java',
    patterns: [
      /\bSystem\.(?:out|err)\.print/,
      /^\s*import\s+(?:static\s+)?java\w*\./,
      /^\s*@Override\b/,
      /^\s*package\s+[\w.]+;\s*$/,
      /\bpublic\s+static\s+void\s+main\s*\(String/,
      /\bnew\s+\w+<>\s*\(/,
      /\bString\[\]\s+\w/,
      /^\s*(?:(?:public|private|protected)\s+)(?:(?:static|final|abstract|synchronized)\s+)*(?:[A-Z]\w*(?:<[^>]*>)?|int|long|void|boolean|double|float|char|byte)(?:\[\])?\s+[a-z]\w*\s*[(=;]/,
      /^\s*(?:[A-Z]\w*(?:<[^>]*>)?|void|int|boolean)\s+[a-z]\w*\s*\([^)]*\)\s*;\s*$/,
      /\b(?:Integer|String)::\w+/,
    ],
  },
  {
    language: 'csharp',
    patterns: [
      /\bConsole\.Write(?:Line)?\(/,
      /^\s*using\s+System[\w.]*;\s*$/,
      /^\s*namespace\s+[\w.]+\s*[{;]?\s*$/,
      /\bstatic\s+(?:async\s+)?(?:void|Task)\s+Main\s*\(/,
      /\{\s*get;\s*(?:(?:private|protected|init)\s+)?(?:set|init);\s*\}/,
      /\basync\s+Task\b|\bTask<\w/,
      /\bforeach\s*\(\s*var\s/,
      /\bnew\s+(?:List|Dictionary|HashSet)<(?:string|int|bool|object|decimal|double|long)\b/,
      /^\s*(?:public|internal)\s+(?:sealed\s+)?record\s/,
      /^\s*(?:public|private|protected|internal)\s+(?:(?:static|async|override|virtual|sealed|readonly|abstract)\s+)*[\w<>[\],?]+\s+[A-Z]\w*\s*\(/,
      /\bstring\[\]\s+args\b|\bIActionResult\b|\bnameof\(/,
    ],
  },
  {
    language: 'go',
    patterns: [
      /^\s*package\s+\w+\s*$/,
      /^\s*func\s+(?:\([^)]*\)\s*)?\w+\s*\([^:]*$/,
      /\bfmt\.\w+\(/,
      /^\s*[a-z_]\w*(?:\s*,\s*[a-z_]\w*)*\s*:=\s*/,
      /^\s*import\s+(?:\(|"[\w./-]+")\s*$/,
      /\berr\s*!=\s*nil\b/,
      /:=\s*range\b|\bfor\s+_,\s*\w+\s*:=/,
      /^\s*type\s+\w+\s+(?:struct|interface)\s*\{/,
      /^\s*defer\s+\w/,
      /\bmake\((?:map|\[\]|chan)\b/,
    ],
  },
  {
    language: 'php',
    patterns: [
      /<\?php/,
      /\$\w+\s*->\s*\w/,
      /^\s*\$\w+\s*=.*;\s*$/,
      /^\s*namespace\s+[\w\\]+;\s*$/,
      /^\s*use\s+[\w\\]+\\[\w\\]+(?:\s+as\s+\w+)?;\s*$/,
      /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+\w+\s*\(/,
      /\bforeach\s*\(\s*\$\w+\s+as\s+\$/,
      /\becho\s+[$"'].*;\s*$/,
    ],
  },
  {
    language: 'powershell',
    patterns: [/\b(?:Get|Set|New|Remove|Write|Invoke|Import|Start|Stop)-[A-Z]\w+/, /\s-(?:eq|ne|gt|lt|like|match)\s/, /^\s*param\s*\(/i],
  },
  {
    language: 'sql',
    patterns: [
      /^\s*(?:SELECT|FROM(?!\s+[\w.-]+[:/@])|WHERE|GROUP BY|ORDER BY|INSERT INTO|UPDATE|DELETE FROM|CREATE (?:TABLE|INDEX|VIEW)|ALTER TABLE|DROP TABLE|(?:LEFT |RIGHT |INNER |OUTER )?JOIN|VALUES|HAVING|LIMIT|SET)\b/,
      /^\s*(?:select\s+(?:\*|distinct\b|[\w.]+(?:\s+as\s+\w+)?\s*,)|from\s+[\w.]+(?:\s+(?:as\s+)?\w+)?\s*;?$|where\s+[\w.]+\s*(?:=|<>|!=|<|>|in\b|like\b|is\b)|(?:inner\s+|left\s+(?:outer\s+)?|right\s+)?join\s+\w+.*\bon\b|(?:group|order)\s+by\s+[\w.]+|limit\s+\d+)/,
      /\b(?:PRIMARY\s+KEY|NOT\s+NULL|FOREIGN\s+KEY|VARCHAR\s*\(|AUTO_INCREMENT|REFERENCES\s+\w|DEFAULT\s+CURRENT_TIMESTAMP)\b/,
    ],
  },
  {
    language: 'c',
    patterns: [
      /^\s*#\s*include\s*[<"][\w/.]+\.h[>"]/,
      /^\s*#\s*(?:define|ifndef|ifdef|endif|pragma)\b/,
      /\b(?:printf|fprintf|sprintf|snprintf|malloc|calloc|realloc|free|memcpy|memset|memmove|strcmp|strncmp|strlen|strcpy|strncpy|fopen|fclose|puts)\s*\(/,
      /^\s*(?:static\s+|extern\s+|inline\s+)*(?:const\s+)?(?:unsigned\s+|signed\s+)?(?:int|void|char|long|short|size_t|double|float|bool|uint\d+_t|int\d+_t|struct\s+\w+)\s*\**\s*\w+\s*\([^)]*\)\s*\{?\s*$/,
      /^\s*typedef\s/,
      /^\s*struct\s+\w+\s*\{/,
      /\bsizeof\s*\(?\s*\*?\w/,
      /\bNULL\b/,
      /^\s*for\s*\(\s*(?:int|size_t|unsigned)\s+\w+\s*=/,
      /^\s*(?:struct\s+\w+|(?:unsigned\s+)?(?:int|char|long|short|float|double|size_t|uint\d+_t|int\d+_t))\s*\**\s*\w+(?:\[\w*\])?\s*;\s*$/,
      ...CPP,
    ],
  },
  {
    language: 'rust',
    patterns: [
      /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:(?:async|const|unsafe|extern)\s+)*fn\s+\w+\s*(?:<[^>]*>)?\s*\(/,
      /^\s*let\s+mut\s+\w+/,
      /\blet\s+\w+\s*:\s*(?:&|Vec<|Option<|Result<|String\b|i\d+\b|u\d+\b|f\d+\b|usize\b|isize\b|bool\b|HashMap<)/,
      /\b(?:println|print|eprintln|format|vec|panic|assert(?:_eq|_ne)?|write(?:ln)?|todo|unimplemented|matches)!\s*[([{]/,
      /^\s*use\s+(?:std|crate|super|self|core|alloc|[a-z_]+)::[\w:{}*, ]+;\s*$/,
      /^\s*(?:pub\s+)?impl\b/,
      /^\s*#!?\[\w+/,
      /&mut\s|&self\b|\bSelf::|\bmut\s+self\b/,
      /->\s*(?:Result|Option|Self|Vec|String|i\d+|u\d+|f\d+|usize|bool|&|impl\b)/,
      /^\s*pub\s+(?:struct|enum|trait|mod|const|static|type|fn)\s/,
      /\b[A-Z]\w*::new\(/,
      /\?;\s*$/,
      /^\s*(?:Some|None|Ok|Err)\b(?:\(.*\))?\s*(?:if\s.+)?=>/,
      /\.unwrap\(\)|\.expect\("|\.iter\(\)|\.collect::</,
      /^\s*match\s+[\w.&*]+\s*\{\s*$/,
      /^\s*for\s+(?:\(\w+(?:,\s*\w+)*\)|\w+)\s+in\s+[\w.()&]+\s*\{\s*$/,
    ],
  },
  {
    language: 'ruby',
    patterns: [
      /^\s*(?:require|require_relative|load)\s+['"]/,
      /^\s*def\s+(?:self\.)?\w+[?!=]?(?:\s*\(.*\))?\s*$/,
      /^\s*end\s*$/,
      /\bputs\s+[^(\s]/,
      /(?:\bdo|\{)\s*\|[\w, *&]+\|/,
      /^\s*attr_(?:accessor|reader|writer)\s+:/,
      /#\{[^}]+\}/,
      /^\s*(?:module|class)\s+[A-Z][\w:]*(?:\s*<\s*[A-Z][\w:]*)?\s*$/,
      /^\s*(?:elsif|unless)\s+[^({]*$|\bunless\s+[\w.!?]+\s*$/,
      /\.(?:empty|nil|any|include|zero|blank|present|key|is_a)\?/,
      /^\s*(?:belongs_to|has_many|has_one|validates|before_action|scope)\s+:/,
      /^\s*@[a-z_]\w*\s*=/,
      /:\w+\s*=>/,
    ],
  },
  {
    language: 'kotlin',
    patterns: [
      /^\s*(?:(?:private|public|internal|protected|override|suspend|inline|open|operator|infix|tailrec)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?\w+\s*\(/,
      /\b(?:listOf|mutableListOf|mapOf|mutableMapOf|setOf|mutableSetOf|arrayOf|emptyList|sumOf)\s*[(<{]/,
      /^\s*(?:data|sealed|enum|inline|value|annotation)\s+class\b/,
      /^\s*when\s*(?:\(.*\))?\s*\{\s*$/,
      /^\s*(?:\d+|"[^"]*"|else|is\s+\w+|in\s+[\w.]+)\s*->\s/,
      /\bit\.\w+/,
      /\bcompanion\s+object\b|\blateinit\s+var\b|\bby\s+lazy\b/,
      /\((?:private\s+|public\s+)?val\s+\w+\s*:/,
    ],
  },
  {
    language: 'swift',
    patterns: [
      /^\s*(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|static|class|override|mutating|final)\s+)*func\s+\w+\s*(?:<[^>]*>)?\s*(?:\([^)]*\)\s*(?:async\s+)?(?:throws\s+)?->|\(\s*(?:_\s+)?\w+\s*:\s*[A-Z[(@])/,
      /"[^"\n]*\\\([\w.]+\)[^"\n]*"/,
      /^\s*guard\s+.+\belse\s*\{/,
      /^\s*(?:\}\s*else\s+)?if\s+(?:let|var)\s+\w+\s*=/,
      /^\s*import\s+(?:SwiftUI|UIKit|Foundation|Combine|AppKit|XCTest|MapKit|CoreData|SwiftData)\s*$/,
      /^\s*@(?:State|Published|Binding|ObservedObject|StateObject|EnvironmentObject|Environment|IBOutlet|IBAction|objc|MainActor|main|discardableResult)\b/,
      /\bsome\s+View\b|:\s*View\s*\{/,
      /^\s*(?:struct|class|enum|extension|protocol)\s+\w+\s*:\s*(?:View|Codable|Decodable|Encodable|Identifiable|Hashable|Equatable|ObservableObject|Error|CaseIterable)\b/,
      /\btry\s+await\b|\btry[?!]\s/,
      /:\s*\[[A-Z]\w*\s*:\s*[A-Z]\w*\]|\[:\]/,
      /^\s*case\s+\w+(?:\s*,\s*\w+)+\s*$/,
      /=\s*\.\w+\s*$/,
      /^(?!.*\b(?:def|fun|func|function|fn)\b).*\b[A-Za-z]\w*\(\w+:\s*[a-z_"$.\d]/,
      /^\s*for\s+(?:\(\w+(?:,\s*\w+)*\)|\w+)\s+in\s+[\w.()]+\s*\{\s*$/,
    ],
  },
  {
    language: 'xml',
    patterns: [
      /^\s*<\/?[a-zA-Z][\w:.-]*(?:\s+[\w:@.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/,
      /^\s*<\?xml\s|^\s*<!DOCTYPE\s|^\s*<!--/i,
      /<\/[a-zA-Z][\w:.-]*>\s*$/,
    ],
  },
  {
    language: 'css',
    patterns: [
      new RegExp(`^\\s*${CSS_PROPERTY.source}\\s*$`),
      /^\s*@(?:media|import|font-face|keyframes|supports|charset|layer|container)\b/,
      new RegExp(`^\\s*${CSS_SELECTOR}(?:(?:\\s*[,>+~]\\s*|\\s+)${CSS_COMPOUND})*\\s*[{,]\\s*$`),
    ],
  },
  {
    language: 'yaml',
    requires: /(?<![\s\S])---\s*$|^(?:\s+[\w.-]+:(?:\s|$)|\s*[\w.-]+:\s*\n\s+-\s)/m,
    patterns: [
      /^\s*[\w.-]+:(?:\s+(?:"[^"]*"|'[^']*'|[\w./@:${}~*+-]+(?:[ \t]+[^\s;{}=,][^;{}=]*)?|\[[^\]]*\]|\{[^}]*\}|[|>][-+]?))?\s*$/,
      /^\s*-\s+(?:[\w.-]+:\s|"[^"]*"\s*$|'[^']*'\s*$|[\w./@:${}~-]+\s*$)/,
    ],
  },
  {
    language: 'dockerfile',
    requires: /^(?:RUN|COPY|ADD|WORKDIR|CMD|ENTRYPOINT|EXPOSE|ENV|ARG|USER|VOLUME|LABEL)\s|^FROM\s+[\w.-]+[:/@]/m,
    patterns: [
      /^(?:FROM\s+\S+(?:\s+AS\s+\S+)?\s*$|RUN\s+\S|COPY\s+(?:--\w+=\S+\s+)?\S+\s+\S|ADD\s+\S+\s+\S|WORKDIR\s+\S|ENV\s+\w+[=\s]\S|EXPOSE\s+\d|(?:CMD|ENTRYPOINT)\s+\S|ARG\s+\w|LABEL\s+\S+=|USER\s+\w|VOLUME\s+[[/]|HEALTHCHECK\s|SHELL\s+\[|ONBUILD\s|STOPSIGNAL\s)/,
    ],
  },
  {
    language: 'makefile',
    requires: new RegExp(String.raw`${MAKE_RULE.source}|\$\([A-Z_][A-Z0-9_]*\)|(?<!")\$[@<^]`, 'm'),
    patterns: [
      /^\t\S/,
      /\$\([A-Z_][A-Z0-9_]*\)|\$\((?:wildcard|patsubst|shell|addprefix|addsuffix|subst|foreach|notdir|basename|dir|filter)\s/,
      /\$[@<^*?]|\$\(@[DF]\)/,
      /^\.(?:PHONY|SUFFIXES|DEFAULT|PRECIOUS|SILENT|INTERMEDIATE)\s*:/,
      /^[A-Za-z_][\w.]*\s*(?::=|\?=|\+=|::=)|^[A-Z_][A-Z0-9_]*\s+=\s/,
      /^[\w.%/$()-]+(?:\s+[\w.%/$()-]+)*\s*::?(?!=)(?:\s+[\w.%/$()-]+)*\s*$/,
    ],
  },
  {
    language: 'lua',
    patterns: [
      /^\s*local\s+(?:function\s+)?[\w, ]+(?:=|\(|$)/,
      /^\s*(?:local\s+)?function\s+[\w.:]+\s*\([^)]*\)\s*$/,
      /^\s*(?:else)?if\s+[^[{;]*\bthen\s*$/,
      /\bi?pairs\s*\(/,
      /\s\.\.\s/,
      /~=/,
      /^\s*(?:for\s+.+|while\s+.+)\s+do\s*$/,
      /^\s*end\s*[)}]?\s*$/,
      /\bsetmetatable\s*\(|\b__index\b/,
    ],
  },
  {
    language: 'r',
    patterns: [
      /^\s*[\w.]+\s*<-\s*/,
      /\b(?:library|require)\s*\(\s*[\w.]+\s*\)/,
      /%>%|%in%|%\*%/,
      /<-\s*function\s*\(/,
      /\b(?:c\(\s*["'\d-]|data\.frame\(|read\.csv\(|ggplot\(|aes\(|geom_\w+\(|sapply\(|lapply\(|group_by\(|summari[sz]e\(|mutate\()/,
    ],
  },
  {
    language: 'perl',
    patterns: [
      /^\s*my\s+(?:[$@%]\w+|\([$@%][\w, $@%]*\))/,
      /^\s*use\s+(?:strict|warnings|utf8|v?5[\d.]*|[A-Z]\w*(?:::\w+)*(?:\s+qw[(/].*)?)\s*;/,
      /^\s*sub\s+\w+\s*\{?\s*$/,
      /=~\s*[ms]?\/|!~\s*\//,
      /\bforeach\s+my\b|\bfor(?:each)?\s+(?:my\s+)?\$\w+\s*\(/,
      /\$_(?=[\s;)}\],])(?!\s+-[a-z])|@_\b|@ARGV\b|%ENV\b|\$ENV\{|<STDIN>|\bchomp\b/,
      /\bqw\s*[(/{]/,
      /\$\w+\{[\w$'"]+\}/,
      /\bkeys\s+%\w+|\bscalar\s*\(?@/,
      /\b(?:next|last)\s+(?:unless|if)\b/,
      /\bor\s+die\b|<\$\w+>|\$!/,
    ],
  },
  {
    language: 'scala',
    patterns: [
      /^\s*(?:case\s+)?object\s+\w+\s+extends\b/,
      /^\s*(?:(?:sealed|abstract|final)\s+)?case\s+(?:class|object)\s/,
      /^\s*(?:sealed\s+)?trait\s+\w+(?:\s*\[.*\])?(?:\s+extends\b.*)?\s*\{?\s*$/,
      /^\s*(?:(?:override|private|protected|final|implicit)\s+)*def\s+\w+(?:\[[^\]]*\])?(?:\([^)]*\))*\s*(?::\s*[^=]+)?=(?!=)/,
      /^\s*import\s+scala\.|^\s*import\s+[\w.]+\.\{[^}]*\}\s*$|^\s*import\s+[\w.]+\._\s*$/,
      /^\s*case\s+[^:]*=>/,
      /\(\s*_\s*[*+\-/]\s*\w+\s*\)|\.(?:map|filter|foreach|flatMap|exists|forall|reduce|foldLeft)\s*\(\s*_\b/,
      /\b(?:Option|Future|Seq)\[[A-Z]\w*|\bList\[(?:Int|String|Double|Long|Boolean)\b/,
      /\bmatch\s*\{\s*$/,
      /\bimplicit\s+(?:val|def|class)\b/,
    ],
  },
  {
    language: 'haskell',
    patterns: [
      /^\s*[a-z_][\w']*\s+::\s+\S/,
      /^\s*import\s+qualified\s|^\s*import\s+(?:[A-Z]\w*\.)+[A-Z]\w*(?:\s+(?:as\s+[A-Z]\w*|hiding\s*\(.*\)|\(.*\)))?\s*$/,
      /^\s*module\s+[A-Z][\w.]*(?:\s*\(.*\))?\s+where\s*$/,
      /^\s*main\s*=\s*(?:do\b|print|putStr)/,
      /\b(?:putStrLn|putStr|mapM_|forM_|getLine|foldr|foldl')\b/,
      /^\s*data\s+[A-Z]\w*(?:\s+[a-z]\w*)*\s*=\s*[A-Z]/,
      /^\s*(?:newtype|instance|class)\s+.*\bwhere\s*$/,
      /\bderiving\s*\(?\s*[A-Z]/,
      /\\[a-z_]\w*(?:\s+[a-z_]\w*)*\s*->/,
      /\s(?:<\$>|>>=|<\*>|\+\+)\s/,
      /^(?!\s*(?:local|let|var|const|val|my|our|auto|int|char|long|short|double|float|bool|unsigned|signed|struct|static|export|set|def|type|private|public|final|string|size_t|return|if|for|while)\b)\s*[a-z_][\w']*(?:\s+(?:[a-z_][\w']*|\d+|\([^)]*\)|\[[^\]]*\]))+\s*=\s/,
    ],
  },
]

/**
 * One line said enough. A single line is guessed only by one of these, and
 * only when one language's matches: each is something people paste on its
 * own (a query, a command, an import, a one-line rule) and that no other
 * language or a sentence writes. Nothing else answers for one line — not the
 * block tells, which need two votes, and not highlight.js.
 */
const ONE_LINE: ReadonlyArray<readonly [language: string, patterns: readonly RegExp[]]> = [
  [
    'python',
    [
      /^(?:async\s+)?def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:/,
      /^from\s+[\w.]+\s+import\s+(?:\*|\w+(?:\s+as\s+\w+)?(?:\s*,\s*\w+(?:\s+as\s+\w+)?)*|\([\w\s,]+\))$/,
      /^import\s+(?:[a-z_]\w*\.[\w.]+|[a-z_]\w*\s+as\s+\w+)$/,
      /^print\((?!.*\\\()(?:f?["'].*["']|[\w.]+)(?:,.*)?\)$/,
    ],
  ],
  [
    'javascript',
    [
      /\bconsole\.(?:log|error|warn|info|debug|table)\(/,
      /\bdocument\.(?:getElementById|querySelector(?:All)?|createElement|addEventListener|body)\b/,
      /^(?:export\s+)?const\s+[\w$]+\s*=\s*\S/,
      /^(?:const|let|var)\s+[\w${}[\], ]+\s*=\s*require\(['"]/,
      /^import\s+(?:[\w*{}\s,]+\s+from\s+)?['"][^'"]+['"];?$/,
    ],
  ],
  [
    'typescript',
    [
      /^(?:export\s+)?(?:const|let|var)\s+\w+\s*:\s*(?:string|number|boolean|unknown|any)\b.*=/,
      /^(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=\s*.*\b(?:string|number|boolean|undefined|null)\b/,
      /^(?:export\s+)?interface\s+\w+(?:<[^>]*>)?\s*(?:extends\s+[\w<>, ]+)?\{.*\w\??:\s*(?:string|number|boolean)\b/,
    ],
  ],
  [
    'bash',
    [
      /^\$\s+(?:sudo\s+)?[a-z][\w.+/-]*(?:\s+\S+)*$/,
      /^sudo\s+\S+/,
      /^(?:apt(?:-get)?|npm|npx|pnpm|pip3?|git|docker|brew|yarn|tar|curl|wget|chmod|chown|mkdir|grep|ssh|scp|rsync|systemctl|kubectl|cargo|ls|rm|cp|mv|find)\s+(?:-{1,2}\w|\S+\s+-{1,2}\w|(?:install|run|clone|init|build|status|commit|push|pull|checkout|add|log|diff|ps|exec)\b)/,
      /\|\s*(?:grep|wc|sort|head|tail|xargs|awk|sed|uniq)\b/,
    ],
  ],
  [
    'sql',
    [
      /^SELECT\s+.+\s+FROM\s+[\w."]+/,
      /^select\s+(?:\*|distinct\s|[\w.]+(?:\s*,\s*[\w.]+)+)\s*from\s+[\w."]+/,
      /^insert\s+into\s+[\w."]+\s*(?:\(|values\b|select\b)/i,
      /^update\s+[\w."]+\s+set\s+[\w."]+\s*=/i,
      /^delete\s+from\s+[\w."]+(?:\s+where\b|\s*;)/i,
      /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|DATABASE|SCHEMA)|DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE\s+TABLE)\b|^create\s+table\s+[\w."]+\s*\(/,
    ],
  ],
  ['java', [/\bSystem\.(?:out|err)\.print/, /^import\s+(?:static\s+)?java\w*\.[\w.*]+;$/, /\bpublic\s+static\s+void\s+main\s*\(String/]],
  ['csharp', [/\bConsole\.Write(?:Line)?\(/, /^using\s+System[\w.]*;$/, /\{\s*get;\s*(?:(?:private|protected|init)\s+)?(?:set|init);\s*\}/]],
  ['go', [/\bfmt\.[A-Z]\w*\(/, /^func\s+(?:\([^)]*\)\s*)?\w+\s*\(\s*[a-z_]\w*[^:)]*\)/, /\berr\s*!=\s*nil\b/, /^package\s+main$/]],
  ['php', [/<\?php/, /\$this->/, /^\$\w+\s*=\s*\$\w+->\w+\(.*\);$/, /^echo\s+\$\w+.*;$/]],
  [
    'powershell',
    [
      /^(?:\$\w+\s*=\s*)?(?:Get|Set|New|Remove|Write|Invoke|Import|Install|Start|Stop|Test|Add|Select|Where|ForEach|Export|ConvertTo|ConvertFrom|Out|Enable|Disable|Restart|Update|Uninstall|Copy|Move|Rename|Clear)-[A-Z][a-zA-Z]{2,}\b.*(?:\s-[A-Z]\w+|\|)/,
    ],
  ],
  ['c', [/^#\s*include\s*<(?:stdio|stdlib|string|math|stdint|stdbool|unistd|errno|assert|ctype|time|signal|fcntl|limits|stddef|stdarg)\.h>$/, /^printf\s*\("[^"]*%[-\d.]*[dsfcuxlp][^"]*",\s*[a-z_]\w*/, /\bmalloc\s*\(.*\bsizeof\b/]],
  [
    'cpp',
    [
      /^(?!use\s).*\bstd::\w/,
      /^#\s*include\s*<(?:iostream|iomanip|fstream|sstream|string|vector|map|unordered_map|set|memory|algorithm|functional|utility|optional|array|thread|chrono)>$/,
      /\b(?:cout|cerr)\s*<</,
    ],
  ],
  ['rust', [/\b(?:println|eprintln|format|vec|panic)!\s*\(/, /^let\s+mut\s+\w+/, /^use\s+(?:std|crate|super)::/, /^(?:pub\s+)?fn\s+\w+\s*(?:<[^>]*>)?\s*\(.*\)\s*(?:->\s*[^{]+)?\{/, /^#\[derive\(/]],
  ['ruby', [/^puts\s+["'#[:]/, /^require\s+'[\w/.-]+'$/, /^attr_(?:accessor|reader|writer)\s+:/, /\.each(?:_with_index)?\s*(?:do\s*)?\{?\s*\|\w+(?:,\s*\w+)*\|/]],
  ['kotlin', [/^(?:(?:private|public|internal|override|suspend)\s+)*fun\s+\w+\s*\(/, /\b(?:listOf|mutableListOf|mapOf|mutableMapOf|setOf)\s*[(<]/, /^data\s+class\s+\w+\s*\(/]],
  ['swift', [/^import\s+(?:SwiftUI|UIKit|Foundation|Combine|AppKit|XCTest|MapKit|SwiftData)$/, /^guard\s+let\s+.+\belse\s*\{/, /^print\(".*\\\([\w.]+\).*"\)$/, /^@(?:State|Published|Binding)\s+(?:private\s+)?var\b/]],
  [
    'xml',
    // Not a lone element: `<b>…</b>` or `<img …>` is as likely a markdown
    // author's HTML as code, and markdown renders it.
    [/^<\?xml\s+version=|^<!DOCTYPE\s+html/i],
  ],
  ['css', [new RegExp(`^[^{}]+\\{\\s*(?:@[^{}]+\\{\\s*)?${CSS_PROPERTY.source}(?:\\s*[^{};]*;)*\\s*\\}\\s*\\}?$`), /^@media\s*\([^)]*\)\s*\{.*\}\s*\}$/]],
  ['dockerfile', [/^FROM\s+[\w.-]+(?:\/[\w.-]+)*(?::[\w.-]+|@sha256:\w+)(?:\s+AS\s+\w+)?$/, /^RUN\s+(?:apt-get|apk|pip3?|npm|yum|dnf|go|cargo)\s/]],
  ['makefile', [/\$\((?:CC|CXX|CFLAGS|CXXFLAGS|LDFLAGS|MAKE|RM)\)/, /^\.PHONY\s*:/]],
  ['lua', [/^local\s+\w+\s*=\s*(?:setmetatable|require)\s*\(/, /^for\s+[\w, ]+\s+in\s+i?pairs\s*\(.*\)\s+do\b/, /^local\s+function\s+\w+\s*\(/]],
  ['r', [/^[\w.]+\s*<-\s*(?:read\.\w+|c|data\.frame|function|list|matrix|lm)\s*\(/, /^library\s*\(\s*[\w.]+\s*\)$/]],
  ['perl', [/^my\s+(?:[$@%]\w+|\([$@%][\w, $@%]*\))\s*(?:=|;)/, /^use\s+(?:strict|warnings)\s*;$/, /\b(?:print|say)\s+"[^"]*\$_[^"]*"\s+(?:for|foreach)\s+@\w+/]],
  ['scala', [/^(?:case\s+)?object\s+\w+\s+extends\b/, /^case\s+class\s+\w+\s*\(/, /\.(?:map|filter|foreach|flatMap)\s*\(\s*_\s*[*+\-/.]/]],
  ['haskell', [/^[a-z_][\w']*\s+::\s+(?:[A-Z(\[]|[a-z]\s*->)/, /^import\s+qualified\s+[A-Z]/, /^main\s*=\s*(?:do\b|putStrLn|print\b|interact\b)/]],
]

/**
 * The fallback, for what the tells do not cover. Languages highlight.js tells
 * apart well enough to be worth it; `markdown` competes so that a block of
 * markdown is recognized as such and left alone. Left out on purpose: `ini`,
 * `perl`, `makefile` and the like, which match logs and prose at a relevance
 * that beats real code (the tells above name those).
 */
const GUESS_SUBSET = [
  'python', 'javascript', 'typescript', 'bash', 'powershell', 'java', 'csharp', 'c', 'cpp', 'go', 'rust',
  'ruby', 'php', 'kotlin', 'swift', 'sql', 'xml', 'css', 'yaml', 'markdown',
]

/** highlight.js relevance its guess must reach when no tell decided. */
const MIN_RELEVANCE = 7
/** Enough to recognize a language; the rest only costs time. */
const SAMPLE_CHARS = 6000

/** A sentence: eight words or more ending as prose does, or two sentences run together. */
const PROSE_LINE = /^(?=(?:\S+\s+){7,}\S)[^]*[.!?]["')\]]?$|[a-z][.!?]\s+[A-Z][a-z]/
/**
 * A sentence wrapped before its end, as license text and wrapped paragraphs
 * are: eight words or more, none of code's marks, and at least three of the
 * little words prose is made of.
 */
function wrappedProse(line: string): boolean {
  const words = line.trim().split(/\s+/)
  if (words.length < 8 || /[{}[\];=<>$\\|&*#@`]/.test(line)) return false
  return words.filter((w) => FUNCTION_WORDS.has(w.replace(/[^a-z]/g, ''))).length >= 3
}
const FUNCTION_WORDS = new Set(
  'the a an of to and or is are was in for with that this be by on as any it not from at which you your we our will can may if all'.split(' '),
)
/** A log or a stack trace: timestamps, levels, `Traceback`, `at …(File:1)`. */
const LOG_LINE =
  /^\[?(?:\d{4}-\d\d-\d\d[ T]\d|\d\d:\d\d:\d\d|[A-Z][a-z]{2} +\d+ \d\d:)|^(?:Traceback \(most recent call last\)|File ".*", line \d+|at [\w$.<>]+\(.*:\d+\))|^(?:INFO|WARN(?:ING)?|ERROR|DEBUG|TRACE|FATAL)\b/
/**
 * Markdown's own marks: a link or a picture with an address, a reference
 * link or its definition, a table row, a quote. A block that is a quarter
 * these is markdown (badges, a link list, a changelog), not code.
 */
const MARKDOWN_LINE = /!?\[[^\]]*\]\((?:[a-z]+:|[.#/]|[\w-]+[/.])[^)\s]*\)|\]\[[\w .-]*\]|^\s*\[[^\]]+\]:\s*\S|^\s*!\[|^\s*\|.*\|\s*$|^\s*>\s/
/** A markdown heading underlined: a line of text at the margin, then `---` or `===`. */
const SETEXT_HEADING = /^[^\s:#-][^:\n]*\n(?:-{3,}|={3,})[ \t]*$/m
/** Something code has on most lines and prose rarely: brackets, operators, a sigil, or indentation. */
const CODE_SHAPED = /[(){}[\];=<>$]|:\s*$|^\s+\S/

const SHEBANG = /^#!\s*\S*?(?:\/env\s+)?(bash|sh|zsh|python[23]?|node|ruby|perl|php|pwsh|lua)\b/

/**
 * A line without its comment: a whole-line `#`, `//`, `--`, `/*` or `*` one, or
 * one that trails the code after white space. Approximate — a `#` inside a
 * string ends the line early — which only matters to the prose and log
 * counts it feeds. A C preprocessor line (`#include`, `#define`) and a Rust
 * attribute (`#[derive]`) are code, not comments.
 */
function withoutComment(line: string): string {
  if (/^\s*(?:#(?!!|\s*(?:include|define|if|ifn?def|endif|else|elif|pragma|undef)\b|\[)|\/\/|--\s|\/\*|\*)/.test(line)) return ''
  return line.replace(/\s+(?:#|\/\/)\s.*$/, '')
}

/** A guess of `from` that has one of these lines is the language `to`. */
const REFINE: ReadonlyArray<readonly [from: string, to: string, patterns: readonly RegExp[]]> = [
  ['javascript', 'typescript', TYPESCRIPT],
  ['c', 'cpp', CPP],
]

function refined(language: string, lines: string[]): string {
  for (const [from, to, patterns] of REFINE) {
    if (language === from && lines.some((line) => patterns.some((p) => p.test(line)))) return to
  }
  return language
}

/** The language the tells clearly point to: two votes or more, a quarter of the lines, twice the runner-up. */
function byTells(lines: string[]): string | undefined {
  const block = lines.join('\n')
  const votes = TELLS.map(({ language, patterns, requires, excludes }) => ({
    language,
    n: (requires && !requires.test(block)) || excludes?.test(block) ? 0 : lines.filter((line) => patterns.some((p) => p.test(line))).length,
  })).sort((a, b) => b.n - a.n)
  const [best, second] = votes
  if (best.n < 2 || best.n * 4 < lines.length || best.n < second.n * 2) return undefined
  return refined(best.language, lines)
}

/** The one language a single line clearly is, if any. */
function byOneLine(line: string): string | undefined {
  const text = line.trim()
  const named = ONE_LINE.filter(([, patterns]) => patterns.some((p) => p.test(text))).map(([language]) => language)
  // C++ lines include C's (`printf` in a `std::` line): the family is one answer.
  const answer = named.includes('cpp') ? named.filter((l) => l !== 'c') : named
  return answer.length === 1 ? refined(answer[0], [text]) : undefined
}

/**
 * The language a block of code is most likely in, or undefined when it does
 * not clearly look like any — prose, a log, a list, markdown, or a snippet too
 * short to tell. One line is guessed only when it says outright what it is
 * (`SELECT … FROM`, `#include <stdio.h>`, `$ npm install`; see ONE_LINE).
 */
export function guessLanguage(text: string): string | undefined {
  const sample = text.slice(0, SAMPLE_CHARS)
  const lines = sample.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return undefined
  // A fenced block is markdown's: an AI answer is mostly the code in its
  // fences, which outvoted the prose round it and made the whole answer one block.
  if (hasFencedCodeBlock(sample)) return undefined

  const shebang = SHEBANG.exec(lines[0].trim())
  if (shebang) return normalizeLanguage(shebang[1])

  const trimmed = sample.trim()
  // One line of JSON must hold a string or a key: `[1]` is a footnote mark.
  if (/^[{[]/.test(trimmed) && text.length <= SAMPLE_CHARS && (lines.length > 1 || trimmed.includes('"'))) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // Not JSON; let the guess decide.
    }
  }

  // Comments are prose by design: PyCharm's own sample script is half
  // sentences after `#`, and counted as prose they vetoed it. They are judged
  // by the code around them, and a block of nothing but comments is not.
  const code = lines.map(withoutComment).filter((l) => l.trim() !== '')
  if (code.length === 0) return undefined
  if (code.length === 1) return LOG_LINE.test(code[0].trim()) || MARKDOWN_LINE.test(code[0]) ? undefined : byOneLine(code[0])
  const prose = code.filter((l) => PROSE_LINE.test(l.trim()) || wrappedProse(l)).length
  const logs = code.filter((l) => LOG_LINE.test(l.trim())).length
  const marked = SETEXT_HEADING.test(sample) ? lines.length : lines.filter((l) => MARKDOWN_LINE.test(l)).length
  const shaped = code.filter((l) => CODE_SHAPED.test(l) || TELLS.some(({ patterns }) => patterns.some((p) => p.test(l)))).length
  if (prose * 4 >= code.length || logs * 3 >= code.length || marked * 4 >= lines.length || shaped * 5 < code.length * 2) return undefined

  const told = byTells(code)
  if (told) return told
  const result = hljs.highlightAuto(sample, GUESS_SUBSET)
  if (!result.language || result.language === 'markdown') return undefined
  if (result.relevance < MIN_RELEVANCE) return undefined
  // highlight.js answers `cpp` for C: without a C++ line, it is C.
  if (result.language === 'cpp') return refined('c', code)
  return result.language
}

/** The entities hub HTML and highlight.js write, decoded. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&')
}

/** A code block's text as it reads: `<br>` as a line break, any other markup dropped. */
export function codeBlockText(body: string): string {
  return decodeEntities(body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
}

/**
 * Hub HTML with a guessed `language-X` on each code block that has no class.
 * A block with any class is someone's decision, `language-plaintext` included,
 * and an inline `<code>` is never guessed. Nor is a block the author formatted
 * (bold, a link): coloring it would print the text without that markup.
 */
export function guessCodeLanguages(html: string): string {
  if (!html.includes('<pre')) return html
  return html.replace(/(<pre(?:\s[^>]*)?>\s*)<code>([\s\S]*?)<\/code>/g, (match, open: string, body: string) => {
    if (/\bnb-/.test(open) || /<(?!br\b)[a-z]/i.test(body)) return match
    const lang = guessLanguage(codeBlockText(body))
    return lang ? `${open}<code class="language-${lang}">${body}</code>` : match
  })
}

/**
 * Pasted plain text that is code and nothing else, as the language it is in.
 * Text in a <pre> was already called code by whoever made it, while pasted
 * text could be anything; the guess holds for both because one line is
 * named only by what says outright what it is (ONE_LINE), and markdown,
 * prose and logs are ruled out first.
 */
export function pastedCodeLanguage(text: string): string | undefined {
  return guessLanguage(text)
}
