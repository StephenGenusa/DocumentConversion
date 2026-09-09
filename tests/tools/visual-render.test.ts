/**
 * Visual-check harness — renders real documents through the readers and the
 * document shell to standalone HTML, so a human (or a vision-capable agent)
 * can LOOK at the result instead of asserting on strings.
 *
 * String assertions cannot see a `<img src=...>` tag rendered as visible text,
 * a title glued to its subtitle, or code and output drawn as identical grey
 * boxes. Every one of those shipped. Pair this with `scripts/print-pdf.cjs` to
 * get a PDF and read it.
 *
 *   VISUAL_FILES="a.pptx|b.ipynb" VISUAL_OUT=/tmp/v npx vitest run tests/tools
 *   npx electron scripts/print-pdf.cjs /tmp/v/a.html /tmp/v/a.pdf
 *
 * Skipped when VISUAL_FILES is unset, so it costs the normal suite nothing.
 */
import { describe, it } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { getReader } from '../../src/core/readers'
import { detect } from '../../src/core/detect'
import { renderDocumentShell } from '../../src/core/shell'
import type { TargetFormat } from '../../src/core/types'

const OUT = process.env.VISUAL_OUT ?? ''
const FILES = (process.env.VISUAL_FILES ?? '').split('|').filter(Boolean)

describe('visual render harness', () => {
  it.skipIf(FILES.length === 0 || OUT === '')('renders the named sources to html', async () => {
    await mkdir(OUT, { recursive: true })
    for (const path of FILES) {
      const bytes = await readFile(path)
      const filename = basename(path)
      const det = detect(bytes, filename)
      if (det.kind !== 'ok') {
        console.log(`SKIP ${filename}: ${det.kind}`)
        continue
      }
      const hub = await getReader(det.format)({ bytes, filename })
      const stem = filename.slice(0, filename.length - extname(filename).length)
      const target = (process.env.VISUAL_TARGET ?? 'pdf') as TargetFormat
      await writeFile(join(OUT, `${stem}.html`), renderDocumentShell(hub, { target }), 'utf8')
      const tables = (hub.html.match(/<table/g) ?? []).length
      console.log(`${filename}: ${det.format}, ${hub.html.length} chars, ${tables} tables -> ${stem}.html`)
    }
  })
})
