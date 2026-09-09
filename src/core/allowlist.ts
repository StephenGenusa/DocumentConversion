import sanitizeHtml from 'sanitize-html'

/**
 * Single source of truth for what the hub allows. The TipTap editor schema
 * (renderer) must model every one of these tags — the invariant is:
 * any HTML the sanitizer passes must round-trip the editor losslessly.
 */
export const HUB_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'pre',
  'code',
  'blockquote',
  'hr',
  'img',
  'a',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'br',
  'span',
  'div',
  // Speaker notes. Without this the sanitiser stripped the tag and kept its
  // text, so a note leaked into the body of an ordinary conversion as a loose
  // run of words. See src/core/speaker-notes.ts.
  'aside',
]

export function hubSanitizeOptions(): sanitizeHtml.IOptions {
  return {
    allowedTags: HUB_TAGS,
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      code: ['class'],
      pre: ['class'],
    },
    // Text inside these is metadata or code, not content: without this the
    // <title> of an HTML page leaked into the body above its own <h1>.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'title', 'head', 'noframes'],
    allowedSchemes: ['http', 'https', 'mailto'],
    // data: URIs are allowed on img only — inlined clipboard/email/URL images.
    allowedSchemesByTag: { img: ['data', 'http', 'https'] },
  }
}

/**
 * Characters HTML carries happily and XML forbids outright: the C0 controls
 * other than tab, newline and carriage return, the two non-characters at the
 * end of the BMP, and any unpaired surrogate. They arrive in real documents —
 * a stray U+0008 or U+001A out of a legacy export, a `&#11;` in a pasted page —
 * and the hub hands them straight to the docx and epub writers, both of which
 * emit XML. Word and every epub reader then refuse the whole file rather than
 * skip the character.
 *
 * Stripped twice on purpose. Here, so a reader that sanitises gets a clean
 * result; and in `convert.ts` `read()`, because most readers never call this
 * function — txt, csv, code, pdf, rst, the ODF readers — and "the one boundary
 * every writer is downstream of" is there, not here.
 */
const XML_ILLEGAL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function stripXmlIllegal(text: string): string {
  return text.replace(XML_ILLEGAL, '')
}

export function sanitizeToHub(html: string): string {
  const clean = sanitizeHtml(html, hubSanitizeOptions())
  // An <img> whose src used a scheme we don't allow (cid:, file:) comes back
  // with no src at all. Such an element carries nothing and made the docx
  // writer throw, so drop it — keeping its alt text where there is any.
  const withoutBlindImages = clean.replace(/<img\b(?![^>]*\bsrc=)[^>]*>/gi, (tag) => {
    const alt = /\balt="([^"]*)"/i.exec(tag)?.[1]?.trim()
    return alt ? `<span>[${alt}]</span>` : ''
  })
  // Last, so it covers text, attribute values and anything the rewrite above
  // moved between the two. The sanitizer decodes `&#x8;` to the raw character,
  // so both spellings land here.
  return stripXmlIllegal(withoutBlindImages)
}
