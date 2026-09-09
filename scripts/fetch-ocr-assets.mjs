/**
 * One-time download of the tesseract English traineddata into resources/ocr/
 * so OCR runs fully offline at runtime (spec F4: no CDN fetches, ever).
 * Run: node scripts/fetch-ocr-assets.mjs
 */
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'resources', 'ocr', 'eng.traineddata.gz')
const URL = 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz'

try {
  await access(dest)
  console.log(`already present: ${dest}`)
  process.exit(0)
} catch {
  /* download */
}

console.log(`downloading ${URL} ...`)
const res = await fetch(URL)
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`)
  process.exit(1)
}
const bytes = Buffer.from(await res.arrayBuffer())
await mkdir(dirname(dest), { recursive: true })
await writeFile(dest, bytes)
console.log(`saved ${bytes.length} bytes to ${dest}`)
