/*
 * A picture's type by its first bytes (a declared type or a name can lie),
 * for every picture type this app reads: pure, with no imports, so the
 * detector, the readers, the picture step and the metafile drawing code
 * can all ask it without importing one another.
 *
 *   imageMime    PNG, JPEG, GIF, WebP: what every target shows, and what
 *                an SVG may hold inside it
 *   pictureMime  those, and what Chromium decodes besides (BMP, AVIF, ICO),
 *                and TIFF (decoded by UTIF.js in the render host)
 *   vectorMime   EMF and WMF, Word's vector pictures (drawn by metafile/)
 *
 * HEIC (iPhone photos) is recognized only to be refused by name: Chromium
 * has no HEIC decoder, so no target could be given one.
 */

export function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a/.test(bytes.toString('latin1', 0, 6))) return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

/** The sizes a BMP's info header can have (BITMAPCOREHEADER to BITMAPV5HEADER, and OS/2's). */
const BMP_HEADERS = new Set([12, 16, 40, 52, 56, 64, 108, 124])

/**
 * An ISO media file's brands (its `ftyp` box: the major brand, then the
 * compatible ones), or null when it does not start with one.
 */
function ftypBrands(bytes: Buffer): string[] | null {
  if (bytes.length < 16 || bytes.toString('latin1', 4, 8) !== 'ftyp') return null
  const size = Math.min(bytes.readUInt32BE(0), bytes.length, 256)
  const brands = [bytes.toString('latin1', 8, 12)]
  for (let at = 16; at + 4 <= size; at += 4) brands.push(bytes.toString('latin1', at, at + 4))
  return brands
}

const AVIF_BRANDS = new Set(['avif', 'avis'])
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])

/** The picture's type, by its signature, for the types a browser decodes and TIFF. */
export function pictureMime(bytes: Buffer): string | null {
  const known = imageMime(bytes)
  if (known) return known
  // "BM", and an info header of a size BMP has: two letters alone open many a text file.
  if (bytes.length >= 26 && bytes.toString('latin1', 0, 2) === 'BM' && BMP_HEADERS.has(bytes.readUInt32LE(14))) return 'image/bmp'
  if (ftypBrands(bytes)?.some((b) => AVIF_BRANDS.has(b))) return 'image/avif'
  if (bytes.length >= 6 && bytes.readUInt32BE(0) === 0x00000100 && bytes.readUInt16LE(4) > 0) return 'image/x-icon'
  // TIFF, either byte order. Not BigTIFF (43), which UTIF.js does not read.
  if (bytes.length >= 8 && (bytes.toString('latin1', 0, 4) === 'II*\0' || bytes.toString('latin1', 0, 4) === 'MM\0*')) return 'image/tiff'
  return null
}

/**
 * Word's vector pictures, by signature: EMF (an EMR_HEADER record whose
 * signature is " EMF") and WMF (Aldus placeable, or a bare memory or disk
 * metafile header of nine words).
 */
export function vectorMime(bytes: Buffer): string | null {
  if (bytes.length >= 88 && bytes.readUInt32LE(0) === 1 && bytes.readUInt32LE(40) === 0x464d4520) return 'image/x-emf'
  if (bytes.length >= 22 && bytes.readUInt32LE(0) === 0x9ac6cdd7) return 'image/x-wmf'
  if (bytes.length >= 18 && [1, 2].includes(bytes.readUInt16LE(0)) && bytes.readUInt16LE(2) === 9 && [0x100, 0x300].includes(bytes.readUInt16LE(4))) {
    return 'image/x-wmf'
  }
  return null
}

/** Every picture type this app recognizes, by its bytes. */
export function pictureType(bytes: Buffer): string | null {
  return pictureMime(bytes) ?? vectorMime(bytes)
}

/** A HEIC or HEIF picture (not AVIF, which shares the container). */
export function isHeic(bytes: Buffer): boolean {
  const brands = ftypBrands(bytes)
  return !!brands && !brands.some((b) => AVIF_BRANDS.has(b)) && brands.some((b) => HEIF_BRANDS.has(b))
}
