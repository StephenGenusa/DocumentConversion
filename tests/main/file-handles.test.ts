import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, utimes, unlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPath, readHandle, stampOf, inputBytes } from '../../src/main/file-handles'
import { ConversionError } from '../../src/core/errors'

/**
 * A file added to the app used to be read once, when it was dropped, and those
 * bytes were converted every time after that. Edit the file, convert again,
 * and the output was the old version with nothing to say so.
 *
 * The handle is what lets a conversion go back to the disk: the main process
 * keeps the path, the renderer holds only a token for it.
 *
 * Real files in a real temp directory; nothing here is mocked.
 */
let dir: string
let file: string

/** Rewrite with an explicit mtime, so a test never depends on clock resolution. */
async function rewrite(content: string, secondsLater: number): Promise<void> {
  await writeFile(file, content)
  const when = new Date(Date.UTC(2026, 0, 1, 0, 0, secondsLater))
  await utimes(file, when, when)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docconv-handles-'))
  file = join(dir, 'notes.md')
  await rewrite('# first', 0)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('reading through a handle', () => {
  it('returns what is on disk now, not what was there when the file was added', async () => {
    const handle = registerPath(file)
    expect((await readHandle(handle)).bytes.toString()).toBe('# first')
    await rewrite('# second', 5)
    expect((await readHandle(handle)).bytes.toString()).toBe('# second')
  })

  it('does not put the path in the token the renderer holds', () => {
    const handle = registerPath(file)
    expect(handle).not.toContain('notes')
    expect(handle).not.toContain(dir)
  })

  it('gives each registration its own token', () => {
    expect(registerPath(file)).not.toBe(registerPath(file))
  })
})

describe('a file that is gone at convert time', () => {
  it('fails by name instead of converting the bytes it had', async () => {
    const handle = registerPath(file)
    await unlink(file)
    const err = await readHandle(handle).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConversionError)
    expect((err as ConversionError).code).toBe('source-missing')
    expect((err as Error).message).toContain('notes.md')
    expect((err as Error).message).toMatch(/moved, renamed or deleted/)
  })

  it('says so when the path has become something unreadable', async () => {
    const handle = registerPath(file)
    await unlink(file)
    await mkdir(file)
    const err = await readHandle(handle).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConversionError)
    expect((err as ConversionError).code).toBe('source-missing')
    expect((err as Error).message).toContain('notes.md')
  })

  it('refuses a token it never issued', async () => {
    const err = await readHandle('not-a-handle').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConversionError)
    expect((err as ConversionError).code).toBe('source-missing')
  })
})

describe('noticing a change on disk', () => {
  it('reports the same stamp while the file is untouched', async () => {
    const handle = registerPath(file)
    expect(await stampOf(handle)).toBe(await stampOf(handle))
  })

  it('reports a different stamp once the file is rewritten', async () => {
    const handle = registerPath(file)
    const before = await stampOf(handle)
    await rewrite('# other', 5)
    expect(await stampOf(handle)).not.toBe(before)
  })

  it('hands back, with the bytes, the stamp those bytes were read at', async () => {
    const handle = registerPath(file)
    expect((await readHandle(handle)).stamp).toBe(await stampOf(handle))
  })

  it('has no stamp for a file that is gone, or a token it never issued', async () => {
    const handle = registerPath(file)
    await unlink(file)
    expect(await stampOf(handle)).toBeNull()
    expect(await stampOf('not-a-handle')).toBeNull()
  })
})

describe('the bytes a conversion runs on', () => {
  const b64 = (s: string): string => Buffer.from(s).toString('base64')

  it('come from disk when the input has a handle, whatever bytes were sent along', async () => {
    const handle = registerPath(file)
    await rewrite('# fresh', 5)
    expect((await inputBytes({ base64: b64('# stale'), handle })).toString()).toBe('# fresh')
  })

  it('come from the request when the input has no file behind it', async () => {
    expect((await inputBytes({ base64: b64('pasted') })).toString()).toBe('pasted')
  })

  it('never fall back to the sent bytes when the file is gone', async () => {
    const handle = registerPath(file)
    await unlink(file)
    await expect(inputBytes({ base64: b64('# stale'), handle })).rejects.toBeInstanceOf(ConversionError)
  })
})
