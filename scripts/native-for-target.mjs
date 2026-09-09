/**
 * Install the native binding for a CROSS-target before packaging for it.
 *
 * `@napi-rs/canvas` ships its Skia binary as one optionalDependency per
 * platform, and npm installs only the one matching the HOST. So a Windows or
 * macOS package built on Linux gets `skia.linux-x64-gnu.node` and no other —
 * and nothing complains. The app still builds, still installs, still converts;
 * it just returns ZERO images from every PDF, silently, because that is the
 * one thing Skia is used for.
 *
 * This was shipped: the Windows installer built on 2026-09-07 produced a
 * 166 KB markdown file from the handbook where the Linux build produced 2.8 MB
 * with 13 images. Nothing in the build log hinted at it.
 *
 *   node scripts/native-for-target.mjs win32-x64-msvc
 *
 * Wired to `prebuild:win`, so `npm run build:win` cannot forget. Building each
 * platform on its own CI runner would make this unnecessary — that is the real
 * fix, and this is the guard until it exists.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/native-for-target.mjs <napi-target-triple>')
  process.exit(2)
}

const { version } = require('@napi-rs/canvas/package.json')
const pkg = `@napi-rs/canvas-${target}`
const dir = new URL(`../node_modules/${pkg}/`, import.meta.url)

if (existsSync(dir)) {
  console.log(`${pkg}@${version} already present`)
  process.exit(0)
}

// --force is required, not optional: npm refuses a package whose `os`/`cpu`
// does not match the host, which is exactly the case we are creating on
// purpose. --no-save keeps it out of package.json and the lockfile, because it
// is a build input for one target, not a dependency of the app.
console.log(`installing ${pkg}@${version} for the ${target} package…`)
execFileSync('npm', ['install', '--no-save', '--force', `${pkg}@${version}`], { stdio: 'inherit' })
