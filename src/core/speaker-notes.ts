/**
 * Speaker notes: how they enter the hub, and how they are kept out of ordinary
 * output.
 *
 * Markdown has no notes syntax, so every tool that supports them agrees on an
 * HTML comment. The hub sanitiser drops comments outright, so a note written
 * that way is gone before any writer sees it — which is why the slides design
 * originally listed notes as out of scope.
 *
 * They are carried as `<aside>` instead. Two things had to be true for that to
 * be safe, and neither was:
 *
 *  1. `aside` had to join HUB_TAGS. Before that the sanitiser stripped the tag
 *     and KEPT ITS TEXT, so a note leaked into the converted body as a loose
 *     run of words with nothing marking it as a note. That is the silent
 *     gluing class section 0 of remaining_work.md calls the worst bug here.
 *  2. Every writer that is not a slides writer had to drop them. That happens
 *     once, at the write boundary in `convert.ts`, rather than in each of the
 *     nine writers — the same reasoning as the XML-illegal strip that lives
 *     there.
 *
 * Adding a tag to HUB_TAGS obliges it to round-trip the TipTap editor
 * losslessly (see allowlist.ts). `SpeakerNotes` in the renderer's editor
 * extensions is that half, and `tests/renderer/editor-round-trip.test.ts`
 * holds it to it.
 */

/** The element notes live in inside the hub. */
export const SPEAKER_NOTES_TAG = 'aside'

/**
 * `<!-- notes: ... -->` in any of the spellings people write it.
 *
 * Deliberately not global-flagged in the source; a fresh RegExp is built per
 * call because `lastIndex` on a shared global regex is a classic source of
 * every-other-call bugs.
 */
const NOTES_COMMENT = /<!--\s*notes\s*:\s*([\s\S]*?)\s*-->/gi

/** Text to HTML text. Notes are prose, never markup. */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Lift notes comments into hub elements. Run BEFORE `sanitizeToHub`, which is
 * what drops the comments.
 *
 * Comments that are not notes are left exactly as they were, so the sanitiser
 * disposes of them as it always did.
 */
export function notesToHub(html: string): string {
  return html.replace(
    NOTES_COMMENT,
    (_m, body: string) => `<${SPEAKER_NOTES_TAG}>${escape(body)}</${SPEAKER_NOTES_TAG}>`,
  )
}

/**
 * Remove notes and everything inside them.
 *
 * Applied at the write boundary for every target that is not a slides target.
 * Removing the element but not its text would reintroduce exactly the leak this
 * whole mechanism exists to prevent, so the content goes with the tag.
 */
export function stripSpeakerNotes(html: string): string {
  return html.replace(
    new RegExp(`<${SPEAKER_NOTES_TAG}\\b[^>]*>[\\s\\S]*?</${SPEAKER_NOTES_TAG}>`, 'gi'),
    '',
  )
}

/** Whether a document carries any notes at all. */
export function hasSpeakerNotes(html: string): boolean {
  return new RegExp(`<${SPEAKER_NOTES_TAG}\\b`, 'i').test(html)
}
