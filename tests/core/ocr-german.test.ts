import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { ocrImage } from '../../src/ocr/pipeline'

/**
 * Recognition in a downloaded, non-English language.
 *
 * Skipped unless the German pack has actually been installed, because the
 * download is on demand by design and a test must not fetch a 1.5 MB model
 * behind the runner's back.
 *
 * The sentence is chosen for umlauts and an eszett: those are exactly what an
 * English model gets wrong, so a pass here means the German pack was really
 * used and not that English happened to cope.
 */
const USER_PACKS = join(homedir(), '.config', 'docconversion', 'ocr')
const GERMAN = join(USER_PACKS, 'deu.traineddata')

const SANS = 'Arial, "Liberation Sans", "DejaVu Sans", sans-serif'

function render(text: string): Buffer {
  const canvas = createCanvas(1400, 220)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, 1400, 220)
  ctx.fillStyle = '#000'
  ctx.font = `64px ${SANS}`
  ctx.fillText(text, 30, 130)
  return canvas.toBuffer('image/png')
}

describe.skipIf(!existsSync(GERMAN))('OCR in a downloaded language', () => {
  it('reads German umlauts the English model would mangle', async () => {
    const page = await ocrImage(render('Grüße über Straßen'), {
      langPath: USER_PACKS,
      language: 'deu',
      // Downloaded packs are NOT gzipped - upstream tessdata serves them
      // plain - while the bundled English pack is. Telling tesseract wrongly
      // is an ENOENT, which is how this failed the first time.
      gzip: false,
    })
    expect(page.text).toMatch(/Gr[üu][ßs]e/)
    expect(page.text).toMatch(/[üu]ber/)
    expect(page.text).toMatch(/Stra[ßs]en/)
  }, 120_000)
})
