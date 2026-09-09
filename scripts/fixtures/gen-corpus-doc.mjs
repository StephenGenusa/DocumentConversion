// Generates the synthetic legacy Word 97-2003 (.doc) replacements for
// tests/corpus/.
//
// There is no JS writer for the .doc binary format (word-extractor only
// reads). This script instead builds an intermediate .docx with html-to-docx
// (a project dependency) and shells out to a locally installed LibreOffice
// (`soffice --headless --convert-to doc:"MS Word 97"`) to produce the real
// Word 97-2003 binary. That is not a JS-only pipeline, but it is
// reproducible and reviewable: the HTML below is the actual source of
// truth, and LibreOffice is a deterministic, freely available converter.
//
// Verified empirically before writing this file: LibreOffice's .doc export
// (a) turns a real HTML <table> into genuine Word cell/row marks that
// word-extractor's getBody() maps to "\t", exactly like the real corpus
// file this replaces, and (b) embeds an inline <img> as a real OfficeArt
// BLIP picture record that countEmbeddedPictures (src/core/readers/doc.ts)
// recognises by its record header and image signature — not merely a zip
// media entry, which is what a .docx would produce instead.
//
// Run with: node scripts/fixtures/gen-corpus-doc.mjs
// Requires: `soffice` on PATH (LibreOffice). If it is not installed, this
// script prints what it could not do rather than writing anything.
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import * as V from './vocabulary.mjs'

/** A quiz body: question, its options, a blank paragraph between groups. */
const quizHtml = (sets) =>
  sets.map((set) => set.map((line) => `<p>${line}</p>`).join('\n    ')).join('\n    <p>&nbsp;</p>\n    ')

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus')

const htd = (await import('html-to-docx')).default ?? (await import('html-to-docx'))
const { readFile } = await import('node:fs/promises')
const PNG = (await readFile(join(here, '../../tests/fixtures/sample.png'))).toString('base64')

async function jpeg() {
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(64, 40)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#2a4d7a'
  ctx.fillRect(0, 0, 64, 40)
  ctx.fillStyle = '#ffffff'
  ctx.font = '10px sans-serif'
  ctx.fillText('LOGO', 12, 24)
  return canvas.toBuffer('image/jpeg').toString('base64')
}
const JPEG = await jpeg()

function img(kind = 'png', w = 60, h = 20) {
  const data = kind === 'jpeg' ? JPEG : PNG
  const mime = kind === 'jpeg' ? 'image/jpeg' : 'image/png'
  return `<p><img src="data:${mime};base64,${data}" width="${w}" height="${h}"/></p>`
}

/**
 * A throwaway LibreOffice profile, and why it is not optional.
 *
 * LibreOffice is single-instance PER PROFILE. A bare `soffice ...` does not
 * start a new process — it hands the request to whatever instance already owns
 * the default profile, which on a developer's desktop is their own open
 * session. It will open windows there, and it can disturb a document they are
 * working in. That happened three times while this corpus was being built.
 *
 * `-env:UserInstallation` gives this script a profile nobody else owns, so it
 * always gets its own process and can never reach a running session.
 */
const LO_PROFILE = join(tmpdir(), 'docconv-fixture-soffice-profile')
const soffice = (args) =>
  run('soffice', [`-env:UserInstallation=file://${LO_PROFILE}`, ...args], { timeout: 120_000 })

/** Whether soffice is available; checked once, up front. */
async function hasSoffice() {
  try {
    await soffice(['--version'])
    return true
  } catch {
    return false
  }
}

async function toLegacyDoc(html, outName) {
  const docxBuf = await htd(html)
  const tmp = await mkdtemp(join(tmpdir(), 'corpus-doc-'))
  const docxPath = join(tmp, 'src.docx')
  await writeFile(docxPath, docxBuf)
  await soffice(['--headless', '--convert-to', 'doc:MS Word 97', '--outdir', tmp, docxPath])
  const producedName = outName.replace(/\.doc$/, '') // soffice names it src.doc regardless
  const producedPath = join(tmp, 'src.doc')
  const bytes = await readFile(producedPath)
  await writeFile(join(OUT, outName), bytes)
  await rm(tmp, { recursive: true, force: true })
  void producedName
  return bytes.length
}

if (!(await hasSoffice())) {
  console.error(
    'soffice (LibreOffice) not found on PATH — cannot build the legacy .doc fixtures. ' +
      'Install LibreOffice and re-run scripts/fixtures/gen-corpus-doc.mjs.',
  )
  process.exit(1)
}

