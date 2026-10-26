import { open } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inlineImages, isRemoteImageSrc, isUncFileUrl, MAX_FETCHED_IMAGE_BYTES, type ImageFetcher } from './inline-images'
import { pictureMime } from './picture-types'
import type { ReadContext } from './types'

/**
 * Pictures a document names by path, embedded from disk.
 *
 * `![fig](assets/fig.svg)` names a file beside the document. A reader gets
 * bytes and a bare filename, so on its own it has nowhere to look and the
 * picture became its alt text. When the document came from a file, the app
 * and the command line put that file's folder in the read context
 * (`sourceDir`), and the readers whose syntax names pictures by path embed
 * them here, before they strip whatever is left unresolved.
 *
 * Any path Markdown can write is read: relative (`assets/a.png`,
 * `../img/a.png`), absolute (`/home/me/a.png`, `C:\pics\a.png`) and `file:`
 * URLs. Two limits stay:
 *
 * - Only local files. A network share (`\\host\share`, `file://host/…`) is a
 *   network connection, and on Windows hands the host the user's NTLM hash;
 *   web addresses are resolveRemoteImages' business, under Settings → Web.
 * - Only pictures. A file is embedded only if its bytes are an image
 *   (fetchedImageType), and only a regular file is opened, so a document
 *   cannot pull text off the disk, or read a device, through an <img>.
 *
 * A picture that is missing, unreadable or not an image becomes its
 * description, as a web picture that failed to arrive does. An SVG's own
 * pictures by path are read the same way, relative to the SVG.
 */

/** `C:\pics\a.png` or `C:/pics/a.png`: a Windows path, which the URL parser reads as a `c:` scheme. */
const DRIVE_PATH = /^[a-zA-Z]:[\\/]/

/** A source to look for on disk: not a data: URI, not a web address, not a network share. */
export function isLocalImageSrc(src: string): boolean {
  const s = src.trim()
  if (s === '' || /^data:/i.test(s)) return false
  return DRIVE_PATH.test(s) || !isRemoteImageSrc(s)
}

/** The file a resolved source names, or null when it is not a local file. */
function localPath(url: string): string | null {
  if (DRIVE_PATH.test(url)) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:' || isUncFileUrl(parsed)) return null
  try {
    return fileURLToPath(parsed)
  } catch {
    return null
  }
}

/** Reads a picture off the disk in place of a download, with the same size limit. */
const fileFetcher: ImageFetcher = async (url) => {
  const path = localPath(url)
  if (path === null) throw new Error('not a local file')
  const file = await open(path, 'r')
  try {
    // Stat and read through one descriptor: a FIFO or /dev/zero never ends.
    const info = await file.stat()
    if (!info.isFile()) throw new Error('not a file')
    if (info.size > MAX_FETCHED_IMAGE_BYTES) throw new Error('too large')
    const bytes = await file.readFile()
    // The bytes decide; an SVG has no signature, so it is offered as one and
    // fetchedImageType keeps it only if it opens like one.
    return { bytes, contentType: pictureMime(bytes) ?? 'image/svg+xml' }
  } finally {
    await file.close()
  }
}

/** The document's pictures by path, embedded from `ctx.sourceDir`; unchanged when there is no folder. */
export async function inlineLocalImages(html: string, ctx: Pick<ReadContext, 'sourceDir'> | undefined): Promise<string> {
  const dir = ctx?.sourceDir
  if (!dir || !/<img\b/i.test(html)) return html
  const base = pathToFileURL(dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}/`).href
  return inlineImages(html, base, fileFetcher, MAX_FETCHED_IMAGE_BYTES, undefined, isLocalImageSrc)
}
