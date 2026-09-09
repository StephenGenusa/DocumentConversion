#!/usr/bin/env node
/**
 * Builds a synthetic RTF for `tests/core/rtf-tables.test.ts`'s "real 807 KB
 * user file" case, replacing a real document that named a person and a real
 * reference number. It reproduces the one property under test: a document that is
 * almost entirely embedded WMF picture payload (hex, no table markup) with a
 * few lines of real prose, which the picture-stripping path has to get out
 * intact and fast.
 *
 * Scaled down on purpose: 44 small picture groups (~1KB of hex each) rather
 * than 44 multi-page-scan-sized ones, so the fixture is tens of KB rather
 * than 826 KB. The shape — mostly picture, a little prose, zero tables — is
 * what the test actually exercises.
 *
 *   node scripts/fixtures/build-rtf-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import * as V from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus/review-notes.rtf')

function pict(seed) {
  const hex = createHash('sha256').update(String(seed)).digest('hex').repeat(16)
  return `{\\pict\\wmetafile8\\picw1200\\pich900\\picwgoal600\\pichgoal450 ${hex}}`
}

const pics = Array.from({ length: 44 }, (_, i) => pict(i)).join('\n')

const reviewer = V.PEOPLE.find((p) => p.last === 'Quill')
const author = V.PEOPLE.find((p) => p.last === 'Vellum')
const items = V.REVIEW_RTF.items.map((t, i) => `${i + 1}. ${t}\\par`).join('\n')

const body = String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0 Calibri;}}
\pard\f0\fs22 ${V.REVIEW_RTF.salutation(reviewer)}\par
\par
${items}
\par
${V.REVIEW_RTF.signOff}\par
${V.fullName(author)}\par
${pics}
\par
${V.REVIEW_RTF.end}\par
}`

const bytes = Buffer.from(body, 'latin1')
writeFileSync(OUT, bytes)
console.log(`wrote ${OUT} (${bytes.length} bytes)`)
