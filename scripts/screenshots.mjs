/**
 * The README's screenshots: the sample documents (Help → Sample Documents)
 * in the real app's editor, and what the app makes of them.
 *
 *   npm run screenshots
 *
 * A manual command, not a test: nothing is compared, the pictures are for a
 * person. It builds the app first when the build is older than the sources,
 * then writes docs/screenshots/*.png (names below, stable from run to run),
 * replacing the PNGs that were there.
 *
 *   app-*        the app, each sample opened from Help → Sample Documents:
 *                the start screen, its Sample documents menu open, the
 *                Settings dialog and the conversion choices at the opening
 *                size (1040 x 700); the top of each document, the code
 *                language picker and the inline-formula popover at the
 *                editing size (1040 x 860); a diagram being edited, its source
 *                over its drawing (1040 x 1160); and app-narrow, the editor
 *                at the window's smallest (560 x 480)
 *   pdf-*        page 1 of each sample as a PDF, and an inner page with a
 *                diagram or formulas; pdf-architecture is the SVG sample's
 *                page, turned landscape by Automatic orientation
 *   word-*       page 1 of each sample as Word, as LibreOffice prints it
 *   epub-*       a chapter of an EPUB at an e-reader's size (600 x 800)
 *   slides-*     a slide of each sample deck, at the deck's own 960 x 700
 *
 * Only the app's own page is captured (the DevTools protocol's
 * Page.captureScreenshot), never the screen: no desktop, no other window, no
 * title bar, no notification can be in a picture. The app runs on its own
 * profile in a temp folder (never the real settings), its fonts pinned by a
 * fontconfig file of its own (DejaVu for the generic families, grayscale
 * antialiasing, scale 1), so a run on the same machine gives the same pixels.
 * The rendered pages come from the CLI (same profile rules), poppler's
 * pdftoppm, LibreOffice for Word (soffice --headless, its own profile too) and
 * an offscreen Electron window (scripts/screenshots/page-shot.cjs) for slides
 * and EPUB chapters. Every PNG is then made smaller by optipng when it is
 * installed (lossless).
 *
 * Requirements: Linux with a display (the app opens its window on the
 * desktop for the run), poppler-utils (pdftoppm, pdftotext), unzip;
 * LibreOffice for the Word pages (skipped, with a warning, without it);
 * optipng optional.
 *
 * The pictures are committed: the README shows them on the first push.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'screenshots')
const SAMPLES_DIR = join(ROOT, 'resources', 'samples')
const PORT = 9471
const MAIN_PORT = 9472
/*
 * The sizes the page is laid out at, set by the DevTools protocol's device
 * metrics (the page sees exactly this window, whatever the screen allows),
 * so a run gives the same pictures on any screen. START is the window's
 * opening size; EDITING is the height the app gives its window when the
 * editor opens (PANE_HEIGHT in App.tsx), where the screen has room for it;
 * NARROW is the window's smallest; DIAGRAM is tall enough for a diagram's
 * source and its drawing under it, as on a large screen.
 */
const START = [1040, 700]
const EDITING = [1040, 860]
const NARROW = [560, 480]
const DIAGRAM = [1040, 1160]
/** A Letter page at this many dots per inch is 816 x 1056: about a README column wide. */
const PAGE_DPI = 96

/**
 * The four Markdown samples: the menu item's id, the file, the name used in
 * the pictures' file names, the heading at the top of the document, the
 * heading of the slide shown, and a phrase on the inner PDF page shown (a
 * page with a diagram or formulas).
 */
