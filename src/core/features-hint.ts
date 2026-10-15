import { getReader } from './readers'
import { docxHasEquations } from './readers/docx'
import { hubFeatures, type HubFeatures } from './rendered-blocks'
import type { SourceFormat } from './types'

/*
 * What an input holds that a writer may draw, known when it is added (spec
 * 2a, V1). The edit pane's read sets `features` too, but a file never opened
 * there would otherwise have none, and the Diagrams choice could not know to
 * show. Main sends this with the other add-time hints (jsonTable, viewCount).
 */

/** The text formats whose readers write diagram or formula blocks (spec B2). */
const HINT_SOURCES: ReadonlySet<SourceFormat> = new Set<SourceFormat>([
  'md',
  'ipynb',
  'asciidoc',
  'rst',
  'djot',
  'textile',
  'html',
])

/** Larger inputs are not read twice; they say nothing until opened or converted. */
export const FEATURES_HINT_MAX_BYTES = 2 * 1024 * 1024

/**
 * The input's features, read by its own reader, or undefined when the format
 * has none to report, the input is too large to read just for this, or it
 * cannot be read. Only the reader runs: nothing is fetched (remote images
 * are resolved by Converter.read, not here).
 */
export async function featuresHint(bytes: Buffer, format: SourceFormat, filename?: string): Promise<HubFeatures | undefined> {
  // A Word file's equations become formulas (spec B12). Converting the whole
  // file just to learn that would be slow, so its parts are only searched,
  // whatever its size.
  if (format === 'docx') {
    const math = await docxHasEquations(bytes)
    return math === undefined ? undefined : { diagrams: false, math }
  }
  if (!HINT_SOURCES.has(format) || bytes.length > FEATURES_HINT_MAX_BYTES) return undefined
  try {
    const hub = await getReader(format)({ bytes, filename })
    return hubFeatures(hub.html)
  } catch {
    return undefined
  }
}
