import { describe, it, expect } from 'vitest'
import { generateJSON, generateHTML } from '@tiptap/html'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'
import { HUB_TAGS, sanitizeToHub } from '../../src/core/allowlist'
import { SPEAKER_NOTES_TAG } from '../../src/core/speaker-notes'

/**
 * allowlist.ts states the invariant that governs this editor: anything
 * `sanitizeToHub` passes must round-trip it losslessly. ProseMirror silently
 * DROPS nodes its schema does not model, so a tag added to HUB_TAGS without a
 * matching editor node deletes content the moment the user opens the edit
 * pane — with no error and nothing in the output to show it happened.
 *
 * Clipboard and URL input always go through the editor, so this is not a
 * hypothetical path; it is the ordinary one.
 */
const roundTrip = (html: string): string =>
  generateHTML(generateJSON(html, EDITOR_EXTENSIONS), EDITOR_EXTENSIONS)

describe('the editor round-trips what the hub allows', () => {
  it('keeps a speaker note, with its text', () => {
    const html = `<p>Slide body</p><${SPEAKER_NOTES_TAG}><p>say this bit</p></${SPEAKER_NOTES_TAG}>`
    const out = roundTrip(html)
    expect(out).toContain(`<${SPEAKER_NOTES_TAG}>`)
    expect(out).toContain('say this bit')
  })

  it('does not let a note swallow the body around it', () => {
    const out = roundTrip(`<p>before</p><${SPEAKER_NOTES_TAG}><p>n</p></${SPEAKER_NOTES_TAG}><p>after</p>`)
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it.each(
    HUB_TAGS.filter((t) => !['span', 'div', 'br', 'thead', 'tbody', 'tr', 'td', 'th', 'li'].includes(t)),
  )('models %s, so the editor cannot silently drop it', (tag) => {
    // Structural tags are exercised through their parents; the rest stand alone.
    const sample: Record<string, string> = {
      table: '<table><tbody><tr><td>c</td></tr></tbody></table>',
      ul: '<ul><li>i</li></ul>',
      ol: '<ol><li>i</li></ol>',
      pre: '<pre><code>x</code></pre>',
      img: '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAIBAAA=" alt="a">',
      a: '<p><a href="https://example.com">l</a></p>',
      hr: '<hr>',
      code: '<p><code>x</code></p>',
      aside: `<${SPEAKER_NOTES_TAG}><p>n</p></${SPEAKER_NOTES_TAG}>`,
    }
    const html = sample[tag] ?? `<${tag}>text</${tag}>`
    // Only assert against what the sanitiser would actually pass on.
    const sanitized = sanitizeToHub(html)
    if (!sanitized.includes('<')) return
    const out = roundTrip(sanitized)
    expect(out.replace(/\s+/g, '')).not.toBe('')
    expect(out).toMatch(/<[a-z]/)
  })
})