const SAMPLES = [
  { id: 'engineering', file: 'engineering-design-note.md', name: 'design-note', heading: 'Ferrow Mill Footbridge', inner: '2. Load path', page: 'Spread footings' },
  { id: 'software', file: 'software-design-specification.md', name: 'software-spec', heading: 'Heron Sync Service', inner: 'Pushing a change', page: 'Pushing a change' },
  { id: 'lab', file: 'lab-report.md', name: 'lab-report', heading: 'Crystal Violet Fading', inner: 'The activation energy', page: 'The activation energy' },
  { id: 'meeting', file: 'meeting-summary.md', name: 'meeting-summary', heading: 'Office Move Planning', inner: 'The new floor plan', page: 'The new floor plan' },
]
/** The EPUB shown: the lab report's Introduction, its formulas drawn as pictures. */
const EPUB = { sample: 'lab', chapter: 'Introduction' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { default: electron } = await import('electron')
const work = mkdtempSync(join(tmpdir(), 'docconv-shots-'))
const written = []
/** Pictures are made here and moved into OUT only when the whole run has worked. */
const SHOTS = join(work, 'shots')

/* ------------------------------- preparation ------------------------------- */

function have(tool) {
  return spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0
}

/** The newest modification time under a folder (or of a file). */
function newest(path) {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.mtimeMs
  let t = 0
  // resources/notices is written by the build itself, after the bundles.
  for (const e of readdirSync(path)) if (e !== 'node_modules' && e !== 'notices') t = Math.max(t, newest(join(path, e)))
  return t
}

/** `npm run build` when the build is missing or older than what it is built from. */
function buildIfNeeded() {
  const built = join(ROOT, 'out', 'main', 'index.js')
  const sources = Math.max(...['src', 'resources', 'package.json', 'electron.vite.config.ts'].map((p) => newest(join(ROOT, p))))
  if (existsSync(built) && statSync(built).mtimeMs >= sources) return
  console.log('Building (the build is older than the sources)…')
  const res = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
  if (res.status !== 0) throw new Error(`npm run build failed:\n${(res.stdout + res.stderr).slice(-2000)}`)
}

/** A fontconfig of its own: the system's, with the generic families pinned and grayscale antialiasing. */
function fontEnv() {
  if (process.platform !== 'linux') return { ...process.env }
  const file = join(work, 'fonts.conf')
  const pin = (generic, family) =>
    `  <match target="pattern"><test name="family"><string>${generic}</string></test><edit name="family" mode="prepend" binding="strong"><string>${family}</string></edit></match>\n`
  writeFileSync(
    file,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n` +
      pin('sans-serif', 'DejaVu Sans') +
      pin('serif', 'DejaVu Serif') +
      pin('monospace', 'DejaVu Sans Mono') +
      `  <match target="font"><edit name="antialias" mode="assign"><bool>true</bool></edit><edit name="hintstyle" mode="assign"><const>hintslight</const></edit><edit name="rgba" mode="assign"><const>none</const></edit></match>\n</fontconfig>\n`,
  )
  return { ...process.env, FONTCONFIG_FILE: file }
}

function requireTools() {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('no display: the app needs one to open its window')
  for (const [tool, pkg] of [
    ['pdftoppm', 'poppler-utils'],
    ['pdftotext', 'poppler-utils'],
    ['unzip', 'unzip'],
  ]) {
    if (!have(tool)) throw new Error(`${tool} is missing (install ${pkg})`)
  }
}

/* -------------------------------- the app ---------------------------------- */

let app
let ws
let seq = 0
const pending = new Map()

function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function js(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400))
  return res.result?.result?.value
}

async function waitFor(expression, what, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (await js(expression)) return
    await sleep(100)
  }
  throw new Error(`never happened: ${what}`)
}

/** Evaluate in the app's main process (window size, the Help menu). */
async function mainEval(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${MAIN_PORT}/json/list`)).json()
  const sock = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((r, j) => {
    sock.onopen = r
    sock.onerror = j
  })
  try {
    const res = await new Promise((resolve) => {
      sock.onmessage = (m) => {
        const d = JSON.parse(m.data)
        if (d.id === 1) resolve(d)
      }
      sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    })
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 300))
    return res.result?.result?.value
  } finally {
    sock.close()
  }
}

/** Lay the page out as a window of this size. */
async function viewport([width, height]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await waitFor(`innerWidth === ${width} && innerHeight === ${height}`, `the page to be ${width} x ${height}`)
  await sleep(500)
}

