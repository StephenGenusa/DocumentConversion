import { ConversionError } from '../errors'
import { escapeHtml } from '../shell'
import type { HubDocument, ReadContext, SourceInput } from '../types'

export type DocExtractor = (bytes: Buffer) => Promise<string>

/**
 * What one cell mark becomes. The structure is genuinely unrecoverable (see
 * DOC_TABLES_ADVICE), but "unrecoverable" is not a licence to hide the
 * boundary: dropped into a `<p>`, HTML collapses the tab to a single space and
 * "28.0 MAX" + "21.0 EXC" arrive as "28.0 MAX 21.0 EXC", with no way to tell
 * where one cell ended and the next began. A literal separator in the TEXT,
 * rather than a CSS rule, is what carries that into the CSS-less targets —
 * txt, md and docx — as well as html.
 */
export const DOC_CELL_SEPARATOR = ' | '

/**
 * Makes the cell marks on one line visible, and nothing more: no grid, no
 * column count, no header row.
 *
 * Empty cells are dropped rather than counted out. word-extractor maps the row
 * mark to "\t" as well, so the trailing tabs on "76.8 MAX\t \t \t \t \t" are a
 * row mark plus Word's padding, not five empty columns, and a separator for
 * each would be a claim about the grid that this reader has no evidence for.
 */
function markCellBoundaries(line: string): string {
  if (!isCellLine(line)) return line
  return line
    .split('\t')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
    .join(DOC_CELL_SEPARATOR)
}

/**
 * Legacy .doc yields plain text in which EVERY newline is a Word paragraph
 * mark (word-extractor maps 0x0D to a single "\n"), so splitting on blank
 * lines the way the txt reader does would collapse a whole document into one
 * paragraph. Split on every newline instead.
 */
export function docBodyToHub(text: string, filename?: string): HubDocument {
  const blocks = text
    // Word control characters (cell/field marks) are not content.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((b) => markCellBoundaries(b))
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  if (blocks.length === 0) {
    // Word 97-2003 pictures live outside the text stream, so a picture-only
    // document extracts to nothing. Say so instead of writing an empty file.
    throw new ConversionError(
      'read-failed',
      'This Word 97-2003 document has no extractable text (it may contain only images). ' +
        'Re-save it as .docx to keep its pictures.',
    )
  }
  const html = blocks.map((b) => `<p>${escapeHtml(b)}</p>`).join('\n')
  return { html, title: filename?.split(/[\\/]/).pop() }
}

/**
 * Said once when a .doc looks like it holds a table. word-extractor maps the
 * Word cell mark AND the row mark to the same character (0x07 -> "\t") and
 * surfaces none of the table flags (fTtp, sprmPFInTable, sprmPTableDepth), so
 * the structure is genuinely unrecoverable from its text API. Being honest
 * about that beats guessing at columns.
 */
export const DOC_TABLES_ADVICE =
  'This file appears to contain one or more tables. Word 97-2003 does not keep table structure in the ' +
  'text that can be read out of a .doc file, so those cells arrive as plain lines. ' +
  'Open the file in Word and re-save it as .docx to keep the tables.'

/**
 * A line whose tab has real text in front of it. A tab at the start of a line
 * is paragraph indentation, which ordinary prose uses constantly; a tab after
 * text is where Word put a cell mark.
 */
function isCellLine(line: string): boolean {
  const tab = line.indexOf('\t')
  return tab > 0 && line.slice(0, tab).trim() !== ''
}

/**
 * Conservative: a false alarm on plain prose is worse than saying nothing.
 * Fires only on a multi-column row (two or more tabs on one line) or on two
 * rows in a row. Measured against the sample documents, prose scores zero
 * cell lines and the one document with a real numeric table scores 52.
 */
export function looksLikeDocTable(text: string): boolean {
  let run = 0
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!isCellLine(line)) {
      run = 0
      continue
    }
    if ((line.match(/\t/g) ?? []).length >= 2) return true
    if (++run >= 2) return true
  }
  return false
}

/**
 * Said once when a .doc looks like it was built out of an automatically
 * numbered or bulleted list.
 *
 * Word 97-2003 keeps auto-numbering in the list tables (PlfLst/PlfLfo in the
 * table stream, reached from a paragraph through sprmPIlfo) and NOT in the text
 * stream, exactly the way .docx keeps it in word/numbering.xml. word-extractor
 * exposes only getBody/getFootnotes/getEndnotes/getHeaders/getFooters/
 * getAnnotations/getTextboxes - it never parses the list tables - so the
 * numbers and bullets are genuinely unreachable through its API. Measured on
 * the review-questions document, getBody() returns the question text with no
 * marker of any kind ("What is the primary purpose ...", then bare "Reduce
 * gaps between the shelves" / "Reduce the gap between shelves" / ...).
 * Inventing "1." and "a)" to fill the gap would be a guess about which scheme
 * the author picked and where each level restarted, so we say what is missing
 * instead - the same bargain DOC_TABLES_ADVICE strikes.
 */
