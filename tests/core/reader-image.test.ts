import { describe, it, expect } from 'vitest'
import { readImage } from '../../src/core/readers/image'
import { detect } from '../../src/core/detect'

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const GIF_HEAD = Buffer.from('GIF89a......', 'latin1')
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

describe('image detection', () => {
  it('detects png/jpeg/gif/webp by magic', () => {
    expect(detect(PNG)).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(JPEG_HEAD)).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(GIF_HEAD)).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(WEBP_HEAD)).toEqual({ kind: 'ok', format: 'image' })
  })
  it('detects by extension too', () => {
    expect(detect(PNG, 'shot.png')).toEqual({ kind: 'ok', format: 'image' })
    expect(detect(JPEG_HEAD, 'photo.jpg')).toEqual({ kind: 'ok', format: 'image' })
  })
})

describe('readImage (embed mode)', () => {
  it('embeds the image as a data URI with the right mime', async () => {
    const hub = await readImage({ bytes: PNG, filename: 'shot.png' })
    expect(hub.html).toContain('<img src="data:image/png;base64,')
    expect(hub.html).toContain(PNG.toString('base64'))
    expect(hub.title).toBe('shot.png')
  })
  it('rejects unknown image bytes', async () => {
    await expect(readImage({ bytes: Buffer.from('not an image') })).rejects.toMatchObject({
      code: 'image-unsupported',
    })
  })
})

/**
 * The alt text is an ATTRIBUTE, and a filename is user data: a name holding a
 * double quote used to close the attribute early and let the rest of the name
 * be parsed as markup.
 */
describe('readImage attribute safety', () => {
  it('escapes a quote in the filename instead of breaking out of alt', async () => {
    const hub = await readImage({ bytes: PNG, filename: 'a" onerror="alert(1)".png' })
    expect(hub.html).not.toContain('onerror="')
    expect(hub.html).toContain('&quot;')
    expect(hub.html).toMatch(/^<img src="data:image\/png;base64,[^"]+" alt="[^"]*">$/)
  })
})
