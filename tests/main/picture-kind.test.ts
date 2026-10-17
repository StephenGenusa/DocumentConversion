import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

/**
 * The Automatic picture format's rule (resources/render/picture-kind.js),
 * the plain script the render host's page loads beside host.js. Here it is
 * given generated pixels, as the page gives it a decoded picture's.
 */
const require = createRequire(import.meta.url)
const { pictureKind } = require(resolve(__dirname, '..', '..', 'resources', 'render', 'picture-kind.js')) as {
  pictureKind: (rgba: Uint8ClampedArray, width: number, height: number, type?: string) => { format: 'png' | 'jpeg'; reason: string }
}

type Pixel = [number, number, number, number?]

function picture(width: number, height: number, pixel: (x: number, y: number) => Pixel): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = pixel(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return data
}

/** A repeatable stream of numbers in [0, 1), so every run sees the same pictures. */
function random(seed: number): () => number {
  // xorshift32: small, and the same everywhere.
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 2 ** 32
  }
}

const kind = (w: number, h: number, pixel: (x: number, y: number) => Pixel, type = 'image/webp') => pictureKind(picture(w, h, pixel), w, h, type)

describe('pictureKind (the Automatic picture format)', () => {
  // Photographs: every pixel a little different from its neighbors.
  const noise = random(1)
  const photoNoise = kind(640, 480, () => [noise() * 256, noise() * 256, noise() * 256])
  const smooth = random(2)
  // A sky-to-ground scene: a gradient in two directions with sensor noise.
  const photoScene = kind(800, 600, (x, y) => {
    const n = (smooth() - 0.5) * 12
    return [90 + (x / 800) * 80 + n, 140 + (y / 600) * 60 + n, 220 - (y / 600) * 150 + n]
  })
  const horizontalGradient = kind(1024, 256, (x) => [x / 4, 255 - x / 4, 128])
  const verticalGradient = kind(256, 1024, (_, y) => [y / 4, y / 4, y / 4])
  const grayNoise = random(3)
  const grayPhoto = kind(500, 500, (x, y) => {
    const v = 60 + ((x * 3 + y * 2) % 120) + grayNoise() * 30
    return [v, v, v]
  })

  // Drawn pictures: large areas of one color.
  const textNoise = random(4)
  const screenshot = kind(1280, 800, (x, y) => {
    if (y < 40) return [236, 236, 236] // a toolbar
    if (x < 220) return [246, 247, 249] // a sidebar
    if (y > 100 && y < 140 && x > 260 && x < 380) return [37, 99, 235] // a button
    // Lines of text: dark glyphs with anti-aliased edges, one pixel in twelve.
    if (y % 24 > 6 && y % 24 < 18 && x > 260 && x < 1200 && textNoise() < 0.25) {
      const v = Math.floor(textNoise() * 200)
      return [v, v, v + 10]
    }
    return [255, 255, 255]
  })
  const lineArt = kind(900, 600, (x, y) => {
    // A circle and two lines, anti-aliased by distance.
    const d = Math.min(Math.abs(Math.hypot(x - 450, y - 300) - 200), Math.abs(x - y), Math.abs(x + y - 900))
    const v = d < 1 ? 0 : d < 2 ? 128 : 255
    return [v, v, v]
  })
  const diagram = kind(700, 500, (x, y) => {
    if (x > 50 && x < 250 && y > 50 && y < 150) return [255, 230, 153]
    if (x > 400 && x < 650 && y > 300 && y < 450) return [173, 216, 230]
    if (y === 100 && x >= 250 && x <= 400) return [0, 0, 0]
    return [255, 255, 255]
  })
  const transparent = kind(320, 240, (x, y) => [x % 256, y % 256, (x * y) % 256, x === 7 && y === 9 ? 0 : 255])
  const bilevel = kind(600, 800, (x, y) => ((x >> 3) + (y >> 4)) % 5 === 0 ? [0, 0, 0] : [255, 255, 255])
  const paper = random(5)
  // A grayscale scan of a typed page: paper that is never quite one white, and text.
  const scan = kind(850, 1100, (x, y) => {
    const ink = y % 30 < 12 && x > 80 && x < 770 && (x * 7 + y) % 11 < 4
    const v = ink ? 20 + paper() * 40 : 235 + paper() * 20
    return [v, v, v + paper() * 6]
  })
  const gifNoise = random(6)
  const gifPhoto = kind(300, 200, () => [gifNoise() * 256, gifNoise() * 256, gifNoise() * 256], 'image/gif')
  const tinyPhoto = kind(4, 4, (x, y) => [200, (x * 61 + y * 17) % 256, (x * 29 + y * 83) % 256])

  it('makes photographs JPG: noise, gradients and a noisy scene', () => {
    expect(photoNoise).toEqual({ format: 'jpeg', reason: 'photo' })
    expect(photoScene).toEqual({ format: 'jpeg', reason: 'photo' })
    expect(horizontalGradient).toEqual({ format: 'jpeg', reason: 'photo' })
    expect(verticalGradient).toEqual({ format: 'jpeg', reason: 'photo' })
    expect(grayPhoto).toEqual({ format: 'jpeg', reason: 'photo' })
    expect(tinyPhoto).toEqual({ format: 'jpeg', reason: 'photo' })
  })

  it('makes screenshots, line art and diagrams PNG', () => {
    expect(screenshot).toEqual({ format: 'png', reason: 'flat' })
    expect(lineArt).toEqual({ format: 'png', reason: 'few colors' })
    expect(diagram).toEqual({ format: 'png', reason: 'few colors' })
  })

  it('makes a picture with see-through parts, a bilevel picture, a scan and a GIF PNG', () => {
    expect(transparent).toEqual({ format: 'png', reason: 'transparent' })
    expect(bilevel).toEqual({ format: 'png', reason: 'few colors' })
    expect(scan).toEqual({ format: 'png', reason: 'bilevel' })
    expect(gifPhoto).toEqual({ format: 'png', reason: 'gif' })
  })

  it('answers the same for the same pixels', () => {
    const pixels = picture(640, 480, (x, y) => [(x * 13) % 256, (y * 7) % 256, (x ^ y) % 256])
    const first = pictureKind(pixels, 640, 480, 'image/bmp')
    for (let i = 0; i < 3; i++) expect(pictureKind(pixels, 640, 480, 'image/bmp')).toEqual(first)
  })
})
