import { DRAWN_KINDS, MAX_SOURCE_BYTES, type BlockKind, type RenderRequest, type RenderResult } from '../core/rendered-blocks'
import type { DrawContext } from '../core/draw-blocks'
import { targetPictures } from '../core/pictures'

/**
 * The editor's door to the render host (spec B11): `render:block`.
 *
 * The page is not trusted to send a well-formed request, so everything is
 * checked here before the host sees it: the kind is one of the three, the
 * source is a string of at most 100 KB, display is a boolean and the
 * priority one of the two the editor uses. The editor always gets SVG, and
 * gets it back as an `<img>`-ready data URI of the SVG the host has already
 * sanitized (B6), so no engine markup is ever handled as markup in the main
 * window.
 */

const KINDS: ReadonlySet<string> = new Set<BlockKind>(['mermaid', 'dot', 'math'])

/** What the editor asks for. */
export interface EditorRenderRequest {
  kind: BlockKind
  source: string
  display: boolean
  priority: 'visible' | 'prefetch'
}

/** What the editor gets: a picture, the engine's message, or "not drawn in this version". */
export type EditorRenderResult =
  | { uri: string; width: number; height: number; baseline?: number }
  | { error: string }
  | { unavailable: true }

/** The request, checked, or the reason it is refused. */
export function checkRenderRequest(value: unknown): EditorRenderRequest | { refused: string } {
  if (typeof value !== 'object' || value === null) return { refused: 'no request' }
  const v = value as Record<string, unknown>
  if (typeof v.kind !== 'string' || !KINDS.has(v.kind)) return { refused: 'unknown kind' }
  if (typeof v.source !== 'string') return { refused: 'no source' }
  if (Buffer.byteLength(v.source, 'utf8') > MAX_SOURCE_BYTES) return { refused: `the source is over ${MAX_SOURCE_BYTES / 1024} KB` }
  const display = v.display === undefined ? true : v.display
  if (typeof display !== 'boolean') return { refused: 'bad display' }
  const priority = v.priority === undefined ? 'visible' : v.priority
  if (priority !== 'visible' && priority !== 'prefetch') return { refused: 'bad priority' }
  return { kind: v.kind as BlockKind, source: v.source, display, priority }
}

type Render = (req: RenderRequest, opts: { priority: 'visible' | 'prefetch' }) => Promise<RenderResult>

/** Answer one `render:block` call with `render` (the host's). Never throws. */
export async function renderForEditor(value: unknown, render: Render): Promise<EditorRenderResult> {
  const req = checkRenderRequest(value)
  if ('refused' in req) return { error: req.refused }
  // A kind with no engine yet is shown as source, not as a failure.
  if (!DRAWN_KINDS.has(req.kind)) return { unavailable: true }
  try {
    const result = await render({ kind: req.kind, source: req.source, display: req.display, format: 'svg' }, { priority: req.priority })
    if ('error' in result) return { error: result.error }
    if (typeof result.svg !== 'string') return { error: 'the engine returned no picture' }
    const uri = `data:image/svg+xml;base64,${Buffer.from(result.svg, 'utf8').toString('base64')}`
    return { uri, width: result.width, height: result.height, ...(result.baseline !== undefined ? { baseline: result.baseline } : {}) }
  } catch (err) {
    return { error: (err as Error).message || 'the drawing failed' }
  }
}

/** A data: URL of a picture the editor's page cannot show (renderer picture-preview.ts). */
const NOT_SHOWN = /^data:image\/(?:tiff|x-emf|x-wmf);base64,[A-Za-z0-9+/=\s]*$/i

/** A copy the page can show: a raster picture, or a sanitized SVG. */
const SHOWN = /^data:image\/(?:png|jpeg|svg\+xml);base64,/

/**
 * Answer one `picture:preview` call: a copy the editor can show of a TIFF,
 * EMF or WMF, made exactly as an HTML conversion makes it (pictures.ts,
 * target html): a TIFF converted by the render host (its first page, for
 * one of several), a drawing drawn as sanitized SVG. Anything else is
 * refused. Never throws.
 */
export async function previewForEditor(value: unknown, ctx: DrawContext): Promise<{ uri: string } | { error: string }> {
  const src = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).src : undefined
  if (typeof src !== 'string' || !NOT_SHOWN.test(src)) return { error: 'not a TIFF, EMF or WMF picture' }
  try {
    const html = await targetPictures(`<img src="${src.replace(/\s+/g, '')}" alt="">`, 'html', { ...ctx, onAdvice: undefined })
    const shown = /<img\b[^>]*\ssrc="([^"]+)"/.exec(html)?.[1]
    return shown && SHOWN.test(shown) ? { uri: shown } : { error: 'the picture could not be shown' }
  } catch (err) {
    return { error: (err as Error).message || 'the picture could not be shown' }
  }
}
