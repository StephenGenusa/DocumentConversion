/**
 * Vendor the sql.js engine into resources/sqlite/ (spec D13).
 *
 * The app runs SQLite in a worker thread from two files: the wasm build of
 * SQLite and its JavaScript loader. sql.js is a devDependency, because the
 * package unpacks to 24 MB and the build ships all of node_modules; only these
 * two files ship, the way resources/ocr ships one file of tessdata.
 *
 * Like the OCR data, the copies are committed, so the files a build packages
 * are the ones in the repository's history. Their SHA-256s are pinned here.
 * A digest that does not match fails, never warns: a different file is not the
 * engine that was reviewed and tested.
 *
 *   node scripts/build-sqlite-assets.mjs           copy from node_modules, checked
 *   node scripts/build-sqlite-assets.mjs --check   check the committed copies (run by `npm run build`)
 *
 * Moving to another sql.js release: change VERSION, run once without the pins
 * matching to see the new digests, review, then pin them.
 */
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.14.2'
const PINNED = {
  'sql-wasm.js': 'f1c84000dbc856c9d87f4f3aabc4d3654bd436165db4be3da13751db3a9c20d7',
  'sql-wasm.wasm': '38c14f6e379210bc942bdc4ebca44e7bfdb4318ecc1c72ca666a28fdce96670a',
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(root, 'node_modules', 'sql.js')
const outDir = join(root, 'resources', 'sqlite')
const check = process.argv.includes('--check')

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

function fail(message) {
  console.error(`build-sqlite-assets: ${message}`)
  process.exit(1)
}

if (!check) {
  const version = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')).version
  if (version !== VERSION) fail(`node_modules/sql.js is ${version}; this script vendors ${VERSION}`)
  await mkdir(outDir, { recursive: true })
}

for (const [name, pinned] of Object.entries(PINNED)) {
  const from = check ? join(outDir, name) : join(pkgDir, 'dist', name)
  let digest
  try {
    digest = await sha256(from)
  } catch {
    fail(`${from} is missing${check ? ': run node scripts/build-sqlite-assets.mjs' : ''}`)
  }
  if (digest !== pinned) fail(`${from} has SHA-256 ${digest}, pinned ${pinned}`)
  if (!check) {
    await copyFile(from, join(outDir, name))
    // npm unpacks the wasm executable; a data file need not be.
    await chmod(join(outDir, name), 0o644)
  }
}
console.log(`sql.js ${VERSION}: ${Object.keys(PINNED).join(', ')} ${check ? 'match their pins' : `copied to ${outDir}`}`)
