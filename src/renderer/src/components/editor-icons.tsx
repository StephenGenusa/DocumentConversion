/**
 * Toolbar icons, drawn inline.
 *
 * Deliberately not an icon package. This app is offline-first and the renderer
 * bundle is already 1.5 MB with a size warning nobody has examined, so a new
 * runtime dependency for fifteen glyphs is a poor trade. An icon FONT is out of
 * the question outright: a missing glyph renders as a tofu box, which is the
 * exact failure this project has already chased through its own OCR fixtures.
 *
 * Bold, italic, underline and strikethrough are NOT here. They are letterforms
 * in the toolbar itself, because that is what every editor does and a drawn "B"
 * reads worse than a bold B.
 */
const svg = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const

/** The three rules a list icon is built from: one per line of "text". */
const LIST_LINES = 'M6 4h8M6 8h8M6 12h8'

export function IconCode(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M5.5 4 2 8l3.5 4" />
      <path d="M10.5 4 14 8l-3.5 4" />
    </svg>
  )
}

export function IconBulletList(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d={LIST_LINES} />
      {[4, 8, 12].map((y) => (
        <circle key={y} cx="2.6" cy={y} r="1" fill="currentColor" stroke="none" />
      ))}
    </svg>
  )
}

export function IconOrderedList(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d={LIST_LINES} />
      {['1', '2', '3'].map((n, i) => (
        <text
          key={n}
          x="0.2"
          y={6 + i * 4}
          fontSize="5.5"
          fontFamily="inherit"
          fill="currentColor"
          stroke="none"
        >
          {n}
        </text>
      ))}
    </svg>
  )
}

/**
 * A pair of quotation marks. Drawn filled rather than stroked: the first
 * attempt was the blockquote's own rendering — a heavy left rule beside three
 * lines of text — and at 16px that is indistinguishable from an align icon.
 */
export function IconQuote(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path
        fill="currentColor"
        stroke="none"
        d="M2.6 3.6h3.9v3.6c0 2.2-1.3 3.7-3.6 4.4l-.7-1.5c1.3-.4 2.1-1.1 2.2-2.2H2.6z"
      />
      <path
        fill="currentColor"
        stroke="none"
        d="M9.5 3.6h3.9v3.6c0 2.2-1.3 3.7-3.6 4.4l-.7-1.5c1.3-.4 2.1-1.1 2.2-2.2H9.5z"
      />
    </svg>
  )
}

export function IconLink(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M6.9 9.1a2.75 2.75 0 0 0 3.9 0l2-2a2.75 2.75 0 0 0-3.9-3.9l-.8.8" />
      <path d="M9.1 6.9a2.75 2.75 0 0 0-3.9 0l-2 2a2.75 2.75 0 0 0 3.9 3.9l.8-.8" />
    </svg>
  )
}

export function IconTable(): React.JSX.Element {
  return (
    <svg {...svg}>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M2 6.5h12M6.7 6.5V13M11.3 6.5V13" />
    </svg>
  )
}

export function IconRule(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M2 8h12" />
    </svg>
  )
}

export function IconUndo(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M2.5 6.5h7.25a3.25 3.25 0 1 1 0 6.5H7.5" />
      <path d="M5.5 3.5 2.5 6.5l3 3" />
    </svg>
  )
}

export function IconRedo(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M13.5 6.5H6.25a3.25 3.25 0 1 0 0 6.5H8.5" />
      <path d="M10.5 3.5 13.5 6.5l-3 3" />
    </svg>
  )
}

/** "Clear formatting": a letter T with the conventional cross beside it. */
export function IconClear(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M2 4V3h7.5v1" />
      <path d="M5.75 3.2v9.6" />
      <path d="M4 12.8h3.5" />
      <path d="M10.5 9.5 14.5 13.5M14.5 9.5 10.5 13.5" />
    </svg>
  )
}
