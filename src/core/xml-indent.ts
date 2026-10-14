/**
 * XML re-indented by structure only.
 *
 * Whitespace inside an element that holds text is the author's: in
 * `<p>Some <b>bold</b> text</p>` the spaces around <b> are content, and in an
 * `xml:space="preserve"` subtree every space is. So only an element whose
 * children are all markup (elements, comments, processing instructions, with
 * nothing but whitespace between them) is broken over lines; anything else,
 * and CDATA, comments and PIs themselves, is copied from the source exactly.
 * Null when the tags do not nest, so the caller keeps the original.
 */

interface XNode {
  /** Start and end offsets of this node's whole source text. */
  from: number
  to: number
  /** Set for an element whose children may be laid out on lines of their own. */
  layout?: XNode[]
  /** Start-tag and end-tag text, for a laid-out element. */
  open?: string
  close?: string
}

const TOKEN = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/?[A-Za-z_:][^>]*>|[^<]+/gi

export function reindentXml(text: string): string | null {
  const root: { children: XNode[] } = { children: [] }
  interface Frame {
    name: string
    from: number
    open: string
    children: XNode[]
    text: boolean
    preserve: boolean
  }
  const stack: Frame[] = []
  const top = (): { children: XNode[] } => stack[stack.length - 1] ?? root
  for (const m of text.matchAll(TOKEN)) {
    const tok = m[0]
    const at = m.index ?? 0
    if (!tok.startsWith('<')) {
      if (tok.trim() !== '') {
        if (stack.length === 0) return null
        stack[stack.length - 1].text = true
      }
      continue
    }
    if (/^<\/[^>]*>$/.test(tok)) {
      const name = /^<\/\s*([^\s>]+)/.exec(tok)?.[1]
      const f = stack.pop()
      if (!f || f.name !== name) return null
      const node: XNode = { from: f.from, to: at + tok.length }
      if (!f.text && !f.preserve && f.children.length > 0) {
        node.layout = f.children
        node.open = f.open
        node.close = tok
      }
      top().children.push(node)
      continue
    }
    if (/^<[A-Za-z_:]/.test(tok) && !tok.endsWith('/>')) {
      const name = /^<\s*([^\s/>]+)/.exec(tok)![1]
      stack.push({ name, from: at, open: tok, children: [], text: false, preserve: /\bxml:space\s*=\s*["']preserve["']/.test(tok) })
      continue
    }
    // Self-closing element, comment, CDATA, PI, DOCTYPE: copied as written.
    // CDATA is text content, so its parent is not laid out.
    if (/^<!\[CDATA\[/i.test(tok) && stack.length) stack[stack.length - 1].text = true
    top().children.push({ from: at, to: at + tok.length })
  }
  if (stack.length) return null
  const out: string[] = []
  const emit = (nodes: XNode[], depth: number): void => {
    for (const n of nodes) {
      const pad = '  '.repeat(depth)
      if (n.layout) {
        out.push(pad + n.open!)
        emit(n.layout, depth + 1)
        out.push(pad + n.close!)
      } else out.push(pad + text.slice(n.from, n.to))
    }
  }
  emit(root.children, 0)
  return out.join('\n')
}
