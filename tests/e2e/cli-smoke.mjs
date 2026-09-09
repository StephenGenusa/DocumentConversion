/**
 * CLI smoke test (Windows-first — the console contract is fragile there).
 * Prereq: npm run build. Usage: node tests/e2e/cli-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The electron package exports the path to its own binary, which is
// `electron.exe` on Windows and `electron` everywhere else. This was hardcoded
// to the Windows name, so the whole smoke suite failed on Linux before running
// a single case - and failed obscurely, because spawnSync on a missing binary
// leaves res.stderr undefined and the reporter crashed trying to slice it.
const { default: electron } = await import('electron')
const appEntry = join(root, 'out', 'main', 'index.js')
const work = mkdtempSync(join(tmpdir(), 'docconv-cli-'))

let failures = 0
function run(name, args, { expectCode, expectFiles = [], expectStderr }) {
  const res = spawnSync(electron, [appEntry, 'convert', ...args], { encoding: 'utf8', timeout: 120000 })
  const problems = []
  if (res.error) problems.push(`could not run: ${res.error.message}`)
  if (res.status !== expectCode) problems.push(`exit ${res.status}, wanted ${expectCode}`)
  for (const f of expectFiles) if (!existsSync(f)) problems.push(`missing output ${f}`)
  if (expectStderr && !res.stderr.includes(expectStderr)) problems.push(`stderr missing "${expectStderr}"`)
  if (problems.length) {
    failures++
    console.log(`FAIL  ${name}: ${problems.join('; ')}\n  stderr: ${(res.stderr ?? '').slice(0, 300)}`)
  } else {
    console.log(`PASS  ${name}`)
  }
}

// fixtures
const md = join(work, 'spec.md')
writeFileSync(md, '# CLI Smoke\n\nHello from the **command line**.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n')
const md2 = join(work, 'notes.md')
writeFileSync(md2, '# Second\n\nAnother document body here.\n')

// 1. single convert, default out path (alongside input)
run('single md->html default out', [md, '--to', 'html'], {
  expectCode: 0,
  expectFiles: [join(work, 'spec.html')],
})

// 2. single convert to pdf with options
run('single md->pdf with flags', [md, '--to', 'pdf', '--out', join(work, 'spec.pdf'), '--scale', '1.25', '--page', 'A4', '--header-footer'], {
  expectCode: 0,
  expectFiles: [join(work, 'spec.pdf')],
})

// 3. batch to directory
const outDir = join(work, 'batch')
run('batch to dir', [md, md2, '--to', 'txt', '--out', outDir], {
  expectCode: 0,
  expectFiles: [join(outDir, 'spec.txt'), join(outDir, 'notes.txt')],
})

// 4. merge
run('merge to one docx', [md, md2, '--to', 'docx', '--merge', '--out', join(work, 'merged.docx')], {
  expectCode: 0,
  expectFiles: [join(work, 'merged.docx')],
})

// 5. csv extraction
run('md->csv table extraction', [md, '--to', 'csv', '--out', join(work, 'table.csv')], {
  expectCode: 0,
  expectFiles: [join(work, 'table.csv')],
})

// 6. --no-clobber refuses second write
run('no-clobber', [md, '--to', 'html', '--out', join(work, 'spec.html'), '--no-clobber'], {
  expectCode: 1,
  expectStderr: 'refusing to overwrite',
})

// 7. bad usage
run('bad usage exit 2', [md], { expectCode: 2, expectStderr: '--to is required' })

// 8. missing input
run('missing input exit 1', [join(work, 'nope.md'), '--to', 'html'], { expectCode: 1, expectStderr: 'ERROR' })

// content sanity
if (existsSync(join(work, 'spec.html'))) {
  const html = readFileSync(join(work, 'spec.html'), 'utf8')
  if (!html.includes('command line')) {
    failures++
    console.log('FAIL  spec.html content missing body text')
  }
}
if (existsSync(join(work, 'spec.pdf'))) {
  const head = readFileSync(join(work, 'spec.pdf')).subarray(0, 5).toString('latin1')
  if (head !== '%PDF-') {
    failures++
    console.log('FAIL  spec.pdf is not a PDF')
  }
}

console.log(failures ? `\n${failures} smoke check(s) failed` : '\nCLI smoke: all checks passed')
rmSync(work, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