async function startApp(env) {
  const args = [`--inspect=${MAIN_PORT}`, ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`, '--force-device-scale-factor=1', '--disable-lcd-text']
  app = spawn(electron, args, { stdio: 'ignore', env, detached: process.platform !== 'win32' })
  let page
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(250)
    try {
      page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page')
    } catch {
      /* not listening yet */
    }
  }
  if (!page) throw new Error('the app did not start')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  }
  // Behave as the focused window whatever else is on the desktop (the language picker fills its list on focus).
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`!!document.querySelector('.dropzone')`, 'the start screen')
}

async function stopApp() {
  ws?.close()
  if (!app || app.exitCode !== null) return
  const exited = new Promise((r) => app.once('exit', r))
  try {
    if (process.platform === 'win32') app.kill()
    else process.kill(-app.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  await Promise.race([exited, sleep(5000)])
  // Until nothing is left in its group, so its profile can be removed.
  for (let i = 0; process.platform !== 'win32' && i < 50; i++) {
    try {
      process.kill(-app.pid, 0)
    } catch {
      break
    }
    await sleep(100)
  }
}

/** The page as it is now, and nothing else, as docs/screenshots/<name>.png. */
async function shot(name) {
  // No cursor in a picture: the pointer is never in a page capture, and it is
  // parked over the empty margin at the page's bottom left so nothing is in a
  // hover state (the real pointer may be over the window); the text caret is
  // made transparent (an input's selection, as in the formula popover, still shows).
  const h = await js('innerHeight')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: h - 2 })
  await js(`(() => { if (document.getElementById('shots-no-caret')) return; const s = document.createElement('style'); s.id = 'shots-no-caret'; s.textContent = '*, *::before, *::after { caret-color: transparent !important; }'; document.head.appendChild(s) })()`)
  // Two frames, so what was just changed is painted.
  await js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`)
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = join(SHOTS, `${name}.png`)
  writeFileSync(file, Buffer.from(res.result.data, 'base64'))
  written.push(file)
}

const EDITOR = `document.querySelector('.clip-pane__editor .ProseMirror')`
const PANE = `document.querySelector('.clip-pane__editor')`

const clickButton = async (label) => {
  const ok = await js(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)
  if (!ok) throw new Error(`no "${label}" button`)
}

async function pressKey(key, code, keyCode, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers })
}

async function startOver() {
  if (await js(`!!document.querySelector('.dropzone')`)) return
  await clickButton('Change')
  await waitFor(`!!document.querySelector('.dropzone')`, 'the start screen')
  await sleep(300)
}

/** Help → Sample Documents → the sample, as the menu item does it. */
async function openSample(s) {
  await startOver()
  await mainEval(`process.mainModule.require('electron').Menu.getApplicationMenu().getMenuItemById('sample-${s.id}').click()`)
  await waitFor(`!!${EDITOR}?.querySelector('h1')?.textContent.includes(${JSON.stringify(s.heading)})`, `the ${s.file} sample in the editor`)
}

/** Every drawn block and formula now on screen finished drawing (or failed), and the pictures decoded. */
async function settle() {
  await waitFor(
    `(() => {
      const pane = ${PANE}.getBoundingClientRect()
      const onScreen = (e) => { const b = e.getBoundingClientRect(); return b.bottom > pane.top && b.top < pane.bottom }
      return [...document.querySelectorAll('.clip-pane__editor .rb, .clip-pane__editor .rm')].filter(onScreen).every((e) => e.dataset.state !== 'waiting' && e.dataset.state !== 'drawing')
    })()`,
    'the blocks on screen to be drawn',
  )
  await js(`Promise.all([...document.querySelectorAll('.clip-pane__editor img')].map((i) => i.decode().catch(() => {})))`)
  await sleep(600)
}

/** Scroll the pane so the element `pick` finds sits `fromTop` px below the pane's top. */
const scrollTo = (pick, fromTop = 24) =>
  js(`(() => { const pane = ${PANE}; const el = ${pick}; if (!el) return false; pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - ${fromTop}; return true })()`)

const headingNamed = (text) => `[...${EDITOR}.querySelectorAll('h1, h2, h3')].find((h) => h.textContent.trim() === ${JSON.stringify(text)})`

