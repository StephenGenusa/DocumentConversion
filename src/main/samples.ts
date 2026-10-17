import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The sample documents, opened from Help → Sample Documents. Each is built by
 * scripts/samples/build-samples.mjs into resources/samples, which ships with
 * the app (electron-builder packs resources/**).
 *
 * A sample opens as an untitled copy: its bytes are handed to the window with
 * no file handle and no folder, so nothing can be written back to the shipped
 * file, a conversion is saved where an untitled document would be, and the
 * window never watches the file for changes.
 */
export const SAMPLES = [
  { id: 'engineering', menu: 'Engineering Design Note', file: 'engineering-design-note.md' },
  { id: 'software', menu: 'Software Design Specification', file: 'software-design-specification.md' },
  { id: 'lab', menu: 'Lab Report', file: 'lab-report.md' },
  { id: 'meeting', menu: 'Meeting Summary', file: 'meeting-summary.md' },
  { id: 'architecture', menu: 'Architecture Diagram (SVG)', file: 'architecture-diagram.svg' },
] as const

export type SampleId = (typeof SAMPLES)[number]['id']

/** What the window is sent to open a sample. */
export interface SampleDocument {
  /** The sample's name, as the window shows it: the menu label without "(SVG)". */
  name: string
  /** The name its conversions are saved under: the name, with the file's extension. */
  filename: string
  base64: string
}

/** resources/samples, wherever this run keeps it (see sqliteAssetDir for why several roots). */
export function samplesDir(): string {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, 'app.asar.unpacked', 'resources', 'samples'), join(resourcesPath, 'app.asar', 'resources', 'samples')] : []),
    join(__dirname, '..', '..', 'resources', 'samples'),
    join(process.cwd(), 'resources', 'samples'),
  ]
  return candidates.find((dir) => existsSync(join(dir, SAMPLES[0].file))) ?? candidates[candidates.length - 1]
}

export function sampleName(id: SampleId): string {
  const sample = SAMPLES.find((s) => s.id === id)
  if (!sample) throw new Error(`no sample ${id}`)
  return sample.menu.replace(/\s*\(SVG\)$/, '')
}

/** One sample's bytes, named for its untitled copy. */
export async function readSample(id: SampleId, dir = samplesDir()): Promise<SampleDocument> {
  const sample = SAMPLES.find((s) => s.id === id)
  if (!sample) throw new Error(`no sample ${id}`)
  const bytes = await readFile(join(dir, sample.file))
  const name = sampleName(id)
  return { name, filename: `${name}${sample.file.slice(sample.file.lastIndexOf('.'))}`, base64: bytes.toString('base64') }
}
