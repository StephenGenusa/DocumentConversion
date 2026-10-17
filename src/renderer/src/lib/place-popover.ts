/*
 * Where a popover goes beside what opened it, kept inside the pane it
 * belongs to and inside the window: the formula popover (block-views.ts) and
 * the code language picker (code-language-picker.ts). The popover is
 * `position: fixed`, so the pane's scrolling box does not clip it.
 */

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Placement {
  left: number
  top: number
  /** Which side of the anchor it went to. */
  side: 'below' | 'above'
  /** The most it may be across and down there; its content scrolls past that. */
  maxWidth: number
  maxHeight: number
}

export interface PlaceOptions {
  /** Between the anchor and the popover. */
  gap?: number
  /** Kept clear inside the bounds. */
  margin?: number
  /** Lined up with the anchor's left edge, its middle, or its right edge, before it is shifted to fit. */
  align?: 'start' | 'center' | 'end'
}

/**
 * Below the anchor if it fits there, else above if it fits there, else on
 * the side with more room, as tall as that room. Across, lined up with the
 * anchor and then shifted to stay inside, never wider than the bounds.
 */
export function placePopover(anchor: Box, size: { width: number; height: number }, bounds: Box, options: PlaceOptions = {}): Placement {
  const gap = options.gap ?? 6
  const margin = options.margin ?? 8
  const maxWidth = Math.max(0, bounds.right - bounds.left - 2 * margin)
  const width = Math.min(size.width, maxWidth)
  const align = options.align ?? 'start'
  let left = align === 'start' ? anchor.left : align === 'end' ? anchor.right - width : (anchor.left + anchor.right) / 2 - width / 2
  left = Math.max(bounds.left + margin, Math.min(left, bounds.right - margin - width))
  const below = bounds.bottom - margin - (anchor.bottom + gap)
  const above = anchor.top - gap - (bounds.top + margin)
  const side = size.height <= below || (size.height > above && below >= above) ? 'below' : 'above'
  const room = Math.max(0, side === 'below' ? below : above)
  const height = Math.min(size.height, room)
  let top = side === 'below' ? anchor.bottom + gap : anchor.top - gap - height
  // An anchor scrolled out of the bounds keeps its popover at their edge.
  top = Math.max(bounds.top + margin, Math.min(top, bounds.bottom - margin - height))
  return { left, top, side, maxWidth, maxHeight: room }
}

/** The part of `el` that shows: its box cut to the window. */
export function visibleBox(el: Element): Box {
  const win = el.ownerDocument.defaultView
  const r = el.getBoundingClientRect()
  const w = win?.innerWidth ?? r.right
  const h = win?.innerHeight ?? r.bottom
  return { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(w, r.right), bottom: Math.min(h, r.bottom) }
}

/** The nearest element `el` scrolls in, else the page. */
export function scrollParent(el: Element): Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return el.ownerDocument.documentElement
}

/**
 * Put a `position: fixed` popover beside `anchor`, inside the box of the
 * element it scrolls in (cut to the window). Returns the side it went to.
 */
export function placeBeside(pop: HTMLElement, anchor: Element, options: PlaceOptions = {}): Placement {
  const bounds = visibleBox(scrollParent(anchor))
  const margin = options.margin ?? 8
  // Measured at the widest it may be, so a long line wraps rather than pushing it out.
  pop.style.maxWidth = `${Math.max(0, bounds.right - bounds.left - 2 * margin)}px`
  pop.style.maxHeight = ''
  const size = pop.getBoundingClientRect()
  const at = placePopover(anchor.getBoundingClientRect(), { width: size.width, height: size.height }, bounds, options)
  pop.style.left = `${Math.round(at.left)}px`
  pop.style.top = `${Math.round(at.top)}px`
  if (at.maxHeight < size.height) pop.style.maxHeight = `${Math.floor(at.maxHeight)}px`
  return at
}