async function appShots() {
  console.log('The app:')
  await viewport(START)
  await sleep(800)
  await shot('app-start')

  // The start screen's Sample documents menu, opened by its key.
  await js(`document.querySelector('.sample-menu button[aria-haspopup="menu"]').focus()`)
  await pressKey('ArrowDown', 'ArrowDown', 40)
  await waitFor(`!!document.querySelector('.sample-menu [role="menu"]')`, 'the Sample documents menu')
  await sleep(300)
  await shot('app-sample-menu')
  await pressKey('Escape', 'Escape', 27)
  await js(`document.activeElement?.blur()`)

  // The Settings dialog, at its first section, with no focus ring on its tab.
  await clickButton('Settings')
  await waitFor(`!!document.querySelector('dialog.settings[open] input[type=radio]')`, 'the Settings dialog')
  await js(`document.activeElement?.blur()`)
  await sleep(400)
  await shot('app-settings')
  await pressKey('Escape', 'Escape', 27)
  await waitFor(`!document.querySelector('dialog.settings[open]')`, 'the Settings dialog to close')

  // The top of each document.
  await viewport(EDITING)
  for (const s of SAMPLES) {
    await openSample(s)
    await js(`${EDITOR}.blur(); ${PANE}.scrollTop = 0`)
    await settle()
    await shot(`app-${s.name}`)
  }

  // The code language picker, opened with Ctrl+Alt+L from the spec's Python block.
  await openSample(SAMPLES[1])
  await js(`(() => {
    const ed = ${EDITOR}.editor
    const pre = [...${EDITOR}.querySelectorAll('pre')].find((p) => p.querySelector('code.language-python'))
    const pos = ed.view.posAtDOM(pre.querySelector('code'), 0)
    ed.commands.setTextSelection(pos)
    ed.commands.focus()
  })()`)
  await scrollTo(`[...${EDITOR}.querySelectorAll('pre')].find((p) => p.querySelector('code.language-python'))`, 90)
  await pressKey('l', 'KeyL', 76, 2 | 1)
  await waitFor(`document.activeElement?.getAttribute('role') === 'combobox'`, 'the language picker')
  await sleep(500)
  await shot('app-code-language')
  await pressKey('Escape', 'Escape', 27)

  // The inline-formula popover, on a formula in a sentence of the lab report.
  await openSample(SAMPLES[2])
  await scrollTo(headingNamed('Introduction'), 12)
  await settle()
  await js(`(async () => {
    const ed = ${EDITOR}.editor
    const pane = ${PANE}.getBoundingClientRect()
    // The Introduction's gas constant, R = \\SI{8.314}{...} (siunitx) in a sentence, a third of the way down the pane.
    let at = -1
    ed.state.doc.descendants((node, pos) => {
      if (at >= 0 || node.type.name !== 'mathInline') return at < 0
      if (!node.attrs.display && node.attrs.tex.startsWith('R = \\\\SI')) at = pos
      return false
    })
    if (at < 0) throw new Error('no gas constant formula in the lab report')
    const face = ed.view.nodeDOM(at)
    ${PANE}.scrollTop += face.getBoundingClientRect().top - pane.top - pane.height / 3
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    ed.commands.setNodeSelection(at)
    ed.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })()`)
  await waitFor(`!!document.querySelector('.rm-pop') && document.querySelector('.rm-pop').style.visibility !== 'hidden'`, 'the formula popover')
  await sleep(600)
  await shot('app-formula')
  await js(`document.querySelector('.rm-pop input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)

  // A diagram being edited: the lab report's flowchart, its source above its live drawing.
  await viewport(DIAGRAM)
  await scrollTo(headingNamed('Method'), 12)
  await settle()
  await js(`(() => {
    const block = [...document.querySelectorAll('.clip-pane__editor .rb')].find((b) => b.compareDocumentPosition(${headingNamed('Method')}) & Node.DOCUMENT_POSITION_PRECEDING)
    block.querySelector('.rb__picture').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
  })()`)
  await waitFor(`!!document.querySelector('.rb[data-state=editing] .rb__preview img')`, 'the diagram to open for editing')
  await js(`Promise.all([...document.querySelectorAll('.rb__preview img')].map((i) => i.decode().catch(() => {})))`)
  // Its end at the pane's foot: the last lines of the source over the whole drawing.
  await js(`(() => { const pane = ${PANE}; const b = document.querySelector('.rb[data-state=editing]').getBoundingClientRect(); pane.scrollTop += b.bottom - pane.getBoundingClientRect().bottom + 16 })()`)
  await sleep(800)
  await shot('app-diagram-editing')
  await js(`${EDITOR}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)

  // The architecture diagram (SVG) is added like a dropped picture: the conversion choices.
  await viewport(START)
  await startOver()
  await mainEval(`process.mainModule.require('electron').Menu.getApplicationMenu().getMenuItemById('sample-architecture').click()`)
  await waitFor(`[...document.querySelectorAll('.card__name')].some((e) => e.textContent === 'Architecture Diagram (sample, untitled)')`, 'the SVG sample to be added')
  await clickButton('PDF')
  await sleep(800)
  await shot('app-convert')

  // The window at its smallest, with the meeting summary.
  await openSample(SAMPLES[3])
  await viewport(NARROW)
  await js(`${EDITOR}.blur(); ${PANE}.scrollTop = 0`)
  await settle()
  await shot('app-narrow')
}

