import { splitSlides, type SplitOn } from '../slides'
import { footnotesForOutput } from '../footnotes'
import { escapeHtml, highlightCodeBlocks, markTaskLists } from '../shell'
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

/**
 * A slide fitted to the slide: a document's section is cut into a slide as
 * it is, and a long one ran off the bottom (and a wide table off the side)
 * with no way to see the rest. When a slide is shown, its text is made
 * smaller in steps until it fits, down to 40%, its pictures with it; one that
 * still does not fit scrolls. A slide that fits is left as written. Pictures
 * are decoded first, so their height is counted.
 */
export const FIT_SLIDES_JS = `(function () {
  var W = 960, H = 700
  function fit(slide) {
    if (!slide || slide.getAttribute('data-fitted')) return
    slide.setAttribute('data-fitted', '1')
    var imgs = slide.querySelectorAll('img')
    var size = 100
    function apply() {
      slide.style.fontSize = size === 100 ? '' : size + '%'
      for (var i = 0; i < imgs.length; i++) if (!imgs[i].hasAttribute('data-rendered') || imgs[i].getAttribute('data-rendered') !== 'formula') imgs[i].style.maxHeight = Math.round(0.7 * H * size / 100) + 'px'
    }
    apply()
    while ((slide.scrollHeight > H || slide.scrollWidth > W) && size > 40) { size -= 5; apply() }
    if (slide.scrollHeight > H) { slide.style.height = H + 'px'; slide.style.overflowY = 'auto' }
    Reveal.layout()
  }
  function when(slide) {
    var imgs = slide ? slide.querySelectorAll('img') : []
    var ready = []
    for (var i = 0; i < imgs.length; i++) if (imgs[i].decode) ready.push(imgs[i].decode().catch(function () {}))
    Promise.all(ready).then(function () { fit(slide) })
  }
  Reveal.on('ready', function (e) { when(e.currentSlide) })
  Reveal.on('slidechanged', function (e) { when(e.currentSlide) })
})();`

/**
 * The theme draws every picture in a slide as a framed block of its own. A
 * formula in a sentence was torn out of its line, and the line broken around
 * it; a drawn diagram got a frame it does not have anywhere else. Pictures
 * sit centered without a frame; a formula stays in its line, a display one
 * centered on its own.
 */
export const DECK_CSS = `
  .reveal section img { border: 0; background: none; margin: 0.4em auto; }
  .reveal section img[data-rendered="formula"] { display: inline; margin: 0; }
  .reveal ul.task-list { list-style: none; }
`

/** reveal expects `<aside class="notes">`; the hub carries a bare `<aside>`. */
function notesMarkup(notes: string[]): string {
  if (notes.length === 0) return ''
  return `<aside class="notes">${notes.join('')}</aside>`
}

export async function writeRevealJs(doc: HubDocument, opts?: ConvertOptions): Promise<Buffer> {
  // A deck has no notes pane of its own; the notes are the last slide's text.
  const slides = splitSlides(markTaskLists(footnotesForOutput(doc.html, 'plain')), { splitOn: (opts?.slides?.splitOn as SplitOn) ?? 'auto' })
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
<style>${DECK_CSS}</style>
${colored ? `<style>${codeCss(REVEAL_CSS)}</style>\n` : ''}</head>
<body>
<div class="reveal"><div class="slides">
${sections}
</div></div>
<script>${REVEAL_JS}</script>
<script>${REVEAL_NOTES_PLUGIN}</script>
<script>
Reveal.initialize({ hash: true, slideNumber: 'c/t', width: 960, height: 700, plugins: [ RevealNotes ] });
${FIT_SLIDES_JS}
</script>
</body>
</html>
`,
    'utf8',
  )
}
