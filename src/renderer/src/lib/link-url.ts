/**
 * The schemes the hub sanitizer passes on an `<a href>`. Kept literal rather
 * than imported from `allowlist.ts` so the renderer does not pull
 * `sanitize-html` into its bundle; the test asserts the two agree.
 */
const ALLOWED = ['http:', 'https:', 'mailto:']

/**
 * Validate and canonicalise a URL typed into the editor's link field.
 *
 * Returns null for anything the hub would strip, so the toolbar can refuse it
 * with a message instead of writing a dead — or dangerous — href into the
 * document. This is a real boundary: edited HTML goes from the editor to the
 * writers with only `stripXmlIllegal()` in between, so a `javascript:` href
 * accepted here would survive into the output.
 *
 * A bare host is promoted to https, because that is what people type.
 */
export function normalizeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Only a well-formed scheme counts as one. Anything else — including the
  // "java\tscript:" spellings that browsers used to tolerate — is treated as a
  // hostname, so it ends up https-prefixed and harmless rather than accepted.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  try {
    const url = new URL(hasScheme ? trimmed : `https://${trimmed}`)
    if (!ALLOWED.includes(url.protocol.toLowerCase())) return null
    if (url.protocol !== 'mailto:' && !url.hostname) return null
    return url.href
  } catch {
    return null
  }
}
