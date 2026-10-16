/**
 * Math corpus harness (plan step 18): every formula in real documents is
 * drawn by MathJax in the real render host, or answers with a message the
 * conversion reports. None may vanish, hang or come back empty.
 *
 *   MATH_FILES="a.ipynb|b.md" npx vitest run tests/tools/math-corpus.test.ts
 *
 * The files are read with the app's own readers (detect + getReader), so the
 * spans are exactly the ones a conversion draws. Prints the count drawn and
 * every message, with no extra flags. Skipped when MATH_FILES is unset, or
 * with no display.
 */
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { parseDocument } from 'htmlparser2'
import { textContent } from 'domutils'
import { detect } from '../../src/core/detect'
import { getReader } from '../../src/core/readers'
import { carryDefinitions } from '../../src/core/tex-definitions'

const ROOT = resolve(__dirname, '..', '..')
const FILES = (process.env.MATH_FILES ?? '').split('|').filter(Boolean)
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
const FORMULA = /<pre><code class="language-math">([\s\S]*?)<\/code><\/pre>|<code class="language-math">([\s\S]*?)<\/code>/g

describe('math real-corpus check', () => {
  it.skipIf(FILES.length === 0 || !hasDisplay)('draws or reports every formula', async () => {
    // `drawn` as a conversion draws it: after the definitions earlier formulas of the same file made.
    const formulas: Array<{ file: string; source: string; display: boolean; drawn: string }> = []
    for (const file of FILES) {
      const bytes = await readFile(file)
      const det = detect(bytes, basename(file))
      if (det.kind !== 'ok') throw new Error(`${file}: ${det.kind}`)
      const { html } = await getReader(det.format)({ bytes, filename: basename(file) })
      const own: Array<{ file: string; source: string; display: boolean }> = []
      for (const m of html.matchAll(FORMULA)) {
        const display = m[1] !== undefined
        const source = textContent(parseDocument(display ? m[1] : m[2], { decodeEntities: true }))
        if (source.trim()) own.push({ file: basename(file), source, display })
      }
      const carried = carryDefinitions(own.map((f) => f.source))
      own.forEach((f, k) => formulas.push({ ...f, drawn: carried[k] }))
    }
    const dir = await mkdtemp(join(tmpdir(), 'docconv-math-corpus-'))
    try {
      const hostJs = join(dir, 'render-host.js')
      await build({ entryPoints: [join(ROOT, 'src/main/render-host.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: hostJs, logLevel: 'silent' })
      const list = join(dir, 'formulas.json')
      await writeFile(list, JSON.stringify(formulas.map(({ drawn, display }) => ({ source: drawn, display }))))
      const electron = require('electron') as unknown as string
      const stdout = await new Promise<string>((done, fail) =>
        execFile(
          electron,
          [join(__dirname, 'math-corpus-harness.cjs'), hostJs, join(ROOT, 'resources', 'render'), list],
          { cwd: ROOT, timeout: 600_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } },
          (err, out) => (err && !out.includes('RESULT ') ? fail(err) : done(out)),
        ),
      )
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '))
      if (!line) throw new Error(`no result from the harness:\n${stdout}`)
      const result = JSON.parse(line.slice(7)) as { fatal?: string; ms: number; results: Array<{ ok?: boolean; error?: string }>; requests: Array<{ url: string; allowed: boolean }> }
      if (result.fatal) throw new Error(result.fatal)
      const drawn = result.results.filter((r) => r.ok).length
      const reported = result.results.map((r, i) => ({ ...formulas[i], error: r.error })).filter((r) => r.error)
      // Straight to stdout: vitest 4 shows a passing test's console.log only
      // with --silent=false --reporter=verbose.
      process.stdout.write(
        `math corpus: ${formulas.length} spans in ${FILES.length} files; ${drawn} drawn, ${reported.length} reported, ${result.ms} ms\n` +
          reported.map((r) => `  ${r.file}: ${JSON.stringify(r.source)} -> ${r.error}`).join('\n') + '\n',
      )
      expect(result.results).toHaveLength(formulas.length)
      for (const r of result.results) expect(r.ok === true || (typeof r.error === 'string' && r.error.length > 0)).toBe(true)
      // Nothing fetched: the page and the one engine file, nothing more.
      expect(result.requests.every((r) => r.allowed)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 900_000)
})
