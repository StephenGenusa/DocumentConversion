/**
 * The sample documents, by name: the Help → Sample Documents menu (main) and
 * the start screen's Sample documents link (the page) offer this one list.
 * Each file is built by scripts/samples/build-samples.mjs into
 * resources/samples; src/main/samples.ts reads them.
 */
export const SAMPLES = [
  { id: 'engineering', menu: 'Engineering Design Note', file: 'engineering-design-note.md' },
  { id: 'software', menu: 'Software Design Specification', file: 'software-design-specification.md' },
  { id: 'lab', menu: 'Lab Report', file: 'lab-report.md' },
  { id: 'meeting', menu: 'Meeting Summary', file: 'meeting-summary.md' },
  { id: 'architecture', menu: 'Architecture Diagram (SVG)', file: 'architecture-diagram.svg' },
] as const

export type SampleId = (typeof SAMPLES)[number]['id']

/** A sample's id as it arrives from the page: anything else is refused. */
export function isSampleId(id: unknown): id is SampleId {
  return SAMPLES.some((s) => s.id === id)
}
