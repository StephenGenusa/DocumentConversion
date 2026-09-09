import { fileURLToPath } from 'node:url'

/**
 * Convert a single `file://` URI to a filesystem path.
 *
 * Node's `fileURLToPath` is host-platform specific: on Windows it rejects
 * POSIX-style URIs (`file:///home/x/a.md`) because they lack a drive letter.
 * Fall back to a manual decode so a URI is always handled the same way
 * regardless of where the app runs.
 */
function fileUriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri)
  } catch {
    try {
      const u = new URL(uri)
      if (u.protocol !== 'file:') return null
      let p = decodeURIComponent(u.pathname)
      // `/C:/x/a.md` → `C:/x/a.md`
      if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1)
      return p
    } catch {
      return null
    }
  }
}

/**
 * Parse a `text/uri-list` payload (one URI per line, `#` comments allowed) and
 * return the filesystem paths of every `file://` entry, in order.
 */
export function allFileUrisToPaths(uriList: string): string[] {
  const paths: string[] = []
  for (const line of uriList.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    if (/^file:\/\//i.test(s)) {
      const p = fileUriToPath(s)
      if (p) paths.push(p)
    }
  }
  return paths
}

/** First `file://` entry of a `text/uri-list`, or null. */
export function firstFileUriToPath(uriList: string): string | null {
  return allFileUrisToPaths(uriList)[0] ?? null
}
