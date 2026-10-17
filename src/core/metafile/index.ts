import { emfSize, wmfSize } from '../picture-headers'
import { View } from './bytes'
import { Budget } from './dib'
import { EMR, EmfPlayer, emfRecords, readEmfHeader } from './emf'
import { EmfPlusPlayer } from './emfplus'
import { Gdi } from './gdi'
import { intersect, SvgOut, TooLarge, type ImageData, type Rect } from './svg'
import { embeddedEmf, META, readWmfHeader, WmfPlayer, wmfRecords } from './wmf'

/*
 * EMF and WMF pictures (Word's vector pictures) drawn as SVG, for every
 * target that cannot hold them (pictures.ts): our own drawing code, pure
 * TypeScript with no DOM, since no library does it under a licence this
 * app can ship. What it draws is in gdi.ts (the device context), emf.ts,
 * emfplus.ts and wmf.ts (the records).
 *
 * The SVG's viewBox is the metafile's frame in its own device pixels; its
 * width and height are the size the document shows it at (the frame, in
 * CSS px).
 *
 * A file whose drawing comes out empty, or lands wholly outside its
 * frame, or whose records mostly could not be read, gets an error (and
 * so its alt text, with a notice): no picture rather than a wrong one.
 *
 * The input is untrusted. Every read is bounded (bytes.ts); records are
 * capped (MAX_RECORDS), the object table (MAX_OBJECTS), saved states,
 * clip chains, region trees, nesting (MAX_DEPTH: an EMF+ picture inside a
 * metafile, an EMF inside a WMF), each bitmap's size and all bitmaps'
 * pixels together (dib.ts), and the SVG's length (maxChars). Every loop
 * moves forward through the file, so none can run forever. The caller
 * sanitises the SVG (svg-sanitize.ts) like any other.
 */

export interface MetafileDrawing {
  /** The picture as SVG (not yet sanitised). */
  svg: string
  /** The size it is shown at, in CSS px. */
  width: number
  height: number
  /** What the file asks for that is not drawn, once each. */
  lost: string[]
}

export type MetafileResult = MetafileDrawing | { error: string }

export const METAFILE_LIMITS = {
  /** The longest SVG made (characters), bitmaps included. */
  maxChars: 24 * 1024 * 1024,
  /** How deep metafiles may nest inside one another. */
  maxDepth: 2,
  /** The largest side of the size a picture is shown at, in CSS px (the render host's rule). */
  maxSide: 20_000,
} as const

interface Options {
  depth?: number
  maxChars?: number
}

/** An EMF or WMF drawn (see above), or why not. */
export function drawMetafile(bytes: Buffer, opts: Options = {}): MetafileResult {
  const file = new View(bytes, 0, bytes.length)
  try {
    if (readEmfHeader(file)) return drawEmf(file, bytes, opts)
    const wmf = readWmfHeader(file)
    if (wmf) return drawWmf(file, bytes, wmf, opts)
    return { error: 'it is not an EMF or WMF picture' }
  } catch (err) {
    if (err instanceof TooLarge) return { error: 'it is too large to convert' }
    return { error: 'it could not be read' }
  }
}

function sane(width: number, height: number): boolean {
  return width >= 1 && height >= 1 && width <= METAFILE_LIMITS.maxSide && height <= METAFILE_LIMITS.maxSide
}

/** A region far larger than the picture: what "everything" is for a clip that excludes. */
function universe(vb: Rect | null): Rect {
  if (!vb) return { l: -1e7, t: -1e7, r: 1e7, b: 1e7 }
  const w = vb.r - vb.l
  const h = vb.b - vb.t
  return { l: vb.l - 10 * w, t: vb.t - 10 * h, r: vb.r + 10 * w, b: vb.b + 10 * h }
}

/** Why a finished drawing is no good, or null when it is. */
function broken(out: SvgOut, vb: Rect, played: number, failed: number): string | null {
  if (out.empty) return 'it draws nothing this app can show'
  if (!out.bounds || !intersect(out.bounds, vb)) return 'nothing it draws is inside its frame'
  if (played > 10 && failed > played / 2) return 'most of it could not be read'
  return null
}

function nestedFor(opts: Options): (bytes: Buffer) => ImageData | null {
  const depth = (opts.depth ?? 0) + 1
  return (bytes) => {
    if (depth > METAFILE_LIMITS.maxDepth) return null
    const r = drawMetafile(bytes, { depth, maxChars: Math.floor((opts.maxChars ?? METAFILE_LIMITS.maxChars) / 4) })
    if ('error' in r) return null
    return { mime: 'image/svg+xml', bytes: Buffer.from(r.svg, 'utf8'), width: r.width, height: r.height }
  }
}

/** Whether an EMF holds EMF+ records, and whether it says it is dual (its EMF records draw the same picture). */
function emfPlus(file: View): { present: boolean; dual: boolean } {
  let seen = 0
  for (const { type, r } of emfRecords(file)) {
    if (type === EMR.COMMENT && r.has(12, 16) && r.u32(12) === 0x2b464d45) {
      // The first EMF+ record is the header; its flags' low bit says dual.
      if (r.u16(16) === 0x4001) return { present: true, dual: (r.u16(18) & 1) === 1 }
      return { present: true, dual: false }
    }
    if (++seen > 64) break
  }
  return { present: false, dual: false }
}

