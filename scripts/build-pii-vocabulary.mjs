#!/usr/bin/env node
/**
 * Derives tests/pii/corpus-vocabulary.txt from scripts/fixtures/vocabulary.mjs.
 *
 * The direction matters. Snapshotting the words the corpus happens to contain
 * approves whatever is already there, including anything that should not be.
 * Deriving the list from the authored vocabulary instead means the guard checks
 * the corpus against what someone intended to write, and any word a generator
 * produces that was never authored fails.
 *
 *   node scripts/build-pii-vocabulary.mjs
 */
import { writeFileSync } from 'node:fs'
import * as V from './fixtures/vocabulary.mjs'

/**
 * Words the READERS add, not the fixtures: mail headers, attachment tables,
 * calendar labels and the bracketed alt text the sanitiser writes. They appear
 * in extracted text without appearing in any document, so they are authored
 * here rather than inferred.
 */
const APP_CHROME = `
  from to cc bcc subject date sent attachments not converted bytes
  when where what page pages img image figure table row column
  untitled unknown none true false null and or of the utc gmt am pm
`

const words = new Set()
const add = (text) => {
  for (const w of String(text).matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
    if (w[0].length > 1) words.add(w[0].toLowerCase())
    // Extractors differ on apostrophes: "Worker's" can arrive as one token or
    // as "Worker" and "s". Approve both halves so the guard is not fooled by
    // which library did the extracting.
    for (const part of w[0].split(/['’]/)) if (part.length > 1) words.add(part.toLowerCase())
  }
}
const walk = (v) => {
  if (v == null) return
  if (typeof v === 'string' || typeof v === 'number') return add(v)
  if (typeof v === 'function') return // helpers; their output is composed of the above
  if (Array.isArray(v)) return v.forEach(walk)
  if (typeof v === 'object') return Object.values(v).forEach(walk)
}
Object.values(V).forEach(walk)
add(APP_CHROME)

// Composed forms the helpers produce from the parts above.
for (const p of V.PEOPLE) {
  add(V.mailbox(p))
  add(V.mailbox(p, V.DOMAINS.org))
  add(V.mailbox(p, V.DOMAINS.net))
  add(V.displayName(p))
  add(V.fullName(p))
  add(V.REVIEW_RTF.salutation(p))
}

const sorted = [...words].sort((a, b) => a.localeCompare(b))
writeFileSync(
  'tests/pii/corpus-vocabulary.txt',
  '# Derived from scripts/fixtures/vocabulary.mjs by scripts/build-pii-vocabulary.mjs.\n' +
    '# Do not hand-edit: add the word to the vocabulary and re-run that script.\n' +
    `${sorted.join('\n')}\n`,
)
console.log(`wrote tests/pii/corpus-vocabulary.txt (${sorted.length} words)`)
