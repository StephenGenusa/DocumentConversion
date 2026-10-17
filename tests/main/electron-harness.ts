import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Runs an Electron harness (a .cjs that ends with harness-result.cjs's
 * writeResult) and returns what it wrote, read once the child has exited.
 * Its output is only shown when there is no result, to say why.
 */
export async function runHarness<T>(args: string[], options: { cwd: string; timeout: number }): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'docconv-harness-'))
  try {
    const file = join(dir, 'result.json')
    const electron = require('electron') as unknown as string
    const failure = await new Promise<string | null>((resolvePromise) => {
      execFile(
        electron,
        [...args, file],
        { cwd: options.cwd, timeout: options.timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } },
        (err, stdout, stderr) => resolvePromise(err ? `${err.message}\n${stdout}\n${stderr}` : null),
      )
    })
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      throw new Error(`no result from the harness:\n${failure ?? '(it exited without writing one)'}`)
    }
    return JSON.parse(text) as T
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
