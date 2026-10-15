#!/usr/bin/env node
/**
 * Builds `tests/corpus/formula-notes.md`: invented notes on overdue fines and
 * loan figures, with TeX formulas (spec B1, B3, step 18) for the e2e matrix.
 * Inline formulas sit in sentences (`$…$`); display ones are paragraphs of
 * their own (`$$…$$`): a sum, a tagged mean, cases and a matrix. Every drawing
 * target must draw them all but the one with an unknown macro, which stays as
 * source with a notice: the matrix checks Word output for PNG media lowered
 * onto the baseline, and the HTML outputs for SVG. Prose dollars (`$5`) and a
 * shell prompt in a code block stay text.
 *
 * The prose comes first and carries the words the matrix probes for, since a
 * drawn formula is no longer text in the output. Every word comes from
 * vocabulary.mjs (FORMULA_NOTES), which the PII guard's vocabulary is
 * derived from.
 *
 *   node scripts/fixtures/build-formula-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FORMULA_NOTES as F } from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus/formula-notes.md')

const $ = (tex) => `$${tex}$`
const $$ = (tex) => `$$${tex}$$`

const md =
  [
    `# ${F.title}`,
    F.intro,
    `${F.finesLead} ${$(F.finesDays)} ${F.finesMid} ${$(F.finesRate)}, ${F.finesTail} ${$(F.rate)} ${F.finesEnd} ${$(F.cap)}.`,
    F.sumLead,
    $$(F.total),
    F.meanLead,
    $$(F.mean),
    F.ruleLead,
    $$(F.rule),
    F.gridLead,
    $$(F.grid),
    `${F.inlineLead} ${$(F.share)} ${F.inlineMid} ${$(F.decay)} ${F.inlineMore} ${$(F.spread)} ${F.inlineEnd} ${$(F.area)}.`,
    F.prices,
    F.shellLead,
    ['```sh', F.shell, '```'].join('\n'),
    `${F.unknownLead} ${$(F.unknown)}.`,
    F.closing,
  ].join('\n\n') + '\n'

writeFileSync(OUT, md)
console.log(`wrote ${OUT}`)
