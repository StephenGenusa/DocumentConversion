import { TABLE_TARGETS, TARGET_FORMATS, type SourceFormat, type TargetFormat } from './types'

export interface TargetValidityInput {
  format: SourceFormat
  imageMode?: 'embed' | 'ocr'
}

/**
 * Valid targets for one input. An embedded image is a picture on a page: it
 * cannot become txt/md, and it has no tables, so csv/json/xlsx are out.
 *
 * OCR used to be restricted the same way as embed plus text, because its
 * output was always plain paragraphs and csv could never be satisfied. It no
 * longer is: the OCR pipeline reconstructs tables from word boxes, so a
 * scanned form can reach a spreadsheet and every target is offered. A page
 * that turns out to hold no table still fails at write time with the ordinary
 * "no tables to extract" message, exactly as a prose .docx does.
 */
function targetsFor(input: TargetValidityInput): TargetFormat[] {
  // epub and revealjs belong with docx/pdf/html here: they are document
  // targets that can hold a picture, unlike txt/md (no image) or
  // csv/json/xlsx (no table). A deck is self-contained HTML carrying data
  // URIs, so one image is a legitimate one-slide deck.
  if (input.format === 'image' && input.imageMode !== 'ocr') {
    return ['docx', 'pdf', 'html', 'epub', 'revealjs', 'azw3', 'azw4']
  }
  return TARGET_FORMATS
}

/**
 * Combined validity is the intersection across every loaded input (spec §F0).
 * With nothing loaded the answer is "nothing", not "everything" — an empty
 * intersection would otherwise offer every target for zero inputs.
 */
export function allowedTargets(inputs: TargetValidityInput[]): TargetFormat[] {
  if (inputs.length === 0) return []
  return TARGET_FORMATS.filter((t) => inputs.every((i) => targetsFor(i).includes(t)))
}

/**
 * Targets whose bytes are not text.
 *
 * This question is asked in more than one place — the clipboard handler
 * refuses a binary target (src/main/index.ts) and the output picker hides the
 * "Convert to clipboard" button for one (OutputPicker.tsx) — and each site
 * used to answer from its own hand-written `docx || pdf` pair. epub was added
 * as a target and appeared in neither, so an epub could be "copied": the
 * handler runs `Buffer.toString('utf8')` over a zip and reports success while
 * putting mojibake on the clipboard. xlsx is the same shape and was already
 * wrong the same way before epub existed.
 *
 * One list, so the next binary target cannot be added to half of them.
 */
export const BINARY_TARGETS: TargetFormat[] = ['docx', 'pdf', 'epub', 'xlsx', 'azw3', 'azw4']

export function isBinaryTarget(target: TargetFormat): boolean {
  return BINARY_TARGETS.includes(target)
}

/**
 * Targets that are text, and still make no sense on the clipboard.
 *
 * A reveal.js deck IS text - so `isBinaryTarget` is correctly false for it, and
 * the clipboard handler would not mangle it - but it is a whole standalone
 * document with ~240 KB of engine inlined. Pasting that into Word gives a wall
 * of minified JavaScript, not a presentation. The distinction is "would a
 * person want this pasted", which is not the same question as "are the bytes
 * text", so it gets its own list rather than being smuggled into the other.
 */
const UNPASTEABLE_TARGETS: TargetFormat[] = ['revealjs']

export function isClipboardTarget(target: TargetFormat): boolean {
  return !isBinaryTarget(target) && !UNPASTEABLE_TARGETS.includes(target)
}

/**
 * Merge produces one document, so the table-extraction targets never apply:
 * csv/json write one file per table and a workbook of merged tables is better
 * served by batch.
 */
export function allowedMergeTargets(inputs: TargetValidityInput[]): TargetFormat[] {
  return allowedTargets(inputs).filter((t) => !TABLE_TARGETS.includes(t))
}
