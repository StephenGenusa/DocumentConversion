/**
 * Resolve a callable export across CJS/ESM interop shapes.
 *
 * Transpiled-CJS packages land differently under vitest/esbuild (which unwrap
 * `.default`) and under rollup in the packaged app (which may leave it wrapped,
 * or wrapped twice). Every occurrence of this has only ever failed in the
 * packaged build — MsgReader "is not a constructor", "parser.parse is not a
 * function" — so probe each layer for the member we actually need.
 */
export function resolveExport<T>(mod: unknown, member: string): T {
  const layers = [mod, (mod as { default?: unknown })?.default, (mod as { default?: { default?: unknown } })?.default?.default]
  for (const layer of layers) {
    if (layer && typeof (layer as Record<string, unknown>)[member] === 'function') return layer as T
  }
  throw new Error(`module does not expose ${member}()`)
}
