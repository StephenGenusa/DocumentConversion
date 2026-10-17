/* eslint-disable */
/**
 * Rasterizes SVGs through the real render host inside Electron, for
 * tests/main/metafile-render.test.ts: the drawings the metafile code made,
 * as the conversion would rasterize them (kind `svg`, PNG at twice the size).
 *
 *   electron metafile-render-harness.cjs <bundled render-host.js> <resources/render> <input.json>
 *
 * The input is [{ name, svg }]. Writes { name: { png, width, height } | { error } }
 * (harness-result.cjs) and exits.
 */
const { app } = require('electron')
const { readFileSync } = require('fs')
const { harnessArgs, writeResult } = require('./harness-result.cjs')

const [hostPath, pageDir, input] = harnessArgs(3)
const { createRenderHost } = require(hostPath)

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try {
    const host = createRenderHost({ pageDir, idleMs: 1500, partition: 'docconv-metafile-test' })
    const out = {}
    for (const { name, svg } of JSON.parse(readFileSync(input, 'utf8'))) {
      out[name] = await host.render({ kind: 'svg', source: svg, display: true, format: 'png' })
    }
    host.close()
    writeResult(out)
    app.exit(0)
  } catch (e) {
    writeResult({ fatal: String(e && e.stack) })
    app.exit(1)
  }
})
