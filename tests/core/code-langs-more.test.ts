import { describe, it, expect } from 'vitest'
import { languageForFilename } from '../../src/core/code-langs'
import { detect } from '../../src/core/detect'
import { readCode } from '../../src/core/readers/code'
import { readMarkdown } from '../../src/core/readers/md'
import { writeHtml } from '../../src/core/writers/html'

const read = (text: string, filename: string) => readCode({ bytes: Buffer.from(text, 'utf8'), filename })

describe('more languages print with color', () => {
  // In highlight.js/lib/common: nothing to register.
  const common: Record<string, string> = {
    'a.php': 'php', 'a.phtml': 'php', 'a.swift': 'swift', 'a.lua': 'lua', 'a.pl': 'perl', 'a.pm': 'perl',
    'a.r': 'r', 'a.R': 'r', 'a.mm': 'objectivec', 'a.vb': 'vbnet', 'a.graphql': 'graphql', 'a.gql': 'graphql',
    'a.less': 'less', 'a.kts': 'kotlin', 'a.wat': 'wasm',
  }
  // Registered on their own, as dockerfile and powershell already are.
  const extra: Record<string, string> = {
    'a.scala': 'scala', 'a.groovy': 'groovy', 'build.gradle': 'groovy', 'a.dart': 'dart', 'a.hs': 'haskell',
    'a.ex': 'elixir', 'a.exs': 'elixir', 'a.erl': 'erlang', 'a.clj': 'clojure', 'a.cljs': 'clojure',
    'a.fs': 'fsharp', 'a.fsx': 'fsharp', 'a.ml': 'ocaml', 'a.jl': 'julia', 'a.vbs': 'vbscript',
    'run.bat': 'dos', 'run.cmd': 'dos', 'a.cmake': 'cmake', 'CMakeLists.txt': 'cmake', 'a.proto': 'protobuf',
    'a.asm': 'x86asm', 'a.s': 'x86asm', 'nginx.conf': 'nginx',
  }
  const config: Record<string, string> = {
    '.env': 'ini', '.env.local': 'ini', '.env.production': 'ini', 'prod.env': 'ini', 'app.properties': 'ini',
    'app.conf': 'ini', 'setup.cfg': 'ini', '.editorconfig': 'ini', '.gitconfig': 'ini', '.npmrc': 'ini',
  }

  for (const [file, lang] of Object.entries({ ...common, ...extra, ...config })) {
    it(`${file} -> ${lang}`, () => {
      expect(languageForFilename(file)).toBe(lang)
      const d = detect(Buffer.from('x = 1\n'), file)
      expect(d.kind === 'ok' && d.format).toBe('code')
    })
  }

  it('leaves .m unmapped: it is Objective-C and MATLAB both', () => {
    expect(languageForFilename('a.m')).toBeNull()
  })

  it('highlights a newly registered language in HTML output', async () => {
    const hub = await read('object Main { def main(args: Array[String]): Unit = println("hi") }\n', 'Main.scala')
    expect((await writeHtml(hub)).toString('utf8')).toMatch(/<span class="hljs-keyword">object<\/span>/)
  })
})

const GIT_DIFF = [
  'diff --git a/src/one.ts b/src/one.ts',
  'index 1111111..2222222 100644',
  '--- a/src/one.ts',
  '+++ b/src/one.ts',
  '@@ -1,2 +1,2 @@',
  '-const a = 1',
  '+const a = 2',
  ' const b = 3',
  'diff --git a/old.md b/new.md',
  'similarity index 90%',
  'rename from old.md',
  'rename to new.md',
  '',
].join('\n')

