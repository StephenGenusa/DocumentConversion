import { splitSlides, type SplitOn } from '../slides'
import { escapeHtml } from '../shell'
import { REVEAL_CSS, REVEAL_JS, REVEAL_NOTES_PLUGIN, REVEAL_VERSION } from '../assets/reveal.generated'
import type { ConvertOptions, HubDocument } from '../types'

/**
 * A reveal.js deck as one self-contained HTML file.
 *
 * Everything is inlined - engine, CSS, notes plugin - because the file has to
 * open with no network and no sibling directory. That is the same promise the
 * rest of the app makes, and a deck that silently needs a CDN would break it in
 * the one place a user is least able to notice: on stage.
 *
 * Roughly 240 KB of runtime per deck. Most of that is unavoidable if reveal is
 * the engine; the one saving taken is the theme, `simple` at 5 KB rather than
 * the stock `white` at 561 KB, which embeds a webfont as base64.
 *
 * Images are already data URIs by the time the hub reaches a writer, so a deck
 * with pictures is still one file.
 */

/** reveal expects `<aside class="notes">`; the hub carries a bare `<aside>`. */
function notesMarkup(notes: string[]): string {
  if (notes.length === 0) return ''
  return `<aside class="notes">${notes.join('')}</aside>`
}

export async function writeRevealJs(doc: HubDocument, opts?: ConvertOptions): Promise<Buffer> {
  const slides = splitSlides(doc.html, { splitOn: (opts?.slides?.splitOn as SplitOn) ?? 'auto' })
  const title = doc.title?.trim() || doc.sourceName?.trim() || 'Presentation'

  /*
   * An empty deck still has to be a valid document. Emitting a file with no
   * <section> gives reveal nothing to show and looks like a corrupted export,
   * so say what happened instead.
   */
  const sections =
    slides.length > 0
      ? slides
          .map((s) => `<section>${s.html}${notesMarkup(s.notes)}</section>`)
          .join('\n')
      : '<section><p>This document had no content to put on a slide.</p></section>'

  return Buffer.from(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<!-- reveal.js ${REVEAL_VERSION}, MIT, (C) Hakim El Hattab and contributors -->
<style>${REVEAL_CSS}</style>
</head>
<body>
<div class="reveal"><div class="slides">
${sections}
</div></div>
<script>${REVEAL_JS}</script>
<script>${REVEAL_NOTES_PLUGIN}</script>
<script>
Reveal.initialize({ hash: true, slideNumber: 'c/t', plugins: [ RevealNotes ] });
</script>
</body>
</html>
`,
    'utf8',
  )
}
