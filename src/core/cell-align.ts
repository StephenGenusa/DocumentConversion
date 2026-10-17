/*
 * A table cell's alignment: a column of numbers lined up on the right, a
 * check mark centered. The hub keeps it on each `<th>`/`<td>` as
 * `style="text-align:left|center|right"`, the form markdown-it writes for a
 * pipe table's `:---:` markers, and keeps nothing else of a cell's style. Like
 * a highlight's color (mark.ts), the style is always rebuilt here from the
 * alignment alone, so the sanitizer, the readers that write the hub
 * themselves (docx, odt) and the editor all write it byte for byte alike.
 *
 * Justified text is not kept: in a cell it is left aligned in every output
 * but Word, and no writer outside Word has a way to say it.
 */

export type CellAlign = 'left' | 'center' | 'right'

const ALIGNS: ReadonlySet<string> = new Set(['left', 'center', 'right'])

/** Every `text-align` declaration in a style; CSS takes the last. */
const TEXT_ALIGN = /(?:^|;)\s*text-align\s*:\s*([^;]*)/gi

/**
 * A cell's alignment from its style, else from the legacy `align` attribute
 * (HTML 4, old mail and old readers). A style's `text-align` that is no
 * alignment the hub keeps (justify, a var()) wins over the attribute all the
 * same, as it does in a browser: the cell then has none.
 */
export function cellAlign(style: string | undefined, align?: string): CellAlign | undefined {
  const declared = style ? [...style.matchAll(TEXT_ALIGN)].pop()?.[1] : undefined
  const value = (declared ?? align)?.replace(/!\s*important\s*$/i, '').trim().toLowerCase()
  return value !== undefined && ALIGNS.has(value) ? (value as CellAlign) : undefined
}

/** The hub's style for a cell of this alignment. */
export function cellAlignStyle(align: CellAlign): string {
  return `text-align:${align}`
}

/**
 * A paragraph alignment as Word (`w:jc`) or LibreOffice (`fo:text-align`)
 * writes it, as the hub's. Start and end are taken as left and right: the
 * hub has no direction of its own, and a right-to-left table is rare enough
 * that guessing it from the paragraph is not worth getting the common case
 * wrong. Justified, distributed and the rest are none.
 */
export function paragraphAlign(value: string | undefined): CellAlign | 'none' {
  switch (value) {
    case 'left':
    case 'start':
      return 'left'
    case 'center':
      return 'center'
    case 'right':
    case 'end':
      return 'right'
    default:
      return 'none'
  }
}

/**
 * A cell's alignment from the alignment of each paragraph in it: the one they
 * all share, or none when they differ or there are none.
 */
export function sharedAlign(aligns: Array<CellAlign | 'none'>): CellAlign | undefined {
  const first = aligns[0]
  if (first === undefined || first === 'none') return undefined
  return aligns.every((a) => a === first) ? first : undefined
}