/* ---------------------------- the rendered pages ---------------------------- */

function cli(inputs, to, outDir, env) {
  const res = spawnSync(electron, [join(ROOT, 'out', 'main', 'index.js'), 'convert', ...inputs, '--to', to, '--out', outDir, `--user-data-dir=${join(work, 'cli-profile')}`], {
    encoding: 'utf8',
    env,
    timeout: 300_000,
  })
  if (res.status !== 0) throw new Error(`converting to ${to} failed: ${(res.stderr ?? '').slice(0, 400)}`)
}

/** Page `page` of a PDF as docs/screenshots/<name>.png. */
function pdfPage(pdf, page, name) {
  const prefix = join(SHOTS, name)
  const res = spawnSync('pdftoppm', ['-png', '-r', String(PAGE_DPI), '-f', String(page), '-l', String(page), '-singlefile', pdf, prefix])
  if (res.status !== 0) throw new Error(`pdftoppm failed on ${basename(pdf)}: ${res.stderr}`)
  written.push(`${prefix}.png`)
}

/** The first page after page 1 that has `phrase`, else the first page that has it. */
function pageWith(pdf, phrase) {
  const pages = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).stdout.split('\f')
  const has = (text) => text.split('\n').some((line) => line.includes(phrase))
  const i = pages.findIndex((text, n) => n > 0 && has(text))
  if (i >= 0) return i + 1
  const j = pages.findIndex(has)
  if (j < 0) throw new Error(`"${heading}" is on no page of ${basename(pdf)}`)
  return j + 1
}

