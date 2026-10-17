import { EXTENSION_FORMATS } from './extensions'
import type { SourceFormat } from './types'

/**
 * The start screen's list of what the app reads, built from the detector's
 * own extension table (extensions.ts), so a format the detector learns is on
 * the list the same day.
 *
 * Ordered by how often each is actually wanted, not alphabetically or by the
 * order of SOURCE_FORMATS: pdf and Word lead because that is what people come
 * here to convert. Every extension the app takes is shown (so nobody has to
 * guess whether .htm or .pptm will be taken), the usual name first.
 * A format missing from ORDER still appears, at the end.
 */
const ORDER: { formats: SourceFormat[]; label?: string }[] = [
  { formats: ['pdf'] },
  { formats: ['docx', 'doc'] },
  { formats: ['md'] },
  { formats: ['html'] },
  { formats: ['txt'] },
  { formats: ['xlsx'] },
  { formats: ['pptx'] },
  { formats: ['eml', 'msg', 'mbox'] },
  { formats: ['epub'] },
  { formats: ['odt', 'odp'] },
  { formats: ['rtf'] },
  { formats: ['csv'] },
  { formats: ['json'] },
  { formats: ['image'], label: 'images' },
  { formats: ['svg', 'metafile'] },
  { formats: ['ipynb'] },
  // Over a hundred names (code-langs.ts): a word, not a list.
  { formats: ['code'], label: 'source code' },
  { formats: ['ics'] },
  { formats: ['vcard'] },
  { formats: ['subtitles'], label: 'subtitles' },
  { formats: ['asciidoc', 'rst'] },
  { formats: ['djot'] },
  { formats: ['textile'] },
  { formats: ['opml'] },
  { formats: ['sqlite'] },
]

/**
 * Names a format is taken under that are not in the extension table: a .db
 * is a SQLite database by its first bytes only (detect.ts), since the name is
 * shared by too many other formats to decide by.
 */
const BY_CONTENT: Partial<Record<SourceFormat, string[]>> = { sqlite: ['db'] }

export interface InputFormatGroup {
  formats: SourceFormat[]
  extensions: string[]
  /** As shown: the extensions joined by "/", or a word before them in parentheses. */
  text: string
}

function extensionsOf(format: SourceFormat): string[] {
  // In the table's order, which puts the usual name first (docx before docm, adoc before asciidoc).
  const exts = [...EXTENSION_FORMATS].filter(([, f]) => f === format).map(([ext]) => ext)
  return [...exts, ...(BY_CONTENT[format] ?? [])]
}

export const INPUT_FORMAT_GROUPS: InputFormatGroup[] = (() => {
  const known = new Set(EXTENSION_FORMATS.values())
  const groups = [...ORDER]
  for (const format of known) if (!groups.some((g) => g.formats.includes(format))) groups.push({ formats: [format] })
  return groups.map(({ formats, label }) => {
    const extensions = formats.flatMap(extensionsOf)
    const list = extensions.join('/')
    const text = !label ? list : extensions.length ? `${label} (${list})` : label
    return { formats, extensions, text }
  })
})()

/** The line as the start screen shows it; archives last, as they are not a format. */
export function inputFormatHint(): string {
  return [...INPUT_FORMAT_GROUPS.map((g) => g.text), 'zip'].join(' · ')
}