function drawEmf(file: View, bytes: Buffer, opts: Options): MetafileResult {
  const h = readEmfHeader(file)!
  const [mx, my] = h.pxPerMm
  const f = h.frame
  const b = h.bounds
  let vb: Rect | null = null
  if (f.r > f.l && f.b > f.t) vb = { l: (f.l / 100) * mx, t: (f.t / 100) * my, r: (f.r / 100) * mx, b: (f.b / 100) * my }
  else if (b.r >= b.l && b.b >= b.t && (b.r > b.l || b.b > b.t)) vb = { l: b.l, t: b.t, r: b.r + 1, b: b.b + 1 }
  const size = emfSize(bytes)
  const maxChars = opts.maxChars ?? METAFILE_LIMITS.maxChars
  const plus = emfPlus(file)

  const run = (mode: 'gdi' | 'plus', box: Rect | null, width: number): { out: SvgOut; failed: number; played: number; lost: Set<string> } => {
    const out = new SvgOut(maxChars, `m${opts.depth ?? 0}${mode[0]}`)
    out.hairline = box && width > 0 ? (box.r - box.l) / width : 1
    const budget = new Budget()
    const gdi = new Gdi({ out, budget, pxPerMm: h.pxPerMm, universe: universe(box) })
    const player = mode === 'plus' ? new EmfPlusPlayer(out, h.pxPerMm, budget, universe(box), gdi.lost, nestedFor(opts)) : null
    const emf = new EmfPlayer(gdi, player)
    emf.play(file)
    return { out, failed: emf.failed + (player?.failed ?? 0), played: emf.played + (player?.records ?? 0), lost: gdi.lost }
  }

  const finish = (r: ReturnType<typeof run>, box: Rect | null): MetafileResult => {
    const viewBox = box ?? r.out.bounds
    if (!viewBox) return { error: 'it draws nothing this app can show' }
    const width = size?.width ?? ((viewBox.r - viewBox.l) / mx) * (96 / 25.4)
    const height = size?.height ?? ((viewBox.b - viewBox.t) / my) * (96 / 25.4)
    if (!sane(width, height)) return { error: 'its size is not one this app can show' }
    const why = broken(r.out, viewBox, r.played, r.failed)
    if (why) return { error: why }
    return { svg: r.out.finish(viewBox, width, height), width, height, lost: [...r.lost] }
  }

  const cssWidth = size?.width ?? (vb ? ((vb.r - vb.l) / mx) * (96 / 25.4) : 0)
  if (plus.present && !plus.dual) {
    // An EMF+-only file is drawn from its EMF+ records (falling back on its
    // EMF records if they draw nothing); a dual file's EMF records draw it.
    const fromPlus = finish(run('plus', vb, cssWidth), vb)
    if (!('error' in fromPlus)) return fromPlus
    const fromGdi = finish(run('gdi', vb, cssWidth), vb)
    return 'error' in fromGdi ? fromPlus : fromGdi
  }
  return finish(run('gdi', vb, cssWidth), vb)
}

function drawWmf(file: View, bytes: Buffer, header: NonNullable<ReturnType<typeof readWmfHeader>>, opts: Options): MetafileResult {
  const placeableSize = wmfSize(bytes)
  // Office's own EMF of the same picture, when the WMF carries one, is the better drawing.
  if ((opts.depth ?? 0) < METAFILE_LIMITS.maxDepth) {
    const emf = embeddedEmf(file, header)
    if (emf) {
      const r = drawMetafile(emf, { ...opts, depth: (opts.depth ?? 0) + 1 })
      if (!('error' in r)) return placeableSize ? { ...r, ...placeableSize } : r
    }
  }
  const maxChars = opts.maxChars ?? METAFILE_LIMITS.maxChars
  // Where no placeable header gives the size, the first window the file sets does.
  let window: { org: [number, number]; ext: [number, number] } | null = null
  const p = header.placeable
  if (p && p.box.r !== p.box.l && p.box.b !== p.box.t) window = { org: [p.box.l, p.box.t], ext: [p.box.r - p.box.l, p.box.b - p.box.t] }
  let width = placeableSize?.width ?? 0
  let height = placeableSize?.height ?? 0
  if (!window) {
    let org: [number, number] = [0, 0]
    for (const { fn, r } of wmfRecords(file, header.records)) {
      if (fn === META.SETWINDOWORG && r.has(6, 4)) org = [r.i16(8), r.i16(6)]
      if (fn === META.SETWINDOWEXT && r.has(6, 4)) {
        const ext: [number, number] = [r.i16(8), r.i16(6)]
        if (ext[0] !== 0 && ext[1] !== 0) window = { org, ext }
        break
      }
    }
  }
  if (window && !placeableSize) {
    // No size is given: the window's units as pixels, brought within 1,000 px a side.
    const w = Math.abs(window.ext[0])
    const hh = Math.abs(window.ext[1])
    const s = Math.min(1, 1000 / Math.max(w, hh))
    width = w * s
    height = hh * s
  }
  const view: Rect = { l: 0, t: 0, r: width || 1, b: height || 1 }
  const out = new SvgOut(maxChars, `w${opts.depth ?? 0}`)
  const gdi = new Gdi({ out, budget: new Budget(), pxPerMm: [96 / 25.4, 96 / 25.4], universe: universe(window ? view : null), wmfView: view })
  if (window && p && placeableSize) {
    gdi.set('winOrg', window.org)
    gdi.set('winExt', window.ext)
    gdi.windowKnown = true
    gdi.changed()
  }
  const player = new WmfPlayer(gdi)
  player.play(file, header)
  const viewBox = gdi.windowKnown ? view : out.bounds
  if (!viewBox) return { error: 'it draws nothing this app can show' }
  if (!gdi.windowKnown) {
    width = viewBox.r - viewBox.l
    height = viewBox.b - viewBox.t
  }
  if (!sane(width, height)) return { error: 'its size is not one this app can show' }
  const why = broken(out, viewBox, player.played, player.failed)
  if (why) return { error: why }
  return { svg: out.finish(viewBox, width, height), width, height, lost: [...gdi.lost] }
}
