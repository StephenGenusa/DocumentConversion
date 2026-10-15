/**
 * Vendor the diagram and formula engines into resources/render/ (spec B5).
 *
 * The render host (src/main/render-host.ts) draws in a hidden, offline window
 * from a bundled page, resources/render/host.html, which loads each engine
 * from a file beside it the first time a block of that kind is drawn. The
 * engines are devDependencies: mermaid's package tree unpacks to well over a
 * hundred megabytes, and the build ships all of node_modules, so only the
 * single runtime file ships, the way resources/sqlite ships sql.js.
 *
 * Like the SQLite engine, the copies are committed, so the files a build
 * packages are the ones in the repository's history. Their SHA-256s are
 * pinned here. A digest that does not match fails, never warns: a different
 * file is not the engine that was reviewed and tested.
 *
 *   node scripts/build-render-assets.mjs           copy from node_modules, checked
 *   node scripts/build-render-assets.mjs --check   check the committed copies (run by `npm run build`)
 *
 * Moving to another release: change the version, run once to see the new
 * digest in the error, review, then pin it. MathJax joins this list in its
 * own step.
 */
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINES = [
  {
    pkg: 'mermaid',
    version: '11.12.0',
    from: 'dist/mermaid.min.js',
    to: 'mermaid.min.js',
    sha256: '07e37dfa97b337ccc85365d57eddf99b9706f09db3b59b260d0333b23b343c4b',
  },
  {
    // Graphviz 16.1.0 (EPL-2.0) and Expat 2.8.5 compiled to WebAssembly,
    // which the file carries inside it: one script, nothing else to load.
    pkg: '@viz-js/viz',
    version: '3.31.0',
    from: 'dist/viz-global.js',
    to: 'viz-global.js',
    sha256: 'c9e0b310f9883910e01c66054b48b7ff4be3d8695141116635e72b0af152692e',
  },
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'render')
const check = process.argv.includes('--check')

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

function fail(message) {
  console.error(`build-render-assets: ${message}`)
  process.exit(1)
}

if (!check) await mkdir(outDir, { recursive: true })

for (const engine of ENGINES) {
  const pkgDir = join(root, 'node_modules', engine.pkg)
  if (!check) {
    const version = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')).version
    if (version !== engine.version) fail(`node_modules/${engine.pkg} is ${version}; this script vendors ${engine.version}`)
  }
  const from = check ? join(outDir, engine.to) : join(pkgDir, engine.from)
  let digest
  try {
    digest = await sha256(from)
  } catch {
    fail(`${from} is missing${check ? ': run node scripts/build-render-assets.mjs' : ''}`)
  }
  if (digest !== engine.sha256) fail(`${from} has SHA-256 ${digest}, pinned ${engine.sha256}`)
  if (!check) {
    await copyFile(from, join(outDir, engine.to))
    await chmod(join(outDir, engine.to), 0o644)
  }
  console.log(`${engine.pkg} ${engine.version}: ${engine.to} ${check ? 'matches its pin' : `copied to ${outDir}`}`)
}
