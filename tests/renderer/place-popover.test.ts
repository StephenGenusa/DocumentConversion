import { describe, it, expect } from 'vitest'
import { placePopover, type Box } from '../../src/renderer/src/lib/place-popover'

/*
 * A popover beside what opened it, inside its pane and the window: the
 * formula popover and the code language picker. Boxes are window pixels.
 */

const pane: Box = { left: 100, top: 50, right: 700, bottom: 650 }
const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, right: left + width, bottom: top + height })
const size = { width: 320, height: 120 }

describe('placing a popover', () => {
  it('goes below the anchor, lined up with its left edge, when there is room', () => {
    const at = placePopover(box(200, 100, 30, 20), size, pane)
    expect(at).toMatchObject({ side: 'below', left: 200, top: 126 })
  })

  it('goes above an anchor near the pane bottom', () => {
    const at = placePopover(box(200, 600, 30, 20), size, pane)
    expect(at.side).toBe('above')
    expect(at.top).toBe(600 - 6 - 120)
  })

  it('takes the side with more room when it fits neither, as tall as that room', () => {
    const short = { left: 100, top: 50, right: 700, bottom: 250 }
    const at = placePopover(box(200, 120, 30, 20), { width: 320, height: 300 }, short)
    expect(at.side).toBe('below')
    expect(at.maxHeight).toBe(250 - 8 - 146)
    expect(at.top + Math.min(300, at.maxHeight)).toBeLessThanOrEqual(250 - 8)
  })

  it('shifts in from the right edge, and from the left edge', () => {
    const right = placePopover(box(650, 100, 30, 20), size, pane)
    expect(right.left + size.width).toBe(700 - 8)
    const left = placePopover(box(60, 100, 30, 20), size, pane, { align: 'end' })
    expect(left.left).toBe(100 + 8)
  })

  it('is never wider than a narrow pane, and starts at its edge', () => {
    const narrow = { left: 0, top: 0, right: 240, bottom: 600 }
    const at = placePopover(box(200, 100, 30, 20), size, narrow)
    expect(at.maxWidth).toBe(240 - 16)
    expect(at.left).toBe(8)
  })

  it('centers on a display formula before shifting', () => {
    const at = placePopover(box(300, 100, 200, 40), size, pane, { align: 'center' })
    expect(at.left).toBe(400 - 160)
  })

  it('stays at the pane edge when the anchor is scrolled out of it', () => {
    const at = placePopover(box(200, -400, 30, 20), size, pane)
    expect(at.top).toBe(50 + 8)
  })
})
