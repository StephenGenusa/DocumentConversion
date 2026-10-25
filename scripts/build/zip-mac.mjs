/**
 * Zip the macOS app built on Linux, keeping its symlinks.
 *
 *   node scripts/build/zip-mac.mjs      (the last step of npm run build:mac)
 *
 * electron-builder keeps symlinks in a mac zip only when it runs on a Mac.
 * Anywhere else it zips with 7-Zip, which follows them: Electron
 * Framework.framework's `Versions/Current` and its top-level links each became
 * a full copy, and the 200 MB framework binary went in three times (1.1 GB
 * unpacked, a 451 MB zip, and a bundle codesign rejects). So npm run build:mac
 * asks electron-builder for the unpacked app (`--mac dir`) and this zips it
 * with Info-ZIP's `zip -y`, which stores a symlink as a symlink.
 *
 * Same name electron-builder gives the zip: <productName>-<version>-mac.zip.
 * scripts/build/build-macos.sh, on a Mac, still lets electron-builder zip.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

const root = new URL('../../', import.meta.url).pathname
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const { productName } = load(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))
const appDir = join(root, 'dist', 'mac')
const app = `${productName}.app`
const zip = join(root, 'dist', `${productName}-${version}-mac.zip`)

if (!existsSync(join(appDir, app))) {
  console.error(`zip-mac: ${join(appDir, app)} is missing; run electron-builder --mac dir first`)
  process.exit(1)
}
try {
  execFileSync('zip', ['-v'], { stdio: 'ignore' })
} catch {
  console.error('zip-mac: Info-ZIP `zip` is not installed (apt install zip)')
  process.exit(1)
}

// zip adds to an existing archive; start from nothing.
rmSync(zip, { force: true })
// -r recurse, -y store symlinks as links, -X no extra file attributes, -q quiet
execFileSync('zip', ['-qryX', zip, app], { cwd: appDir, stdio: 'inherit' })
// The blockmap was electron-builder's, for an updater this app does not have.
rmSync(`${zip}.blockmap`, { force: true })
console.log(`zip-mac: ${zip}`)
