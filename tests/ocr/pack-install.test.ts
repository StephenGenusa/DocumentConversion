import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { installPack, type PackFetch } from '../../src/ocr/pack-install'

// The installer builds its paths with the platform's separator, so the fake
// filesystem is addressed the same way: a literal FAST
// found nothing on Windows while the file was there under backslashes.
const DIR = '/packs'
const FAST = join(DIR, 'deu.traineddata')
const BEST = join(DIR, 'deu.best.traineddata')

const BODY = Buffer.from('pretend traineddata')
const DIGEST = createHash('sha256').update(BODY).digest('hex')

function fakeFs() {
  const files = new Map<string, Buffer>()
  return {
    files,
    writeFile: async (path: string, bytes: Buffer) => void files.set(path, bytes),
    rename: async (from: string, to: string) => {
      const b = files.get(from)
      if (!b) throw new Error('no such temp file')
      files.delete(from)
      files.set(to, b)
    },
    unlink: async (path: string) => void files.delete(path),
    mkdir: async () => {},
  }
}

const ok: PackFetch = async () => ({ ok: true, bytes: BODY })

/**
 * A traineddata file is a MODEL, not a resource: it decides how every document
 * a user converts is read. A corrupt or substituted one does not crash - it
 * quietly reads their documents wrong. So the download is checksum-gated, and
 * nothing reaches the language directory until it has passed.
 */
describe('installPack', () => {
  it('writes the pack once it verifies', async () => {
    const fs = fakeFs()
    const result = await installPack(
      { code: 'deu', set: 'fast', dir: DIR, sha256: DIGEST },
      { fetch: ok, fs },
    )
    expect(result.kind).toBe('ok')
    expect(fs.files.get(FAST)).toEqual(BODY)
  })

  it('refuses a pack whose checksum does not match', async () => {
    const fs = fakeFs()
    const result = await installPack(
      { code: 'deu', set: 'fast', dir: DIR, sha256: 'f'.repeat(64) },
      { fetch: ok, fs },
    )
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.message).toMatch(/checksum/i)
  })

  it('leaves NOTHING behind when the checksum fails', async () => {
    // A half-installed model is worse than none: the pipeline would load it.
    const fs = fakeFs()
    await installPack({ code: 'deu', set: 'fast', dir: DIR, sha256: 'f'.repeat(64) }, { fetch: ok, fs })
    expect([...fs.files.keys()]).toEqual([])
  })

  it('leaves nothing behind when the download fails', async () => {
    const fs = fakeFs()
    const result = await installPack(
      { code: 'deu', set: 'fast', dir: DIR, sha256: DIGEST },
      { fetch: async () => ({ ok: false, error: 'network unreachable' }), fs },
    )
    expect(result.kind).toBe('error')
    expect([...fs.files.keys()]).toEqual([])
  })

  it('writes to a temp name and renames, so a reader never sees a partial file', async () => {
    const seen: string[] = []
    const fs = fakeFs()
    const spy = {
      ...fs,
      writeFile: async (path: string, bytes: Buffer) => {
        seen.push(path)
        fs.files.set(path, bytes)
      },
    }
    await installPack({ code: 'deu', set: 'fast', dir: DIR, sha256: DIGEST }, { fetch: ok, fs: spy })
    expect(seen[0]).not.toBe(FAST)
    expect(seen[0]).toContain(join(DIR, ''))
    expect(fs.files.has(FAST)).toBe(true)
  })

  it('keeps the two model sets apart on disk', async () => {
    const fs = fakeFs()
    await installPack({ code: 'deu', set: 'best', dir: DIR, sha256: DIGEST }, { fetch: ok, fs })
    expect(fs.files.has(BEST)).toBe(true)
    expect(fs.files.has(FAST)).toBe(false)
  })

  it('refuses a language it does not know rather than fetching an arbitrary name', async () => {
    // The code becomes both a URL path segment and a filename.
    const fs = fakeFs()
    const result = await installPack(
      { code: '../../etc/passwd', set: 'fast', dir: DIR, sha256: DIGEST },
      { fetch: ok, fs },
    )
    expect(result.kind).toBe('error')
    expect([...fs.files.keys()]).toEqual([])
  })

  it('reports cancellation without leaving a file', async () => {
    const fs = fakeFs()
    const result = await installPack(
      { code: 'deu', set: 'fast', dir: DIR, sha256: DIGEST },
      { fetch: async () => ({ ok: false, error: 'cancelled', cancelled: true }), fs },
    )
    expect(result.kind).toBe('cancelled')
    expect([...fs.files.keys()]).toEqual([])
  })
})
