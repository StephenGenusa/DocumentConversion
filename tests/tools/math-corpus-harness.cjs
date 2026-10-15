/* eslint-disable */
/**
 * Draws every formula of a corpus with the real render host, for
 * tests/tools/math-corpus.test.ts.
 *
 *   electron math-corpus-harness.cjs <bundled render-host.js> <resources/render> <formulas.json>
 *
 * formulas.json is [{ source, display }]. Prints one line, `RESULT <json>`:
 * per formula { ok } or { error }, and the requests the window made.
 */
const { app } = require('electron')
const { readFileSync } = require('fs')

const [hostPath, pageDir, listPath] = process.argv.slice(-3)
const { createRenderHost } = require(hostPath)
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try {
    const requests = []
    const host = createRenderHost({ pageDir, partition: 'docconv-math-corpus', onRequest: (url, allowed) => requests.push({ url, allowed }) })
    const out = []
    const t0 = Date.now()
    for (const f of JSON.parse(readFileSync(listPath, 'utf8'))) {
      const r = await host.render({ kind: 'math', source: f.source, display: f.display, format: 'svg' }, { timeoutMs: 2000 })
      out.push(r.error ? { error: r.error } : { ok: Boolean(r.svg && r.width > 0 && r.height > 0) })
    }
    host.close()
    console.log('RESULT ' + JSON.stringify({ results: out, ms: Date.now() - t0, requests }))
    app.exit(0)
  } catch (e) {
    console.log('RESULT ' + JSON.stringify({ fatal: String(e && e.stack) }))
    app.exit(1)
  }
})
