/**
 * Minimal document-order scanning for OOXML parts.
 *
 * There is no maintained JS library for PowerPoint, so these parts are read by
 * hand. Regex alone cannot find the end of a nested element, which is why
 * shapes, tables and groups need a real element scanner.
 */
export interface XmlElement {
  name: string
  xml: string
  /** Content between the open and close tags ('' for a self-closing element). */
  inner: string
}

function isSelfClosing(xml: string, openEnd: number): boolean {
  return xml[openEnd - 2] === '/'
}

/** Index just past the element that starts at `start`, honouring nesting. */
function elementEnd(xml: string, start: number, name: string): { end: number; inner: string } {
  const openEnd = xml.indexOf('>', start)
  if (openEnd === -1) return { end: xml.length, inner: '' }
  if (isSelfClosing(xml, openEnd + 1)) return { end: openEnd + 1, inner: '' }
  const open = new RegExp(`<${name}(?=[\\s/>])`, 'g')
  const close = new RegExp(`</${name}>`, 'g')
  let depth = 1
  let cursor = openEnd + 1
  while (depth > 0 && cursor < xml.length) {
    open.lastIndex = cursor
    close.lastIndex = cursor
    const nextOpen = open.exec(xml)
    const nextClose = close.exec(xml)
    if (!nextClose) return { end: xml.length, inner: xml.slice(openEnd + 1) }
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++
      cursor = nextOpen.index + 1
      continue
    }
    depth--
    cursor = nextClose.index + nextClose[0].length
    if (depth === 0) return { end: cursor, inner: xml.slice(openEnd + 1, nextClose.index) }
  }
  return { end: xml.length, inner: xml.slice(openEnd + 1) }
}

/** Elements matching any of `names`, in document order, without descending into them. */
export function scanElements(xml: string, names: string[]): XmlElement[] {
  const pattern = new RegExp(`<(${names.map((n) => n.replace(':', '\\:')).join('|')})(?=[\\s/>])`, 'g')
  const found: XmlElement[] = []
  let cursor = 0
  for (;;) {
    pattern.lastIndex = cursor
    const match = pattern.exec(xml)
    if (!match) return found
    const { end, inner } = elementEnd(xml, match.index, match[1])
    found.push({ name: match[1], xml: xml.slice(match.index, end), inner })
    cursor = end
  }
}

/** Decode the five XML predefined entities. */
export function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
