import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

/**
 * The colors laid over Mermaid's 'neutral' theme (resources/render/mermaid-colors.js),
 * the plain script the render host's page loads beside host.js.
 */
const require = createRequire(import.meta.url)
const colors = require(resolve(__dirname, '..', '..', 'resources', 'render', 'mermaid-colors.js')) as {
  themeVariables: () => Record<string, any>
  ownTheme: (source: string) => boolean
  contrast: (a: string, b: string) => number
}

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
/** Max minus min channel: 0 for a gray. */
const chroma = (hex: string): number => Math.max(...rgb(hex)) - Math.min(...rgb(hex))
const hue = (hex: string): number => {
  const [r, g, b] = rgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
/** khroma's lighten: HSL lightness up by `by` points (kanban draws its columns 10 lighter). */
const lighten = (hex: string, by: number): string => {
  const [r, g, b] = rgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = d === 0 ? 0 : hue(hex)
  const l2 = Math.min(1, l + by / 100)
  const c = (1 - Math.abs(2 * l2 - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l2 - c / 2
  h = Math.floor(h / 60)
  const [r1, g1, b1] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][h % 6]
  return '#' + [r1, g1, b1].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')
}

describe('Mermaid colors', () => {
  const v = colors.themeVariables()

  it('gives the twelve section colors (mind map, timeline, kanban, treemap, pie) distinct hues', () => {
    const fills = Array.from({ length: 12 }, (_, i) => v[`cScale${i}`] as string)
    for (const f of fills) expect(chroma(f)).toBeGreaterThan(40)
    const buckets = new Set(fills.map((f) => Math.floor(hue(f) / 30)))
    expect(buckets.size).toBeGreaterThanOrEqual(8)
  })

  it('sets every section label so it reads on its fill, and on the lighter kanban fill', () => {
    for (let i = 0; i < 12; i++) {
      const fill = v[`cScale${i}`]
      const label = v[`cScaleLabel${i}`]
      expect(colors.contrast(fill, label), `section ${i}`).toBeGreaterThanOrEqual(4.5)
      expect(colors.contrast(lighten(fill, 10), label), `kanban ${i}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('colors git branches (and the mind map root) with readable branch labels', () => {
    for (let i = 0; i < 8; i++) {
      expect(chroma(v[`git${i}`])).toBeGreaterThan(80)
      expect(colors.contrast(v[`git${i}`], v[`gitBranchLabel${i}`]), `branch ${i}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("colors journey sections, quadrants, Gantt tasks and the XY chart's series; their text reads", () => {
    for (let i = 0; i < 8; i++) {
      expect(chroma(v[`fillType${i}`])).toBeGreaterThan(15)
      // Journey text is the theme's #333.
      expect(colors.contrast(v[`fillType${i}`], '#333')).toBeGreaterThanOrEqual(4.5)
    }
    for (let i = 1; i <= 4; i++) {
      expect(chroma(v[`quadrant${i}Fill`])).toBeGreaterThan(15)
      expect(colors.contrast(v[`quadrant${i}Fill`], '#111111')).toBeGreaterThanOrEqual(4.5)
    }
    expect(chroma(v.taskBkgColor)).toBeGreaterThan(80)
    expect(colors.contrast(v.taskBkgColor, v.taskTextColor)).toBeGreaterThanOrEqual(4.5)
    expect(colors.contrast(v.activeTaskBkgColor, '#333')).toBeGreaterThanOrEqual(4.5)
    const series = (v.xyChart.plotColorPalette as string).split(',')
    for (const s of series) expect(chroma(s)).toBeGreaterThan(80)
    // Mermaid replaces xyChart whole: every axis color is given.
    expect(Object.keys(v.xyChart)).toHaveLength(11)
  })

  it("leaves a diagram that names its own theme to that theme; themeVariables alone don't count", () => {
    expect(colors.ownTheme('mindmap\n  root')).toBe(false)
    expect(colors.ownTheme("%%{init: {'theme': 'forest'}}%%\nmindmap\n  root")).toBe(true)
    expect(colors.ownTheme('%%{init: {"theme":"neutral"}}%%\npie\n  "a": 1')).toBe(true)
    expect(colors.ownTheme('---\nconfig:\n  theme: dark\n---\nmindmap\n  root')).toBe(true)
    expect(colors.ownTheme('%%{init: {"themeVariables": {"primaryColor": "#ff0000"}}}%%\npie\n  "a": 1')).toBe(false)
    expect(colors.ownTheme('---\ntitle: theme: none\n---\npie\n  "a": 1')).toBe(false)
  })
})
