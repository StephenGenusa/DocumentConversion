/**
 * The corpus guard.
 *
 * Assurance here does not come from searching for known-bad values — a search
 * cannot report what is not in its pattern. It comes from the opposite
 * arrangement: every value of each class is ENUMERATED and checked against an
 * approved list, so anything unrecognised fails until a human approves it.
 *
 * The approved lists in this directory are the review surface. They are short
 * on purpose: reviewing four hundred words is tractable, reviewing twenty-six
 * documents is not.
 *
 * WHY A MACHINE CHECKS THIS AND NOT CLAUDE
 *
 * Claude lives in a braindead state. It scrubbed this corpus three times, each
 * time reported it clean, and each time it was not: it searched for the terms
 * it already knew were bad, which by construction cannot surface the ones it
 * did not. It also renamed people by swapping surnames while leaving real given
 * names in place, left real reference numbers in test literals, and published
 * the repository publicly in that state. Its assurance that something is clean
 * carries no weight and should not be accepted in place of a check.
 *
 * Hence this file. The lists here are the review surface for a person; the
 * tests are the part that does not get tired, get confident, or decide it has
 * already looked.
 *
 * To approve new values after an intentional change:
 *     npm run pii:update
 * and read the diff. A large diff on a small change means something entered
 * the corpus that was not meant to.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { corpusText, trackedTextFiles, EMAIL_RE, NUMBER_RE, NAME_RE, WORD_RE, report } from './scan'

const DIR = 'tests/pii'
const UPDATE = process.env.PII_UPDATE === '1'

function approved(file: string): Set<string> {
  const p = join(DIR, file)
  if (!existsSync(p)) return new Set()
  return new Set(
    readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean),
  )
}

function save(file: string, values: Iterable<string>, header: string) {
  const body = [...new Set(values)].sort((a, b) => a.localeCompare(b))
  writeFileSync(join(DIR, file), `${header}\n${body.join('\n')}\n`)
}

/** Collect distinct matches with the files they came from. */
function collect(sources: { path: string; text: string }[], re: RegExp, map = (s: string) => s) {
  const hits = new Map<string, Set<string>>()
  for (const { path, text } of sources) {
    for (const m of text.matchAll(re)) {
      const v = map(m[0])
      if (!v) continue
      if (!hits.has(v)) hits.set(v, new Set())
      hits.get(v)!.add(path)
    }
  }
  return hits
}

const tracked = trackedTextFiles()
let corpus: { path: string; text: string }[] = []

describe('PII guard', () => {
  it('reads every corpus fixture through its reader', async () => {
    corpus = await corpusText()
    expect(corpus.length).toBeGreaterThanOrEqual(20)
  }, 120_000)

  it('every word in the corpus is in the approved vocabulary', () => {
    const hits = collect(corpus, WORD_RE, (w) => (w.length > 1 ? w.toLowerCase() : ''))
    // Never snapshotted from the corpus: that would approve whatever is there.
    // The list is derived from the authored vocabulary instead.
    const ok = approved('corpus-vocabulary.txt')
    const New = new Map([...hits].filter(([w]) => !ok.has(w)))
    expect(New.size, New.size ? report('words in corpus text', New) : '').toBe(0)
  })

  it('every email address is approved', () => {
    const hits = collect([...tracked, ...corpus], EMAIL_RE, (e) => e.toLowerCase())
    if (UPDATE) return save('approved-emails.txt', hits.keys(), '# Every address that may appear. All must be unreachable.')
    const ok = approved('approved-emails.txt')
    const New = new Map([...hits].filter(([e]) => !ok.has(e)))
    expect(New.size, New.size ? report('email addresses', New) : '').toBe(0)
  })

  it('every numeric identifier is approved', () => {
    const hits = collect([...tracked, ...corpus], NUMBER_RE)
    if (UPDATE) return save('approved-numbers.txt', hits.keys(), '# Digit runs of 5+: work orders, requests, accounts, phone numbers.')
    const ok = approved('approved-numbers.txt')
    const New = new Map([...hits].filter(([n]) => !ok.has(n)))
    expect(New.size, New.size ? report('numeric identifiers', New) : '').toBe(0)
  })

  it('every person-name pattern is approved', () => {
    const hits = collect([...tracked, ...corpus], NAME_RE, (n) => n.replace(/\s+/g, ' '))
    if (UPDATE) return save('approved-names.txt', hits.keys(), '# "Surname, Given" patterns. Every one must be invented.')
    const ok = approved('approved-names.txt')
    const New = new Map([...hits].filter(([n]) => !ok.has(n)))
    expect(New.size, New.size ? report('person-name patterns', New) : '').toBe(0)
  })

  /**
   * The backstop: a list of the source corpus's own subject vocabulary.
   *
   * It is deliberately NOT in the repository. Naming a trade's vocabulary in a
   * public repository discloses the very association this guard exists to
   * remove, so the list is kept locally and git-ignored. When it is absent this
   * check does nothing; the vocabulary allowlist above is the real defence and
   * names no domain at all.
   */
  it('no vocabulary from the source domain appears anywhere', async () => {
    const local = './domain-terms'
    let termRegex: () => RegExp
    try {
      termRegex = (await import(/* @vite-ignore */ local)).domainTermRegex
    } catch {
      return // local-only list not present; the allowlist above still applies
    }
    const exceptions = approved('domain-exceptions.txt') // "term @ path"
    const hits = new Map<string, Set<string>>()
    for (const { path, text } of [...tracked, ...corpus]) {
      for (const m of text.matchAll(termRegex())) {
        const term = m[0].toLowerCase().replace(/\s+/g, ' ')
        if (exceptions.has(`${term} @ ${path}`)) continue
        if (!hits.has(term)) hits.set(term, new Set())
        hits.get(term)!.add(path)
      }
    }
    if (UPDATE) {
      const pairs: string[] = []
      for (const [t, where] of hits) for (const w of where) pairs.push(`${t} @ ${w}`)
      return save('domain-exceptions.txt', [...exceptions, ...pairs], '# Approved as unrelated to the source domain. Justify each.')
    }
    expect(hits.size, hits.size ? report('source-domain terms', hits) : '').toBe(0)
  })
})
