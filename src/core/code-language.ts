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
 * before sanitising and turns whatever the page called the language into the
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
const KEPT_IN_CODE = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'a', 'sup', 'sub'])

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
 * named. Runs before sanitising, while the classes and attributes are there.
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
 * not — a plain eight-line Python function scored 3 and lost to SQL. So the
 * common languages are recognised by their shape first, and highlight.js
 * decides only what these do not.
 *
 * A pattern belongs here only when it is rare in every other language: a
 * closing brace or a trailing semicolon would vote JavaScript for any C-family
 * snippet.
 */
const TELLS: ReadonlyArray<readonly [language: string, patterns: readonly RegExp[]]> = [
  [
    'python',
    [
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
    ],
  ],
  [
    'javascript',
    [
      /^\s*(?:export\s+)?(?:const|let|var)\s+[\w${}[\], ]+\s*=/,
      /\)\s*=>|\w\s*=>\s*[{(\w]/,
      /\bfunction\b\s*\*?\s*\w*\s*\(/,
      /\bconsole\.\w+\(/,
      /^\s*import\s.+\sfrom\s+['"]|\brequire\(['"]/,
      /^\s*export\s+(?:default|function|class|const|async)\b/,
      /\s(?:===|!==)\s/,
      /\b(?:document|window)\.\w+/,
      /\bawait\s+\w|\basync\s+(?:function\b|\()/,
    ],
  ],
  [
    'bash',
    [
      /^\s*(?:sudo\s+)?(?:echo|cd|export|apt(?:-get)?|npm|npx|pip3?|git|ls|mkdir|rm|cp|mv|chmod|chown|grep|curl|wget|source|cat|docker|brew|yarn|tar|ssh|scp|sed|awk|systemctl|unset|alias)\s/,
      /^\s*(?:if\s+\[\[?\s|elif\s+\[|fi\b|then\b|do\b|done\b|esac\b|case\s.+\sin\s*$)/,
      /"\$\{?[A-Za-z_]\w*\}?"|\$\(|\$\{\w+\}/,
      /^\s*(?:export\s+)?[A-Z_][A-Z0-9_]*=\S*\s*$/,
      /\s(?:&&|\|\|)\s|\s\|\s*(?:grep|sort|head|tail|wc|xargs|awk|sed)\b/,
    ],
  ],
  ['java', [/\bSystem\.(?:out|err)\.print/, /^\s*import\s+java\w*\./, /^\s*@Override\b/, /^\s*package\s+[\w.]+;\s*$/, /\bpublic\s+static\s+void\s+main\s*\(String/]],
  ['csharp', [/\bConsole\.Write(?:Line)?\(/, /^\s*using\s+System[\w.]*;\s*$/, /^\s*namespace\s+[\w.]+\s*[{;]?\s*$/, /\bstatic\s+(?:async\s+)?(?:void|Task)\s+Main\s*\(/]],
  ['go', [/^\s*package\s+\w+\s*$/, /^\s*func\s+(?:\([^)]*\)\s*)?\w+\s*\(/, /\bfmt\.\w+\(/, /\w\s*:=\s*/, /^\s*import\s+(?:\(|"[\w./-]+")\s*$/]],
  ['php', [/<\?php/, /\$\w+\s*->\s*\w/, /^\s*\$\w+\s*=.*;\s*$/, /^\s*(?:namespace|use)\s.*;\s*$/]],
  ['powershell', [/\b(?:Get|Set|New|Remove|Write|Invoke|Import|Start|Stop)-[A-Z]\w+/, /\s-(?:eq|ne|gt|lt|like|match)\s/, /^\s*param\s*\(/i]],
  [
    'sql',
    [/^\s*(?:SELECT|FROM|WHERE|GROUP BY|ORDER BY|INSERT INTO|UPDATE|DELETE FROM|CREATE (?:TABLE|INDEX|VIEW)|ALTER TABLE|DROP TABLE|(?:LEFT |RIGHT |INNER |OUTER )?JOIN|VALUES|HAVING|LIMIT)\b/],
  ],
]

/** TypeScript is JavaScript plus these: a winning JavaScript guess that has one is TypeScript. */
const TYPESCRIPT = [/^\s*(?:export\s+)?(?:interface|type)\s+\w+\b/, /\w\??:\s*(?:string|number|boolean|void|unknown|any)\b/, /\bas\s+const\b/]

/**
 * The fallback, for what the tells do not cover. Languages highlight.js tells
 * apart well enough to be worth it; `markdown` competes so that a block of
 * markdown is recognised as such and left alone. Left out on purpose: `ini`,
 * `perl`, `makefile` and the like, which match logs and prose at a relevance
 * that beats real code.
 */
const GUESS_SUBSET = [
  'python', 'javascript', 'typescript', 'bash', 'powershell', 'java', 'csharp', 'c', 'cpp', 'go', 'rust',
  'ruby', 'php', 'kotlin', 'swift', 'sql', 'xml', 'css', 'yaml', 'markdown',
]

/** highlight.js relevance its guess must reach when no tell decided. */
const MIN_RELEVANCE = 7
/** Enough to recognise a language; the rest only costs time. */
const SAMPLE_CHARS = 6000

/** A sentence: eight words or more ending as prose does, or two sentences run together. */
const PROSE_LINE = /^(?=(?:\S+\s+){7,}\S)[^]*[.!?]["')\]]?$|[a-z][.!?]\s+[A-Z][a-z]/
/** A log or a stack trace: timestamps, levels, `Traceback`, `at …(File:1)`. */
const LOG_LINE =
  /^\[?(?:\d{4}-\d\d-\d\d[ T]\d|\d\d:\d\d:\d\d|[A-Z][a-z]{2} +\d+ \d\d:)|^(?:Traceback \(most recent call last\)|File ".*", line \d+|at [\w$.<>]+\(.*:\d+\))|^(?:INFO|WARN(?:ING)?|ERROR|DEBUG|TRACE|FATAL)\b/
/** Something code has on most lines and prose rarely: brackets, operators, a sigil, or indentation. */
const CODE_SHAPED = /[(){}[\];=<>$]|:\s*$|^\s+\S/

const SHEBANG = /^#!\s*\S*?(?:\/env\s+)?(bash|sh|zsh|python[23]?|node|ruby|perl|php|pwsh)\b/

/**
 * A line without its comment: a whole-line `#`, `//`, `--`, `/*` or `*` one, or
 * one that trails the code after white space. Approximate — a `#` inside a
 * string ends the line early — which only matters to the prose and log
 * counts it feeds.
 */
function withoutComment(line: string): string {
  if (/^\s*(?:#(?!!)|\/\/|--\s|\/\*|\*)/.test(line)) return ''
  return line.replace(/\s+(?:#|\/\/)\s.*$/, '')
}

/** The language the tells clearly point to: two votes or more, a quarter of the lines, twice the runner-up. */
function byTells(lines: string[]): string | undefined {
  const votes = TELLS.map(([language, patterns]) => ({
    language,
    n: lines.filter((line) => patterns.some((p) => p.test(line))).length,
  })).sort((a, b) => b.n - a.n)
  const [best, second] = votes
  if (best.n < 2 || best.n * 4 < lines.length || best.n < second.n * 2) return undefined
  if (best.language === 'javascript' && lines.some((line) => TYPESCRIPT.some((p) => p.test(line)))) return 'typescript'
  return best.language
}

/**
 * The language a block of code is most likely in, or undefined when it does
 * not clearly look like any — prose, a log, a list, markdown, or a snippet too
 * short to tell.
 */
export function guessLanguage(text: string): string | undefined {
  const sample = text.slice(0, SAMPLE_CHARS)
  const lines = sample.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return undefined

  const shebang = SHEBANG.exec(lines[0].trim())
  if (shebang) return normalizeLanguage(shebang[1])

  const trimmed = sample.trim()
  if (/^[{[]/.test(trimmed) && text.length <= SAMPLE_CHARS) {
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
  const prose = code.filter((l) => PROSE_LINE.test(l.trim())).length
  const logs = code.filter((l) => LOG_LINE.test(l.trim())).length
  const shaped = code.filter((l) => CODE_SHAPED.test(l) || TELLS.some(([, patterns]) => patterns.some((p) => p.test(l)))).length
  if (prose * 4 >= code.length || logs * 3 >= code.length || shaped * 5 < code.length * 2) return undefined

  const told = byTells(code)
  if (told) return told
  const result = hljs.highlightAuto(sample, GUESS_SUBSET)
  if (!result.language || result.language === 'markdown') return undefined
  return result.relevance >= MIN_RELEVANCE ? result.language : undefined
}

function decodeEntities(s: string): string {
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
 * Stricter than a block's guess: text in a <pre> was already called code by
 * whoever made it, while pasted text could be anything — so it must be two
 * lines or more, and markdown is ruled out first by the guess itself.
 */
export function pastedCodeLanguage(text: string): string | undefined {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length < 2) return undefined
  return guessLanguage(text)
}
