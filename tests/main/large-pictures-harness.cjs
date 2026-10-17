/* eslint-disable */
/**
 * Whole conversions of large pictures and long formula runs, through the
 * real render host inside Electron, for tests/main/large-pictures.test.ts.
 *
 *   electron large-pictures-harness.cjs <bundled core.cjs> <bundled render-host.js> <resources/render> <cases.json> <outDir>
 *
 * Each case is { name, target, htmlFile }: the hub's HTML is read from
 * htmlFile, written for `target`, and the output saved as <outDir>/<name>.
 * Prints one line, `RESULT <json>`: { name: { ms, baseMainMb, peakMainMb,
 * peakAllMb, advice, error? } }, and exits. Run with --js-flags=--expose-gc,
 * so each case starts from what the one before let go.
 */
const { app } = require('electron')
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const [corePath, hostPath, pageDir, casesFile, outDir] = process.argv.slice(-5)

app.on('window-all-closed', () => {})

/** The largest the main process, and every process of the app together, grew to while `fn` ran, in MB. */
async function measured(fn) {
  let peakMain = 0
  let peakAll = 0
  const sample = () => {
    peakMain = Math.max(peakMain, process.memoryUsage().rss)
    // workingSetSize is in KB.
    peakAll = Math.max(peakAll, app.getAppMetrics().reduce((n, m) => n + m.memory.workingSetSize * 1024, 0))
  }
  const timer = setInterval(sample, 25)
  const t0 = Date.now()
  try {
    const value = await fn()
    return { value, ms: Date.now() - t0 }
  } finally {
    clearInterval(timer)
    sample()
    Object.assign(measured, { peakMainMb: Math.round(peakMain / 1048576), peakAllMb: Math.round(peakAll / 1048576) })
  }
}

app.whenReady().then(async () => {
  try {
    // Loaded here, so a failure is a RESULT line rather than a dialog nobody closes.
    const { createConverter } = require(corePath)
    const { createRenderHost } = require(hostPath)
    const host = createRenderHost({ pageDir, partition: 'docconv-large-pictures-test' })
    const conv = createConverter(async () => Buffer.from('%PDF-1.4\n%%EOF'), { renderBlocks: host.renderBlocks })
    const out = {}
    for (const c of JSON.parse(readFileSync(casesFile, 'utf8'))) {
      const html = readFileSync(c.htmlFile, 'utf8')
      const advice = []
      if (global.gc) global.gc()
      const baseMainMb = Math.round(process.memoryUsage().rss / 1048576)
      try {
        const { value, ms } = await measured(() =>
          conv.write({ html, title: c.name }, c.target, {}, { onAdvice: (_kind, message) => advice.push(message) }),
        )
        writeFileSync(join(outDir, c.name), value.parts[0].bytes)
        out[c.name] = { ms, baseMainMb, peakMainMb: measured.peakMainMb, peakAllMb: measured.peakAllMb, advice }
      } catch (e) {
        out[c.name] = { error: String(e && e.stack), advice }
      }
      // Each case starts from a fresh window and an empty cache, as a conversion of its own would.
      host.close()
    }
    console.log('RESULT ' + JSON.stringify(out))
    app.exit(0)
  } catch (e) {
    console.log('RESULT ' + JSON.stringify({ fatal: String(e && e.stack) }))
    app.exit(1)
  }
})
