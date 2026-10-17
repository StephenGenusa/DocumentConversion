/*
 * happy-dom has no CSS Custom Highlight API: a stand-in with the same shape
 * (a registry of named sets of ranges) holds what the editor paints, and
 * `painted` reads it back.
 */

export function installHighlights(): void {
  class Highlight extends Set<AbstractRange> {}
  const w = window as unknown as { Highlight?: unknown; CSS?: object & { highlights?: unknown } }
  w.Highlight ??= Highlight
  // happy-dom makes a new CSS object on each read: pin one that has the registry.
  if (!w.CSS?.highlights) Object.defineProperty(window, 'CSS', { value: Object.assign(Object.create(w.CSS ?? null), { highlights: new Map() }), configurable: true })
}

/** What is painted in `el`, as `highlight:text`, in the order of the text. */
export const painted = (el: Element): string[] => {
  const registry = (window as unknown as { CSS: { highlights: Map<string, Set<AbstractRange>> } }).CSS.highlights
  const nodes: Text[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  const offset = (node: Node, at: number): number => {
    let sum = 0
    for (const n of nodes) {
      if (n === node) return sum + at
      sum += n.data.length
    }
    return -1
  }
  const text = nodes.map((n) => n.data).join('')
  const out: [number, string][] = []
  for (const [name, h] of registry) {
    for (const r of h) {
      const a = offset(r.startContainer, r.startOffset)
      const b = offset(r.endContainer, r.endOffset)
      if (a >= 0 && b >= a) out.push([a, `${name}:${text.slice(a, b)}`])
    }
  }
  return out.sort((x, y) => x[0] - y[0]).map(([, s]) => s)
}
