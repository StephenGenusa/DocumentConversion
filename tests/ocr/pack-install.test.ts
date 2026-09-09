import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { installPack, type PackFetch } from '../../src/ocr/pack-install'

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
      { code: 'deu', set: 'fast', dir: '/packs', sha256: DIGEST },
      { fetch: ok, fs },
    )
    expect(result.kind).toBe('ok')
    expect(fs.files.get('/packs/deu.traineddata')).toEqual(BODY)
  })

  it('refuses a pack whose checksum does not match', async () => {
    const fs = fakeFs()
    const result = await installPack(
      { code: 'deu', set: 'fast', dir: '/packs', sha256: 'f'.repeat(64) },
      { fetch: ok, fs },
    )
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.message).toMatch(/checksum/i)
  })

  it('leaves NOTHING behind when the checksum fails', async () => {
    // A half-installed model is worse than none: the pipeline would load it.
    const fs = fakeFs()
    await installPack({ code: 'deu', set: 'fast', dir: '/packs', sha256: 'f'.repeat(64) }, { fetch: ok, fs })
    expect([...fs.files.keys()]).toEqual([])
  })

  it('leaves nothing behind when the download fails', async () => {
    const fs = fakeFs()
    const result = await installPack(
      { code: 'deu', set: 'fast', dir: '/packs', sha256: DIGEST },
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
    await installPack({ code: 'deu', set: 'fast', dir: '/packs', sha256: DIGEST }, { fetch: ok, fs: spy })
    expect(seen[0]).not.toBe('/packs/deu.traineddata')
    expect(seen[0]).toContain('/packs/')
    expect(fs.files.has('/packs/deu.traineddata')).toBe(true)
  })

  it('keeps the two model sets apart on disk', async () => {
    const fs = fakeFs()
    await installPack({ code: 'deu', set: 'best', dir: '/packs', sha256: DIGEST }, { fetch: ok, fs })
    expect(fs.files.has('/packs/deu.best.traineddata')).toBe(true)
    expect(fs.files.has('/packs/deu.traineddata')).toBe(false)
  })

  it('refuses a language it does not know rather than fetching an arbitrary name', async () => {
    // The code becomes both a URL path segment and a filename.
    const fs = fakeFs()
    const result = await installPack(
      { code: '../../etc/passwd', set: 'fast', dir: '/packs', sha256: DIGEST },
      { fetch: ok, fs },
    )
    expect(result.kind).toBe('error')
    expect([...fs.files.keys()]).toEqual([])
  })

  it('reports cancellation without leaving a file', async () => {
    const fs = fakeFs()
    const result = await installPack(
      { code: 'deu', set: 'fast', dir: '/packs', sha256: DIGEST },
      { fetch: async () => ({ ok: false, error: 'cancelled', cancelled: true }), fs },
    )
    expect(result.kind).toBe('cancelled')
    expect([...fs.files.keys()]).toEqual([])
  })
})
