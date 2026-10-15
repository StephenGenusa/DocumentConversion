#!/usr/bin/env node
/**
 * Builds `tests/corpus/graphviz-notes.md`: invented notes on how volumes move
 * between library rooms, with Graphviz diagrams only (spec B1, B3, step 17),
 * for the e2e matrix. Every drawing target must draw the three good graphs
 * (a `dot` fence laid out by dot, a `graphviz` fence whose graph asks for
 * neato, and an undirected `gv` graph) and keep the broken one as source: the
 * matrix checks Word output for PNG media and the HTML outputs for SVG.
 *
 * The prose comes first and carries the words the matrix probes for, since a
 * drawn diagram's labels are no longer text in the output. Every word comes
 * from vocabulary.mjs (GRAPHVIZ_NOTES), which the PII guard's vocabulary is
 * derived from.
 *
 *   node scripts/fixtures/build-graphviz-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRAPHVIZ_NOTES as G } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus/graphviz-notes.md')

const fence = (lang, lines) => ['```' + lang, ...[].concat(lines), '```'].join('\n')

const md =
  [
    `# ${G.title}`,
    G.intro,
    fence('dot', G.route),
    G.branchesIntro,
    fence('graphviz', G.branches),
    G.undirectedIntro,
    fence('gv', G.undirected),
    G.brokenIntro,
    fence('dot', G.broken),
    G.closing,
  ].join('\n\n') + '\n'

writeFileSync(OUT, md)
console.log(`wrote ${OUT}`)
