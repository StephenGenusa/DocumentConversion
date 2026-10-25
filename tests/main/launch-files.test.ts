import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pathsFromArgs, createOpenQueue } from '../../src/main/launch-files'

/**
 * Files the OS hands the app: dropped on its Dock or dock icon, dropped on its
 * shortcut, or chosen with Open With. They arrive as command-line arguments
 * (Windows, Linux) mixed with Chromium's own switches, or one at a time from
 * macOS, possibly before the window can take them.
 *
 * Real files in a real temp directory; nothing here is mocked.
 */
let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docconv-launch-'))
  file = join(dir, 'notes.md')
  await writeFile(file, '# notes')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('pathsFromArgs', () => {
  it('keeps an absolute path to a file', () => {
    expect(pathsFromArgs([file], '/')).toEqual([file])
  })

  it('drops switches, Chromium and AppImage alike', () => {
    expect(pathsFromArgs(['--no-sandbox', '--allow-file-access-from-files', file, '-psn_0_12345'], '/')).toEqual([file])
  })

  it('drops a folder: the dev launch `electron .` names the app folder', async () => {
    const sub = join(dir, 'sub')
    await mkdir(sub)
    expect(pathsFromArgs(['.', sub, file], dir)).toEqual([file])
  })

  it('drops a path that does not exist', () => {
    expect(pathsFromArgs([join(dir, 'gone.md'), file], '/')).toEqual([file])
  })

  it('resolves a relative path against the launching folder', () => {
    expect(pathsFromArgs(['notes.md'], dir)).toEqual([file])
  })

  it('reads a file:// URI, which a .desktop Exec %U passes', async () => {
    const spaced = join(dir, 'my notes.md')
    await writeFile(spaced, 'x')
    expect(pathsFromArgs([pathToFileURL(spaced).href], '/')).toEqual([spaced])
  })

  it('keeps the order given and drops a repeat', () => {
    const other = join(dir, 'a.txt')
    return writeFile(other, 'a').then(() => {
      expect(pathsFromArgs([other, file, other], '/')).toEqual([other, file])
    })
  })

  it('ignores a non-file URI', () => {
    expect(pathsFromArgs(['https://example.com/a.md', file], '/')).toEqual([file])
  })
})

describe('createOpenQueue', () => {
  it('holds paths until the window takes them, then hands them over once', () => {
    const sent: string[][] = []
    const q = createOpenQueue((p) => sent.push(p))
    q.add(['/a'])
    q.add(['/b'])
    expect(sent).toEqual([])
    expect(q.take()).toEqual(['/a', '/b'])
    expect(q.take()).toEqual([])
  })

  it('sends straight to a window that has taken its queue', () => {
    const sent: string[][] = []
    const q = createOpenQueue((p) => sent.push(p))
    q.take()
    q.add(['/a'])
    expect(sent).toEqual([['/a']])
    expect(q.take()).toEqual([])
  })

  it('queues again once the window is gone (macOS keeps running with none)', () => {
    const sent: string[][] = []
    const q = createOpenQueue((p) => sent.push(p))
    q.take()
    q.detach()
    q.add(['/a'])
    expect(sent).toEqual([])
    expect(q.take()).toEqual(['/a'])
  })

  it('ignores an empty add', () => {
    const sent: string[][] = []
    const q = createOpenQueue((p) => sent.push(p))
    q.take()
    q.add([])
    expect(sent).toEqual([])
  })
})
