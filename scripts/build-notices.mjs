/**
 * Write the licence notices the app shows in Help → About and ships as
 * THIRD_PARTY_NOTICES.txt.
 *
 *   node scripts/build-notices.mjs          after `electron-vite build` (npm run build does this)
 *   node scripts/build-notices.mjs --dev    before `electron-vite dev`, tolerating a missing out/
 *
 * Fails, listing every problem, when a shipped component's licence is not on
 * the allowlist or no licence text can be found for it. See scripts/notices/lib.mjs.
 *
 * Output (git-ignored, regenerated every build, packaged with resources/**):
 *   resources/notices/notices.json
 *   resources/notices/THIRD_PARTY_NOTICES.txt
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectNotices, noticesText } from './notices/lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dev = process.argv.includes('--dev')
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

const bundledDir = join(ROOT, 'out/bundled-packages')
const bundled = []
if (existsSync(bundledDir)) {
  for (const f of readdirSync(bundledDir).filter((f) => f.endsWith('.json'))) bundled.push(...read(`out/bundled-packages/${f}`))
} else if (!dev) {
  console.error('build-notices: out/bundled-packages/ is missing; run electron-vite build first')
  process.exit(1)
}

const templates = {}
for (const f of readdirSync(join(ROOT, 'scripts/notices/templates'))) {
  templates[f.replace(/\.txt$/, '')] = readFileSync(join(ROOT, 'scripts/notices/templates', f), 'utf8')
}

const { entries, errors } = collectNotices({
  root: ROOT,
  lock: read('package-lock.json'),
  bundled,
  vendored: read('scripts/notices/vendored.json').components,
  overrides: read('scripts/notices/overrides.json').packages,
  templates,
})
if (errors.length) {
  console.error(`build-notices: ${errors.length} problem(s):\n  ${errors.join('\n  ')}`)
  process.exit(1)
}

const pkg = read('package.json')
const app = {
  name: 'Document Converter',
  version: pkg.version,
  license: readFileSync(join(ROOT, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim(),
}
const out = join(ROOT, 'resources/notices')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'notices.json'), JSON.stringify({ app, components: entries }) + '\n')
writeFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), noticesText(app, entries))
console.log(`build-notices: ${entries.length} components${dev && !existsSync(bundledDir) ? ' (dev: bundled packages not recorded yet)' : ''}`)
