import { resolve, dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Record every npm package whose code ends up INSIDE this bundle.
 *
 * The licence notices (scripts/build-notices.mjs) cover the production
 * dependencies the package ships in node_modules, but that is not everything
 * that ships: Vite inlines whatever a bundle imports that is not externalised
 * — React into the renderer, pdf-lib into main — and those are
 * devDependencies, invisible to a scan of node_modules. Listing them by hand
 * would drift the first time an import changed, so the bundler, which knows,
 * writes them down: `out/bundled-packages/<bundle>.json`.
 */
function recordBundledPackages(bundle: string): Plugin {
  return {
    name: 'record-bundled-packages',
    apply: 'build',
    generateBundle() {
      const found = new Map<string, string>()
      for (const id of this.getModuleIds()) {
        const file = id.replace(/\?.*$/, '').replace(/\\/g, '/')
        const at = file.lastIndexOf('/node_modules/')
        if (at < 0) continue
        // Walk up from the module to the package.json that names its package.
        let dir = dirname(file)
        while (dir.length > at + '/node_modules'.length) {
          const manifest = join(dir, 'package.json')
          if (existsSync(manifest)) {
            const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string }
            // Nested package.json files without a name (e.g. `"type": "module"`
            // markers in dist/esm) are not the package root.
            if (pkg.name && pkg.version) {
              found.set(`${pkg.name}@${pkg.version}`, dir)
              break
            }
          }
          dir = dirname(dir)
        }
      }
      const outDir = resolve('out/bundled-packages')
      mkdirSync(outDir, { recursive: true })
      const list = [...found].sort(([a], [b]) => a.localeCompare(b)).map(([id, dir]) => ({ id, dir }))
      writeFileSync(join(outDir, `${bundle}.json`), JSON.stringify(list, null, 2) + '\n')
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), recordBundledPackages('main')],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // utilityProcess entry hosting the OCR pipeline
          'ocr-entry': resolve('src/main/ocr-entry.ts'),
          // worker_threads script hosting sql.js (sqlite-host.ts). It must not
          // share a chunk with index: it is unpacked from app.asar, and a chunk
          // left inside the archive could not be required from outside it.
          'sqlite-worker': resolve('src/main/sqlite-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(), recordBundledPackages('preload')],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), recordBundledPackages('renderer')],
  },
})
