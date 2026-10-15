import type { BlockKind } from '../../../core/rendered-blocks'

/**
 * The editor's side of drawing (spec B11): asks the main process for a
 * block's picture and remembers the answers.
 *
 * The main process has the real cache (shared with conversions). This one
 * is small and exists so the editor never flickers: ProseMirror rebuilds a
 * node view whenever the content around it is replaced, and a rebuilt view
 * that finds its picture here shows it at once instead of a placeholder.
 * Sizes are kept longer than pictures, for placeholders of the right size.
 */

export type BlockPicture = { uri: string; width: number; height: number; baseline?: number }
export type BlockDrawing = BlockPicture | { error: string }
export type BlockAnswer = BlockDrawing | { unavailable: true }
export type DrawPriority = 'visible' | 'prefetch'

export interface BlockRequest {
  kind: BlockKind
  source: string
  display: boolean
}

/** What actually draws: window.api.renderBlock in the app, a fake in tests. */
export type DrawFn = (req: BlockRequest & { priority: DrawPriority }) => Promise<BlockAnswer>

const PICTURES = 200
const SIZES = 5000

const keyOf = (r: BlockRequest): string => `${r.kind}\u0000${r.display ? 1 : 0}\u0000${r.source}`

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value as string)
}

export interface RenderClient {
  /** The answer already known for this exact block, without asking. */
  known(req: BlockRequest): BlockAnswer | undefined
  /** The last size this block was drawn at, for a placeholder. */
  sizeOf(req: BlockRequest): { width: number; height: number } | undefined
  /** Draw it. A request already waiting is shared, and hurried along when asked again as `visible`. */
  draw(req: BlockRequest, priority: DrawPriority): Promise<BlockAnswer>
}

export function createRenderClient(drawFn: DrawFn): RenderClient {
  const answers = new Map<string, BlockAnswer>()
  const sizes = new Map<string, { width: number; height: number }>()
  const waiting = new Map<string, { promise: Promise<BlockAnswer>; priority: DrawPriority }>()

  return {
    known(req) {
      const key = keyOf(req)
      const hit = answers.get(key)
      if (hit) remember(answers, key, hit, PICTURES)
      return hit
    },
    sizeOf: (req) => sizes.get(keyOf(req)),
    draw(req, priority) {
      const key = keyOf(req)
      const hit = answers.get(key)
      if (hit) return Promise.resolve(hit)
      const pending = waiting.get(key)
      // The host joins a repeated request to the queued one at the more urgent
      // priority, so asking again is how a prefetch is moved to the front.
      if (pending && (pending.priority === 'visible' || priority === 'prefetch')) return pending.promise
      const promise = drawFn({ ...req, priority })
        .catch((err: Error): BlockAnswer => ({ error: err?.message || 'the drawing failed' }))
        .then((answer) => {
          if (waiting.get(key)?.promise === promise) waiting.delete(key)
          remember(answers, key, answer, PICTURES)
          if ('uri' in answer) remember(sizes, key, { width: answer.width, height: answer.height }, SIZES)
          return answer
        })
      waiting.set(key, { promise, priority })
      return promise
    },
  }
}

let shared: RenderClient | null = null

/** The app's client, through the preload bridge. Replaced in tests with setRenderClient. */
export function renderClient(): RenderClient {
  if (!shared) {
    shared = createRenderClient((req) =>
      typeof window !== 'undefined' && window.api?.renderBlock
        ? window.api.renderBlock(req)
        : Promise.resolve({ unavailable: true as const }),
    )
  }
  return shared
}

export function setRenderClient(client: RenderClient | null): void {
  shared = client
}
