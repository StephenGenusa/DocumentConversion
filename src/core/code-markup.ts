/**
 * A code block colored by its language without losing the author's markup.
 *
 * The html reader keeps an author's bold, italic and links inside a `<pre>`
 * (code-language.ts KEPT_IN_CODE): rustdoc and javadoc link every type name to
 * its page. highlight.js colors plain text, so coloring such a block from its
 * text printed the colors and dropped the links. Here the two are laid over
 * each other, as highlight.js's own mergeStreams did before v11: both are a
 * tree of tags over the same text, so each becomes a list of open and close
 * events at text offsets, and the lists are walked together. The author's
 * tags are the outer ones; a token span that an author's tag opens or closes
 * inside is closed before it and opened again after it, so the result nests.
 */
import hljs from './hljs'
import { codeBlockText, decodeEntities, KEPT_IN_CODE } from './code-language'

interface TagEvent {
  /** Offset in the code's text. */
  at: number
  /** The tag as written: `<a href="…">` or `</a>`. */
  tag: string
  /** The element's name, for the matching close. */
  name: string
  open: boolean
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The tags of `html` as events over its text, only those `keep` names. A
 * `<br>` is the newline it draws (codeBlockText reads it so), and any other
 * tag gives up its text, as it does when the block is colored from its text.
 */
function eventsOf(html: string, keep: (name: string) => boolean): { text: string; events: TagEvent[] } {
  let text = ''
  const events: TagEvent[] = []
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*>|[^<]+|</g)) {
    if (m[2] === undefined) {
      text += decodeEntities(m[0])
      continue
    }
    const name = m[2].toLowerCase()
    if (name === 'br') text += '\n'
    else if (keep(name)) events.push({ at: text.length, tag: m[0], name, open: m[1] === '' })
  }
  return { text, events }
}

/**
 * The two event lists over `text` as one tree. At one offset an author's tag
 * goes first, unless a token span closes there (closing it first keeps it out
 * of the tag that opens).
 */
function merge(text: string, authored: TagEvent[], tokens: TagEvent[]): string {
  let out = ''
  let done = 0
  let a = 0
  let t = 0
  const open: TagEvent[] = []
  const closeOf = (e: TagEvent): string => `</${e.name}>`
  while (a < authored.length || t < tokens.length) {
    const fromAuthor =
      t >= tokens.length || (a < authored.length && (authored[a].at < tokens[t].at || (authored[a].at === tokens[t].at && tokens[t].open)))
    const at = fromAuthor ? authored[a].at : tokens[t].at
    out += escape(text.slice(done, at))
    done = at
    if (fromAuthor) {
      for (let i = open.length - 1; i >= 0; i--) out += closeOf(open[i])
      do out += authored[a++].tag
      while (a < authored.length && authored[a].at === done)
      for (const e of open) out += e.tag
    } else {
      const e = tokens[t++]
      if (e.open) open.push(e)
      else open.pop()
      out += e.tag
    }
  }
  return out + escape(text.slice(done))
}

/**
 * A code block's body (hub HTML) highlighted as `language`, which
 * highlight.js must know: its token spans, and the author's inline markup
 * kept around them. Line breaks come out as newlines.
 */
export function highlightMarkup(body: string, language: string): string {
  const { value } = hljs.highlight(codeBlockText(body), { language })
  if (!/<(?!br\b)[a-z]/i.test(body)) return value
  const authored = eventsOf(body, (name) => KEPT_IN_CODE.has(name))
  if (!authored.events.length) return value
  const tokens = eventsOf(value, (name) => name === 'span')
  // Both read the same text; should they ever not, the colors win, as before.
  if (tokens.text !== authored.text) return value
  return merge(authored.text, authored.events, tokens.events)
}