/* -------------------------------------------------------------------------- */
/* loan-calculations.doc — doc-cell-separator, doc-{tables,images}-notice     */
/*                                                                            */
/* A prose document whose numeric reference table survives only as Word cell */
/* marks (word-extractor maps both the cell mark and the row mark to "\t"),  */
/* plus six inline pictures that Word 97-2003 keeps outside the text stream  */
/* entirely. Reproduces: the exact tab-joined table-row text the cell-       */
/* separator test pins, the doc-tables notice, the doc-images notice (6      */
/* pictures), and doc-lists staying silent (no stacked short unterminated    */
/* lines — every paragraph here is an ordinary sentence).                    */
/* -------------------------------------------------------------------------- */
{
  const html = `<html><body>
    <p>${V.LOAN_DOC.intro}</p>
    <p>${V.LOAN_DOC.formulaLead}</p>
    ${img('png')}
    ${img('png')}
    <p>${V.LOAN_DOC.tableLead}</p>
    <table>
      ${V.LOAN_DOC.rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('\n      ')}
    </table>
    <p>${V.LOAN_DOC.tail[0]}</p>
    ${img('png')}
    ${img('png')}
    <p>${V.LOAN_DOC.tail[1]}</p>
    ${img('png')}
    ${img('png')}
    <p>${V.LOAN_DOC.tail[2]}</p>
    <p>${V.LOAN_DOC.tail[3]}</p>
  </body></html>`
  const n = await toLegacyDoc(html, 'loan-calculations.doc')
  console.log('loan-calculations.doc', n, 'bytes')
}

/* -------------------------------------------------------------------------- */
/* shelving-instructions.doc — doc-tables-notice, doc-images-notice         */
/*                                                                            */
/* A one-column title block (two consecutive cell-mark lines — the shape     */
/* that trips looksLikeDocTable's "two rows in a row" rule even though the   */
/* extracted text reads fine) plus one JPEG logo. doc-lists stays silent.   */
/* -------------------------------------------------------------------------- */
{
  const html = `<html><body>
    <table>
      <tr><td>${V.SHELVING_DOC.title}</td></tr>
      <tr><td>${V.SHELVING_DOC.subtitle}</td></tr>
    </table>
    ${img('jpeg')}
    <p>${V.SHELVING_DOC.lead}</p>
    ${V.SHELVING_DOC.steps.map((t) => `<p>${t}</p>`).join('\n    ')}
  </body></html>`
  const n = await toLegacyDoc(html, 'shelving-instructions.doc')
  console.log('shelving-instructions.doc', n, 'bytes')
}

/* -------------------------------------------------------------------------- */
/* reading-group-questions.doc — doc-lists-notice                          */
/*                                                                            */
/* A quiz whose Word auto-numbering/lettering is gone by the time            */
/* word-extractor sees it: five question blocks, each a stack of short,      */
/* unterminated lines. Pins the exact question/answer text the reader test   */
/* checks for. No tabs, no images: doc-tables and doc-images stay silent.    */
/* -------------------------------------------------------------------------- */
{
  const html = `<html><body>
    ${quizHtml(V.QUIZ_READING_GROUP)}
  </body></html>`
  const n = await toLegacyDoc(html, 'reading-group-questions.doc')
  console.log('reading-group-questions.doc', n, 'bytes')
}

/* -------------------------------------------------------------------------- */
/* volunteer-induction-questions.doc — doc-lists-notice               */
/* Same quiz shape, different generic subject; no text is pinned.            */
/* -------------------------------------------------------------------------- */
{
  const html = `<html><body>
    ${quizHtml(V.QUIZ_INDUCTION)}
  </body></html>`
  const n = await toLegacyDoc(html, 'volunteer-induction-questions.doc')
  console.log('volunteer-induction-questions.doc', n, 'bytes')
}

/* -------------------------------------------------------------------------- */
/* cataloguing-questions.doc — doc-lists-notice             */
/* Same quiz shape again, a third generic subject.                           */
/* -------------------------------------------------------------------------- */
{
  const html = `<html><body>
    ${quizHtml(V.QUIZ_CATALOGUING)}
  </body></html>`
  const n = await toLegacyDoc(html, 'cataloguing-questions.doc')
  console.log('cataloguing-questions.doc', n, 'bytes')
}

/* -------------------------------------------------------------------------- */
/* definitions.doc — silent on tables, lists and images                      */
/* Plain prose glossary: ordinary sentences, no tabs, no pictures.           */
/* -------------------------------------------------------------------------- */
{
  const html = `<html><body>
    ${V.DEFINITIONS_DOC.map((t) => `<p>${t}</p>`).join('\n    ')}
  </body></html>`
  const n = await toLegacyDoc(html, 'definitions.doc')
  console.log('definitions.doc', n, 'bytes')
}

/* -------------------------------------------------------------------------- */
/* classification-explanation.doc — silent on tables, lists and images       */
/* Plain explanatory prose about a generic wiring configuration.             */
/* -------------------------------------------------------------------------- */
{
  const html = `<html><body>
    ${V.CLASSIFICATION_DOC.map((t) => `<p>${t}</p>`).join('\n    ')}
  </body></html>`
  const n = await toLegacyDoc(html, 'classification-explanation.doc')
  console.log('classification-explanation.doc', n, 'bytes')
}

/* -------------------------------------------------------------------------- */
/* picture-only-figure.doc — doc-tables-notice, doc-images-notice             */
/* A document with a picture and NO text at all, so word-extractor's body    */
/* extracts to nothing and readDoc must reject it with 'read-failed' before  */
/* any advice is emitted.                                                    */
/* -------------------------------------------------------------------------- */
{
  const html = `<html><body>${img('png', 200, 150)}</body></html>`
  const n = await toLegacyDoc(html, 'picture-only-figure.doc')
  console.log('picture-only-figure.doc', n, 'bytes')
}

console.log('legacy .doc corpus fixtures written to', OUT)
