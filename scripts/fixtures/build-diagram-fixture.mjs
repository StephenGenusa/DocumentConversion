#!/usr/bin/env node
/**
 * Builds `tests/corpus/diagram-notes.md`: invented library returns notes with
 * Mermaid diagrams (spec B1, B3), for the e2e matrix. Every drawing target
 * must turn the two good diagrams into PNG pictures (the matrix checks Word
 * output for PNG media), keep the broken one as source, and leave the
 * Graphviz block and the formula as source until their steps.
 *
 * The prose comes first and carries the words the matrix probes for, since a
 * drawn diagram's labels are no longer text in the output. Every word comes
 * from vocabulary.mjs (DIAGRAM_NOTES), which the PII guard's vocabulary is
 * derived from.
 *
 *   node scripts/fixtures/build-diagram-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIAGRAM_NOTES as D } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus/diagram-notes.md')

const fence = (lang, lines) => ['```' + lang, ...[].concat(lines), '```'].join('\n')

const md = [
  `# ${D.title}`,
  D.intro,
  fence('mermaid', D.flowchart),
  D.between,
  fence('mermaid', D.sequence),
  D.brokenIntro,
  fence('mermaid', D.broken),
  D.dotIntro,
  fence('dot', D.dot),
  D.formula,
].join('\n\n') + '\n'

writeFileSync(OUT, md)
console.log(`wrote ${OUT}`)