export const DOC_LISTS_ADVICE =
  'This file appears to be built out of a numbered or bulleted list. Word 97-2003 keeps automatic list ' +
  'numbers and bullets outside the text that can be read out of a .doc file, so the items arrive as plain ' +
  'lines with their numbering gone. ' +
  'Open the file in Word and re-save it as .docx to keep the numbering.'

/** The advice key for the notice above; listed in ReadContext.onAdvice. */
const DOC_LISTS_ADVICE_KIND = 'doc-lists' as const

/**
 * A line that could be a list item whose marker was dropped: short, free of
 * cell marks, and not closed off like a sentence. The three filters each earn
 * their place - the tab filter hands table rows to looksLikeDocTable instead,
 * the length cap keeps running prose out, and the terminator check keeps
 * ordinary short sentences out.
 */
function isListItemLine(line: string): boolean {
  if (line.includes('\t')) return false
  const t = line.trim()
  if (t.length === 0 || t.length > 90) return false
  return !/[.;:]$/.test(t)
}

/** A marker the author typed by hand, which survives extraction: "1. ", "a) ". */
function hasTypedMarker(line: string): boolean {
  return /^(\d{1,3}[.)]|[A-Za-z][.)])\s+\S/.test(line)
}

/**
 * Conservative, in the spirit of looksLikeDocTable: a false alarm on prose is
 * worse than saying nothing, so this asks for a document that is mostly list
 * and not merely a document containing one.
 *
 * Two gates. At least three separate stacks of adjacent item-shaped lines, so a
 * title block or a single short run cannot trip it; and those stacks together
 * covering at least 40% of the non-blank lines, so the document really is a
 * list rather than prose with a list in it. Measured against the sample .doc
 * files as (stacks, coverage): the three Review Questions documents score
 * (5, 0.85), (11, 0.97) and (9, 0.50); the delta-explanation document
 * scores (3, 0.32), the loan calculations (4, 0.09), the shelving
 * instructions (2, 0.10) and the definitions list (0, 0.00) - all silent.
 *
 * The third gate is the honest one: if half or more of the candidate lines
 * already carry a typed marker then nothing was lost on the way out of the
 * file, and there is nothing to warn anybody about.
 */
export function looksLikeDocList(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const stacks: string[][] = []
  let stack: string[] = []
  for (const line of lines) {
    if (isListItemLine(line)) {
      stack.push(line.trim())
      continue
    }
    if (stack.length >= 2) stacks.push(stack)
    stack = []
  }
  if (stack.length >= 2) stacks.push(stack)
  if (stacks.length < 3) return false

  const items = stacks.flat()
  const marked = items.filter(hasTypedMarker).length
  if (marked * 2 >= items.length) return false

  const nonBlank = lines.reduce((n, l) => (l.trim().length > 0 ? n + 1 : n), 0)
  return items.length >= nonBlank * 0.4
}

/**
 * Said once when a .doc really does hold pictures, all of which were dropped.
 *
 * Word 97-2003 keeps pictures outside the text stream, and word-extractor's
 * Document exposes text and nothing else — getBody/getFootnotes/getEndnotes/
 * getHeaders/getFooters/getAnnotations/getTextboxes, with no picture accessor
 * of any kind. Worse, its `clean()` filter ends in
 * `.replace(/[\x00-\x07]/g, '')`, which DELETES the 0x01 inline-picture
 * character (and 0x08, the floating anchor) before the text is handed over, so
 * the reader is never told where a picture stood, only that words are missing.
 *
 * The picture bytes themselves are still in the file — in "Loan
 * Formulas.doc" six OfficeArt PNG blips carve out as valid images of 400x50,
 * 281x47, 264x39, 425x42, 146x41 and 372x43, the first of which is the formula
 * the sentence "That formula is as follows:" introduces. Their POSITIONS are
 * what is gone: recovering those means the FIB, the piece table and the CHPX
 * bin table, and then re-deriving offsets through word-extractor's own text
 * cleaning, which is a different program from this one. So the reader carries
 * no picture into the body — an <img> parked at a guessed spot would be the
 * fabrication DOC_TABLES_ADVICE and DOC_LISTS_ADVICE exist to avoid — and says
 * plainly what was left behind.
 */
export const DOC_IMAGES_ADVICE =
  'This file contains one or more pictures. Word 97-2003 keeps pictures outside the text that can be read ' +
  'out of a .doc file, so they are missing from the converted document. ' +
  'Open the file in Word and re-save it as .docx to keep the pictures.'

/**
 * The advice key for the notice above. NOT yet listed in ReadContext.onAdvice
 * (src/core/types.ts), which still names only 'landscape' | 'doc-tables' |
 * 'doc-lists'; adding 'doc-images' there is a one-line change, and casting
 * around it here would hide the fact that a fourth key exists.
 */
const DOC_IMAGES_ADVICE_KIND = 'doc-images' as const

