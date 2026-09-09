/**
 * EPUB corpus harness — writes real documents out as epub and reads them back,
 * reporting chapter and image counts and how much text survived.
 *
 * The round trip is the strongest cheap validity check available: epubcheck is
 * a Java tool and not worth a dependency, but an epub this app writes must be
 * one this app can read. Note that "text kept" is measured on letters only, so
 * an entity in the hub (&quot;) against the character it denotes (") in the
 * output reads as a small shortfall without anything being lost.
 *
 *   EPUB_FILES="a.pdf|b.docx" EPUB_OUT=/tmp/e npx vitest run tests/tools/zz-epub-check.test.ts
 *
 * Skipped when EPUB_FILES is unset, so it costs the normal suite nothing.
 */
import { describe, it, expect } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { detect } from '../../src/core/detect'
import { getReader } from '../../src/core/readers'
import { writeEpub } from '../../src/core/writers/epub'
import { readEpub } from '../../src/core/readers/epub'

const OUT = process.env.EPUB_OUT ?? ''
const FILES = (process.env.EPUB_FILES ?? '').split('|').filter(Boolean)

/**
 * How much of the hub's text may go missing on the round trip before the
 * document counts as damaged. It is not 100%: entity spellings differ either
 * way across the trip (`&quot;` in the hub against `"` in the output), which
 * reads as a shortfall of a few characters per document without anything
 * being lost. It is nowhere near 0% either, which is what a broken writer or
 * an unreadable epub produces.
 */
const MIN_TEXT_KEPT = 0.9

describe('epub real-corpus check', () => {
  it.skipIf(FILES.length === 0)('writes and re-reads real documents', async () => {
    await mkdir(OUT, { recursive: true })
    // Every file is measured before anything is asserted, so one run names
    // every damaged document rather than stopping at the first.
    const failures: string[] = []
    let checked = 0

    for (const path of FILES) {
      const bytes = await readFile(path)
      const det = detect(bytes, path.split(/[\\/]/).pop())
      if (det.kind !== 'ok') {
        console.log(`SKIP ${path}: ${det.kind}`)
        continue
      }
      const hub = await getReader(det.format)({ bytes, filename: path.split(/[\\/]/).pop() })
      const epub = await writeEpub(hub)
      const name = `${path.split(/[\\/]/).pop()}.epub`
      await writeFile(join(OUT, name), epub)

      const zip = await JSZip.loadAsync(epub)
      const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
      const chapters = files.filter((n) => /ch\d+\.xhtml$/.test(n)).length
      const images = files.filter((n) => n.startsWith('OEBPS/images/')).length
      const back = await readEpub({ bytes: epub, filename: name })

      const strip = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const before = strip(hub.html).length
      const after = strip(back.html).length
      const kept = before === 0 ? 1 : after / before
      console.log(
        `${det.format.padEnd(6)} ${String(chapters).padStart(3)} ch ${String(images).padStart(3)} img ` +
          `${(epub.length / 1024).toFixed(0).padStart(6)}KB  text kept ${(kept * 100).toFixed(1)}%  ${name}`,
      )

      // The reported numbers are the check, so they have to be checked.
      checked++
      const say = (problem: string): number => failures.push(`${name}: ${problem}`)
      if (!files.includes('META-INF/container.xml')) say('no META-INF/container.xml')
      if (chapters === 0) say('wrote no chapters')
      if (before > 0 && kept < MIN_TEXT_KEPT) {
        say(`kept only ${(kept * 100).toFixed(1)}% of ${before} characters of text`)
      }
      // An epub whose images the reader cannot find back is a silent loss the
      // text ratio does not see.
      const hubImages = (hub.html.match(/<img\b/g) ?? []).length
      if (hubImages > 0 && images === 0) say(`hub had ${hubImages} images, the epub has none`)
      if (images > 0 && !/<img\b/.test(back.html)) say(`${images} images written, none read back`)
    }

    expect(failures).toEqual([])
    // A corpus run that quietly examined nothing is not a passing run.
    expect(checked, 'no file in EPUB_FILES could be read at all').toBeGreaterThan(0)
  }, 900000)
})
