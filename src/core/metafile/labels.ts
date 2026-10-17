import type { Rect } from './svg'

/** A run of text a drawing drew, and the box it covers (device space, y down). */
export interface DrawingLabel {
  text: string
  bounds: Rect
}

interface Placed {
  text: string
  l: number
  t: number
  r: number
  b: number
  /** Its middle, top to bottom. */
  cy: number
  h: number
}

/**
 * A drawing's text as a reader reads it: its labels top to bottom, and on one
 * line left to right, by where they are drawn rather than the order the file
 * drew them in (a plan's rooms, a chart's title, axis and legend).
 *
 * A line is the labels whose middles lie within one another's height. On a
 * line, runs that nearly touch are one label (a file may draw a phrase a word
 * or a few letters at a time): closer than about half their height apart
 * they join, with a space unless they touch. A run drawn again over itself (a
 * shadow, an outline) is said once. Everything else is a label of its own.
 */
export function readingOrder(labels: readonly DrawingLabel[]): string[] {
  const placed: Placed[] = []
  for (const { text, bounds: { l, t, r, b } } of labels) {
    const clean = text.replace(/\s+/g, ' ')
    if (!clean.trim() || ![l, t, r, b].every(Number.isFinite)) return fallback(labels)
    placed.push({ text: clean, l: Math.min(l, r), r: Math.max(l, r), t: Math.min(t, b), b: Math.max(t, b), cy: (t + b) / 2, h: Math.max(Math.abs(b - t), 1e-6) })
  }
  placed.sort((a, b) => a.cy - b.cy || a.l - b.l)
  const lines: Placed[][] = []
  for (const p of placed) {
    // The last lines started, newest first: a label belongs to the first whose middle it spans and that spans its middle.
    const line = lines
      .slice(-4)
      .reverse()
      .find((ln) => ln.some((q) => q.cy >= p.t && q.cy <= p.b && p.cy >= q.t && p.cy <= q.b))
    if (line) line.push(p)
    else lines.push([p])
  }
  const out: string[] = []
  for (const line of lines) {
    line.sort((a, b) => a.l - b.l)
    let phrase: Placed | null = null
    for (const p of line) {
      if (!phrase) {
        phrase = { ...p }
        continue
      }
      const h = Math.min(phrase.h, p.h)
      const gap = p.l - phrase.r
      if (p.text.trim() === phrase.text.trim() && p.l < phrase.r) continue
      if (gap <= 0.6 * h) {
        const touching = gap <= 0.12 * h || /\s$/.test(phrase.text) || /^\s/.test(p.text)
        phrase.text = touching ? phrase.text + p.text : `${phrase.text} ${p.text}`
        phrase.r = Math.max(phrase.r, p.r)
        continue
      }
      out.push(phrase.text.trim())
      phrase = { ...p }
    }
    if (phrase) out.push(phrase.text.trim())
  }
  return out.filter(Boolean)
}

/** A label with no usable box: the runs in drawing order, as they were. */
function fallback(labels: readonly DrawingLabel[]): string[] {
  return labels.map((l) => l.text.replace(/\s+/g, ' ').trim()).filter(Boolean)
}