async function renderedShots(env) {
  const conv = join(work, 'converted')
  mkdirSync(conv, { recursive: true })
  const inputs = [...SAMPLES.map((s) => join(SAMPLES_DIR, s.file)), join(SAMPLES_DIR, 'architecture-diagram.svg')]
  console.log('Converting the samples…')
  for (const to of ['pdf', 'docx', 'epub', 'revealjs']) cli(inputs, to, conv, env)
  const stem = (file) => file.replace(/\.[^.]+$/, '')

  console.log('PDF pages:')
  for (const s of SAMPLES) {
    const pdf = join(conv, `${stem(s.file)}.pdf`)
    pdfPage(pdf, 1, `pdf-${s.name}`)
    pdfPage(pdf, pageWith(pdf, s.page), `pdf-${s.name}-inner`)
  }
  pdfPage(join(conv, 'architecture-diagram.pdf'), 1, 'pdf-architecture')

  if (have('soffice')) {
    console.log('Word pages (LibreOffice):')
    const word = join(work, 'word')
    const docx = SAMPLES.map((s) => join(conv, `${stem(s.file)}.docx`))
    const res = spawnSync('soffice', [`-env:UserInstallation=file://${join(work, 'libreoffice')}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', word, ...docx], {
      encoding: 'utf8',
      env,
      timeout: 300_000,
    })
    if (res.status !== 0) throw new Error(`LibreOffice failed: ${res.stderr}`)
    for (const s of SAMPLES) pdfPage(join(word, `${stem(s.file)}.pdf`), 1, `word-${s.name}`)
  } else {
    console.warn('  ! LibreOffice (soffice) is not installed: no Word pages')
  }

  // The EPUB chapter and the slides, in an offscreen window.
  const jobs = []
  const book = join(work, 'epub')
  const sample = SAMPLES.find((s) => s.id === EPUB.sample)
  const unz = spawnSync('unzip', ['-q', '-o', join(conv, `${stem(sample.file)}.epub`), '-d', book])
  if (unz.status !== 0) throw new Error('unzip failed on the EPUB')
  const text = join(book, 'OEBPS')
  const chapter = readdirSync(text)
    .filter((f) => /^ch\d+\.xhtml$/.test(f))
    .sort()
    .find((f) => readFileSync(join(text, f), 'utf8').includes(`<h2>${EPUB.chapter}</h2>`))
  if (!chapter) throw new Error(`no EPUB chapter "${EPUB.chapter}"`)
  // A reader's page: its margins and paper, the book's own style inside them.
  jobs.push({ file: join(text, chapter), out: join(SHOTS, `epub-${sample.name}.png`), width: 600, height: 800, css: 'html { background: #fbfaf6; } body { margin: 36px 40px !important; font-size: 18px; }' })
  for (const s of SAMPLES) jobs.push({ file: join(conv, `${stem(s.file)}.html`), out: join(SHOTS, `slides-${s.name}.png`), width: 960, height: 700, slide: s.inner })
  const jobFile = join(work, 'jobs.json')
  writeFileSync(jobFile, JSON.stringify(jobs))
  console.log('EPUB chapter and slides:')
  const res = spawnSync(electron, [join(ROOT, 'scripts', 'screenshots', 'page-shot.cjs'), jobFile, `--user-data-dir=${join(work, 'page-profile')}`], {
    encoding: 'utf8',
    env,
    timeout: 300_000,
  })
  const missing = jobs.filter((j) => !existsSync(j.out)).map((j) => basename(j.out))
  if (res.status !== 0 || missing.length) throw new Error(`page-shot failed (${res.status ?? res.signal}; missing ${missing.join(', ') || 'none'}): ${(res.stderr ?? '').split('\n').filter((l) => !l.startsWith('MESA-LOADER')).join('\n').slice(0, 600)}`)
  for (const j of jobs) written.push(j.out)
}

/* --------------------------------- the run ---------------------------------- */

function optimize() {
  if (!have('optipng')) {
    console.warn('  ! optipng is not installed: the PNGs are left as written')
    return
  }
  const res = spawnSync('optipng', ['-quiet', '-o2', '-strip', 'all', ...written])
  if (res.status !== 0) console.warn(`  ! optipng failed: ${res.stderr}`)
}

let failed = false
try {
  requireTools()
  buildIfNeeded()
  mkdirSync(SHOTS, { recursive: true })
  const env = fontEnv()
  console.log('Launching the app…')
  await startApp(env)
  try {
    await appShots()
  } finally {
    await stopApp()
  }
  await renderedShots(env)
  optimize()
  const lost = written.filter((f) => !existsSync(f))
  if (lost.length) throw new Error(`not made: ${lost.map((f) => basename(f)).join(', ')}`)
  mkdirSync(OUT, { recursive: true })
  for (const f of readdirSync(OUT)) if (f.endsWith('.png')) rmSync(join(OUT, f))
  let total = 0
  for (const made of written.sort()) {
    const file = join(OUT, basename(made))
    copyFileSync(made, file)
    const size = statSync(file).size
    total += size
    console.log(`  ${basename(file).padEnd(36)} ${String(Math.round(size / 1024)).padStart(5)} KB`)
  }
  console.log(`${written.length} pictures, ${(total / 1024 / 1024).toFixed(2)} MB, in ${OUT}`)
} catch (err) {
  failed = true
  console.error(`\nscreenshots failed: ${err.message}`)
  await stopApp()
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
process.exit(failed ? 1 : 0)