describe('diff and patch files', () => {
  it('read as diffs, one section per file', async () => {
    const hub = await read(GIT_DIFF, 'change.diff')
    expect(hub.html).toMatch(/<h2>src\/one\.ts<\/h2>\s*<pre><code class="language-diff">diff --git a\/src\/one\.ts/)
    expect(hub.html).toMatch(/<h2>old\.md → new\.md<\/h2>/)
    expect(hub.html.match(/<pre>/g)).toHaveLength(2)
  })

  it('split a plain unified diff on its --- / +++ pairs', async () => {
    const plain = '--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-x\n+y\n--- b.txt\n+++ b.txt\n@@ -1 +1 @@\n-p\n+q\n'
    const hub = await read(plain, 'two.patch')
    expect(hub.html).toMatch(/<h2>a\.txt<\/h2>[\s\S]*<h2>b\.txt<\/h2>/)
  })

  it('show a git format-patch mail header as a preamble, and never read the file as a mailbox', async () => {
    const patch =
      'From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001\n' +
      'From: A Developer <dev@example.com>\nDate: Tue, 13 Oct 2026 10:00:00 +0000\nSubject: [PATCH] Fix one\n\n---\n src/one.ts | 2 +-\n\n' +
      GIT_DIFF
    const d = detect(Buffer.from(patch), '0001-fix-one.patch')
    expect(d.kind === 'ok' && d.format).toBe('code')
    const hub = await read(patch, '0001-fix-one.patch')
    expect(hub.html).toMatch(/<h1>0001-fix-one\.patch<\/h1>\s*<pre><code class="language-plaintext">From 0123456789abcdef[\s\S]*Subject: \[PATCH\] Fix one/)
    expect(hub.html).toMatch(/<h2>src\/one\.ts<\/h2>/)
  })

  it('keep a file that is not a recognisable diff as one block', async () => {
    const hub = await read('just some text\n', 'notes.diff')
    expect(hub.html.match(/<pre>/g)).toHaveLength(1)
    expect(hub.html).not.toContain('<h2>')
  })

  it('print added and removed lines with full-line backgrounds', async () => {
    const html = (await writeHtml(await read(GIT_DIFF, 'change.diff'))).toString('utf8')
    expect(html).toMatch(/\.language-diff \.hljs-addition[^{]*\{[^}]*display: ?inline-block/)
    expect(html).toContain('class="hljs-addition"')
  })
})

describe('Markdown variants', () => {
  for (const ext of ['mdown', 'mkd', 'mkdn', 'mdwn', 'markdn', 'Rmd', 'qmd']) {
    it(`.${ext} is Markdown`, () => {
      const d = detect(Buffer.from('# T\n'), `a.${ext}`)
      expect(d.kind === 'ok' && d.format).toBe('md')
    })
  }

  const rmd = (text: string, name = 'report.Rmd') => readMarkdown({ bytes: Buffer.from(text, 'utf8'), filename: name })

  it('R Markdown: front matter title, chunk languages, inline code', async () => {
    const hub = await rmd('---\ntitle: "Quarterly"\noutput: html_document\n---\n\n```{r setup, echo=FALSE}\nx <- 1\n```\n\n```{python}\nprint(1)\n```\n\nThe answer is `r x`.\n')
    expect(hub.title).toBe('Quarterly')
    expect(hub.html).toContain('<pre><code class="language-r">x &lt;- 1')
    expect(hub.html).toContain('<pre><code class="language-python">print(1)')
    expect(hub.html).toContain('<code>r x</code>')
  })

  it('Quarto: callout blocks become alerts, other ::: divs are unwrapped', async () => {
    const hub = await rmd(
      '::: {.callout-warning}\nHot surface.\n:::\n\n::: {.callout-tip title="Hint"}\nUse gloves.\n:::\n\n::: {.column-margin}\nIn the margin.\n:::\n',
      'doc.qmd',
    )
    expect(hub.html).toMatch(/<blockquote>\s*<p><strong>Warning<\/strong><\/p>\s*<p>Hot surface\.<\/p>\s*<\/blockquote>/)
    expect(hub.html).toMatch(/<strong>Tip<\/strong>[\s\S]*Use gloves\./)
    expect(hub.html).toContain('<p>In the margin.</p>')
    expect(hub.html).not.toContain(':::')
  })

  it('leaves ::: alone in an ordinary .md file and inside code', async () => {
    expect((await rmd('::: {.callout-note}\nx\n:::\n', 'plain.md')).html).toContain(':::')
    expect((await rmd('```\n::: {.callout-note}\n```\n', 'doc.qmd')).html).toContain('::: {.callout-note}')
  })
})
