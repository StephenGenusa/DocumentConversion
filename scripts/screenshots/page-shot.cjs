/**
 * Pictures of converted pages that a person would see in a reader rather
 * than in the app: a slide of a deck, a chapter of an EPUB at an e-reader's
 * size. Run by scripts/screenshots.mjs, under Electron:
 *
 *   electron scripts/screenshots/page-shot.cjs <jobs.json> --user-data-dir=<temp>
 *
 * Each job is { file, out, width, height, css?, slide? }: `file` is loaded
 * in an offscreen window of that size (no window on the desktop, nothing but
 * the page in the picture), `css` is laid over it, and `slide`, for a reveal
 * deck, is the text of the heading whose slide to show. Nothing leaves the
 * machine: every request that is not for a local file is refused.
 */
const { app, BrowserWindow, session } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-lcd-text')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shoot(job) {
  const win = new BrowserWindow({
    show: false,
    width: job.width,
    height: job.height,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  })
  try {
    win.webContents.setFrameRate(30)
    await win.loadURL(pathToFileURL(job.file).href)
    if (job.css) await win.webContents.insertCSS(job.css)
    if (job.slide) {
      const found = await win.webContents.executeJavaScript(`new Promise((resolve) => {
        const go = () => {
          const want = ${JSON.stringify(job.slide)}
          const slides = [...document.querySelectorAll('.reveal .slides > section')]
          const i = slides.findIndex((s) => [...s.querySelectorAll('h1, h2')].some((h) => h.textContent.trim() === want))
          if (i < 0) return resolve(false)
          Reveal.slide(i)
          resolve(true)
        }
        if (Reveal.isReady()) go()
        else Reveal.on('ready', go)
      })`)
      if (!found) throw new Error(`no slide headed "${job.slide}" in ${job.file}`)
    }
    // Pictures decoded and the deck's own fitting run (FIT_SLIDES_JS) before the picture.
    await win.webContents.executeJavaScript(
      `Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`,
    )
    await sleep(job.slide ? 1200 : 400)
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: job.width, height: job.height })
    writeFileSync(job.out, image.toPNG())
  } finally {
    win.destroy()
  }
}

// Each job's window is closed before the next opens: that must not quit the app.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  // Local files only: a page that asked for anything else gets nothing.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(file|data|blob|devtools):/.test(details.url) })
  })
  let code = 0
  try {
    const jobs = JSON.parse(readFileSync(process.argv.find((a) => a.endsWith('.json')), 'utf8'))
    for (const job of jobs) await shoot(job)
  } catch (err) {
    console.error(err && err.message ? err.message : String(err))
    code = 1
  }
  app.exit(code)
})