/**
 * OfficeArt BLIP record types, paired with the signature the picture bytes
 * inside them begin with. Checking both is what makes this evidence rather
 * than a scan: a bare "\x89PNG" can turn up in any binary, but a record header
 * that declares a length the file can hold AND has the matching signature at a
 * blip-header offset inside it is a picture.
 */
const BLIP_RECORDS: ReadonlyArray<readonly [number, readonly number[]]> = [
  [0xf01a, [0x01, 0x00, 0x00, 0x00]], // EMF
  [0xf01b, [0x01, 0x00, 0x09, 0x00]], // WMF
  [0xf01d, [0xff, 0xd8, 0xff]], // JPEG
  [0xf01e, [0x89, 0x50, 0x4e, 0x47]], // PNG
  [0xf029, [0x49, 0x49, 0x2a, 0x00]], // TIFF
  [0xf02a, [0xff, 0xd8, 0xff]], // JPEG, CMYK
]

/** Record header: 2 bytes of ver/instance, 2 of type, 4 of length. */
const BLIP_HEADER = 8
/**
 * A blip's own header is one or two 16-byte UIDs plus a tag byte for a bitmap
 * (so the image starts at 17 or 33), or that plus a 34-byte metafile header
 * (50 or 66). The signature therefore sits 17 to 66 bytes into the record
 * data — never at the front, which is what rules out a stray signature that
 * merely happens to sit near a matching pair of bytes.
 */
const BLIP_SIGNATURE_MIN = 17
const BLIP_SIGNATURE_MAX = 66
/** Smaller than this is not a picture; it is a coincidence. */
const BLIP_MIN_LENGTH = 64

/**
 * How many embedded pictures the file actually holds. Conservative in the same
 * direction as looksLikeDocTable: a record split across CFB sectors is missed
 * and nothing is said, which is far better than telling someone pictures were
 * lost from a document that never had any.
 *
 * Measured across the sample documents: the loan calculations score 6 (six
 * PNG formulas) and the shelving instructions score 1 (a JPEG logo); the five
 * prose documents and every .docx in the corpus score 0 — a .docx keeps its
 * media as plain zip entries with no OfficeArt record around them.
 */
export function countEmbeddedPictures(bytes: Buffer): number {
  let count = 0
  for (const [type, signature] of BLIP_RECORDS) {
    const marker = Buffer.from([type & 0xff, type >> 8])
    const sig = Buffer.from(signature)
    for (let at = 0; at < bytes.length; ) {
      const found = bytes.indexOf(marker, at)
      if (found < 0) break
      at = found + 1
      // The two ver/instance bytes come first, so a hit in the first two bytes
      // of the file cannot be a record header — skip it, don't stop looking.
      const start = found - 2
      if (start < 0 || start + BLIP_HEADER + BLIP_MIN_LENGTH > bytes.length) continue
      const length = bytes.readUInt32LE(start + 4)
      if (length < BLIP_MIN_LENGTH || start + BLIP_HEADER + length > bytes.length) continue
      const window = Math.min(BLIP_SIGNATURE_MAX + sig.length, length)
      const sigAt = bytes.subarray(start + BLIP_HEADER, start + BLIP_HEADER + window).indexOf(sig)
      if (sigAt < BLIP_SIGNATURE_MIN || sigAt > BLIP_SIGNATURE_MAX) continue
      count++
      at = start + BLIP_HEADER + length
    }
  }
  return count
}

const defaultExtractor: DocExtractor = async (bytes) => {
  const mod = await import('word-extractor')
  const WordExtractor = ((mod as unknown as { default?: unknown }).default ?? mod) as new () => {
    extract(input: Buffer): Promise<{ getBody(): string }>
  }
  const doc = await new WordExtractor().extract(bytes)
  return doc.getBody()
}

/**
 * Legacy Word (.doc). Recorded fidelity: text and paragraph breaks only —
 * headings, tables, list numbering, and inline formatting are not recovered.
 * When the text looks like it came out of a table, or out of an automatically
 * numbered list, or when the file holds pictures none of which can reach the
 * output, say so instead of pretending otherwise. The three notices are
 * independent: a document can honestly earn all of them, and the shelving
 * instructions earn two.
 */
export async function readDoc(
  src: SourceInput,
  ctx?: ReadContext,
  extractor: DocExtractor = defaultExtractor,
): Promise<HubDocument> {
  let text: string
  try {
    text = await extractor(src.bytes)
  } catch (err) {
    throw new ConversionError('read-failed', `Could not read legacy Word document: ${(err as Error).message}`)
  }
  const hub = docBodyToHub(text, src.filename)
  if (looksLikeDocTable(text)) ctx?.onAdvice?.('doc-tables', DOC_TABLES_ADVICE)
  if (looksLikeDocList(text)) ctx?.onAdvice?.(DOC_LISTS_ADVICE_KIND, DOC_LISTS_ADVICE)
  if (countEmbeddedPictures(src.bytes) > 0) ctx?.onAdvice?.(DOC_IMAGES_ADVICE_KIND, DOC_IMAGES_ADVICE)
  return hub
}
