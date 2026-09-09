/* eslint-disable */
/**
 * Render a standalone HTML file to PDF through the same Electron printToPDF
 * path the app uses, so what you look at is what the app produces.
 *
 *   npx electron scripts/print-pdf.cjs input.html output.pdf
 *
 * Companion to tests/tools/visual-render.test.ts.
 */
const { app, BrowserWindow } = require('electron')
const { writeFile } = require('fs/promises')
const { pathToFileURL } = require('url')

app.whenReady().then(async () => {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) {
    console.error('usage: electron scripts/print-pdf.cjs <input.html> <output.pdf>')
    app.exit(2)
    return
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false, webSecurity: true },
  })
  try {
    await win.loadURL(pathToFileURL(input).href)
    const pdf = await win.webContents.printToPDF({ printBackground: true })
    await writeFile(output, pdf)
    console.log(`wrote ${output} (${pdf.length} bytes)`)
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    if (!win.isDestroyed()) win.destroy()
    app.quit()
  }
})
