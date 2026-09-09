import JSZip from 'jszip'
import { ConversionError } from './errors'

export interface ArchiveEntry {
  filename: string
  bytes: Buffer
}

export const MAX_ARCHIVE_ENTRIES = 100
export const MAX_ARCHIVE_ENTRY_BYTES = 50 * 1024 * 1024
/** Ceiling on everything one archive may expand to, so 100 near-cap entries cannot add up to 5 GB. */
export const MAX_ARCHIVE_TOTAL_BYTES = 200 * 1024 * 1024

/**
 * A zip entry name is nominally '/'-separated, but the format does not forbid a
 * backslash and Windows tools write them, so both are separators here. Splitting
 * on only one of them is how a name like `..\..\x` survives as a single
 * "basename".
 */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]/)
}

/** Archive junk and hidden files never belong in a conversion list. */
function isSkippable(path: string): boolean {
  if (/^__MACOSX([\\/]|$)/.test(path)) return true
  return segmentsOf(path).some((segment) => segment.startsWith('.'))
}

/**
 * Names no honest archive contains, refused rather than repaired: anything
 * rooted at a drive, a share or the filesystem root, and anything that climbs
 * with '..'. Reducing such a name to its basename would usually be safe, but
 * "usually" is not what a traversal guard is for, and a name shaped like
 * `C:\Windows\x` would still be carried as a filename into the writers.
 */
export function isUnsafeArchivePath(path: string): boolean {
  if (/^[\\/]/.test(path)) return true // /etc/passwd, \\server\share\x
  if (/^[A-Za-z]:/.test(path)) return true // C:\x and the C:x drive-relative form
  return segmentsOf(path).some((segment) => segment === '.' || segment === '..')
}

/**
 * Windows refuses, or worse silently redirects, some names a zip may carry: a
 * reserved device name (`NUL.pdf` opens the NUL device and the write "succeeds"
 * with no file), a colon (`a:b.pdf` writes an NTFS alternate data stream), and
 * the `<>"|?*` and control characters. The output path is built from this
 * basename, so make it a plain filename before it gets there.
 */
export function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  let out = name.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(out)) out = `_${out}`
  return out || '_'
}

/**
 * Inflate one entry, stopping the moment it exceeds `limit`. The central
 * directory's size claim is checked before this is called, but it can lie
 * DOWNWARD — declare 100 bytes and hold 60 MB — and `file.async()` would then
 * inflate all of it into memory before anyone could look at the length. Deflate
 * reaches ~1000:1, so a few megabytes on disk can drive the main process into a
 * multi-gigabyte allocation. Reading through the stream and counting is the
 * only place the real length can be seen in time.
 *
 * Returns null for an entry that is over the limit or that JSZip cannot inflate
 * (its own end-of-stream length check is one such failure); the caller skips
 * that entry and keeps the rest of the archive.
 */
function inflateBounded(file: JSZip.JSZipObject, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const stream = file.nodeStream('nodebuffer')
    const finish = (value: Buffer | null): void => {
      if (done) return
      done = true
      resolve(value)
    }
    stream.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        // Over the ceiling mid-stream: stop reading. One deflate block inflates
        // synchronously inside the inflater, so the overshoot is bounded by a
        // block, not by the entry.
        finish(null)
        ;(stream as unknown as { destroy(): void }).destroy()
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', () => finish(null))
    stream.on('end', () => finish(Buffer.concat(chunks)))
  })
}

/**
 * Expand a ZIP into its file entries so they can join the multi-input list
 * (spec F17). Nested archives are not recursed.
 */
export async function expandZipArchive(bytes: Buffer): Promise<ArchiveEntry[]> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (err) {
    throw new ConversionError('read-failed', `Could not read archive: ${(err as Error).message}`)
  }
  const entries: ArchiveEntry[] = []
  // Zip-slip is defeated by `isUnsafeArchivePath` above, which refuses the dangerous
  // names outright; flattening what is left to a basename is a separate,
  // presentational step, and it means two entries from different folders can
  // collide. Batch output would then overwrite one with the other, so
  // disambiguate here.
  const used = new Set<string>()
  let spent = 0
  for (const [path, file] of Object.entries(zip.files)) {
    if (entries.length >= MAX_ARCHIVE_ENTRIES) break
    if (file.dir || isSkippable(path) || isUnsafeArchivePath(path)) continue

    // A zip bomb is a few kilobytes on disk and gigabytes once expanded, so a
    // size cap applied to the decompressed result has already paid the cost it
    // existed to avoid. The central directory declares the expanded size; read
    // that first and decline before doing any work. It can of course lie, so
    // the real length is checked again below.
    const claim = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    if (claim > MAX_ARCHIVE_ENTRY_BYTES) continue
    if (spent + claim > MAX_ARCHIVE_TOTAL_BYTES) break

    // Whichever ceiling is nearer: the entry's own, or what is left of the
    // archive's. A header that lied downward is caught here, mid-stream.
    const content = await inflateBounded(file, Math.min(MAX_ARCHIVE_ENTRY_BYTES, MAX_ARCHIVE_TOTAL_BYTES - spent))
    if (content === null) continue
    spent += Math.max(claim, content.byteLength)

    const base = safeFilename(segmentsOf(path).pop() || path)
    let filename = base
    if (used.has(filename)) {
      const dot = base.lastIndexOf('.')
      const stem = dot > 0 ? base.slice(0, dot) : base
      const ext = dot > 0 ? base.slice(dot) : ''
      for (let i = 2; used.has(filename); i++) filename = `${stem}-${i}${ext}`
    }
    used.add(filename)
    entries.push({ filename, bytes: content })
  }
  return entries
}
