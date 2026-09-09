/**
 * The corpus guard's scanner.
 *
 * Every earlier scrub of this repository was a grep for terms already known to
 * be bad, and every one of them passed while unknown data was still present -
 * a denylist cannot report what is not on it. These functions invert that: they
 * ENUMERATE every value of each class, and the test compares the enumeration
 * against an explicit allowlist. Anything new fails until it is approved, so an
 * unrecognised name, address, number or word cannot enter unnoticed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { detect } from '../../src/core/detect'
import { getReader } from '../../src/core/readers'

export const CORPUS_DIR = 'tests/corpus'

/** Files whose content is vendored or generated and is not ours to re-theme. */
const SKIP_PATHS = new Set([
  'package-lock.json',
  'src/core/assets/reveal.generated.ts',
  'tests/pii/corpus-vocabulary.txt',
  // The guard's own lists name the values they exist to exclude. Scanning them
  // makes every check trip on itself.
  'tests/pii/domain-terms.ts',
  'tests/pii/approved-emails.txt',
  'tests/pii/approved-names.txt',
  'tests/pii/approved-numbers.txt',
  'tests/pii/domain-exceptions.txt',
])
const BINARY_EXT =
  /\.(png|jpe?g|gif|ico|icns|svg|pdf|docx?|xlsx?|pptx?|odt|odp|ods|epub|msg|rtf|eml|ics|gz|zip|traineddata|woff2?|ttf|mobi|azw3?|azw4)$/i

/**
 * A minimal .gitignore matcher.
 *
 * The guard has to work in a directory that is not a repository, so it cannot
 * ask git which files count. Reading .gitignore keeps one list in one place:
 * whatever the project excludes from version control is what this skips.
 */
function ignoreMatcher(): (rel: string, isDir: boolean) => boolean {
  const rules: { re: RegExp; negate: boolean; dirOnly: boolean; anchored: boolean }[] = []
  let text = ''
  try {
    text = readFileSync('.gitignore', 'utf8')
  } catch {
    /* no ignore file; everything below is then in scope */
  }
  for (let line of text.split('\n')) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.includes('/')
    const body = line
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
    rules.push({ re: new RegExp(`^${body}$`), negate, dirOnly, anchored })
  }
  return (rel, isDir) => {
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    let ignored = false
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue
      if (r.re.test(r.anchored ? rel : base)) ignored = !r.negate
    }
    return ignored
  }
}

/**
 * Text of every non-binary project file.
 *
 * Walks the filesystem rather than asking git, so the guard runs whether or not
 * this directory is a repository.
 */
export function trackedTextFiles(): { path: string; text: string }[] {
  const ignored = ignoreMatcher()
  const out: { path: string; text: string }[] = []
  const walk = (dir: string) => {
    const entries = readdirSync(dir === '' ? '.' : dir, { withFileTypes: true })
    for (const entry of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === '.git' || ignored(rel, true)) continue
        walk(rel)
        continue
      }
      if (!entry.isFile()) continue
      if (SKIP_PATHS.has(rel) || BINARY_EXT.test(rel) || ignored(rel, false)) continue
      try {
        if (statSync(rel).size > 2_000_000) continue
        out.push({ path: rel, text: readFileSync(rel, 'utf8') })
      } catch {
        /* unreadable as UTF-8; it is binary in practice */
      }
    }
  }
  walk('')
  return out
}

/**
 * The COMPLETE extracted text of every corpus fixture, read through the same
 * readers the app uses. Reading the bytes is not enough: what leaks is what a
 * user sees after conversion, and that only exists once a reader has run.
 */
export async function corpusText(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = []
  for (const name of readdirSync(CORPUS_DIR).sort()) {
    const bytes = readFileSync(join(CORPUS_DIR, name))
    const d = detect(bytes, name)
    if (d.kind !== 'ok') continue
    let html: string
    try {
      html = (await getReader(d.format)({ bytes, filename: name })).html
    } catch {
      continue // e.g. picture-only-figure.doc, which has no extractable text
    }
    out.push({
      path: `${CORPUS_DIR}/${name}`,
      text: html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))),
    })
  }
  return out
}

export interface Hit {
  value: string
  where: string[]
}

/** Collect every distinct match of `re`, with the files it appeared in. */
export function enumerate(
  sources: { path: string; text: string }[],
  re: RegExp,
  normalise: (m: RegExpMatchArray) => string = (m) => m[0],
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  for (const { path, text } of sources) {
    for (const m of text.matchAll(re)) {
      const v = normalise(m)
      if (!v) continue
      if (!found.has(v)) found.set(v, new Set())
      found.get(v)!.add(path)
    }
  }
  return found
}

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** Five or more digits: work orders, request numbers, phone numbers, account ids. */
export const NUMBER_RE = /\b\d{5,}\b/g
/** "Surname, Given" - how Exchange and most directories render a person. */
export const NAME_RE = /\b[A-Z][a-z]{2,},\s+[A-Z][a-z]{2,}\b/g
/** Words, for the corpus vocabulary snapshot. */
export const WORD_RE = /[A-Za-z][A-Za-z'-]{2,}/g

export function report(kind: string, hits: Map<string, Set<string>>): string {
  const lines = [...hits.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([v, where]) => `  ${JSON.stringify(v)}  <- ${[...where].sort().join(', ')}`)
  return (
    `${hits.size} unapproved ${kind} found.\n\n${lines.join('\n')}\n\n` +
    `Each is either real data that must be replaced, or invented data that must be\n` +
    `approved explicitly. To approve, add it to tests/pii/allowlist.ts (or run\n` +
    `npm run pii:update for the vocabulary snapshot) and say so in the commit.`
  )
}
