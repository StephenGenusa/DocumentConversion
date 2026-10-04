import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { ConversionError } from '../core/errors'

/**
 * The way back to a file on disk.
 *
 * An input used to be read exactly once, when it was dropped or opened, and
 * the renderer kept those bytes and sent them with every conversion. Convert,
 * edit the file in another program, convert again: the second output was the
 * first version, with nothing on screen to say so. Nothing could have re-read
 * it either, because only the file's folder was kept, not its path.
 *
 * So the main process keeps the path and hands the renderer a token for it.
 * A conversion that names a token is run on what the file holds NOW. The
 * renderer never holds the path itself: a token can only ever lead back to a
 * file the user already gave the app.
 *
 * Deliberately Electron-free, so it is tested against real files.
 */
const paths = new Map<string, string>()

/** Remember a path and return the token the renderer refers to it by. */
export function registerPath(path: string): string {
  const handle = randomUUID()
  paths.set(handle, path)
  return handle
}

/**
 * What a file looked like when it was read: enough to tell, later, whether it
 * has been written since. Opaque to the renderer, which only compares two.
 */
const stampFrom = (info: { mtimeMs: number; size: number }): string => `${info.mtimeMs}:${info.size}`

/**
 * Read the file as it is now, with the stamp those bytes were read at.
 *
 * A file that has gone is an ERROR, by name. Falling back to bytes captured
 * earlier would put the stale-output bug straight back, just for the one case
 * where the user is least likely to notice.
 */
export async function readHandle(handle: string): Promise<{ bytes: Buffer; stamp: string }> {
  const path = paths.get(handle)
  if (path === undefined) {
    throw new ConversionError('source-missing', 'This input is no longer available. Add the file again.')
  }
  const name = basename(path)
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, 'r')
    // Stat and read through one descriptor, so the stamp describes these bytes
    // and not whatever replaced them a moment later.
    const info = await file.stat()
    return { bytes: await file.readFile(), stamp: stampFrom(info) }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ConversionError(
        'source-missing',
        `${name} is no longer at ${path}. It was moved, renamed or deleted after it was added. Add it again to convert it.`,
      )
    }
    throw new ConversionError('source-missing', `${name} could not be read from ${path}: ${(err as Error).message}`)
  } finally {
    await file?.close()
  }
}

/** The file's stamp now, or null when it is gone or the token is unknown. */
export async function stampOf(handle: string): Promise<string | null> {
  const path = paths.get(handle)
  if (path === undefined) return null
  try {
    return stampFrom(await stat(path))
  } catch {
    return null
  }
}

/**
 * The bytes a conversion runs on: the file on disk when the input has one,
 * otherwise what the request carried (pasted text, a download, a zip entry,
 * or a document edited in the pane - none of which has a file to go back to).
 */
export async function inputBytes(input: { base64: string; handle?: string }): Promise<Buffer> {
  if (input.handle) return (await readHandle(input.handle)).bytes
  return Buffer.from(input.base64, 'base64')
}
