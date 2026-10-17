/**
 * A code block's language, kept in a Word file as a hidden bookmark around
 * the block: `_DocConvCode_<n>_<language>`. Word keeps no language of its
 * own, so without it the docx reader could only guess (code-language.ts).
 *
 * A bookmark rather than the alternatives: Word hides one whose name starts
 * with `_` from its Bookmarks dialog (as it does its own `_Toc`, `_Ref`), shows
 * nothing in the text, and keeps it through editing and saving, as LibreOffice
 * does; it travels with the block when the block is moved, and goes when the
 * block is deleted. A content control shows its handles when hovered (and
 * LibreOffice reads them imperfectly), a paragraph style holds no value of
 * its own and is restyled by users, and a document variable is global, so
 * it would map block numbers to languages and break when a block is added.
 *
 * Bookmark names are at most 40 letters, digits and underscores, and must be
 * unique: `n` makes them so, and the language is spelled with each character
 * other than a-z and 0-9 as `_` and two hex digits (`c++` is `c_2b_2b`).
 */

export const CODE_BOOKMARK_PREFIX = '_DocConvCode_'

const MAX_NAME = 40

/** The hub's language token (allowlist.ts keeps `language-[\w+-]+`). */
const LANGUAGE = /^[\w+-]+$/

/** The bookmark name for block `n` in `language`, or undefined when it cannot be one (too long, not a language token). */
export function codeBookmarkName(n: number, language: string): string | undefined {
  if (!LANGUAGE.test(language)) return undefined
  const spelled = language.replace(/[^a-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
  const name = `${CODE_BOOKMARK_PREFIX}${n}_${spelled}`
  return name.length <= MAX_NAME ? name : undefined
}

const NAME = /^_DocConvCode_\d+_((?:[a-z0-9]|_[0-9a-f]{2})+)$/i

/** The language a bookmark name records, or undefined when it is not one of ours or is garbled. */
export function codeBookmarkLanguage(name: string): string | undefined {
  const spelled = NAME.exec(name)?.[1]
  if (!spelled) return undefined
  const language = spelled.replace(/_([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  return LANGUAGE.test(language) ? language : undefined
}
