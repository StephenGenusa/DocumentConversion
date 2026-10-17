import { escapeHtml } from '../shell'
import { languageForFilename } from '../code-langs'
import type { HubDocument, ReadContext, SourceInput } from '../types'
import { needsReformat, reindentJson } from '../json-tokens'
import { reindentXml } from '../xml-indent'

interface DiffSection {
  title: string
  body: string
}

/** `b/path` -> `path`; a timestamp after a tab (GNU diff) is not part of it. */
function diffPath(raw: string): string {
  return raw.split('\t')[0].trim().replace(/^[ab]\//, '')
}

/**
 * A patch as one section per file, plus whatever comes before the first.
 *
 * A long patch printed as one block is hard to find your way around and
 * splits badly into e-book chapters. Git diffs are split on `diff --git`
 * lines; a plain unified diff on each `---` line followed by `+++`. Text
 * before the first file is a preamble: the mail header and diffstat of a
 * `git format-patch` file. Null when the text is not a recognizable diff.
 */
export function diffSections(text: string): { preamble: string; files: DiffSection[] } | null {
  const lines = text.split('\n')
  const starts: { at: number; title: string }[] = []
  const git = lines.some((l) => l.startsWith('diff --git '))
  for (let i = 0; i < lines.length; i++) {
    if (git) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[i])
      if (m) starts.push({ at: i, title: m[1] === m[2] ? m[2] : `${m[1]} → ${m[2]}` })
    } else if (lines[i].startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const to = diffPath(lines[i + 1].slice(4))
      starts.push({ at: i, title: to === '/dev/null' ? diffPath(lines[i].slice(4)) : to })
    }
  }
  if (starts.length === 0) return null
  const files = starts.map((s, k) => ({
    title: s.title,
    body: lines.slice(s.at, starts[k + 1]?.at ?? lines.length).join('\n').replace(/\n+$/, ''),
  }))
  return { preamble: lines.slice(0, starts[0].at).join('\n').trim(), files }
}

/**
 * A minified JSON or XML file re-indented so it can be read (spec D5). Only
 * when it cannot be read as written (see needsReformat): a file someone laid
 * out by hand is theirs. The re-indenting never re-serializes values, and a
 * file it cannot make sense of is shown as it is.
 */
function readable(text: string, language: string, ctx?: ReadContext): string {
  if ((language !== 'json' && language !== 'xml') || !needsReformat(text)) return text
  const pretty = language === 'json' ? reindentJson(text) : reindentXml(text)
  if (pretty === null) return text
  ctx?.onAdvice?.('reformatted', 'The file was minified; it is shown re-indented so it can be read. Nothing in it was changed.')
  return pretty
}

/** A whole file as one highlighted listing under its name. */
export function codeListing(name: string, text: string, language: string, ctx?: ReadContext): HubDocument {
  const body = readable(text, language, ctx)
  return {
    html: `<h1>${escapeHtml(name)}</h1>\n<pre><code class="language-${language}">${escapeHtml(body)}</code></pre>`,
    title: name,
    language,
  }
}

/** "Print this file for review": one fenced block, filename as heading. */
export async function readCode(src: SourceInput, ctx?: ReadContext): Promise<HubDocument> {
  const filename = src.filename ?? 'code'
  const language = languageForFilename(filename) ?? 'plaintext'
  // Strip the BOM and normalize CRLF; a literal CR leaks into docx/txt output.
  const text = src.bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const name = filename.split(/[\\/]/).pop() ?? filename
  const heading = `<h1>${escapeHtml(name)}</h1>`
  const block = (lang: string, body: string): string => `<pre><code class="language-${lang}">${escapeHtml(body)}</code></pre>`
  const sections = language === 'diff' ? diffSections(text) : null
  if (sections) {
    const parts = [heading]
    if (sections.preamble) parts.push(block('plaintext', sections.preamble))
    for (const f of sections.files) parts.push(`<h2>${escapeHtml(f.title)}</h2>`, block('diff', f.body))
    return { html: parts.join('\n'), title: name, language }
  }
  return codeListing(name, text, language, ctx)
}
