import { splitSlides, type SplitOn } from '../slides'
import { footnotesForOutput } from '../footnotes'
import { escapeHtml, highlightCodeBlocks } from '../shell'
import { DARK_CODE_GROUND, DARK_CODE_TEXT, HLJS_CSS, HLJS_DARK_CSS } from '../hljs'
import { relativeLuminance } from '../css-color'
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

/**
 * Code is colored here, as static hljs spans styled by class, not by reveal's
 * highlight plugin: that colors in the browser and brings its own theme, and
 * this deck must open as it is. The palette follows the slide: on a light one
 * (the `simple` theme that ships is white with black text) the screen palette
 * the html and pdf share (GitHub light), on that palette's faint ground so the
 * block reads as code beside the slide's prose; on a dark one, GitHub dark on
 * its dark ground: the light palette's dark colors sink into a black slide,
 * and its pale block glares on one. Plain text and the blocks that are
 * drawn (formulas, diagrams) are left as they came; the notes are words for
 * the speaker and are not colored.
 */
const LEFT_AS_IS = ['plaintext', 'text', 'math', 'mermaid', 'dot']

/**
 * The code palette for a deck in this theme's CSS: dark when the slide's
 * `--r-background-color` is (black text reads worse on it than white, below
 * a luminance of about 0.18), light otherwise, and light when it names no
 * color that can be read (a var(), a gradient).
 */
export function codeCss(themeCss: string): string {
  const declared = [...themeCss.matchAll(/--r-background-color:\s*([^;}]+)/g)].pop()?.[1]
  const luminance = declared === undefined ? undefined : relativeLuminance(declared)
  // Where white text and black text contrast equally: (1 + 0.05) / (L + 0.05) = (L + 0.05) / 0.05.
  const dark = luminance !== undefined && luminance < Math.sqrt(1.05 * 0.05) - 0.05
  return dark
    ? `
  .reveal pre code.hljs { background: ${DARK_CODE_GROUND}; color: ${DARK_CODE_TEXT}; }
${HLJS_DARK_CSS}`
    : `
  .reveal pre code.hljs { background: #f6f8fa; color: #24292f; }
${HLJS_CSS}`
}

/** reveal expects `<aside class="notes">`; the hub carries a bare `<aside>`. */
function notesMarkup(notes: string[]): string {
  if (notes.length === 0) return ''
  return `<aside class="notes">${notes.join('')}</aside>`
}

export async function writeRevealJs(doc: HubDocument, opts?: ConvertOptions): Promise<Buffer> {
  // A deck has no notes pane of its own; the notes are the last slide's text.
  const slides = splitSlides(footnotesForOutput(doc.html, 'plain'), { splitOn: (opts?.slides?.splitOn as SplitOn) ?? 'auto' })
  const title = doc.title?.trim() || doc.sourceName?.trim() || 'Presentation'

  let colored = false
  /*
   * An empty deck still has to be a valid document. Emitting a file with no
   * <section> gives reveal nothing to show and looks like a corrupted export,
   * so say what happened instead.
   */
  const sections =
    slides.length > 0
      ? slides
          .map((s) => {
            const code = opts?.codeColor === false ? { html: s.html, any: false } : highlightCodeBlocks(s.html, { skip: LEFT_AS_IS })
            colored ||= code.any
            return `<section>${code.html}${notesMarkup(s.notes)}</section>`
          })
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
${colored ? `<style>${codeCss(REVEAL_CSS)}</style>\n` : ''}</head>
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
